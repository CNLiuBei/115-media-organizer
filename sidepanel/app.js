import { DEFAULT_SETTINGS, FOLDER_LAYOUTS, STORAGE_KEYS, cmpVersion, resolveLayoutKey } from '../lib/types.js';
import {
  buildPreviewRows,
  summarizeRows,
  executeOrganize,
  refreshOrganizeStatus,
  findDuplicateEpisodes,
  findEpisodeGaps,
  findDestinationCollisions,
  sortRowsByEpisode,
} from '../lib/organizer.js';
import { createApi115 } from '../lib/api115.js';
import {
  calibrateTitles,
  calibrationKey,
  seriesQueryTitle,
  primeTmdbDetailCache,
  exportTmdbDetailCache,
  fetchTmdbById,
  TMDB_DETAIL_STORAGE_KEY,
} from '../lib/metadata.js';
import { summarizeFilter } from '../lib/filter.js';
import { buildRenamePlan } from '../lib/rename.js';
import { resolveOrganizeSettings } from '../lib/settings.js';
import { resolveTargetRootCid, buildLayoutTreePreview } from '../lib/folderOptions.js';
import { cleanFoldersWithoutVideo } from '../lib/cleanup.js';
import { REGION_FOLDERS, detectRegion } from '../lib/region.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: { ...DEFAULT_SETTINGS },
  rows: [],
  rootCid: '0',
  running: false,
  scanning: false,
  scanAbort: null,
  autoCid: '0',
  cidDirty: false,
  picker: {
    cid: '0',
    parentCid: '0',
    path: [{ cid: '0', name: '根目录' }],
    folders: [],
  },
  /** groupKey → collapsed */
  groupCollapsed: new Map(),
  /** Filter text for preview table */
  tableFilter: '',
  /** View chip: all | need | done | low | conflict */
  viewFilter: 'all',
  organizeAbort: null,
  cleanupAbort: null,
  /** Last organize failed ids for retry */
  lastFailedIds: [],
  /** Last finished scan stats, used for empty-state copy */
  lastScan: null,
  /** cid → folder name */
  cidNames: new Map(),
};

const UI_PREFS_KEY = 'sidepanelUiPrefs';

const api = createApi115(async (url, init) => fetch(url, init));

const MAX_LOG_LINES = 300;

function log(msg, level = 'info') {
  const el = $('log');
  const ts = new Date().toLocaleTimeString();
  const prefix = level === 'error' ? '✗' : level === 'ok' ? '✓' : '·';
  el.textContent += `[${ts}] ${prefix} ${msg}\n`;
  const lines = el.textContent.split('\n');
  if (lines.length > MAX_LOG_LINES) {
    el.textContent = lines.slice(-MAX_LOG_LINES).join('\n');
  }
  el.scrollTop = el.scrollHeight;
}

function setStatus(text) {
  $('statusLine').textContent = text;
}

/* ---------- Progress bar ----------
 * One place for show / percent / indeterminate / auto-hide.
 * - pct only ever moves forward: phase estimates (mkdir → rename → move) overlap.
 * - indeterminate: tree scan has no known total, so slide a segment instead of
 *   parking the bar at a misleading 100%.
 * - finish with hideProgress(delay) so a completed run does not stay pinned at 100%.
 */
const progressView = { hideTimer: null, pct: 0, indeterminate: false };

function setProgress({ text = null, pct = null, indeterminate, reset = false } = {}) {
  const box = $('progress');
  const bar = $('progressBar');
  const fill = $('barFill');
  if (!box || !bar || !fill) return;

  clearTimeout(progressView.hideTimer);
  progressView.hideTimer = null;
  box.hidden = false;
  document.body.classList.add('has-progress');

  if (reset) {
    progressView.pct = 0;
    progressView.indeterminate = false;
    bar.classList.remove('is-indeterminate');
    fill.style.width = '0%';
    const pctEl = $('progressPct');
    if (pctEl) pctEl.textContent = '0%';
  }

  // indeterminate is tri-state: true = enter slide mode, false = leave it,
  // undefined = keep the current mode (text-only updates must not flip it).
  if (indeterminate === true) {
    progressView.indeterminate = true;
    bar.classList.add('is-indeterminate');
    const pctEl = $('progressPct');
    if (pctEl) pctEl.textContent = '处理中';
  } else {
    if (indeterminate === false || pct != null) {
      progressView.indeterminate = false;
      bar.classList.remove('is-indeterminate');
    }
    if (pct != null) {
      const next = Math.max(progressView.pct, Math.min(100, Math.round(Number(pct) || 0)));
      progressView.pct = next;
      fill.style.width = `${next}%`;
      const pctEl = $('progressPct');
      if (pctEl) pctEl.textContent = `${next}%`;
    }
  }

  if (text != null) $('progressText').textContent = text;
}

/** Hide the bar now, or keep the final state visible for `delay` ms. */
function hideProgress(delay = 0) {
  clearTimeout(progressView.hideTimer);
  progressView.hideTimer = null;
  const hide = () => {
    $('progress').hidden = true;
    document.body.classList.remove('has-progress');
    progressView.hideTimer = null;
  };
  if (delay > 0) progressView.hideTimer = setTimeout(hide, delay);
  else hide();
}

const PROGRESS_HOLD_MS = 2600;

/** Map a 0..1 fraction onto a [from, to] slice of the overall bar. */
function fracPct(from, to, frac) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return from + f * (to - from);
}

async function send(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (!res?.ok) throw new Error(res?.error || '消息失败');
  return res.result;
}

async function saveSettings(partial = {}) {
  state.settings = { ...state.settings, ...partial };
  try {
    await send('SAVE_SETTINGS', state.settings);
  } catch {
    await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: state.settings });
  }
}

function fillFolderLayoutSelect() {
  const sel = $('folderLayout');
  const current = resolveLayoutKey(sel.value || state.settings.folderLayout || 'emby');
  sel.innerHTML = '';
  for (const [key, layout] of Object.entries(FOLDER_LAYOUTS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = layout.label;
    sel.appendChild(opt);
  }
  sel.value = FOLDER_LAYOUTS[current] ? current : 'emby';
}

function formatTargetLabel(name, cid) {
  const n = (name || '').trim() || (cid === '0' ? '根目录' : `目录 ${cid}`);
  return n;
}

/** 115 destination folder shown in preview; not part of create/move segments. */
function targetRootLabel() {
  if (!$('moveFiles')?.checked) return '';
  const mode = $('targetMode')?.value === 'cid' ? 'cid' : 'scan';
  if (mode === 'cid') {
    const cid = $('targetCid')?.value.trim() || '0';
    return formatTargetLabel(state.settings.targetCidName, cid);
  }
  const cid = $('cidInput')?.value.trim() || state.rootCid || '0';
  if (isDriveRootCid(cid)) return '根目录';
  return cidDisplayName(cid) || '扫描目录';
}

function fullPlanPath(rel) {
  const root = targetRootLabel();
  const path = String(rel || '').replace(/^\/+|\/+$/g, '');
  if (!root) return path;
  return path ? `${root}/${path}` : root;
}

function fullPlanFilePath(row) {
  const dir = fullPlanPath(row?.pathDisplay);
  const name = row?.newName || '';
  if (!dir) return name;
  return name ? `${dir}/${name}` : dir;
}

function planPathPrefixHtml() {
  const root = targetRootLabel();
  if (!root) return '';
  return `<span class="plan-root" title="目标目录：${escapeAttr(root)}">${escapeHtml(root)}/</span>`;
}

function updateTargetCidLabel() {
  const cid = $('targetCid').value.trim() || '0';
  const name = state.settings.targetCidName || (cid === '0' ? '根目录' : `目录 ${cid}`);
  const label = formatTargetLabel(name, cid);
  const el = $('targetCidLabel');
  el.textContent = label;
  el.title = `${label} · cid=${cid}`;
}

function hasTmdbKey() {
  return !!String(state.settings.tmdbApiKey || '').trim();
}

function updateMetaHint() {
  // Key optional: without it we still use www.themoviedb.org HTML search
  const show = $('enableMeta').checked && !hasTmdbKey();
  $('metaHint').hidden = !show;
}

function applyOrganizeUiFromSettings() {
  const s = state.settings;
  $('enableMeta').checked = s.enableMetadata !== false;
  $('scanRecursive').checked = s.scanRecursive !== false;
  $('skipCalibrateOrganized').checked = s.skipCalibrateOrganized !== false;
  $('moveFiles').checked = s.moveFiles !== false;
  $('cleanEmptyFolders').checked = s.cleanEmptyFolders !== false;
  $('folderLayout').value = resolveLayoutKey(s.folderLayout);
  $('targetMode').value = s.targetMode === 'cid' ? 'cid' : 'scan';
  $('targetCid').value = s.targetCid != null ? String(s.targetCid) : '0';
  $('targetBasePath').value = s.targetBasePath || '';
  updateFolderLayoutHint();
  updateTargetModeUi();
  updateOrganizeBoxEnabled();
  updateTargetCidLabel();
  updateMetaHint();
}

async function loadRecentCids() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.recentCids);
    renderRecentCids(data[STORAGE_KEYS.recentCids] || []);
  } catch {
    renderRecentCids([]);
  }
}

function renderRecentCids(list = []) {
  const sel = $('recentCid');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">最近…</option>';
  for (const item of list) {
    if (!item?.cid) continue;
    const cid = String(item.cid);
    if (item.name) rememberCidName(cid, item.name);
    const name = cidDisplayName(cid) || item.name;
    const opt = document.createElement('option');
    opt.value = cid;
    opt.textContent = name && name !== cid ? name : `cid=${cid}`;
    opt.title = `cid=${cid}`;
    sel.appendChild(opt);
  }
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  renderCidName();
}

async function pushRecentCid(cid, name = '') {
  const value = String(cid || '0');
  if (!value || value === '0') return;
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.recentCids);
    let list = Array.isArray(data[STORAGE_KEYS.recentCids]) ? data[STORAGE_KEYS.recentCids] : [];
    list = [
      { cid: value, name: name || `目录 ${value}`, at: Date.now() },
      ...list.filter((x) => String(x.cid) !== value),
    ].slice(0, 8);
    await chrome.storage.local.set({ [STORAGE_KEYS.recentCids]: list });
    renderRecentCids(list);
  } catch {
    /* ignore */
  }
}

function updateFolderLayoutHint() {
  const key = resolveLayoutKey($('folderLayout').value);
  const layout = FOLDER_LAYOUTS[key] || FOLDER_LAYOUTS.emby;
  $('folderLayoutHint').textContent = layout.desc || '';
  const treeEl = $('folderLayoutTree');
  if (treeEl) treeEl.textContent = buildLayoutTreePreview(currentOrganizeSettings());
}

function updateTargetModeUi() {
  const isCid = $('targetMode').value === 'cid';
  $('targetCidField').hidden = !isCid;
}

function updateOrganizeBoxEnabled() {
  const enabled = $('moveFiles').checked;
  const box = $('organizeBox');
  box.classList.toggle('is-disabled', !enabled);
  box.toggleAttribute('inert', !enabled);
  if (!enabled) box.open = false;
}

/** Settings used for path/name planning (layout + base path + move flag). */
function currentOrganizeSettings() {
  return resolveOrganizeSettings({
    ...state.settings,
    enableMetadata: $('enableMeta').checked,
    moveFiles: $('moveFiles').checked,
    folderLayout: resolveLayoutKey($('folderLayout').value),
    targetMode: $('targetMode').value === 'cid' ? 'cid' : 'scan',
    targetCid: $('targetCid').value.trim() || '0',
    targetCidName: state.settings.targetCidName || '',
    targetBasePath: $('targetBasePath').value.trim(),
  });
}

function readOrganizeFields() {
  return {
    moveFiles: $('moveFiles').checked,
    cleanEmptyFolders: $('cleanEmptyFolders').checked,
    scanRecursive: $('scanRecursive').checked,
    folderLayout: resolveLayoutKey($('folderLayout').value),
    targetMode: $('targetMode').value === 'cid' ? 'cid' : 'scan',
    targetCid: $('targetCid').value.trim() || '0',
    targetCidName: state.settings.targetCidName || '',
    targetBasePath: $('targetBasePath').value.trim(),
  };
}

function rememberCidName(cid, name) {
  const value = String(cid || '').trim();
  const label = String(name || '').trim();
  if (!value || value === '0' || !label || label === value) return;
  if (/^目录 /.test(label) || label === '当前 115 目录' || label === '当前扫描目录') return;
  state.cidNames.set(value, label);
}

function cidDisplayName(cid) {
  const value = String(cid || '0').trim() || '0';
  if (value === '0') return '网盘根目录';
  return state.cidNames.get(value) || '';
}

function renderCidName() {
  const cid = $('cidInput')?.value.trim() || '0';
  const name = cidDisplayName(cid);
  const label = $('cidFieldLabel');
  if (label) label.textContent = name ? `扫描目录 · ${name}` : '扫描目录';
  const input = $('cidInput');
  if (input) {
    input.title = name
      ? `${name} · cid=${cid}`
      : `目录 CID，不能为 0（网盘根目录）`;
  }
}

async function fetchCidName(cid) {
  const value = String(cid || '0').trim() || '0';
  if (value === '0') {
    renderCidName();
    return '网盘根目录';
  }
  const cached = cidDisplayName(value);
  if (cached) {
    renderCidName();
    return cached;
  }
  try {
    const info = await api.getFolderInfo(value);
    const parts = (info.path || []).filter((p) => String(p.cid) !== '0');
    const name = (parts.length ? parts[parts.length - 1].name : info.name) || '';
    if (name && name !== '根目录') rememberCidName(value, name);
  } catch {
    /* ignore */
  }
  renderCidName();
  return cidDisplayName(value);
}

function syncBusyLayout() {
  const busy = !!(state.scanning || state.running);
  document.body.classList.toggle('is-busy', busy);
  setBusyControls(busy);
}

const BUSY_CONTROL_IDS = [
  'cidInput', 'btnRefreshCid', 'recentCid',
  'scanRecursive', 'enableMeta', 'skipCalibrateOrganized', 'moveFiles', 'cleanEmptyFolders',
  'folderLayout', 'targetMode', 'targetCid', 'btnPickTarget', 'btnUseScanAsTarget', 'targetBasePath',
  'checkAllVisible',
];

/** Lock directory/target/selection edits while scanning or organizing. */
function setBusyControls(busy) {
  for (const id of BUSY_CONTROL_IDS) {
    const el = $(id);
    if (el) el.disabled = !!busy;
  }
  const tbody = $('tbody');
  if (tbody) tbody.inert = !!busy;
  const tools = $('toolsPanel');
  if (tools) tools.inert = !!busy;
}

function syncResultsLayout() {
  const has = state.rows.length > 0;
  const was = document.body.classList.contains('has-results');
  document.body.classList.toggle('has-results', has);
  const opts = $('scanOptions');
  if (opts) {
    if (has && !was) opts.open = false;
    if (!has && !state.scanning) opts.open = true;
  }
  $('btnScan')?.classList.toggle('primary', !has || state.scanning);
  renderCidName();
}

function rebuildPlans() {
  const settings = currentOrganizeSettings();
  for (const row of state.rows) {
    if (row.companionOf) continue;
    const plan = buildRenamePlan(row.parsed, settings);
    row.newName = plan.newName;
    row.pathSegments = plan.pathSegments;
    row.pathDisplay = plan.pathDisplay;
    row.kind = plan.kind;
  }
  const byId = new Map(state.rows.filter((r) => !r.companionOf).map((r) => [r.id, r]));
  for (const row of state.rows.filter((r) => r.companionOf)) {
    const parent = byId.get(row.companionOf);
    if (!parent) continue;
    const ext = row.originalName.includes('.')
      ? row.originalName.slice(row.originalName.lastIndexOf('.'))
      : '';
    const parentBase = parent.newName.includes('.')
      ? parent.newName.slice(0, parent.newName.lastIndexOf('.'))
      : parent.newName;
    const stem = row.originalName.includes('.')
      ? row.originalName.slice(0, row.originalName.lastIndexOf('.'))
      : row.originalName;
    const lang = stem.match(/\.(zh|zh-cn|zh-hans|zh-hant|chs|cht|en|eng|jp|jpn|sc|tc|und)$/i)?.[0] || '';
    row.newName = `${parentBase}${lang}${ext}`;
    row.pathSegments = [...parent.pathSegments];
    row.pathDisplay = parent.pathDisplay;
    row.kind = parent.kind;
  }
  refreshOrganizeStatus(state.rows, { sameRoot: targetRootMatchesScan() });
  if (state.rows.length) renderTable();
}

function isLowConfidence(row) {
  if (!row || row.companionOf) return false;
  if (row.kind === 'unknown') return true;
  if (!row.parsed?.metaSource) return true;
  const score = Number(row.parsed?.metaScore);
  if (Number.isFinite(score) && score < 0.72) return true;
  return false;
}

async function hydrateTmdbCache() {
  try {
    const data = await chrome.storage.local.get(TMDB_DETAIL_STORAGE_KEY);
    primeTmdbDetailCache(data[TMDB_DETAIL_STORAGE_KEY] || {});
  } catch {
    /* ignore */
  }
}

async function persistTmdbCache() {
  try {
    await chrome.storage.local.set({
      [TMDB_DETAIL_STORAGE_KEY]: exportTmdbDetailCache({ max: 400 }),
    });
  } catch {
    /* ignore */
  }
}

async function loadSettings() {
  try {
    state.settings = await send('GET_SETTINGS');
  } catch {
    const data = await chrome.storage.sync.get(STORAGE_KEYS.settings);
    state.settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
  }
  fillFolderLayoutSelect();
  applyOrganizeUiFromSettings();
}

async function loadCid({ quiet = false, force = false } = {}) {
  // Never let a refresh overwrite the working directory mid-scan/organize
  if (state.running || state.scanning) return null;
  try {
    const result = await send('REFRESH_CID').catch(() => send('GET_CID'));
    const cid = result?.cid != null && result.cid !== '' ? String(result.cid) : null;
    if (cid == null) {
      if (!quiet) setStatus('未能读取 115 当前目录，请确认已打开网盘页面或手动填写 CID');
      updateCidRootWarning();
      return null;
    }
    state.autoCid = cid;
    if (force || !state.cidDirty) {
      $('cidInput').value = cid;
      state.rootCid = cid;
      if (force) state.cidDirty = false;
    }
    const shown = $('cidInput').value.trim() || cid;
    if (shown && shown !== '0' && !state.cidNames.has(shown)) fetchCidName(shown);
    else renderCidName();
    if (!quiet) {
      const name = cidDisplayName(shown);
      setStatus(
        isDriveRootCid(cid)
          ? '已同步到网盘根目录，已禁止扫描。请进入具体文件夹后再点同步'
          : `已同步 ${name || `cid=${shown}`}`,
      );
    }
    updateCidRootWarning();
    return cid;
  } catch {
    /* ignore */
  }
  updateCidRootWarning();
  return null;
}

function isDriveRootCid(cid) {
  const v = String(cid ?? '').trim();
  return !v || v === '0';
}

function isCidValue(cid) {
  return /^\d+$/.test(String(cid ?? '').trim());
}

/** requestDelayMs: treat 0 as "no delay" instead of falling back to a default. */
function requestDelay(fallback) {
  const n = Number(state.settings.requestDelayMs);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/** Whether the resolved target root is the same folder as the scan root. */
function targetRootMatchesScan() {
  if ($('targetMode')?.value !== 'cid') return true;
  const target = String($('targetCid')?.value.trim() || '0');
  const scan = String($('cidInput')?.value.trim() || state.rootCid || '0');
  return isCidValue(target) && target === scan;
}

function updateScanButtonState() {
  const cid = $('cidInput')?.value.trim();
  const invalid = !isCidValue(cid);
  if ($('btnScan')) {
    $('btnScan').disabled = state.scanning || state.running || isDriveRootCid(cid) || invalid;
  }
}

function updateCidRootWarning() {
  const el = $('cidRootWarn');
  const root = isDriveRootCid($('cidInput')?.value);
  if (el) el.hidden = !root;
  updateScanButtonState();
}

function formatSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function selectedSizeLabel(rows = state.rows) {
  let total = 0;
  let count = 0;
  for (const r of rows) {
    if (!r.selected || r.companionOf) continue;
    total += Number(r.size) || 0;
    count += 1;
  }
  return count ? `${formatSize(total)}` : '';
}

function selectByKind(kind) {
  const companions = companionIndex();
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = !row.alreadyOrganized && (row.kind === kind || row.parsed?.kind === kind);
    for (const c of companions.get(row.id) || []) {
      c.selected = row.selected;
    }
  }
  refreshSelectionUi();
}

function parseLabel(parsed) {
  if (!parsed) return '-';
  let base;
  if (parsed.kind === 'tv') {
    if (parsed.airDate && parsed._fromAirDate) {
      const region = parsed.region ? ` · ${parsed.region}` : '';
      base = `${parsed.title} ${parsed.airDate}${region}`;
    } else {
    const s = String(parsed.season ?? 1).padStart(2, '0');
    const e = String(parsed.episode ?? 0).padStart(2, '0');
      const e2 = parsed.episodeEnd != null && Number(parsed.episodeEnd) > Number(parsed.episode || 0)
        ? `-E${String(parsed.episodeEnd).padStart(2, '0')}`
        : '';
      const region = parsed.region ? ` · ${parsed.region}` : '';
      base = `${parsed.title} S${s}E${e}${e2}${region}`;
    }
  } else if (parsed.kind === 'movie') {
    base = `${parsed.title}${parsed.year ? ` (${parsed.year})` : ''}`;
  } else {
    base = parsed.title || '-';
  }
  return base;
}

function calibrationHint(parsed) {
  if (!parsed?.metaSource) return '';
  const score = parsed.metaScore != null ? Number(parsed.metaScore).toFixed(2) : '';
  const from = parsed.localTitle && parsed.localTitle !== parsed.title
    ? `${parsed.localTitle}→`
    : '';
  return ` · <span class="calib-hint">${escapeHtml(from)}${escapeHtml(parsed.metaSource)}${score ? ` ${score}` : ''}</span>`;
}

function groupKeyForRow(row) {
  if (row.companionOf) return `companion:${row.companionOf}`;
  if (row.parsed?.kind === 'tv') return calibrationKey(row.parsed);
  // Movies: one group per file (or same title+year)
  return calibrationKey(row.parsed) || `file:${row.id}`;
}

function buildRowGroups() {
  /** @type {Map<string, { key: string, rows: object[], primary: object }>} */
  const map = new Map();
  const byId = new Map(state.rows.map((row) => [row.id, row]));
  const companions = [];
  for (const row of state.rows) {
    if (row.companionOf) {
      companions.push(row);
      continue;
    }
    const key = groupKeyForRow(row);
    if (!map.has(key)) map.set(key, { key, rows: [], primary: row });
    map.get(key).rows.push(row);
  }
  // Attach companions after their parent episode inside the same series group
  for (const c of companions) {
    const parent = byId.get(c.companionOf);
    const key = parent ? groupKeyForRow(parent) : groupKeyForRow(c);
    if (!map.has(key)) map.set(key, { key, rows: [], primary: c });
    map.get(key).rows.push(c);
  }
  return [...map.values()];
}

function episodeRangeLabel(rows) {
  const eps = rows
    .filter((r) => !r.companionOf && r.parsed?.kind === 'tv')
    .map((r) => ({ s: r.parsed.season ?? 1, e: r.parsed.episode ?? 0 }))
    .filter((x) => x.e > 0)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  if (!eps.length) return '';
  const seasons = [...new Set(eps.map((x) => x.s))];
  if (seasons.length === 1) {
    const list = eps.map((x) => x.e);
    const min = Math.min(...list);
    const max = Math.max(...list);
    return list.length === 1
      ? `S${String(eps[0].s).padStart(2, '0')}E${String(min).padStart(2, '0')}`
      : `S${String(eps[0].s).padStart(2, '0')}E${String(min).padStart(2, '0')}–E${String(max).padStart(2, '0')} · ${list.length} 集`;
  }
  return `${eps.length} 集 · ${seasons.length} 季`;
}

function posterZoomUrl(url) {
  const s = String(url || '');
  if (!s) return '';
  return s.replace(/\/t\/p\/w\d+(?:_and_h\d+_face)?/, '/t/p/w342');
}

function posterHtml(url, title, { tmdbId, kind } = {}) {
  if (!url) return '<div class="poster poster-empty" title="无海报"></div>';
  const zoom = posterZoomUrl(url);
  const img = `<img class="poster" src="${escapeAttr(url)}" data-zoom="${escapeAttr(zoom)}" alt="${escapeAttr(title || '')}" loading="lazy" referrerpolicy="no-referrer" />`;
  const tid = String(tmdbId || '').trim();
  const inner = /^\d+$/.test(tid)
    ? `<a class="poster-link" href="${escapeAttr(`https://www.themoviedb.org/${kind === 'movie' ? 'movie' : 'tv'}/${tid}`)}" target="_blank" rel="noopener noreferrer" title="悬停放大 · 点击打开 TMDB">${img}</a>`
    : img;
  return `<div class="poster-wrap">${inner}</div>`;
}

let posterZoomTimer = 0;
let posterZoomImg = null;

function hidePosterZoom() {
  clearTimeout(posterZoomTimer);
  posterZoomTimer = 0;
  posterZoomImg = null;
  const el = $('posterZoom');
  if (!el) return;
  el.hidden = true;
  el.removeAttribute('src');
}

function placePosterZoom(img) {
  const el = $('posterZoom');
  if (!el || el.hidden) return;
  const r = img.getBoundingClientRect();
  const pad = 8;
  const w = el.offsetWidth || 160;
  const h = el.offsetHeight || 240;
  let left = r.right + pad;
  let top = r.top;
  if (left + w > window.innerWidth - pad) left = Math.max(pad, r.left - w - pad);
  if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
  if (top < pad) top = pad;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function showPosterZoom(img) {
  const url = img?.dataset?.zoom || img?.currentSrc || img?.src;
  const el = $('posterZoom');
  if (!url || !el) return;
  posterZoomImg = img;
  el.alt = img.alt || '';
  const onReady = () => {
    if (posterZoomImg !== img) return;
    el.hidden = false;
    placePosterZoom(img);
  };
  if (el.src === url && el.complete && el.naturalWidth) {
    onReady();
    return;
  }
  el.onload = onReady;
  el.src = url;
  if (el.complete && el.naturalWidth) onReady();
}

function groupMatchesFilter(group, q) {
  if (!q) return true;
  const blob = group.rows.map((r) => [
    r.originalName,
    r.newName,
    r.pathDisplay,
    r.parsed?.title,
    r.parsed?.pathTitle,
    r.parsed?.tmdbId,
    r.item?._relPath,
  ].join(' ')).join(' ').toLowerCase();
  return blob.includes(q);
}

function groupMatchesView(group, view, collideIds) {
  const videos = group.rows.filter((r) => !r.companionOf);
  if (!videos.length) return view === 'all';
  if (view === 'all') return true;
  if (view === 'need') return videos.some((r) => !r.alreadyOrganized);
  if (view === 'done') return videos.every((r) => r.alreadyOrganized);
  if (view === 'low') return videos.some((r) => isLowConfidence(r));
  if (view === 'conflict') return videos.some((r) => collideIds.has(r.id));
  return true;
}

function countVideosInGroups(groups) {
  let n = 0;
  for (const g of groups || []) n += g.rows.filter((r) => !r.companionOf).length;
  return n;
}

/** Shared list filter context for table + chips + select-visible. */
function getListContext() {
  const groups = buildRowGroups();
  const collisions = findDestinationCollisions(state.rows);
  const collideIds = new Set(collisions.flatMap((c) => c.ids));
  const filterQ = String(state.tableFilter || '').trim().toLowerCase();
  const view = state.viewFilter || 'all';
  const textMatched = filterQ ? groups.filter((g) => groupMatchesFilter(g, filterQ)) : groups;
  const visibleGroups = textMatched.filter((g) => groupMatchesView(g, view, collideIds));
  return { groups, collisions, collideIds, filterQ, view, textMatched, visibleGroups };
}

function setViewFilter(view, { force = false } = {}) {
  if (!view) return;
  if (!force && view === state.viewFilter) return;
  state.viewFilter = view;
  syncViewChips();
  renderTable();
}

/** After organize: jump to remaining work / conflicts, collapse finished groups. */
function afterOrganizeSmartView() {
  for (const group of buildRowGroups()) {
    const videos = group.rows.filter((r) => !r.companionOf);
    if (videos.length > 1 && videos.every((r) => r.alreadyOrganized)) {
      state.groupCollapsed.set(group.key, true);
    }
  }
  const { collisions, collideIds, textMatched } = getListContext();
  const needLeft = textMatched.some((g) => groupMatchesView(g, 'need', collideIds));
  const conflictLeft = collisions.length > 0
    && textMatched.some((g) => groupMatchesView(g, 'conflict', collideIds));
  if (conflictLeft) {
    setViewFilter('conflict', { force: true });
    log('仍有目标路径冲突，已切换到「冲突」视图', 'info');
  } else if (needLeft) {
    setViewFilter('need', { force: true });
  } else {
    // Nothing left → back to the neutral view (never park the panel on 已在位)
    setViewFilter('all');
  }
}

async function loadUiPrefs() {
  try {
    const data = await chrome.storage.local.get(UI_PREFS_KEY);
    const prefs = data[UI_PREFS_KEY] || {};
    if (prefs.organizeOpen) $('organizeBox').open = true;
    const logEl = document.querySelector('details.log');
    if (logEl && prefs.logOpen === true) logEl.open = true;
    // viewFilter is intentionally not restored: every open starts on「全部」
    if (prefs.viewFilter !== undefined) {
      const next = { ...prefs };
      delete next.viewFilter;
      await chrome.storage.local.set({ [UI_PREFS_KEY]: next });
    }
  } catch {
    /* ignore */
  }
}

async function saveUiPrefs(partial = {}) {
  try {
    const data = await chrome.storage.local.get(UI_PREFS_KEY);
    const next = { ...(data[UI_PREFS_KEY] || {}), ...partial };
    await chrome.storage.local.set({ [UI_PREFS_KEY]: next });
  } catch {
    /* ignore */
  }
}

function syncViewChips(ctx) {
  const context = ctx || (state.rows.length ? getListContext() : null);
  const textMatched = context?.textMatched || [];
  const collideIds = context?.collideIds || new Set();
  const hasRows = !!state.rows.length;
  const counts = {
    all: countVideosInGroups(textMatched),
    need: countVideosInGroups(textMatched.filter((g) => groupMatchesView(g, 'need', collideIds))),
    done: countVideosInGroups(textMatched.filter((g) => groupMatchesView(g, 'done', collideIds))),
    low: countVideosInGroups(textMatched.filter((g) => groupMatchesView(g, 'low', collideIds))),
    conflict: countVideosInGroups(textMatched.filter((g) => groupMatchesView(g, 'conflict', collideIds))),
  };
  for (const btn of document.querySelectorAll('#viewFilters .view-chip')) {
    const view = btn.dataset.view;
    const n = counts[view] ?? 0;
    btn.classList.toggle('is-active', view === state.viewFilter);
    btn.classList.toggle('is-empty', hasRows && view !== 'all' && n === 0);
    const countEl = btn.querySelector('.view-count');
    if (countEl) {
      countEl.textContent = String(n);
      countEl.hidden = !hasRows;
    }
  }
}

function applyEnrichToParsed(parsed, hit, originalName = '') {
  if (!hit || !parsed) return parsed;
  // Keep SxxExx as TV even if TMDB returned a same-name movie
  if (
    hit.kind === 'movie'
    && parsed.kind === 'tv'
    && parsed.season != null
    && parsed.episode != null
  ) {
    return parsed;
  }
  const localTitle = parsed.localTitle || parsed.title;
  const next = {
    ...parsed,
    localTitle,
    title: hit.title || parsed.title,
    year: hit.year || parsed.year,
    seriesYear: hit.year || parsed.seriesYear,
    kind: hit.kind || parsed.kind,
    metaSource: hit.source,
    metaScore: hit.score,
    tmdbId: hit.id || parsed.tmdbId,
    originalTitle: hit.originalTitle || parsed.originalTitle,
    originCountries: hit.originCountries || parsed.originCountries,
    originalLanguage: hit.originalLanguage || parsed.originalLanguage,
    isAnime: hit.isAnime || parsed.isAnime,
    posterUrl: hit.posterUrl || parsed.posterUrl,
    calibrated: hit.title && hit.title !== localTitle,
  };
  if (parsed.season != null && parsed.episode != null) next.kind = 'tv';
  if (next.kind === 'tv') {
    next.region = detectRegion({
      filename: originalName,
      title: next.title,
      relPath: next.relPath || '',
      tags: next.tags,
      originCountries: next.originCountries,
      originalLanguage: next.originalLanguage,
      isAnime: next.isAnime,
    });
  }
  return next;
}

/**
 * TMDB calibrate a subset of rows (in place) then rebuild plans.
 */
async function runCalibration(targetRows, { signal, quiet = false } = {}) {
  const settings = {
    ...currentOrganizeSettings(),
    tmdbApiKey: state.settings.tmdbApiKey || '',
    preferDouban: false,
    enableMetadata: true,
  };
  const skipDone = $('skipCalibrateOrganized')?.checked !== false
    && state.settings.skipCalibrateOrganized !== false;
  let targets = (targetRows || []).filter(
    (r) => !r.companionOf && (r.mediaType === 'video' || r.mediaType === 'audio'),
  );
  if (skipDone) {
    const before = targets.length;
    targets = targets.filter((r) => !(
      r.alreadyOrganized && /^\d+$/.test(String(r.parsed?.tmdbId || '').trim())
    ));
    const skipped = before - targets.length;
    if (skipped && !quiet) log(`跳过已在位校准 ${skipped} 项`, 'info');
  }
  if (!targets.length) {
    if (!quiet) log('无需 TMDB 查询（均已在位或无目标）', 'info');
    return { hitCount: 0, total: 0, aborted: false };
  }

  const byKey = new Map();
  for (const r of targets) {
    const key = calibrationKey(r.parsed);
    if (!byKey.has(key)) byKey.set(key, { ids: [], parsed: r.parsed });
    byKey.get(key).ids.push(r.id);
  }

  if (!quiet) {
    log(`TMDB 去重：${targets.length} 个文件 → ${byKey.size} 次查询`);
  }
  setStatus(`TMDB 校准中 · 0/${byKey.size}`);
  if (!quiet) {
    setProgress({ reset: true, pct: 0, text: `TMDB 校准 0/${byKey.size}` });
  }

  const tmdbDelay = Math.min(requestDelay(200), 250);
  const parsedList = [...byKey.values()].map((v) => v.parsed);
  const knownIds = parsedList.filter((p) => /^\d+$/.test(String(p?.tmdbId || '').trim())).length;
  if (knownIds && !quiet) log(`其中 ${knownIds} 部按 TMDB ID 拉取`);

  let aborted = false;
  const resultMap = await calibrateTitles(fetch, settings, parsedList, {
    delayMs: tmdbDelay,
    concurrency: knownIds === parsedList.length ? 4 : 3,
    signal,
    onProgress: ({ index, total, title, error, aborted: calAbort }) => {
      if (!quiet) {
        setProgress({
          pct: fracPct(0, 98, index / Math.max(1, total)),
          text: `TMDB 校准 ${index}/${total}${title ? ` · ${title}` : ''}`,
        });
      }
      if (calAbort) {
        aborted = true;
        setStatus(`TMDB 已停止 · ${index}/${total}`);
        return;
      }
      if (title) setStatus(`TMDB 校准 ${index}/${total}: ${title}`);
      if (error) log(`TMDB 失败 ${title}: ${error}`, 'error');
    },
  });
  if (signal?.aborted) aborted = true;

  let hitCount = 0;
  // Row lookup indexes: applying hits to N ids must not scan state.rows per id
  const rowById = new Map(state.rows.map((r) => [r.id, r]));
  const companionsByParent = new Map();
  for (const r of state.rows) {
    if (!r.companionOf) continue;
    const bucket = companionsByParent.get(r.companionOf);
    if (bucket) bucket.push(r);
    else companionsByParent.set(r.companionOf, [r]);
  }
  for (const [key, { ids, parsed }] of byKey) {
    const hit = resultMap.get(key);
    if (!hit) continue;
    hitCount += 1;
    const label = parsed.searchTitle || parsed.pathTitle || parsed.title;
    for (const id of ids) {
      const row = rowById.get(id);
      if (!row) continue;
      row.parsed = applyEnrichToParsed(row.parsed, hit, row.originalName);
      row.kind = row.parsed.kind;
      for (const c of companionsByParent.get(id) || []) {
        c.parsed = { ...row.parsed, ext: c.parsed?.ext };
        c.kind = row.kind;
      }
    }
    if (!quiet) {
      const via = hit.source === 'tmdb-web' ? '网页' : (hit.source || 'tmdb');
      log(
        hit.title && hit.title !== parsed.title
          ? `TMDB(${via}) ${label} → ${hit.title}${hit.year ? ` (${hit.year})` : ''}`
          : `TMDB(${via}) 确认 ${hit.title}${hit.year ? ` (${hit.year})` : ''}`,
        'ok',
      );
    }
  }

  rebuildPlans();
  await persistTmdbCache();
  log(
    aborted
      ? `TMDB 已停止：已校准 ${hitCount}/${byKey.size}`
      : `TMDB 完成：${hitCount}/${byKey.size} 命中`,
    hitCount ? 'ok' : 'info',
  );
  if (!quiet) {
    setProgress({
      pct: aborted ? null : 100,
      text: aborted
        ? `TMDB 已停止 · ${hitCount}/${byKey.size} 命中`
        : `TMDB 完成 · ${hitCount}/${byKey.size} 命中`,
    });
    hideProgress(PROGRESS_HOLD_MS);
  }
  return { hitCount, total: byKey.size, aborted };
}

function emptyStateInner(title, hint) {
  return `<div class="empty-state">
    <strong>${escapeHtml(title)}</strong>
    ${hint ? `<p>${hint}</p>` : ''}
  </div>`;
}

function emptyStateRow(title, hint) {
  return `<tr class="empty"><td colspan="3">${emptyStateInner(title, hint)}</td></tr>`;
}

function scanEmptyCopy() {
  const scan = state.lastScan;
  if (!scan) {
    return {
      title: '还没有扫描结果',
      hint: '确认上方目录 CID 后点「扫描目录」。扫描后可校对片名与路径，再点底部「执行整理」。',
    };
  }
  if (scan.aborted && !scan.files) {
    return {
      title: '扫描已停止',
      hint: '还没拉到文件。点「扫描」再试一次。',
    };
  }
  if (!scan.files) {
    return {
      title: '这个目录是空的',
      hint: scan.recursive
        ? '当前目录和子文件夹里都没有文件。换一个文件夹后再扫。'
        : '当前层没有文件。勾选「含子文件夹」再扫，或换一个目录。',
    };
  }
  const bits = [];
  if (scan.tooSmall) bits.push(`${scan.tooSmall} 个小于体积下限`);
  if (scan.other) bits.push(`${scan.other} 个非媒体文件`);
  if (scan.junk) bits.push(`${scan.junk} 个样本/预告`);
  if (!scan.video && !scan.audio) bits.push('没有识别到视频或音频');
  return {
    title: '没有可整理的媒体',
    hint: bits.length
      ? `扫到 ${scan.files} 个文件，但没有可整理项（${bits.join('，')}）。可在设置里调低最小体积，或换一个目录。`
      : `扫到 ${scan.files} 个文件，但没有可整理的媒体。检查扩展名和最小体积后再扫。`,
  };
}

const VIEW_LABELS = {
  all: '全部',
  need: '待整理',
  done: '已在位',
  low: '低置信',
  conflict: '冲突',
};

function filterEmptyCopy(filterQ, view) {
  const viewLabel = VIEW_LABELS[view] || '全部';
  if (filterQ) {
    return {
      title: `没有匹配「${filterQ}」`,
      hint: view && view !== 'all'
        ? `当前在「${viewLabel}」视图。改关键词，或按 Esc 清空筛选。`
        : '改关键词，或按 Esc 清空筛选。',
    };
  }
  if (view === 'need') {
    return { title: '没有待整理的作品', hint: '当前视图下都已在目标位置。可切到「已在位」或「全部」。' };
  }
  if (view === 'done') {
    return { title: '没有已在位的作品', hint: '当前视图下都还没整理。可切到「待整理」或「全部」。' };
  }
  if (view === 'low') {
    return { title: '没有低置信项', hint: '校准结果看起来都比较稳。可切回「全部」。' };
  }
  if (view === 'conflict') {
    return { title: '没有路径冲突', hint: '目标路径没有撞车。可切回「全部」。' };
  }
  return { title: '当前筛选没有匹配条目', hint: '试试「全部」，或清空搜索。' };
}

function renderTable() {
  hidePosterZoom();
  const tbody = $('tbody');
  if (!state.rows.length) {
    const empty = scanEmptyCopy();
    tbody.innerHTML = emptyStateRow(empty.title, empty.hint);
    $('btnRun').disabled = true;
    $('btnSelectAll').disabled = true;
    $('btnSelectNone').disabled = true;
    $('btnSelectVisible').disabled = true;
    $('btnSelectNeed').disabled = true;
    $('btnSelectTv').disabled = true;
    $('btnSelectMovie').disabled = true;
    $('btnSelectLow').disabled = true;
    if ($('selectPreset')) $('selectPreset').disabled = true;
    $('btnExpandAll').disabled = true;
    $('btnCollapseAll').disabled = true;
    $('btnRecalibrate').disabled = true;
    $('btnCopyPlan').disabled = true;
    $('btnRetryFailed').disabled = true;
    $('btnRetryFailed').hidden = true;
    $('summary').hidden = true;
    $('toolsPanel').hidden = true;
    $('actionBar').hidden = true;
    const checkAll = $('checkAllVisible');
    if (checkAll) {
      checkAll.checked = false;
      checkAll.indeterminate = false;
      checkAll.disabled = true;
    }
    syncViewChips(null);
    syncResultsLayout();
    return;
  }

  syncResultsLayout();
  $('toolsPanel').hidden = false;
  const summary = summarizeRows(state.rows);
  const listCtx = getListContext();
  const { groups, collideIds, visibleGroups } = listCtx;
  const selSize = selectedSizeLabel();
  $('summary').hidden = false;
  syncViewChips(listCtx);
  $('summaryText').textContent =
    `共 ${summary.total} 项` +
    (groups.length ? ` · ${groups.length} 部` : '') +
    ` · 已选 ${summary.selected}` +
    (selSize ? `（${selSize}）` : '') +
    (visibleGroups.length !== groups.length ? ` · 显示 ${visibleGroups.length} 部` : '');

  const visibleRows = visibleGroups.flatMap((g) => g.rows.filter((r) => !r.companionOf));
  // 已在位 items can't be checked, so they don't count towards "select all"
  const selectableRows = visibleRows.filter((r) => !r.alreadyOrganized);
  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every((r) => r.selected);
  const someVisibleSelected = selectableRows.some((r) => r.selected);
  const checkAll = $('checkAllVisible');
  if (checkAll) {
    checkAll.checked = allVisibleSelected;
    checkAll.indeterminate = !allVisibleSelected && someVisibleSelected;
    checkAll.disabled = selectableRows.length === 0 || state.running || state.scanning;
    checkAll.title = selectableRows.length
      ? '勾选当前筛选/视图下可见且待整理的作品'
      : '当前视图均为已在位，无需勾选';
  }
  $('actionBar').hidden = false;
  $('actionBarSummary').textContent = summary.selected
    ? `已选 ${summary.selected} 项${selSize ? ` · ${selSize}` : ''}`
    : `未勾选 · 共 ${summary.total} 项`;

  tbody.innerHTML = '';
  if (!visibleGroups.length) {
    const empty = filterEmptyCopy(listCtx.filterQ, listCtx.view);
    tbody.innerHTML = emptyStateRow(empty.title, empty.hint);
  }
  // Hoist per-render constants out of the row loops (DOM reads + escaping per row)
  const moveChecked = $('moveFiles').checked;
  const planPrefixHtml = planPathPrefixHtml();
  const frag = document.createDocumentFragment();
  for (const group of visibleGroups) {
    const primary = group.rows.find((r) => !r.companionOf) || group.rows[0];
    const videos = group.rows.filter((r) => !r.companionOf);
    const multi = videos.length > 1;
    const collapsed = multi
      ? (state.groupCollapsed.has(group.key) ? state.groupCollapsed.get(group.key) : true)
      : false;
    if (multi) state.groupCollapsed.set(group.key, collapsed);

    // Already at target → not selectable, so it never shows up as "all selected"
    const selectable = videos.filter((r) => !r.alreadyOrganized);
    const allSelected = selectable.length > 0 && selectable.every((r) => r.selected);
    const someSelected = selectable.some((r) => r.selected);
    const title = primary.parsed?.title || seriesQueryTitle(primary.parsed) || primary.originalName;
    const region = REGION_FOLDERS.includes(primary.parsed?.region)
      ? primary.parsed.region
      : '其他剧集';
    const year = primary.parsed?.year || '';
    const range = episodeRangeLabel(group.rows);
    const pathSample = primary.pathDisplay || '';
    const poster = primary.parsed?.posterUrl || '';
    const groupDone = videos.every((r) => r.alreadyOrganized);
    const groupLow = videos.some((r) => isLowConfidence(r));
    const dups = findDuplicateEpisodes(videos);
    const gaps = findEpisodeGaps(videos);
    const kind = primary.kind || primary.parsed?.kind || 'unknown';
    const groupCollide = videos.some((r) => collideIds.has(r.id));
    const regionOpts = REGION_FOLDERS.map(
      (r) => `<option value="${escapeAttr(r)}" ${region === r ? 'selected' : ''}>${escapeHtml(r)}</option>`,
    ).join('');
    const metaLine = [
      range || (kind === 'movie' ? '电影' : '1 项'),
      groupDone ? '已在位' : '',
      groupLow ? '低置信' : '',
      dups.length ? `重复 ${dups.map((d) => d.key).join(',')}` : '',
      gaps.length
        ? `缺集 ${gaps.slice(0, 6).map((g) => g.key).join(',')}${gaps.length > 6 ? '…' : ''}`
        : '',
    ].filter(Boolean).join(' · ');
    const calib = calibrationHint(primary.parsed);

    // Series header
    const head = document.createElement('tr');
    head.className = `group-head${collapsed ? ' is-collapsed' : ''}${groupDone ? ' is-done' : ''}${groupLow ? ' is-low' : ''}${dups.length || groupCollide ? ' is-dup' : ''}${gaps.length ? ' is-gap' : ''}`;
    head.dataset.group = group.key;
    // 重复集不随勾选变化；冲突集随勾选变化（refreshSelectionUi 依赖此标记恢复 is-dup）
    head.dataset.dup = dups.length ? '1' : '';
    head.innerHTML = `
      <td class="col-check">
        <input type="checkbox" data-role="group-select" data-group="${escapeAttr(group.key)}"
          ${allSelected ? 'checked' : ''} ${!allSelected && someSelected ? 'data-indeterminate="1"' : ''}
          ${selectable.length ? '' : 'disabled title="整组均已在目标位置，无需再整理"'} />
      </td>
      <td class="col-work">
        <div class="work-cell">
          ${posterHtml(poster, title, { tmdbId: primary.parsed?.tmdbId, kind })}
          <div class="group-title-block">
            <div class="group-title-row">
              ${multi ? `<button type="button" class="group-toggle" data-role="group-toggle" data-group="${escapeAttr(group.key)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展开剧集' : '折叠剧集'}"></button>` : ''}
              <input type="text" class="group-title-input" data-role="group-title" data-group="${escapeAttr(group.key)}" value="${escapeAttr(title)}" title="修改片名后整组路径/文件名会重算" />
              <input type="text" class="group-year-input" data-role="group-year" data-group="${escapeAttr(group.key)}" value="${escapeAttr(year)}" placeholder="年" maxlength="4" title="年份" />
            </div>
            <div class="group-meta-row">
              <select class="kind-select" data-role="group-kind" data-group="${escapeAttr(group.key)}" title="切换类型并重算路径">
                <option value="tv" ${kind === 'tv' ? 'selected' : ''}>剧集</option>
                <option value="movie" ${kind === 'movie' ? 'selected' : ''}>电影</option>
                <option value="unknown" ${kind === 'unknown' ? 'selected' : ''}>其他</option>
              </select>
              ${kind === 'tv' ? `<select class="region-select" data-role="group-region" data-group="${escapeAttr(group.key)}" title="覆盖地区分类">${regionOpts}</select>` : ''}
              <label class="tmdb-inline" title="手动指定 TMDB ID 后回车应用">
                <span>tmdb</span>
                <input type="text" class="group-tmdb-input" data-role="group-tmdbid" data-group="${escapeAttr(group.key)}" value="${escapeAttr(primary.parsed?.tmdbId || '')}" placeholder="ID" inputmode="numeric" />
              </label>
              <span class="muted meta-line">${escapeHtml(metaLine)}${calib || ''}<span class="collide-flag"${groupCollide ? '' : ' hidden'}> · 路径冲突</span></span>
            </div>
          </div>
        </div>
      </td>
      <td class="col-plan">
        <div class="plan-stack">
          <div class="plan-path-row">
            ${planPrefixHtml}
            <input type="text" class="plan-path" data-role="group-path" data-group="${escapeAttr(group.key)}" value="${escapeAttr(pathSample)}" ${!moveChecked ? 'disabled' : ''} title="${escapeAttr(fullPlanPath(pathSample) || '目标路径')}" placeholder="相对路径" />
          </div>
          <div class="muted plan-sub">${multi ? `${videos.length} 个文件` : `<span class="plan-name-preview" title="${escapeAttr(primary.newName)}">${escapeHtml(primary.newName)}</span>`}</div>
        </div>
      </td>
    `;
    const groupCb = head.querySelector('[data-role="group-select"]');
    if (groupCb?.dataset.indeterminate) groupCb.indeterminate = true;
    frag.appendChild(head);

    // Episode rows (sorted by S/E)
    const ordered = sortRowsByEpisode(group.rows);
    for (const row of ordered) {
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;
      tr.dataset.group = group.key;
      tr.className = `group-child${collapsed ? ' is-hidden' : ''}${row.companionOf ? ' is-companion' : ''}${row.alreadyOrganized ? ' is-done' : ''}${isLowConfidence(row) ? ' is-low' : ''}${collideIds.has(row.id) ? ' is-dup' : ''}`;
      const epHint = parseLabel(row.parsed);
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" data-role="select" ${row.selected && !row.alreadyOrganized ? 'checked' : ''} ${row.alreadyOrganized ? 'disabled title="已在目标位置，无需再整理"' : ''} /></td>
        <td class="col-work">
          <div class="file-cell">
            <div class="file-name" title="${escapeAttr(row.originalName)}">${escapeHtml(row.originalName)}${row.alreadyOrganized ? ' <span class="tag-done">已在位</span>' : ''}<span class="tag-warn"${collideIds.has(row.id) ? '' : ' hidden'}>冲突</span></div>
            <div class="muted file-meta">
              <span class="badge ${row.kind}">${row.kind}</span>
              ${escapeHtml(epHint)}
              · ${formatSize(row.size)}${row.companionOf ? ' · 附属' : ''}
            </div>
          </div>
      </td>
        <td class="col-plan">
          <div class="plan-stack">
            <input type="text" class="plan-name" data-role="newName" value="${escapeAttr(row.newName)}" title="${escapeAttr(row.newName)}" />
            <div class="plan-path-row">
              ${planPrefixHtml}
              <input type="text" class="plan-path" data-role="path" value="${escapeAttr(row.pathDisplay)}" ${!moveChecked ? 'disabled' : ''} title="${escapeAttr(fullPlanPath(row.pathDisplay))}" />
            </div>
          </div>
        </td>
    `;
    frag.appendChild(tr);
    }
  }
  tbody.appendChild(frag);

  $('btnRun').disabled = summary.selected === 0 || state.running || state.scanning;
  $('btnSelectAll').disabled = false;
  $('btnSelectNone').disabled = false;
  $('btnSelectVisible').disabled = visibleGroups.length === 0;
  $('btnSelectNeed').disabled = false;
  $('btnSelectTv').disabled = false;
  $('btnSelectMovie').disabled = false;
  $('btnSelectLow').disabled = false;
  if ($('selectPreset')) $('selectPreset').disabled = false;
  $('btnExpandAll').disabled = false;
  $('btnCollapseAll').disabled = false;
  $('btnRecalibrate').disabled = summary.selected === 0 || state.running || state.scanning;
  $('btnCopyPlan').disabled = summary.selected === 0;
  const hasFailed = (state.lastFailedIds || []).length > 0;
  $('btnRetryFailed').hidden = !hasFailed;
  $('btnRetryFailed').disabled = !hasFailed || state.running || state.scanning;
  const failedOpt = $('optSelectFailed');
  if (failedOpt) {
    failedOpt.hidden = !hasFailed;
    failedOpt.disabled = !hasFailed;
  }
}

/**
 * Light refresh for selection-only changes: sync checkboxes / summary / bar
 * in place instead of rebuilding the whole tbody (big libraries stay snappy).
 * Only valid when no render-relevant field besides `selected` changed.
 */
function refreshSelectionUi() {
  if (!state.rows.length) {
    renderTable();
    return;
  }
  // 冲突视图的成员本身依赖勾选（findDestinationCollisions 只统计已选行），
  // 可见性需要完整重算，回退全量渲染。
  if ((state.viewFilter || 'all') === 'conflict') {
    renderTable();
    return;
  }
  const summary = summarizeRows(state.rows);
  const listCtx = getListContext();
  const { groups, visibleGroups, collideIds } = listCtx;
  const selSize = selectedSizeLabel();
  $('summaryText').textContent =
    `共 ${summary.total} 项` +
    (groups.length ? ` · ${groups.length} 部` : '') +
    ` · 已选 ${summary.selected}` +
    (selSize ? `（${selSize}）` : '') +
    (visibleGroups.length !== groups.length ? ` · 显示 ${visibleGroups.length} 部` : '');
  $('actionBarSummary').textContent = summary.selected
    ? `已选 ${summary.selected} 项${selSize ? ` · ${selSize}` : ''}`
    : `未勾选 · 共 ${summary.total} 项`;
  syncViewChips(listCtx);

  const tbody = $('tbody');
  const groupByKey = new Map(groups.map((g) => [g.key, g]));
  // Group heads: checkbox state + collision flag（冲突集随勾选变化）
  for (const head of tbody.querySelectorAll('tr.group-head')) {
    const group = groupByKey.get(head.dataset.group);
    if (!group) continue;
    const selectable = group.rows.filter((r) => !r.companionOf && !r.alreadyOrganized);
    const allSelected = selectable.length > 0 && selectable.every((r) => r.selected);
    const someSelected = selectable.some((r) => r.selected);
    const cb = head.querySelector('[data-role="group-select"]');
    if (cb) {
      cb.checked = allSelected;
      cb.indeterminate = !allSelected && someSelected;
    }
    const groupCollide = group.rows.some((r) => collideIds.has(r.id));
    head.classList.toggle('is-dup', head.dataset.dup === '1' || groupCollide);
    const flag = head.querySelector('.collide-flag');
    if (flag) flag.hidden = !groupCollide;
  }
  // Rows: checkbox + collision highlight/tag（附属行跟随父级勾选）
  const rowsById = new Map(state.rows.map((r) => [String(r.id), r]));
  for (const tr of tbody.querySelectorAll('tr.group-child')) {
    const row = rowsById.get(String(tr.dataset.id));
    if (!row) continue;
    const collide = collideIds.has(row.id);
    tr.classList.toggle('is-dup', collide);
    const tag = tr.querySelector('.tag-warn');
    if (tag) tag.hidden = !collide;
    const cb = tr.querySelector('input[data-role="select"]');
    if (!cb || cb.disabled) continue;
    cb.checked = !!row.selected;
  }
  // Master checkbox over visible rows
  const visibleRows = visibleGroups.flatMap((g) => g.rows.filter((r) => !r.companionOf));
  const selectableRows = visibleRows.filter((r) => !r.alreadyOrganized);
  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every((r) => r.selected);
  const someVisibleSelected = selectableRows.some((r) => r.selected);
  const checkAll = $('checkAllVisible');
  if (checkAll) {
    checkAll.checked = allVisibleSelected;
    checkAll.indeterminate = !allVisibleSelected && someVisibleSelected;
  }
  $('btnRun').disabled = summary.selected === 0 || state.running || state.scanning;
  $('btnRecalibrate').disabled = summary.selected === 0 || state.running || state.scanning;
  $('btnCopyPlan').disabled = summary.selected === 0;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function syncRowFromDom(tr) {
  const id = tr.dataset.id;
  const row = state.rows.find((r) => r.id === id);
  if (!row) return;
  row.selected = tr.querySelector('[data-role="select"]').checked && !row.alreadyOrganized;
  const typedName = tr.querySelector('[data-role="newName"]').value.trim();
  row.newName = typedName || row.originalName || row.newName;
  const path = tr.querySelector('[data-role="path"]').value.trim();
  row.pathDisplay = path;
  row.pathSegments = path ? path.split(/[\\/]+/).filter(Boolean) : [];
}

/** Keep subtitle/nfo names & paths aligned with parent after manual edits. */
function syncCompanionsForParent(parent) {
  if (!parent?.id) return;
  const parentBase = parent.newName.includes('.')
    ? parent.newName.slice(0, parent.newName.lastIndexOf('.'))
    : parent.newName;
  for (const row of state.rows.filter((r) => r.companionOf === parent.id)) {
    const ext = row.originalName.includes('.')
      ? row.originalName.slice(row.originalName.lastIndexOf('.'))
      : '';
    const stem = row.originalName.includes('.')
      ? row.originalName.slice(0, row.originalName.lastIndexOf('.'))
      : row.originalName;
    const lang = stem.match(/\.(zh|zh-cn|zh-hans|zh-hant|chs|cht|en|eng|jp|jpn|sc|tc|und)$/i)?.[0] || '';
    row.newName = `${parentBase}${lang}${ext}`;
    row.pathSegments = [...(parent.pathSegments || [])];
    row.pathDisplay = parent.pathDisplay;
    row.kind = parent.kind;
    row.selected = parent.selected;
  }
}

function rowsInGroup(key) {
  const byId = new Map(state.rows.map((row) => [row.id, row]));
  return state.rows.filter((row) => {
    const parent = row.companionOf ? byId.get(row.companionOf) : row;
    return parent && groupKeyForRow(parent) === key;
  });
}

/** parent row id → companion rows (subtitles / nfo / images). */
function companionIndex() {
  const map = new Map();
  for (const row of state.rows) {
    if (!row.companionOf) continue;
    const list = map.get(row.companionOf);
    if (list) list.push(row);
    else map.set(row.companionOf, [row]);
  }
  return map;
}

function applyGroupTitleYear(key, { title, year } = {}) {
  const nextTitle = title != null ? String(title).trim() : null;
  const nextYear = year != null ? String(year).trim() : null;
  for (const row of rowsInGroup(key)) {
    if (row.companionOf) continue;
    if (nextTitle) {
      row.parsed.title = nextTitle;
      row.parsed.searchTitle = nextTitle;
      row.parsed.pathTitle = nextTitle;
    }
    if (nextYear !== null) {
      row.parsed.year = /^(19|20)\d{2}$/.test(nextYear) ? nextYear : (nextYear ? row.parsed.year : null);
    }
  }
  rebuildPlans();
}

/** group key|tmdb id currently being fetched — prevents Enter + change double-apply. */
const applyingTmdb = new Set();

async function applyGroupTmdbId(key, rawId) {
  const tid = String(rawId || '').trim().replace(/^tmdb-?/i, '');
  if (!/^\d+$/.test(tid)) {
    log('TMDB ID 应为数字', 'error');
    return;
  }
  const guardKey = `${key}|${tid}`;
  if (applyingTmdb.has(guardKey)) return;
  applyingTmdb.add(guardKey);
  const rows = rowsInGroup(key).filter((r) => !r.companionOf);
  if (!rows.length) {
    applyingTmdb.delete(guardKey);
    return;
  }
  const kind = rows[0].kind === 'movie' || rows[0].parsed?.kind === 'movie' ? 'movie' : 'tv';
  setStatus(`按 TMDB ID ${tid} 拉取…`);
  try {
    await hydrateTmdbCache();
    const detail = await fetchTmdbById(fetch, state.settings.tmdbApiKey || '', kind, tid);
    const hit = detail
      ? {
        ...detail,
        id: Number(tid),
        source: 'tmdb-manual',
        score: 1,
      }
      : {
        title: rows[0].parsed.title,
        year: rows[0].parsed.year,
        id: Number(tid),
        source: 'tmdb-manual',
        score: 1,
        kind,
      };
    const companions = companionIndex();
    for (const row of rows) {
      row.parsed.tmdbId = tid;
      row.parsed = applyEnrichToParsed(row.parsed, hit, row.originalName);
      row.parsed.tmdbId = tid;
      row.kind = row.parsed.kind;
      for (const c of companions.get(row.id) || []) {
        c.parsed = { ...row.parsed, ext: c.parsed?.ext };
        c.kind = row.kind;
      }
    }
    rebuildPlans();
    await persistTmdbCache();
    log(
      detail?.title
        ? `已应用 TMDB ${tid} → ${detail.title}${detail.year ? ` (${detail.year})` : ''}`
        : `已写入 TMDB ID ${tid}（详情暂不可用，仍可用于目录命名）`,
      'ok',
    );
    setStatus(`已应用 tmdb-${tid}`);
  } catch (err) {
    log(`应用 TMDB ID 失败: ${err.message || err}`, 'error');
    setStatus('TMDB ID 应用失败');
  } finally {
    applyingTmdb.delete(guardKey);
  }
}

$('tbody').addEventListener('change', (e) => {
  const role = e.target.dataset?.role;

  if (role === 'group-select') {
    const key = e.target.dataset.group;
    const on = e.target.checked;
    for (const row of rowsInGroup(key)) row.selected = on && !row.alreadyOrganized;
    refreshSelectionUi();
    return;
  }

  if (role === 'group-title' || role === 'group-year') {
    const key = e.target.dataset.group;
    const head = e.target.closest('tr');
    const titleEl = head?.querySelector('[data-role="group-title"]');
    const yearEl = head?.querySelector('[data-role="group-year"]');
    applyGroupTitleYear(key, {
      title: titleEl?.value,
      year: yearEl?.value,
    });
    return;
  }

  if (role === 'group-kind') {
    const key = e.target.dataset.group;
    const kind = e.target.value === 'movie' ? 'movie' : e.target.value === 'tv' ? 'tv' : 'unknown';
    for (const row of rowsInGroup(key)) {
      if (row.companionOf) continue;
      row.parsed.kind = kind;
      row.kind = kind;
      if (kind === 'tv' && (row.parsed.season == null || row.parsed.season === '')) {
        row.parsed.season = 1;
      }
      if (kind === 'tv' && !row.parsed.episode) row.parsed.episode = 1;
      if (kind !== 'tv') {
        row.parsed.region = null;
      } else if (!REGION_FOLDERS.includes(row.parsed.region)) {
        // Re-detect so the region dropdown matches the planned path folder
        row.parsed.region = detectRegion({
          filename: row.originalName,
          title: row.parsed.title || row.parsed.localTitle,
          relPath: row.parsed.relPath || row.item?._relPath || '',
          tags: row.parsed.tags,
          originCountries: row.parsed.originCountries,
          originalLanguage: row.parsed.originalLanguage,
          isAnime: row.parsed.isAnime,
        });
      }
    }
    rebuildPlans();
    return;
  }

  if (role === 'group-region') {
    const key = e.target.dataset.group;
    const region = e.target.value;
    if (!REGION_FOLDERS.includes(region)) return;
    for (const row of rowsInGroup(key)) {
      if (row.companionOf) continue;
      row.parsed.region = region;
    }
    rebuildPlans();
    return;
  }

  if (role === 'group-tmdbid') {
    const key = e.target.dataset.group;
    const raw = String(e.target.value || '').trim();
    if (!raw) return;
    const next = raw.replace(/^tmdb-?/i, '');
    const current = String(
      rowsInGroup(key).find((r) => !r.companionOf)?.parsed?.tmdbId || '',
    ).trim();
    // Enter already applied it; only react when the value actually changed
    if (next !== current) applyGroupTmdbId(key, raw);
    return;
  }

  if (role === 'group-path') {
    const key = e.target.dataset.group;
    const path = e.target.value.trim();
    const base = path ? path.split(/[\\/]+/).filter(Boolean).filter((s) => !/^Season\s+\d+$/i.test(s)) : [];
    const companions = companionIndex();
    for (const row of rowsInGroup(key)) {
      if (row.companionOf) continue;
      const seasonSeg = (row.pathSegments || []).find((s) => /^Season\s+\d+$/i.test(s));
      row.pathSegments = seasonSeg ? [...base, seasonSeg] : [...base];
      row.pathDisplay = row.pathSegments.join('/');
      // companions share path
      for (const c of companions.get(row.id) || []) {
        c.pathSegments = [...row.pathSegments];
        c.pathDisplay = row.pathDisplay;
      }
    }
    refreshOrganizeStatus(state.rows, { sameRoot: targetRootMatchesScan() });
    renderTable();
    return;
  }

  const tr = e.target.closest('tr');
  if (!tr?.dataset.id) return;
  syncRowFromDom(tr);
  if (role === 'select') {
    const row = state.rows.find((r) => r.id === tr.dataset.id);
    if (row && !row.companionOf) {
      syncCompanionsForParent(row);
      refreshSelectionUi();
    } else if (row?.companionOf) {
      refreshSelectionUi();
    }
  } else if (role === 'newName' || role === 'path') {
    const row = state.rows.find((r) => r.id === tr.dataset.id);
    if (row && !row.companionOf) syncCompanionsForParent(row);
    refreshOrganizeStatus(state.rows, { sameRoot: targetRootMatchesScan() });
    if (row && !row.companionOf) renderTable();
  }
});

$('tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-role="group-toggle"]');
  if (!btn) return;
  const key = btn.dataset.group;
  const cur = state.groupCollapsed.has(key) ? state.groupCollapsed.get(key) : true;
  state.groupCollapsed.set(key, !cur);
  renderTable();
});

$('tbody').addEventListener('mouseover', (e) => {
  const img = e.target.closest('img.poster[data-zoom]');
  if (!img) return;
  if (e.relatedTarget && img.contains(e.relatedTarget)) return;
  clearTimeout(posterZoomTimer);
  posterZoomTimer = setTimeout(() => showPosterZoom(img), 80);
});

$('tbody').addEventListener('mouseout', (e) => {
  const img = e.target.closest('img.poster[data-zoom]');
  if (!img) return;
  if (e.relatedTarget && img.contains(e.relatedTarget)) return;
  hidePosterZoom();
});

document.querySelector('.table-wrap')?.addEventListener('scroll', hidePosterZoom, { passive: true });
window.addEventListener('blur', hidePosterZoom);

$('tbody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const role = e.target?.dataset?.role;
  if (role === 'group-tmdbid') {
    e.preventDefault();
    applyGroupTmdbId(e.target.dataset.group, e.target.value);
  }
});

$('tbody').addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  if (!tr?.dataset.id) return;
  syncRowFromDom(tr);
});

$('selectPreset')?.addEventListener('change', (e) => {
  const id = e.target.value;
  e.target.value = '';
  if (id) $(id)?.click();
});

$('btnSelectAll').addEventListener('click', () => {
  state.rows.forEach((r) => { r.selected = !r.alreadyOrganized; });
  refreshSelectionUi();
});

$('btnSelectNone').addEventListener('click', () => {
  state.rows.forEach((r) => { r.selected = false; });
  refreshSelectionUi();
});

$('btnSelectVisible').addEventListener('click', () => {
  const { visibleGroups } = getListContext();
  const visibleIds = new Set(
    visibleGroups.flatMap((g) => g.rows.filter((r) => !r.companionOf).map((r) => r.id)),
  );
  const companions = companionIndex();
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = visibleIds.has(row.id) && !row.alreadyOrganized;
    for (const c of companions.get(row.id) || []) {
      c.selected = row.selected;
    }
  }
  refreshSelectionUi();
  log(`已勾选可见 ${state.rows.filter((r) => !r.companionOf && r.selected).length} 项`, 'ok');
});

/** Set selection for currently visible works only (leave hidden groups untouched). */
function setVisibleSelection(selected) {
  const { visibleGroups } = getListContext();
  const visibleIds = new Set(
    visibleGroups.flatMap((g) => g.rows.filter((r) => !r.companionOf).map((r) => r.id)),
  );
  if (!visibleIds.size) return;
  const companions = companionIndex();
  for (const row of state.rows) {
    if (row.companionOf || !visibleIds.has(row.id)) continue;
    row.selected = !!selected && !row.alreadyOrganized;
    for (const c of companions.get(row.id) || []) {
      c.selected = row.selected;
    }
  }
  refreshSelectionUi();
}

$('checkAllVisible')?.addEventListener('change', (e) => {
  setVisibleSelection(e.target.checked);
});

$('btnSelectNeed').addEventListener('click', () => {
  const companions = companionIndex();
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = !row.alreadyOrganized;
    for (const c of companions.get(row.id) || []) {
      c.selected = row.selected;
    }
  }
  refreshSelectionUi();
  log(`已勾选待整理 ${state.rows.filter((r) => !r.companionOf && r.selected).length} 项`, 'ok');
});

$('btnSelectTv').addEventListener('click', () => {
  selectByKind('tv');
  log(`已勾选剧集 ${state.rows.filter((r) => !r.companionOf && r.selected).length} 项`, 'ok');
});

$('btnSelectMovie').addEventListener('click', () => {
  selectByKind('movie');
  log(`已勾选电影 ${state.rows.filter((r) => !r.companionOf && r.selected).length} 项`, 'ok');
});

$('btnSelectLow').addEventListener('click', () => {
  const companions = companionIndex();
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = !row.alreadyOrganized && isLowConfidence(row);
    for (const c of companions.get(row.id) || []) {
      c.selected = row.selected;
    }
  }
  refreshSelectionUi();
  log(`已勾选低置信 ${state.rows.filter((r) => !r.companionOf && r.selected).length} 项`, 'ok');
});

$('btnRetryFailed').addEventListener('click', () => {
  const failed = new Set(state.lastFailedIds || []);
  if (!failed.size) return;
  const companions = companionIndex();
  for (const row of state.rows) {
    if (row.companionOf) {
      // Failed subtitle/nfo can be retried alone without re-moving a successful parent
      row.selected = failed.has(row.id) && !row.alreadyOrganized;
      continue;
    }
    row.selected = failed.has(row.id) && !row.alreadyOrganized;
    for (const c of companions.get(row.id) || []) {
      if (failed.has(c.id)) c.selected = !c.alreadyOrganized;
      else if (row.selected && !c.alreadyOrganized) c.selected = true;
      else if (!failed.has(c.id)) c.selected = false;
    }
  }
  const n = state.rows.filter((r) => r.selected).length;
  refreshSelectionUi();
  log(`已勾选上次失败 ${n} 项，可再次执行整理`, 'ok');
});

function setAllGroupsCollapsed(collapsed) {
  for (const group of buildRowGroups()) {
    const videos = group.rows.filter((r) => !r.companionOf);
    if (videos.length > 1) state.groupCollapsed.set(group.key, collapsed);
  }
  renderTable();
}

$('btnExpandAll').addEventListener('click', () => setAllGroupsCollapsed(false));
$('btnCollapseAll').addEventListener('click', () => setAllGroupsCollapsed(true));

$('btnRecalibrate').addEventListener('click', async () => {
  if (state.running || state.scanning) return;
  const selected = state.rows.filter((r) => r.selected && !r.companionOf);
  if (!selected.length) {
    log('请先勾选要重校准的项', 'error');
    return;
  }
  const abort = new AbortController();
  state.scanAbort = abort;
  setScanningUi(true);
  $('btnRecalibrate').disabled = true;
  try {
    await hydrateTmdbCache();
    if (!hasTmdbKey()) log('未配置 API Key，将使用 TMDB 网页搜索', 'info');
    await runCalibration(selected, { signal: abort.signal });
  } catch (err) {
    log(err.message || String(err), 'error');
  } finally {
    state.scanAbort = null;
    setScanningUi(false);
    $('btnRecalibrate').disabled = false;
  }
});

$('btnCopyPlan').addEventListener('click', async () => {
  const lines = state.rows
    .filter((r) => r.selected && !r.companionOf)
    .map((r) => fullPlanFilePath(r));
  if (!lines.length) return;
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log(`已复制 ${lines.length} 行整理清单`, 'ok');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    log(`已复制 ${lines.length} 行整理清单`, 'ok');
  }
});

let tableFilterTimer = 0;
$('tableFilter')?.addEventListener('input', () => {
  state.tableFilter = $('tableFilter').value || '';
  clearTimeout(tableFilterTimer);
  tableFilterTimer = setTimeout(() => renderTable(), 120);
});

$('viewFilters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-chip');
  if (!btn?.dataset.view) return;
  setViewFilter(btn.dataset.view);
});

// Double-click a view chip → switch + 勾选可见
$('viewFilters')?.addEventListener('dblclick', (e) => {
  const btn = e.target.closest('.view-chip');
  if (!btn?.dataset.view || !state.rows.length) return;
  setViewFilter(btn.dataset.view, { force: true });
  $('btnSelectVisible')?.click();
});

$('organizeBox')?.addEventListener('toggle', () => {
  saveUiPrefs({ organizeOpen: !!$('organizeBox').open });
});

document.querySelector('details.log')?.addEventListener('toggle', (e) => {
  saveUiPrefs({ logOpen: !!e.currentTarget.open });
});

const VIEW_HOTKEYS = { 1: 'all', 2: 'need', 3: 'done', 4: 'low', 5: 'conflict' };

document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)) {
    if (e.key === 'Escape' && e.target.id === 'tableFilter') {
      e.target.value = '';
      state.tableFilter = '';
      renderTable();
      e.target.blur();
    }
    return;
  }
  // Single-key shortcuts must not fire while a button/link has focus
  if (/^(BUTTON|A)$/i.test(e.target?.tagName || '')) return;
  if (e.key === 'Escape') {
    let changed = false;
    if (state.tableFilter) {
      state.tableFilter = '';
      if ($('tableFilter')) $('tableFilter').value = '';
      changed = true;
    }
    if (state.viewFilter && state.viewFilter !== 'all') {
      state.viewFilter = 'all';
      changed = true;
    }
    if (changed) {
      e.preventDefault();
      renderTable();
    }
    return;
  }
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    $('tableFilter')?.focus();
    $('tableFilter')?.select();
    return;
  }
  if (VIEW_HOTKEYS[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey && state.rows.length) {
    e.preventDefault();
    setViewFilter(VIEW_HOTKEYS[e.key]);
    return;
  }
  if ((e.key === 'v' || e.key === 'V') && !e.metaKey && !e.ctrlKey && !e.altKey && state.rows.length) {
    e.preventDefault();
    $('btnSelectVisible')?.click();
    return;
  }
  if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (!state.scanning && !state.running) {
      e.preventDefault();
      $('btnScan').click();
    }
  }
});

$('btnClearLog').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  $('log').textContent = '';
});

$('moveFiles').addEventListener('change', async () => {
  updateOrganizeBoxEnabled();
  await saveSettings(readOrganizeFields());
  rebuildPlans();
});

$('cleanEmptyFolders').addEventListener('change', async () => {
  await saveSettings({ cleanEmptyFolders: $('cleanEmptyFolders').checked });
});

$('folderLayout').addEventListener('change', async () => {
  updateFolderLayoutHint();
  await saveSettings(readOrganizeFields());
  rebuildPlans();
});

$('targetMode').addEventListener('change', async () => {
  updateTargetModeUi();
  await saveSettings(readOrganizeFields());
  if (state.rows.length) renderTable();
});

$('targetBasePath').addEventListener('change', async () => {
  updateFolderLayoutHint();
  await saveSettings(readOrganizeFields());
  rebuildPlans();
});

$('targetBasePath').addEventListener('input', () => {
  updateFolderLayoutHint();
});

$('btnUseScanAsTarget').addEventListener('click', async () => {
  const cid = $('cidInput').value.trim() || '0';
  $('targetCid').value = cid;
  state.settings.targetCidName = cid === '0'
    ? '根目录'
    : (cidDisplayName(cid) || (cid === state.autoCid ? '当前扫描目录' : `目录 ${cid}`));
  updateTargetCidLabel();
  await saveSettings(readOrganizeFields());
  if (state.rows.length) renderTable();
  log(`目标目录已设为当前扫描 cid=${cid}`, 'ok');
});

$('enableMeta').addEventListener('change', async () => {
  updateMetaHint();
  if ($('enableMeta').checked && !hasTmdbKey()) {
    log('已勾选 TMDB 校准（未配置 Key，将使用网页搜索）', 'info');
  }
  await saveSettings({ enableMetadata: $('enableMeta').checked });
});

$('scanRecursive').addEventListener('change', async () => {
  updateCidRootWarning();
  await saveSettings({ scanRecursive: $('scanRecursive').checked });
});

$('skipCalibrateOrganized').addEventListener('change', async () => {
  await saveSettings({ skipCalibrateOrganized: $('skipCalibrateOrganized').checked });
});

$('recentCid').addEventListener('change', () => {
  const cid = $('recentCid').value;
  if (!cid) return;
  $('cidInput').value = cid;
  state.cidDirty = true;
  state.rootCid = cid;
  renderCidName();
  updateCidRootWarning();
  const name = cidDisplayName(cid);
  setStatus(`已选择 ${name || `cid=${cid}`}`);
  log(`切换到最近目录 ${name || cid}`, 'ok');
});

$('cidInput').addEventListener('input', () => {
  state.cidDirty = true;
  state.rootCid = $('cidInput').value.trim() || '0';
  renderCidName();
  updateCidRootWarning();
});

$('cidInput').addEventListener('change', () => {
  const cid = $('cidInput').value.trim();
  if (isCidValue(cid) && cid !== '0') fetchCidName(cid);
});

$('btnRefreshCid').addEventListener('click', async () => {
  state.cidDirty = false;
  const cid = await loadCid({ quiet: false, force: true });
  const name = cid ? cidDisplayName(cid) : '';
  log(cid != null ? `已从 115 页面同步 ${name || `cid=${cid}`}` : '未能读取当前目录 cid', cid != null ? 'ok' : 'error');
});

/* ---------- Folder picker ---------- */

function openFolderPicker() {
  $('folderPicker').hidden = false;
  const startCid = $('targetCid').value.trim() || '0';
  loadPicker(startCid);
}

function closeFolderPicker() {
  $('folderPicker').hidden = true;
}

async function loadPicker(cid = '0') {
  $('pickerStatus').textContent = '加载中…';
    $('pickerList').innerHTML = `<li class="empty">${emptyStateInner('正在加载…', '正在读取子文件夹。')}</li>`;
  try {
    const data = await api.listFolders(cid);
    state.picker = {
      cid: String(data.cid || cid),
      parentCid: String(data.parentCid || '0'),
      path: data.path || [{ cid: '0', name: '根目录' }],
      folders: data.folders || [],
    };
    renderPicker();
  } catch (err) {
    $('pickerStatus').textContent = '加载失败';
    $('pickerList').innerHTML = `<li class="empty">${emptyStateInner('加载失败', err.message || String(err))}</li>`;
  }
}

function pathDisplay(path) {
  return (path || []).map((p) => p.name).join(' / ') || '根目录';
}

function renderPicker() {
  const { cid, parentCid, path, folders } = state.picker;
  $('btnPickerUp').disabled = cid === '0';
  $('pickerStatus').textContent = folders.length
    ? `${folders.length} 个子文件夹`
    : '没有子文件夹 · 可选择当前目录';
  $('pickerCurrent').textContent = `当前：${pathDisplay(path)}`;

  const crumb = $('pickerCrumb');
  crumb.innerHTML = '';
  path.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      crumb.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = p.name;
    btn.disabled = i === path.length - 1;
    btn.addEventListener('click', () => loadPicker(p.cid));
    crumb.appendChild(btn);
  });

  const list = $('pickerList');
  list.innerHTML = '';
  if (!folders.length) {
    list.innerHTML = `<li class="empty">${emptyStateInner(
      '此目录下没有子文件夹',
      '可以直接选择当前目录，或点「上级」换一层。',
    )}</li>`;
    return;
  }
  for (const folder of folders) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ico" aria-hidden="true"></span><span class="name">${escapeHtml(folder.name)}</span>`;
    li.title = `cid=${folder.cid}`;
    li.addEventListener('click', () => loadPicker(folder.cid));
    list.appendChild(li);
  }
}

async function confirmPicker() {
  const { cid, path } = state.picker;
  const name = pathDisplay(path);
  $('targetCid').value = cid;
  state.settings.targetCidName = name;
  updateTargetCidLabel();
  await saveSettings(readOrganizeFields());
  closeFolderPicker();
  if (state.rows.length) renderTable();
  log(`已选择目标目录：${name} (cid=${cid})`, 'ok');
}

$('btnPickTarget').addEventListener('click', openFolderPicker);
$('btnPickerConfirm').addEventListener('click', confirmPicker);
$('btnPickerRoot').addEventListener('click', () => loadPicker('0'));
$('btnPickerUp').addEventListener('click', () => {
  const { parentCid, path } = state.picker;
  const up = path.length > 1 ? path[path.length - 2].cid : parentCid;
  loadPicker(up || '0');
});
$('folderPicker').addEventListener('click', (e) => {
  if (e.target?.dataset?.role === 'close-picker') closeFolderPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('folderPicker').hidden) closeFolderPicker();
});

function setScanningUi(scanning) {
  state.scanning = scanning;
  updateScanButtonState();
  $('btnStopScan').hidden = !scanning;
  $('btnRun').disabled = scanning || state.running || !state.rows.some((r) => r.selected);
  syncBusyLayout();
  $('btnScan')?.classList.toggle('primary', !state.rows.length || scanning);
}

function stopScan() {
  if (!state.scanning) return;
  state.scanAbort?.abort();
  log('正在停止扫描…');
  setStatus('正在停止…');
  setProgress({ indeterminate: true, text: '正在停止扫描…' });
}

async function scan() {
  if (state.running || state.scanning) return;
  // Sync from 115 page only when user hasn't manually edited CID
  if (!state.cidDirty) {
    await loadCid({ quiet: true, force: true });
  }
  const cid = $('cidInput').value.trim();
  const recursive = $('scanRecursive').checked;

  if (!isCidValue(cid)) {
    setStatus('CID 无效：只能填数字');
    log('已阻止扫描：CID 只能填纯数字。请点「同步」读取当前 115 目录，或从「最近」选择。', 'error');
    return;
  }
  if (isDriveRootCid(cid)) {
    updateCidRootWarning();
    setStatus('已阻止：不能扫描网盘根目录');
    log('已阻止扫描：当前是网盘根目录（cid=0）。请先在 115 进入具体文件夹后点「同步」，或手动填入子目录 CID。', 'error');
    return;
  }

  state.rootCid = cid;
  await send('SET_CID', { cid }).catch(() => {});
  const folderName = cidDisplayName(cid) || await fetchCidName(cid);
  await pushRecentCid(
    cid,
    cid === '0' ? '网盘根目录' : (folderName || (cid === state.autoCid ? '当前 115 目录' : `目录 ${cid}`)),
  );

  const abort = new AbortController();
  state.scanAbort = abort;
  const signal = abort.signal;
  let aborted = false;

  setStatus('正在检查登录…');
  log(
    `扫描目录 ${folderName || cid}${cid === '0' ? '（网盘根）' : ''}` +
    `${recursive ? '（含子文件夹）' : '（仅当前层）'}`,
  );
  setScanningUi(true);
  setProgress({ reset: true, indeterminate: true, text: '正在拉取文件列表…' });

  try {
    const login = await send('CHECK_LOGIN');
    if (signal.aborted) throw Object.assign(new Error('已停止扫描'), { name: 'AbortError' });
    if (!login.loggedIn) {
      throw new Error(login.error || '未登录 115，请先在浏览器打开并登录 115.com');
    }
    setStatus(recursive ? '正在递归拉取文件…' : '正在拉取文件列表…');

    const delayMs = requestDelay(250);
    let files;
    if (recursive) {
      files = await api.listAllFilesRecursive(cid, {
        delayMs,
        signal,
        onProgress: (p) => {
          if (p.phase === 'list') {
            setStatus(`扫描中 · 目录 ${p.scannedDirs} · 文件 ${p.files}${p.path ? ` · ${p.path}` : ''}`);
            setProgress({
              indeterminate: true,
              text: `扫描 目录 ${p.scannedDirs} · 文件 ${p.files}`,
            });
          } else if (p.phase === 'aborted') {
            aborted = true;
            setStatus(`已停止 · 已扫到 ${p.files} 个文件`);
            setProgress({ indeterminate: false, text: `已停止 · 已扫到 ${p.files} 个文件` });
          }
        },
      });
      if (signal.aborted) aborted = true;
    } else {
      if (signal.aborted) throw Object.assign(new Error('已停止扫描'), { name: 'AbortError' });
      try {
        const result = await send('API_LIST_ALL', { cid, recursive: false });
        files = result.files;
      } catch {
        files = await api.listAllFiles(cid);
      }
    }

    if (signal.aborted && !files?.length) {
      throw Object.assign(new Error('已停止扫描'), { name: 'AbortError' });
    }

    log(
      aborted
        ? `扫描已停止，保留已拉取的 ${files.length} 个文件`
        : `拉取到 ${files.length} 个文件${recursive ? '（已展开子文件夹）' : '（当前目录条目，含文件夹）'}`,
      aborted ? 'info' : 'ok',
    );
    setStatus('正在解析…');
    setProgress({ indeterminate: true, text: `解析 ${files.length} 个文件条目…` });

    try {
      const fresh = await send('GET_SETTINGS');
      if (fresh?.tmdbApiKey != null) state.settings.tmdbApiKey = fresh.tmdbApiKey;
      if (fresh?.preferDouban != null) state.settings.preferDouban = fresh.preferDouban;
    } catch {
      /* ignore */
    }
    updateMetaHint();
    const settings = currentOrganizeSettings();

    // 先出预览表，避免等 TMDB 时列表一直空白
    const filterStats = summarizeFilter(files, settings);
    state.lastScan = {
      cid,
      recursive,
      aborted,
      files: files.length,
      kept: filterStats.kept,
      video: filterStats.video,
      audio: filterStats.audio,
      junk: filterStats.junk,
      tooSmall: filterStats.tooSmall,
      other: filterStats.other,
    };
    log(
      `筛选：视频 ${filterStats.video} · 音频 ${filterStats.audio}` +
      (filterStats.junk ? ` · 样本/预告 ${filterStats.junk}` : '') +
      ` · 过小 ${filterStats.tooSmall} · 其他 ${filterStats.other} → 可整理 ${filterStats.kept}`,
    );
    if (filterStats.kept === 0) {
      const empty = scanEmptyCopy();
      log(`${empty.title}${empty.hint ? `：${empty.hint}` : ''}`, files.length ? 'error' : 'info');
    }

    await hydrateTmdbCache();
    // Target root differs from scan root → relative paths are incomparable, so do not
    // auto-unselect "already at target" rows (they may still need to be moved).
    const sameRoot = targetRootMatchesScan();
    if (!sameRoot) {
      log('目标目录不是扫描目录：不会自动判定“已在位”，请确认勾选后再执行', 'info');
    }
    state.rows = buildPreviewRows(files, settings, { enrichMap: new Map(), sameRoot });
    renderTable();
    const alreadyN = state.rows.filter((r) => !r.companionOf && r.alreadyOrganized).length;
    if (alreadyN) {
      log(`检测到 ${alreadyN} 个已在目标位置，默认不勾选`, 'info');
    }
    setStatus(`已解析 ${state.rows.length} 项${settings.enableMetadata && !signal.aborted ? ' · 即将 TMDB 校准' : ''}`);

    // 再异步 TMDB 校准并刷新表格（无 Key 时走网页搜索兜底）
    if (settings.enableMetadata && !signal.aborted && state.rows.length) {
      updateMetaHint();
      if (!hasTmdbKey()) {
        log('未配置 API Key，将使用 TMDB 网页搜索校准', 'info');
      }
      const cal = await runCalibration(state.rows, { signal });
      if (cal.aborted) aborted = true;
    } else if (!settings.enableMetadata && state.rows.length) {
      const tvEps = state.rows.filter((r) => !r.companionOf && r.parsed?.season != null).length;
      log(
        `未开启 TMDB 校准${tvEps ? `（含 ${tvEps} 个剧集文件）` : ''}：勾选上方「TMDB 校准」可自动匹配中文片名与海报`,
        'info',
      );
    } else if (settings.enableMetadata && signal.aborted) {
      log('已停止，跳过 TMDB 校准', 'info');
    }

    const org = readOrganizeFields();
    const calibrated = state.rows.filter((r) => !r.companionOf && r.parsed?.metaSource).length;
    const targetHint = org.moveFiles
      ? (org.targetMode === 'cid'
        ? ` · 输出到 ${formatTargetLabel(state.settings.targetCidName, org.targetCid)}`
        : ' · 输出到扫描目录下')
      : '';
    const calHint = calibrated ? ` · 已校准 ${calibrated}` : '';
    if (!state.rows.length) {
      const empty = scanEmptyCopy();
      setStatus(aborted ? `扫描已停止 · ${empty.title}` : empty.title);
    } else if (aborted) {
      setStatus(`扫描已停止${calHint}`);
      log(`已停止，可整理当前 ${state.rows.length} 项${targetHint}`, 'ok');
    } else {
      setStatus(`扫描完成${calHint}`);
      log(`可整理 ${state.rows.length} 项 · 结构「${FOLDER_LAYOUTS[org.folderLayout]?.label || org.folderLayout}」${targetHint}`, 'ok');
    }
    // TMDB already parked the bar at 100%; otherwise close it out here
    if (progressView.pct < 100) {
      setProgress({
        indeterminate: false,
        pct: aborted ? null : 100,
        text: aborted ? '扫描已停止' : `扫描完成 · ${state.rows.length} 项`,
      });
    }
    hideProgress(PROGRESS_HOLD_MS);
  } catch (err) {
    if (err?.name === 'AbortError' || /已停止/.test(err?.message || '')) {
      if (!state.rows.length) {
        state.lastScan = {
          cid,
          recursive,
          aborted: true,
          files: 0,
          kept: 0,
          video: 0,
          audio: 0,
          junk: 0,
          tooSmall: 0,
          other: 0,
        };
        renderTable();
      }
      setStatus('扫描已停止');
      log('已停止扫描', 'ok');
      setProgress({ indeterminate: false, text: '扫描已停止' });
    } else {
      setStatus('扫描失败');
      log(err.message || String(err), 'error');
      setProgress({ indeterminate: false, text: `扫描失败：${err.message || err}` });
    }
    hideProgress(PROGRESS_HOLD_MS);
  } finally {
    state.scanAbort = null;
    setScanningUi(false);
  }
}

function setOrganizeUi(running) {
  state.running = running;
  const hasRows = state.rows.length > 0;
  // Keep the dock (and its stop button) available even when cleaning an empty preview
  $('actionBar').hidden = !(hasRows || running);
  if (running && !hasRows) $('actionBarSummary').textContent = '正在处理当前目录…';
  $('btnRun').disabled = running || state.scanning || !state.rows.some((r) => r.selected);
  $('btnStopRun').hidden = !running;
  updateScanButtonState();
  $('btnClean').disabled = running || state.scanning;
  syncBusyLayout();
}

function stopOrganize() {
  if (!state.running) return;
  if (state.cleanupAbort) {
    state.cleanupAbort.abort();
    log('正在停止清理…');
    setStatus('正在停止清理…');
    setProgress({ text: '正在停止清理…' });
    return;
  }
  state.organizeAbort?.abort();
  log('正在停止整理…');
  setStatus('正在停止整理…');
  setProgress({ text: '正在停止整理…' });
}

async function runOrganize() {
  if (state.running || state.scanning) return;
  for (const tr of $('tbody').querySelectorAll('tr[data-id]')) {
    syncRowFromDom(tr);
  }
  const skippedDone = state.rows.filter((r) => r.selected && r.alreadyOrganized).length;
  // 已在位 = 目标名与目标路径都和现状一致，再执行只会白跑一次接口
  const selected = state.rows.filter((r) => r.selected && !r.alreadyOrganized);
  if (skippedDone) log(`已跳过 ${skippedDone} 个已在目标位置的文件`, 'info');
  if (!selected.length) return;

  const org = readOrganizeFields();
  const moveFiles = org.moveFiles;
  // Snapshot the scan root: cleanup after the run must use the same folder,
  // not whatever the CID input happens to show later.
  const scanCidSnapshot = String(state.rootCid || $('cidInput').value.trim() || '0');
  const targetRoot = resolveTargetRootCid(org.targetMode, scanCidSnapshot, org.targetCid);
  const targetLabel = org.targetMode === 'cid'
    ? formatTargetLabel(state.settings.targetCidName, org.targetCid)
    : `扫描目录 (cid=${state.rootCid || '0'})`;

  const doClean = moveFiles && $('cleanEmptyFolders').checked;
  const collisions = findDestinationCollisions(selected);
  if (collisions.length) {
    log(
      `目标路径冲突 ${collisions.length} 处（同路径同名会被覆盖）: ` +
      collisions.slice(0, 5).map((c) => `${c.path}/${c.name}×${c.count}`).join('；'),
      'error',
    );
  }
  const okConfirm = confirm(
    `将对 ${selected.length} 个文件执行重命名${moveFiles ? '并移动' : ''}。\n` +
    (moveFiles ? `输出根目录：${targetLabel}\n` : '') +
    (collisions.length ? `⚠ 有 ${collisions.length} 组目标路径/文件名冲突，可能导致互相覆盖。\n` : '') +
    (doClean ? '完成后将清理推广图/广告包等垃圾，并删除无有效视频文件夹（进回收站）。\n' : '') +
    '是否继续？',
  );
  if (!okConfirm) return;

  const abort = new AbortController();
  state.organizeAbort = abort;
  setOrganizeUi(true);
  setProgress({ reset: true, pct: 0, text: `准备整理 ${selected.length} 个文件…` });

  // Organize uses short pauses between batches only (not per file).
  // Scan/TMDB still honor the higher requestDelayMs setting.
  const delayMs = Math.min(requestDelay(80), 80);

  api.clearFolderCache();
  const uniquePaths = new Set(
    selected.map((r) => (r.pathSegments || []).join('/')).filter(Boolean),
  );
  log(
    `开始整理 → 根目录 cid=${targetRoot}${moveFiles ? `（${targetLabel}）` : '（仅重命名）'}` +
    ` · ${selected.length} 文件 · ${uniquePaths.size || 1} 个目标目录（批量）`,
  );

  let aborted = false;
  const results = await executeOrganize(api, selected, {
    rootCid: targetRoot,
    moveFiles,
    delayMs,
    signal: abort.signal,
    onProgress: (p) => {
      if (p.phase === 'aborted') {
        aborted = true;
        setStatus(`整理已停止 · ${p.done || 0}/${p.total || selected.length}`);
        setProgress({ text: `已停止 · ${p.done || 0}/${selected.length}` });
      } else if (p.phase === 'mkdir') {
        setStatus(`创建目录 ${p.groupIndex}/${p.groupCount}: ${p.path || '(根)'}`);
        setProgress({
          pct: fracPct(2, 10, (p.groupIndex || 0) / Math.max(1, p.groupCount || 1)),
          text: `建目录 ${p.groupIndex}/${p.groupCount}${p.path ? ` · ${p.path}` : ''}`,
        });
      } else if (p.phase === 'rename') {
        setStatus(`批量重命名 ${p.renameCount} 个…`);
        setProgress({
          pct: fracPct(10, 35, (p.renameCount || 0) / Math.max(1, selected.length)),
          text: `重命名 ${p.renameCount} 个`,
        });
      } else if (p.phase === 'rename_fallback') {
        log(`批量重命名失败，改为逐个: ${p.error}`, 'error');
      } else if (p.phase === 'move') {
        setStatus(`批量移动 ${p.moveCount} → ${p.path}`);
        setProgress({
          // Group-based estimate fills the bar during the long move stage
          pct: fracPct(35, 60, (p.groupIndex || 0) / Math.max(1, p.groupCount || 1)),
          text: `移动 ${p.groupIndex}/${p.groupCount} 组 · 本组 ${p.moveCount} 个`,
        });
        log(`移动 ${p.moveCount} 个文件 → ${p.path}`, 'ok');
      } else if (p.phase === 'move_fallback') {
        log(`批量移动失败，改为逐个: ${p.error}`, 'error');
      } else if ((p.phase === 'done' && p.row) || p.phase === 'error') {
        const done = p.done || 0;
        setProgress({
          pct: fracPct(35, 95, done / Math.max(1, selected.length)),
          text: `${done} / ${selected.length}`,
        });
        if (p.phase === 'error') {
          log(`${p.row?.originalName || '?'}: ${p.error}`, 'error');
          if (/验证|captcha|安全/i.test(p.error || '')) {
            log('可能触发了 115 安全验证，请在网盘页面完成验证后重试', 'error');
          }
        } else if (p.ok) {
          log(
            `${p.row.originalName} → ${fullPlanFilePath(p.row)}`,
            'ok',
          );
        }
      } else if (p.phase === 'finished') {
        setProgress({ pct: 100, text: `完成 · ${p.ok || 0} 成功 / ${p.failed || 0} 失败` });
      }
    },
  });

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
  const failedIds = results.filter((r) => !r.ok).map((r) => r.id);
  // Items never reported (stopped mid-way) also count as pending retry (incl. companions)
  const failedSet = new Set(failedIds);
  for (const row of selected) {
    if (!okIds.has(row.id) && !failedSet.has(row.id)) {
      failedIds.push(row.id);
    }
  }
  state.lastFailedIds = failedIds;
  log(
    aborted
      ? `整理已停止：成功 ${okCount}，失败/未完成 ${failedIds.length}`
      : `整理结束：成功 ${okCount}，失败 ${failCount}`,
    failedIds.length ? 'error' : 'ok',
  );
  if (failedIds.length) log(`可点「重试失败」再次勾选失败项`, 'info');

  // Mark succeeded rows as already organized / unselected.
  // Companions must succeed on their own id — parent ok must not hide a failed subtitle.
  for (const row of state.rows) {
    if (!okIds.has(row.id)) continue;
    row.alreadyOrganized = true;
    row.selected = false;
    // After move, treat current path as destination for status
    if (row.pathDisplay) {
      row.item = { ...row.item, _relPath: row.pathDisplay };
      row.originalName = row.newName || row.originalName;
    }
  }
  // Files now sit at the target, so compare against the planned path directly
  refreshOrganizeStatus(state.rows, { sameRoot: true });
  afterOrganizeSmartView();

  // Skip auto-clean when anything failed — leftover companions may still sit in source dirs
  if (doClean && okCount > 0 && failCount === 0 && !aborted) {
    // 115 listing can lag right after batch move — settle then clear path cache
    api.clearFolderCache();
    await sleep(600);
    await runCleanup({
      quietConfirm: true,
      reason: '整理后自动清理',
      scanCid: scanCidSnapshot,
      targetRootCid: targetRoot,
    });
  } else if (doClean && failCount > 0) {
    log('有失败项，已跳过自动清理（避免误删源目录残留字幕/文件）。可重试失败后再清，或手动点「清理空夹」。', 'info');
  }

  state.organizeAbort = null;
  setOrganizeUi(false);
  setStatus(
    aborted
      ? `整理已停止（成功 ${okCount}）`
      : (failCount ? `完成（${failCount} 失败）` : '整理完成'),
  );
  // Keep the final result readable, then collapse the dock row
  hideProgress(PROGRESS_HOLD_MS);
}

/**
 * Delete junk files + folders under current scan cid with no keepable video.
 */
async function runCleanup({
  quietConfirm = false,
  reason = '手动清理',
  scanCid: scanCidSnapshot = null,
  targetRootCid: targetRootSnapshot = null,
} = {}) {
  const scanCid = String(
    scanCidSnapshot != null
      ? scanCidSnapshot
      : ($('cidInput').value.trim() || state.rootCid || '0'),
  );
  if (!isCidValue(scanCid)) {
    log('跳过清理：扫描目录 CID 无效（只能填数字）', 'error');
    return null;
  }
  if (scanCid === '0') {
    log('跳过清理：扫描目录为网盘根目录（cid=0），过于危险', 'error');
    return null;
  }

  if (!quietConfirm) {
    const ok = confirm(
      `将扫描目录 cid=${scanCid} 下：\n` +
      '· 删除广告包 / 推广图 / 预告 / ≤30MB 无正片信号的音视频等垃圾\n' +
      '· 删除整棵子树没有有效视频的文件夹（进回收站）\n' +
      '不会删除扫描根目录本身。是否继续？',
    );
    if (!ok) return null;
  }

  let targetRoot;
  if (targetRootSnapshot != null) {
    targetRoot = String(targetRootSnapshot);
  } else {
    const org = readOrganizeFields();
    targetRoot = resolveTargetRootCid(org.targetMode, state.rootCid || '0', org.targetCid);
  }
  const delayMs = requestDelay(300);
  const protectCids = [scanCid, targetRoot, '0'];
  const abort = new AbortController();
  state.cleanupAbort = abort;

  api.clearFolderCache();
  log(`${reason}：清理垃圾文件 + 无有效视频夹（cid=${scanCid}）…`);
  setStatus('清理中…');
  // Reset first: a previous organize left the bar at 100%
  setProgress({ reset: true, indeterminate: true, text: '正在扫描目录结构…' });
  $('btnStopRun').hidden = false;
  $('btnStopRun').textContent = '停止清理';

  try {
    const result = await cleanFoldersWithoutVideo(api, scanCid, {
      delayMs,
      purgeJunkFiles: true,
      protectCids,
      signal: abort.signal,
      onProgress: (p) => {
        if (p.phase === 'scan') {
          // Tree size is unknown up front → keep the bar indeterminate
          setProgress({ indeterminate: true, text: `扫描 ${p.scanned} 个文件夹…` });
          setStatus(`清理扫描: ${p.path || p.cid}`);
        } else if (p.phase === 'junk') {
          setProgress({
            pct: fracPct(0, 30, (p.done || 0) / Math.max(1, p.total || 1)),
            text: `删垃圾 ${p.done + 1}/${p.total}`,
          });
          setStatus(`删垃圾: ${p.path || p.name}`);
        } else if (p.phase === 'delete') {
          setProgress({
            pct: fracPct(30, 98, (p.done || 0) / Math.max(1, p.total || 1)),
            text: `删空夹 ${p.done + 1}/${p.total}`,
          });
          setStatus(`删除: ${p.path || p.name}`);
        } else if (p.phase === 'error') {
          log(`删除失败 ${p.path || p.name}: ${p.error}`, 'error');
        } else if (p.phase === 'done') {
          const junkN = p.deletedJunk || 0;
          const folderN = p.deleted || 0;
          setProgress({
            indeterminate: false,
            pct: p.aborted ? null : 100,
            text: p.aborted
              ? `已停止 · 垃圾 ${junkN} · 空夹 ${folderN}`
              : `完成 · 垃圾 ${junkN} · 空夹 ${folderN}`,
          });
        }
      },
    });

    for (const j of result.deletedJunk || []) {
      log(`已删垃圾 ${j.path || j.name}`, 'ok');
    }
    for (const d of result.deleted) {
      log(`已清理空夹 ${d.path || d.name}`, 'ok');
    }
    const junkN = (result.deletedJunk || []).length;
    const folderN = result.deleted.length;
    log(
      `${result.aborted ? '清理已停止' : '清理完成'}：扫描 ${result.scanned} 目录` +
      ` · 垃圾 ${junkN} · 空夹 ${folderN}` +
      (result.skipped ? ` · 跳过 ${result.skipped}` : ''),
      junkN || folderN ? 'ok' : 'info',
    );
    setStatus(
      result.aborted
        ? `清理已停止 · 垃圾 ${junkN} · 空夹 ${folderN}`
        : `清理完成 · 垃圾 ${junkN} · 空夹 ${folderN}`,
    );
    return result;
  } catch (err) {
    log(`清理失败: ${err.message || err}`, 'error');
    setStatus('清理失败');
    setProgress({ indeterminate: false, text: `清理失败：${err.message || err}` });
    return null;
  } finally {
    state.cleanupAbort = null;
    $('btnStopRun').textContent = '停止整理';
    if (!$('btnStopRun').hidden && !state.organizeAbort) {
      $('btnStopRun').hidden = true;
    }
    hideProgress(PROGRESS_HOLD_MS);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

$('btnScan').addEventListener('click', scan);
$('btnStopScan').addEventListener('click', stopScan);
$('btnRun').addEventListener('click', runOrganize);
$('btnStopRun').addEventListener('click', stopOrganize);
$('btnClean').addEventListener('click', async () => {
  if (state.running || state.scanning) return;
  setOrganizeUi(true);
  $('actionBarSummary').textContent = '正在清理当前目录…';
  try {
    await runCleanup({ quietConfirm: false });
  } finally {
    setOrganizeUi(false);
    hideProgress(PROGRESS_HOLD_MS);
    if (state.rows.length) renderTable();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || area === 'session') {
    const ch = changes[STORAGE_KEYS.lastCid];
    if (ch?.newValue != null) {
      const cid = String(ch.newValue);
      state.autoCid = cid;
      // Do not rewrite the working CID while a scan/organize is in progress
      if (!state.cidDirty && !state.running && !state.scanning) {
        $('cidInput').value = cid;
        state.rootCid = cid;
        updateCidRootWarning();
        if (cid !== '0' && !state.cidNames.has(cid)) fetchCidName(cid);
        else renderCidName();
      }
    }
  }
  if (area === 'sync' && changes[STORAGE_KEYS.settings]) {
    state.settings = { ...DEFAULT_SETTINGS, ...changes[STORAGE_KEYS.settings].newValue };
    fillFolderLayoutSelect();
    applyOrganizeUiFromSettings();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadCid({ quiet: false, force: !state.cidDirty });
});

window.addEventListener('focus', () => {
  if (!state.cidDirty) loadCid({ quiet: true, force: true });
});

// CID is pushed by the content script on navigation and by focus/visibility refresh;
// no polling needed (the old 2s interval caused constant storage writes).

/* ---------- Update check (GitHub-hosted update.json) ----------
 * Unpacked extensions cannot self-update; we only compare versions and show a
 * banner. Throttled to once per 24h via chrome.storage.local; a dismissed
 * version stays hidden until a newer one appears.
 */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function showUpdateBanner(version, url, notes) {
  const box = $('updateBanner');
  if (!box) return;
  $('updateBannerText').textContent = `发现新版本 v${version}（当前 v${chrome.runtime.getManifest().version}）`;
  const notesEl = $('updateBannerNotes');
  const text = String(notes || '').trim().slice(0, 120);
  notesEl.textContent = text;
  notesEl.hidden = !text;
  const link = $('updateBannerLink');
  if (/^https?:\/\//i.test(String(url || ''))) {
    link.href = url;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  box.dataset.version = version;
  box.hidden = false;
}

$('updateBannerClose')?.addEventListener('click', async () => {
  const box = $('updateBanner');
  box.hidden = true;
  const version = box.dataset.version;
  if (version) {
    try {
      await chrome.storage.local.set({ dismissedUpdateVersion: version });
    } catch {
      /* ignore */
    }
  }
});

async function checkForUpdate({ force = false } = {}) {
  const url = String(state.settings.updateCheckUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return;
  try {
    const store = await chrome.storage.local.get(['lastUpdateCheckAt', 'dismissedUpdateVersion']);
    if (!force && Date.now() - (store.lastUpdateCheckAt || 0) < UPDATE_CHECK_INTERVAL_MS) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const info = await res.json();
    await chrome.storage.local.set({ lastUpdateCheckAt: Date.now() });
    const remote = String(info?.version || '').trim();
    if (!remote) return;
    const local = chrome.runtime.getManifest().version;
    if (cmpVersion(remote, local) > 0 && store.dismissedUpdateVersion !== remote) {
      showUpdateBanner(remote, info.url, info.notes);
    }
  } catch {
    /* silent: update check must never disturb normal usage */
  }
}

(async function init() {
  try {
    const ver = chrome.runtime.getManifest?.()?.version;
    if (ver && $('appVersion')) $('appVersion').textContent = `v${ver}`;
  } catch {
    /* ignore */
  }
  await loadSettings();
  await hydrateTmdbCache();
  await loadUiPrefs();
  await loadRecentCids();
  await loadCid({ force: true });
  syncViewChips();
  checkForUpdate();
  try {
    const login = await send('CHECK_LOGIN');
    const cid = $('cidInput').value || '0';
    updateCidRootWarning();
    renderCidName();
    const folder = cidDisplayName(cid);
    setStatus(
      login.loggedIn
        ? (isDriveRootCid(cid)
          ? '已登录 · 当前是网盘根目录，请进入子文件夹后点「同步」再扫描'
          : `已登录 · ${folder || `cid=${cid}`}`)
        : '未登录 115，请先打开 115.com',
    );
  } catch {
    setStatus('准备就绪');
  }
})();
