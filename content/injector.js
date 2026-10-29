(function () {
  const BTN_ID = 'x115-media-organize-btn';
  const FAB_ID = 'x115-media-organize-fab';
  let lastHref = location.href;
  let lastCid = null;
  let dead = false;
  /** @type {number | null} */
  let pollTimer = null;

  function isAlive() {
    try {
      return !dead && !!(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function teardown() {
    if (dead) return;
    dead = true;
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(FAB_ID)?.remove();
  }

  function sendRuntime(message, callback) {
    if (!isAlive()) {
      teardown();
      return;
    }
    try {
      if (typeof callback === 'function') {
        chrome.runtime.sendMessage(message, (...args) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message || '';
            if (/context invalidated|Extension context/i.test(err)) teardown();
          }
          try {
            callback(...args);
          } catch {
            /* ignore */
          }
        });
      } else {
        const p = chrome.runtime.sendMessage(message);
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            const msg = String(err?.message || err || '');
            if (/context invalidated|Extension context/i.test(msg)) teardown();
          });
        }
      }
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (/context invalidated|Extension context/i.test(msg)) teardown();
    }
  }

  function extractCid(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    // allow numeric cid (including 0) and long digit strings
    if (/^\d+$/.test(s)) return s;
    return null;
  }

  function parseCidFromLocation(href = location.href) {
    try {
      const u = new URL(href, location.origin);
      const fromSearch = extractCid(u.searchParams.get('cid'));
      if (fromSearch !== null) return fromSearch;

      // hash forms: #cid=123  #/?cid=123  #cid=123&offset=0
      const hash = (u.hash || '').replace(/^#/, '');
      if (hash) {
        try {
          const hp = new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
          const fromHash = extractCid(hp.get('cid'));
          if (fromHash !== null) return fromHash;
        } catch {
          /* ignore */
        }
        const m = hash.match(/(?:^|[?&#])cid=([^&]+)/i);
        if (m) {
          const fromMatch = extractCid(decodeURIComponent(m[1]));
          if (fromMatch !== null) return fromMatch;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function cidFromElement(el) {
    if (!el) return null;
    const dataCid = extractCid(el.getAttribute?.('data-cid'));
    if (dataCid !== null) return dataCid;
    const href = el.getAttribute?.('href') || '';
    if (!href.includes('cid=')) return null;
    try {
      const abs = new URL(href, location.origin);
      return extractCid(abs.searchParams.get('cid')) || parseCidFromLocation(abs.href);
    } catch {
      const m = href.match(/[?&#]cid=([^&]+)/i);
      return m ? extractCid(decodeURIComponent(m[1])) : null;
    }
  }

  function parseCidFromDom() {
    // Only read breadcrumb / path box — last item is current folder.
    // Do NOT scan all page links (sidebar would pollute and often fall back to root).
    const pathBoxes = [
      '#js_top_header_file_path_box',
      '#js_file_path_box',
      '#js_path_link_box',
      '.file-path',
      '.path',
      '#main_top .file-path',
    ];
    for (const boxSel of pathBoxes) {
      const box = document.querySelector(boxSel);
      if (!box) continue;
      const nodes = box.querySelectorAll('a[href*="cid="], [data-cid]');
      let best = null;
      for (const el of nodes) {
        const c = cidFromElement(el);
        if (c !== null) best = c;
      }
      if (best !== null) return best;
    }
    return null;
  }

  /** @returns {string|null} null = unknown (do not overwrite a good stored cid with 0) */
  function readCidFromPage() {
    return parseCidFromLocation() ?? parseCidFromDom();
  }

  function notifyCid(cid, force = false) {
    if (!isAlive()) {
      teardown();
      return;
    }
    const next = String(cid ?? '0');
    if (!force && next === lastCid) return;
    lastCid = next;
    sendRuntime({ type: 'SET_CID', payload: { cid: next } });
  }

  function syncCid(force = false) {
    const cid = readCidFromPage();
    // Unknown page location → keep last good cid; never push fake root "0"
    if (cid == null) return;
    notifyCid(cid, force);
  }

  function openPanel() {
    if (!isAlive()) {
      teardown();
      return;
    }
    const cid = readCidFromPage() ?? lastCid;
    if (cid != null) notifyCid(cid, true);
    sendRuntime({ type: 'OPEN_SIDEPANEL', payload: { cid: cid ?? undefined } }, () => {
      void chrome.runtime?.lastError;
    });
  }

  function makeButton(id, text) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    });
    return btn;
  }

  function findToolbar() {
    const selectors = [
      '#js_top_header_file_path_box',
      '#js_top_panel_box',
      '#js_file_path_box',
      '.top-header',
      '.header-wrap',
      '.list-top-header',
      '.file-path',
      '#main_top',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function ensureUi() {
    if (!isAlive()) {
      teardown();
      return;
    }
    let fab = document.getElementById(FAB_ID);
    if (!fab) {
      fab = makeButton(FAB_ID, '媒体整理');
      document.documentElement.appendChild(fab);
    }

    const toolbar = findToolbar();
    if (toolbar) {
      fab.classList.remove('visible');
      if (!document.getElementById(BTN_ID)) {
        toolbar.appendChild(makeButton(BTN_ID, '媒体整理'));
      }
    } else {
      fab.classList.add('visible');
    }
  }

  function onUrlMaybeChanged() {
    if (!isAlive()) {
      teardown();
      return;
    }
    if (location.href === lastHref) return;
    lastHref = location.href;
    syncCid(true);
  }

  // 115 uses History API with ?cid=..., not only hashchange
  const wrapHistory = (method) => {
    const original = history[method];
    if (typeof original !== 'function') return;
    history[method] = function (...args) {
      const ret = original.apply(this, args);
      queueMicrotask(onUrlMaybeChanged);
      return ret;
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');

  window.addEventListener('hashchange', () => {
    if (!isAlive()) {
      teardown();
      return;
    }
    syncCid(true);
  });
  window.addEventListener('popstate', () => {
    if (!isAlive()) {
      teardown();
      return;
    }
    lastHref = location.href;
    syncCid(true);
  });

  // respond when sidepanel/background asks for fresh cid
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isAlive()) {
        teardown();
        return false;
      }
      if (message?.type === 'REQUEST_CID') {
        const cid = readCidFromPage();
        if (cid != null) {
          notifyCid(cid, true);
          sendResponse({ ok: true, cid });
        } else {
          // Unknown — let background keep previous storage cid
          sendResponse({ ok: false, cid: null, reason: 'unresolved' });
        }
        return true;
      }
      return false;
    });
  } catch {
    teardown();
  }

  pollTimer = setInterval(() => {
    if (!isAlive()) {
      teardown();
      return;
    }
    onUrlMaybeChanged();
    syncCid(false);
    ensureUi();
  }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!isAlive()) {
        teardown();
        return;
      }
      ensureUi();
      syncCid(true);
    });
  } else {
    ensureUi();
    syncCid(true);
  }
})();
