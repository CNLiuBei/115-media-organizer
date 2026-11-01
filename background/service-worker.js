import { createApi115 } from '../lib/api115.js';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../lib/types.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const api = createApi115(fetch);

async function getSettings() {
  const data = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
}

function extractCidFromUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href);
    const fromSearch = u.searchParams.get('cid');
    if (fromSearch != null && /^\d+$/.test(fromSearch)) return fromSearch;
    const hash = (u.hash || '').replace(/^#/, '');
    if (hash) {
      try {
        const hp = new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
        const fromHash = hp.get('cid');
        if (fromHash != null && /^\d+$/.test(fromHash)) return fromHash;
      } catch {
        /* ignore */
      }
      const m = hash.match(/(?:^|[?&#])cid=([^&]+)/i);
      if (m && /^\d+$/.test(decodeURIComponent(m[1]))) return decodeURIComponent(m[1]);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function is115Tab(url) {
  try {
    const u = new URL(url);
    return u.hostname === '115.com' || u.hostname.endsWith('.115.com');
  } catch {
    return false;
  }
}

async function persistCid(cid) {
  const value = String(cid ?? '0');
  // Same value → skip storage writes (avoids onChanged churn on every tab event)
  if (value === lastPersistedCid) return value;
  lastPersistedCid = value;
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.lastCid]: value });
  } catch {
    /* ignore */
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.lastCid]: value });
  return value;
}

let lastPersistedCid = null;

async function askTabForCid(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_CID' }, { frameId: 0 });
    if (res?.ok && res.cid != null && /^\d+$/.test(String(res.cid))) {
      return String(res.cid);
    }
  } catch {
    /* content script may not be ready */
  }
  return null;
}

async function resolveCidFromTabs() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = tabs.find((t) => t.url && is115Tab(t.url));
  if (!tab) {
    const all = await chrome.tabs.query({ url: ['https://115.com/*', 'https://*.115.com/*'] });
    tab = all.sort((a, b) => Number(b.active) - Number(a.active))[0];
  }
  if (!tab) return null;

  const fromContent = tab.id != null ? await askTabForCid(tab.id) : null;
  if (fromContent != null) {
    await persistCid(fromContent);
    return { cid: fromContent, source: 'content', tabId: tab.id };
  }

  const fromUrl = extractCidFromUrl(tab.url || '');
  if (fromUrl != null) {
    await persistCid(fromUrl);
    return { cid: fromUrl, source: 'url', tabId: tab.id };
  }

  // Do NOT invent cid=0 here — that would make recursive scan eat the whole drive
  return null;
}

async function readStoredCid() {
  try {
    const session = await chrome.storage.session.get(STORAGE_KEYS.lastCid);
    if (session[STORAGE_KEYS.lastCid] != null && session[STORAGE_KEYS.lastCid] !== '') {
      return { cid: String(session[STORAGE_KEYS.lastCid]), source: 'session' };
    }
  } catch {
    /* ignore */
  }
  const local = await chrome.storage.local.get(STORAGE_KEYS.lastCid);
  if (local[STORAGE_KEYS.lastCid] != null && local[STORAGE_KEYS.lastCid] !== '') {
    return { cid: String(local[STORAGE_KEYS.lastCid]), source: 'local' };
  }
  return null;
}

// Keep cid in sync when user navigates 115 tabs
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab?.url || !is115Tab(tab.url)) return;
  if (changeInfo.url || changeInfo.status === 'complete') {
    const cid = extractCidFromUrl(changeInfo.url || tab.url);
    if (cid != null) await persistCid(cid);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !is115Tab(tab.url)) return;
    const cid = extractCidFromUrl(tab.url) ?? (await askTabForCid(tabId));
    if (cid != null) await persistCid(cid);
  } catch {
    /* ignore */
  }
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err), code: err.code, data: err.data }));
  return true;
});

async function handleMessage(message, sender) {
  const { type, payload } = message || {};

  switch (type) {
    case 'PING':
      return { pong: true };

    case 'SET_CID': {
      const cid = await persistCid(payload?.cid || '0');
      return { cid };
    }

    case 'GET_CID': {
      // Prefer live tab/content-script cid; never invent root unless storage says so
      const live = await resolveCidFromTabs();
      if (live?.cid != null) return live;
      const stored = await readStoredCid();
      if (stored) return stored;
      return { cid: '0', source: 'default' };
    }

    case 'REFRESH_CID': {
      const live = await resolveCidFromTabs();
      if (live?.cid != null) return live;
      const stored = await readStoredCid();
      if (stored) return { ...stored, refreshed: false };
      return { cid: null, source: 'none' };
    }

    case 'OPEN_SIDEPANEL': {
      const tabId = sender.tab?.id || payload?.tabId;
      if (payload?.cid != null) await persistCid(payload.cid);
      else if (tabId) {
        const fromContent = await askTabForCid(tabId);
        if (fromContent != null) await persistCid(fromContent);
        else {
          try {
            const tab = await chrome.tabs.get(tabId);
            const fromUrl = extractCidFromUrl(tab.url || '');
            if (fromUrl != null) await persistCid(fromUrl);
          } catch {
            /* ignore */
          }
        }
      }
      if (tabId) {
        await chrome.sidePanel.open({ tabId });
      }
      return { opened: true };
    }

    case 'GET_SETTINGS':
      return getSettings();

    case 'SAVE_SETTINGS': {
      const next = { ...DEFAULT_SETTINGS, ...(payload || {}) };
      await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: next });
      return next;
    }

    case 'API_LIST_ALL': {
      const cid = String(payload?.cid || '0');
      const recursive = !!payload?.recursive;
      const files = recursive
        ? await api.listAllFilesRecursive(cid, {
          delayMs: Number(payload?.delayMs) || 250,
          maxDepth: Number(payload?.maxDepth) || 30,
        })
        : await api.listAllFiles(cid);
      return { files, cid, recursive };
    }

    case 'CHECK_LOGIN': {
      try {
        const data = await api.listFiles('0', { offset: 0, limit: 1 });
        return { loggedIn: true, user_id: data.user_id, count: data.count };
      } catch (err) {
        return { loggedIn: false, error: err.message };
      }
    }

    default:
      throw new Error(`未知消息类型: ${type}`);
  }
}
