import { DEFAULT_SETTINGS, FOLDER_LAYOUTS, STORAGE_KEYS, cmpVersion, resolveLayoutKey } from '../lib/types.js';
import { buildLayoutTreePreview } from '../lib/folderOptions.js';

const fields = [
  'tmdbApiKey',
  'minSizeMB',
  'requestDelayMs',
  'targetBasePath',
  'tvPathTemplate',
  'tvNameTemplate',
  'moviePathTemplate',
  'movieNameTemplate',
  'unknownPathTemplate',
  'unknownNameTemplate',
  'updateCheckUrl',
];

const checks = [
  'enableMetadata',
  'preferDouban',
  'includeVideo',
  'includeAudio',
  'includeSubtitle',
  'includeImage',
  'skipJunkMedia',
  'skipCalibrateOrganized',
  'moveFiles',
  'cleanEmptyFolders',
];

const selects = ['folderLayout', 'targetMode'];

const form = document.getElementById('form');
const msgEl = document.getElementById('msg');
let dirty = false;

function setMsg(text, kind = '') {
  msgEl.textContent = text;
  msgEl.className = `msg${kind ? ` ${kind}` : ''}`;
}

function markDirty() {
  if (dirty) return;
  dirty = true;
  setMsg('有未保存的更改', 'warn');
}

function markClean(text = '已保存') {
  dirty = false;
  setMsg(text, 'ok');
}

function fillFolderLayoutSelect() {
  const sel = document.getElementById('folderLayout');
  sel.innerHTML = '';
  for (const [key, layout] of Object.entries(FOLDER_LAYOUTS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = layout.label;
    sel.appendChild(opt);
  }
}

function updateFolderLayoutHint() {
  const key = resolveLayoutKey(document.getElementById('folderLayout').value);
  const layout = FOLDER_LAYOUTS[key] || FOLDER_LAYOUTS.emby;
  document.getElementById('folderLayoutHint').textContent = layout.desc || '';
  const custom = key === 'custom';
  const sections = document.getElementById('templateSections');
  if (sections) sections.hidden = !custom;
  const tree = document.getElementById('folderLayoutTree');
  if (tree) tree.textContent = buildLayoutTreePreview(read());
}

function fill(settings) {
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el) el.value = settings[key] ?? '';
  }
  for (const key of checks) {
    const el = document.getElementById(key);
    if (el) el.checked = !!settings[key];
  }
  for (const key of selects) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (key === 'folderLayout') {
      el.value = resolveLayoutKey(settings.folderLayout);
    } else if (key === 'targetMode') {
      el.value = settings.targetMode === 'cid' ? 'cid' : 'scan';
    }
  }
  updateFolderLayoutHint();
}

function read(base = {}) {
  const data = { ...DEFAULT_SETTINGS, ...base };
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.type === 'number') data[key] = Number(el.value);
    else data[key] = el.value;
  }
  for (const key of checks) {
    const el = document.getElementById(key);
    if (el) data[key] = el.checked;
  }
  data.folderLayout = resolveLayoutKey(document.getElementById('folderLayout').value);
  data.targetMode = document.getElementById('targetMode').value === 'cid' ? 'cid' : 'scan';
  return data;
}

async function load() {
  fillFolderLayoutSelect();
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  fill({ ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) });
}

document.getElementById('folderLayout').addEventListener('change', updateFolderLayoutHint);

form.addEventListener('input', markDirty);
form.addEventListener('change', markDirty);

for (const id of [
  'tvPathTemplate', 'tvNameTemplate',
  'moviePathTemplate', 'movieNameTemplate',
  'unknownPathTemplate', 'unknownNameTemplate',
  'targetBasePath',
]) {
  document.getElementById(id)?.addEventListener('input', updateFolderLayoutHint);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = form.querySelector('button[type="submit"]');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
    const prev = stored[STORAGE_KEYS.settings] || {};
    // Preserve sidepanel-selected targetCid / targetCidName
    const settings = read(prev);
    await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
    markClean('已保存');
  } catch (err) {
    setMsg(`保存失败：${err.message || err}`, 'warn');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
});

document.getElementById('btnReset').addEventListener('click', async () => {
  if (!confirm('恢复默认设置并立即保存？当前自定义目录模板会被覆盖。')) return;
  fill(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
  markClean('已恢复默认并保存');
});

document.getElementById('btnOpenSidePanel')?.addEventListener('click', async () => {
  try {
    if (!chrome.sidePanel?.open) throw new Error('当前 Chrome 不支持');
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
    setMsg('已打开侧边栏', 'ok');
  } catch {
    setMsg('无法直接打开：请点浏览器工具栏的扩展图标', 'warn');
  }
});

document.getElementById('btnCheckUpdate')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnCheckUpdate');
  const url = String(document.getElementById('updateCheckUrl').value || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    setMsg('请先填写版本信息地址（update.json 的 Raw 地址）', 'warn');
    return;
  }
  if (btn) btn.disabled = true;
  setMsg('正在检查更新…');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const remote = String(info?.version || '').trim();
    if (!remote) throw new Error('返回的 JSON 缺少 version 字段');
    const local = chrome.runtime.getManifest().version;
    if (cmpVersion(remote, local) > 0) {
      setMsg(`发现新版本 v${remote}（当前 v${local}）。请到发布页下载并重启浏览器。`, 'warn');
    } else {
      setMsg(`已是最新版本 v${local}`, 'ok');
    }
  } catch (err) {
    if (err?.name === 'AbortError') setMsg('检查失败：请求超时', 'warn');
    else setMsg(`检查失败：${err.message || err}`, 'warn');
  } finally {
    if (btn) btn.disabled = false;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

load();
