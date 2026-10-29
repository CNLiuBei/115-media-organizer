import { DEFAULT_SETTINGS, FOLDER_LAYOUTS, STORAGE_KEYS } from '../lib/types.js';

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
  const key = document.getElementById('folderLayout').value || 'standard';
  const layout = FOLDER_LAYOUTS[key] || FOLDER_LAYOUTS.standard;
  document.getElementById('folderLayoutHint').textContent = layout.desc || '';
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
      el.value = FOLDER_LAYOUTS[settings.folderLayout] ? settings.folderLayout : 'standard';
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
  data.folderLayout = document.getElementById('folderLayout').value || 'standard';
  data.targetMode = document.getElementById('targetMode').value === 'cid' ? 'cid' : 'scan';
  return data;
}

async function load() {
  fillFolderLayoutSelect();
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  fill({ ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) });
}

document.getElementById('folderLayout').addEventListener('change', updateFolderLayoutHint);

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  const prev = stored[STORAGE_KEYS.settings] || {};
  // Preserve sidepanel-selected targetCid / targetCidName
  const settings = read(prev);
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
  const msg = document.getElementById('msg');
  msg.textContent = '已保存';
  msg.className = 'msg ok';
});

document.getElementById('btnReset').addEventListener('click', async () => {
  fill(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
  const msg = document.getElementById('msg');
  msg.textContent = '已恢复默认并保存';
  msg.className = 'msg ok';
});

load();
