import { DEFAULT_SETTINGS, FOLDER_LAYOUTS, STORAGE_KEYS } from '../lib/types.js';
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
import { resolveTargetRootCid } from '../lib/folderOptions.js';
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
};

const UI_PREFS_KEY = 'sidepanelUiPrefs';

const api = createApi115(async (url, init) => fetch(url, init));

function log(msg, level = 'info') {
  const el = $('log');
  const ts = new Date().toLocaleTimeString();
  const prefix = level === 'error' ? '✗' : level === 'ok' ? '✓' : '·';
  el.textContent += `[${ts}] ${prefix} ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(text) {
  $('statusLine').textContent = text;
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
  const current = sel.value || state.settings.folderLayout || 'standard';
  sel.innerHTML = '';
  for (const [key, layout] of Object.entries(FOLDER_LAYOUTS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = layout.label;
    sel.appendChild(opt);
  }
  sel.value = FOLDER_LAYOUTS[current] ? current : 'standard';
}

function formatTargetLabel(name, cid) {
  const n = (name || '').trim() || (cid === '0' ? '根目录' : `目录 ${cid}`);
  return n;
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
  $('enableMeta').checked = !!s.enableMetadata;
  $('skipCalibrateOrganized').checked = s.skipCalibrateOrganized !== false;
  $('moveFiles').checked = s.moveFiles !== false;
  $('cleanEmptyFolders').checked = s.cleanEmptyFolders !== false;
  $('folderLayout').value = FOLDER_LAYOUTS[s.folderLayout] ? s.folderLayout : 'standard';
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
    const opt = document.createElement('option');
    opt.value = String(item.cid);
    const label = item.name ? `${item.name} (${item.cid})` : `cid=${item.cid}`;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
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
  const key = $('folderLayout').value || 'standard';
  const layout = FOLDER_LAYOUTS[key] || FOLDER_LAYOUTS.standard;
  $('folderLayoutHint').textContent = layout.desc || '';
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
    folderLayout: $('folderLayout').value || 'standard',
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
    folderLayout: $('folderLayout').value || 'standard',
    targetMode: $('targetMode').value === 'cid' ? 'cid' : 'scan',
    targetCid: $('targetCid').value.trim() || '0',
    targetCidName: state.settings.targetCidName || '',
    targetBasePath: $('targetBasePath').value.trim(),
  };
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
    const lang = stem.match(/\.(zh|zh-cn|chs|cht|en|eng|jp|jpn|sc|tc)$/i)?.[0] || '';
    row.newName = `${parentBase}${lang}${ext}`;
    row.pathSegments = [...parent.pathSegments];
    row.pathDisplay = parent.pathDisplay;
    row.kind = parent.kind;
  }
  refreshOrganizeStatus(state.rows);
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
  try {
    const result = await send('REFRESH_CID').catch(() => send('GET_CID'));
    const cid = result?.cid != null ? String(result.cid) : null;
    if (cid == null) return null;
    state.autoCid = cid;
    if (force || !state.cidDirty) {
      $('cidInput').value = cid;
      state.rootCid = cid;
      if (force) state.cidDirty = false;
    }
    if (!quiet) setStatus(`已同步目录 cid=${$('cidInput').value}${result?.source ? ` (${result.source})` : ''}`);
    return cid;
  } catch {
    /* ignore */
  }
  return null;
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
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = row.kind === kind || row.parsed?.kind === kind;
    for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
      c.selected = row.selected;
    }
  }
  renderTable();
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
    const parent = state.rows.find((r) => r.id === c.companionOf);
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

function posterHtml(url, title, { tmdbId, kind } = {}) {
  const img = url
    ? `<img class="poster" src="${escapeAttr(url)}" alt="${escapeAttr(title || '')}" loading="lazy" referrerpolicy="no-referrer" />`
    : '<div class="poster poster-empty" title="无海报"></div>';
  const tid = String(tmdbId || '').trim();
  if (!/^\d+$/.test(tid)) return img;
  const type = kind === 'movie' ? 'movie' : 'tv';
  const href = `https://www.themoviedb.org/${type}/${tid}`;
  return `<a class="poster-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="打开 TMDB">${img}</a>`;
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

function setViewFilter(view) {
  if (!view || view === state.viewFilter) return;
  state.viewFilter = view;
  syncViewChips();
  saveUiPrefs({ viewFilter: state.viewFilter });
  renderTable();
}

async function loadUiPrefs() {
  try {
    const data = await chrome.storage.local.get(UI_PREFS_KEY);
    const prefs = data[UI_PREFS_KEY] || {};
    if (prefs.organizeOpen) $('organizeBox').open = true;
    if (prefs.logOpen === false) {
      const logEl = document.querySelector('details.log');
      if (logEl) logEl.open = false;
    }
    if (prefs.viewFilter) state.viewFilter = prefs.viewFilter;
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
    all: textMatched.length,
    need: textMatched.filter((g) => groupMatchesView(g, 'need', collideIds)).length,
    done: textMatched.filter((g) => groupMatchesView(g, 'done', collideIds)).length,
    low: textMatched.filter((g) => groupMatchesView(g, 'low', collideIds)).length,
    conflict: textMatched.filter((g) => groupMatchesView(g, 'conflict', collideIds)).length,
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

  const tmdbDelay = Math.min(Math.max(Number(state.settings.requestDelayMs) || 200, 120), 250);
  const parsedList = [...byKey.values()].map((v) => v.parsed);
  const knownIds = parsedList.filter((p) => /^\d+$/.test(String(p?.tmdbId || '').trim())).length;
  if (knownIds && !quiet) log(`其中 ${knownIds} 部按 TMDB ID 拉取`);

  let aborted = false;
  const resultMap = await calibrateTitles(fetch, settings, parsedList, {
    delayMs: tmdbDelay,
    concurrency: knownIds === parsedList.length ? 4 : 3,
    signal,
    onProgress: ({ index, total, title, error, aborted: calAbort }) => {
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
  for (const [key, { ids, parsed }] of byKey) {
    const hit = resultMap.get(key);
    if (!hit) continue;
    hitCount += 1;
    const label = parsed.searchTitle || parsed.pathTitle || parsed.title;
    for (const id of ids) {
      const row = state.rows.find((r) => r.id === id);
      if (!row) continue;
      row.parsed = applyEnrichToParsed(row.parsed, hit, row.originalName);
      row.kind = row.parsed.kind;
      for (const c of state.rows.filter((r) => r.companionOf === id)) {
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
  return { hitCount, total: byKey.size, aborted };
}

function renderTable() {
  const tbody = $('tbody');
  if (!state.rows.length) {
    tbody.innerHTML = `
      <tr class="empty">
        <td colspan="3">
          <div class="empty-state">
            <strong>还没有扫描结果</strong>
            <p>确认上方目录 CID 后点击「扫描」。可先展开「整理目标」选择输出结构。</p>
          </div>
        </td>
      </tr>`;
    $('btnRun').disabled = true;
    $('btnSelectAll').disabled = true;
    $('btnSelectNone').disabled = true;
    $('btnSelectVisible').disabled = true;
    $('btnSelectNeed').disabled = true;
    $('btnSelectTv').disabled = true;
    $('btnSelectMovie').disabled = true;
    $('btnSelectLow').disabled = true;
    $('btnExpandAll').disabled = true;
    $('btnCollapseAll').disabled = true;
    $('btnRecalibrate').disabled = true;
    $('btnCopyPlan').disabled = true;
    $('btnRetryFailed').disabled = true;
    $('btnRetryFailed').hidden = true;
    $('summary').hidden = true;
    $('toolsPanel').hidden = true;
    syncViewChips(null);
    return;
  }

  $('toolsPanel').hidden = false;
  const summary = summarizeRows(state.rows);
  const listCtx = getListContext();
  const { groups, collisions, collideIds, visibleGroups } = listCtx;
  const already = state.rows.filter((r) => !r.companionOf && r.alreadyOrganized).length;
  const need = state.rows.filter((r) => !r.companionOf && !r.alreadyOrganized).length;
  const low = state.rows.filter((r) => isLowConfidence(r)).length;
  const selSize = selectedSizeLabel();
  $('summary').hidden = false;
  syncViewChips(listCtx);
  $('summaryText').textContent =
    `共 ${summary.total} 项，已选 ${summary.selected}` +
    (selSize ? `（${selSize}）` : '') +
    ` · ${groups.length} 部` +
    (visibleGroups.length !== groups.length ? ` · 显示 ${visibleGroups.length}` : '') +
    ` · 待整理 ${need} · 已在位 ${already}` +
    (low ? ` · 低置信 ${low}` : '') +
    (collisions.length ? ` · 冲突 ${collisions.length}` : '');

  tbody.innerHTML = '';
  if (!visibleGroups.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="3">当前筛选没有匹配条目，试试「全部」或清空搜索</td></tr>';
  }
  for (const group of visibleGroups) {
    const primary = group.rows.find((r) => !r.companionOf) || group.rows[0];
    const videos = group.rows.filter((r) => !r.companionOf);
    const multi = videos.length > 1;
    const collapsed = multi
      ? (state.groupCollapsed.has(group.key) ? state.groupCollapsed.get(group.key) : true)
      : false;
    if (multi) state.groupCollapsed.set(group.key, collapsed);

    const allSelected = videos.every((r) => r.selected);
    const someSelected = videos.some((r) => r.selected);
    const title = primary.parsed?.title || seriesQueryTitle(primary.parsed) || primary.originalName;
    const region = primary.parsed?.region || '';
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
      primary.parsed?.tmdbId ? `tmdb-${primary.parsed.tmdbId}` : '',
      groupDone ? '已在位' : '',
      groupLow ? '低置信' : '',
      dups.length ? `重复 ${dups.map((d) => d.key).join(',')}` : '',
      gaps.length
        ? `缺集 ${gaps.slice(0, 6).map((g) => g.key).join(',')}${gaps.length > 6 ? '…' : ''}`
        : '',
      groupCollide ? '路径冲突' : '',
    ].filter(Boolean).join(' · ');
    const calib = calibrationHint(primary.parsed);

    // Series header
    const head = document.createElement('tr');
    head.className = `group-head${collapsed ? ' is-collapsed' : ''}${groupDone ? ' is-done' : ''}${groupLow ? ' is-low' : ''}${dups.length || groupCollide ? ' is-dup' : ''}${gaps.length ? ' is-gap' : ''}`;
    head.dataset.group = group.key;
    head.innerHTML = `
      <td class="col-check">
        <input type="checkbox" data-role="group-select" data-group="${escapeAttr(group.key)}"
          ${allSelected ? 'checked' : ''} ${!allSelected && someSelected ? 'data-indeterminate="1"' : ''} />
      </td>
      <td class="col-work">
        <div class="work-cell">
          ${posterHtml(poster, title, { tmdbId: primary.parsed?.tmdbId, kind })}
          <div class="group-title-block">
            <div class="group-title-row">
              ${multi ? `<button type="button" class="group-toggle" data-role="group-toggle" data-group="${escapeAttr(group.key)}" aria-expanded="${!collapsed}">${collapsed ? '▶' : '▼'}</button>` : '<span class="group-toggle-spacer"></span>'}
              <div class="group-title-edit">
                <input type="text" class="group-title-input" data-role="group-title" data-group="${escapeAttr(group.key)}" value="${escapeAttr(title)}" title="修改片名后整组路径/文件名会重算" />
                <input type="text" class="group-year-input" data-role="group-year" data-group="${escapeAttr(group.key)}" value="${escapeAttr(year)}" placeholder="年" maxlength="4" title="年份" />
                <input type="text" class="group-tmdb-input" data-role="group-tmdbid" data-group="${escapeAttr(group.key)}" value="${escapeAttr(primary.parsed?.tmdbId || '')}" placeholder="ID" title="手动指定 TMDB ID 后回车应用" inputmode="numeric" />
              </div>
            </div>
            <div class="kind-inline">
              <select class="kind-select" data-role="group-kind" data-group="${escapeAttr(group.key)}" title="切换类型并重算路径">
                <option value="tv" ${kind === 'tv' ? 'selected' : ''}>剧集</option>
                <option value="movie" ${kind === 'movie' ? 'selected' : ''}>电影</option>
                <option value="unknown" ${kind === 'unknown' ? 'selected' : ''}>其他</option>
              </select>
              ${kind === 'tv' ? `<select class="region-select" data-role="group-region" data-group="${escapeAttr(group.key)}" title="覆盖地区分类">${regionOpts}</select>` : ''}
            </div>
            <div class="muted meta-line">${escapeHtml(metaLine)}${calib || '<span class="muted"> · 未校准</span>'}</div>
          </div>
        </div>
      </td>
      <td class="col-plan">
        <div class="plan-stack">
          <input type="text" class="plan-path" data-role="group-path" data-group="${escapeAttr(group.key)}" value="${escapeAttr(pathSample)}" ${!$('moveFiles').checked ? 'disabled' : ''} title="${escapeAttr(pathSample || '目标路径')}" placeholder="目标路径" />
          <div class="muted plan-sub">${multi ? `${videos.length} 个文件` : `<span class="plan-name-preview" title="${escapeAttr(primary.newName)}">${escapeHtml(primary.newName)}</span>`}</div>
        </div>
      </td>
    `;
    const groupCb = head.querySelector('[data-role="group-select"]');
    if (groupCb?.dataset.indeterminate) groupCb.indeterminate = true;
    tbody.appendChild(head);

    // Episode rows (sorted by S/E)
    const ordered = sortRowsByEpisode(group.rows);
    for (const row of ordered) {
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;
      tr.dataset.group = group.key;
      tr.className = `group-child${collapsed ? ' is-hidden' : ''}${row.companionOf ? ' is-companion' : ''}${row.alreadyOrganized ? ' is-done' : ''}${isLowConfidence(row) ? ' is-low' : ''}${collideIds.has(row.id) ? ' is-dup' : ''}`;
      const epHint = parseLabel(row.parsed);
      tr.innerHTML = `
        <td class="col-check"><input type="checkbox" data-role="select" ${row.selected ? 'checked' : ''} /></td>
        <td class="col-work">
          <div class="file-cell">
            <div class="file-name" title="${escapeAttr(row.originalName)}">${escapeHtml(row.originalName)}${row.alreadyOrganized ? ' <span class="tag-done">已在位</span>' : ''}${collideIds.has(row.id) ? ' <span class="tag-warn">冲突</span>' : ''}</div>
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
            <input type="text" class="plan-path" data-role="path" value="${escapeAttr(row.pathDisplay)}" ${!$('moveFiles').checked ? 'disabled' : ''} title="${escapeAttr(row.pathDisplay)}" />
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }
  }

  $('btnRun').disabled = summary.selected === 0 || state.running;
  $('btnSelectAll').disabled = false;
  $('btnSelectNone').disabled = false;
  $('btnSelectVisible').disabled = visibleGroups.length === 0;
  $('btnSelectNeed').disabled = false;
  $('btnSelectTv').disabled = false;
  $('btnSelectMovie').disabled = false;
  $('btnSelectLow').disabled = false;
  $('btnExpandAll').disabled = false;
  $('btnCollapseAll').disabled = false;
  $('btnRecalibrate').disabled = summary.selected === 0 || state.running || state.scanning;
  $('btnCopyPlan').disabled = summary.selected === 0;
  const hasFailed = (state.lastFailedIds || []).length > 0;
  $('btnRetryFailed').hidden = !hasFailed;
  $('btnRetryFailed').disabled = !hasFailed || state.running || state.scanning;
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
  row.selected = tr.querySelector('[data-role="select"]').checked;
  row.newName = tr.querySelector('[data-role="newName"]').value.trim();
  const path = tr.querySelector('[data-role="path"]').value.trim();
  row.pathDisplay = path;
  row.pathSegments = path ? path.split(/[\\/]+/).filter(Boolean) : [];
}

function rowsInGroup(key) {
  return state.rows.filter((row) => {
    const parent = row.companionOf ? state.rows.find((r) => r.id === row.companionOf) : row;
    return parent && groupKeyForRow(parent) === key;
  });
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

async function applyGroupTmdbId(key, rawId) {
  const tid = String(rawId || '').trim().replace(/^tmdb-?/i, '');
  if (!/^\d+$/.test(tid)) {
    log('TMDB ID 应为数字', 'error');
    return;
  }
  const rows = rowsInGroup(key).filter((r) => !r.companionOf);
  if (!rows.length) return;
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
    for (const row of rows) {
      row.parsed.tmdbId = tid;
      row.parsed = applyEnrichToParsed(row.parsed, hit, row.originalName);
      row.parsed.tmdbId = tid;
      row.kind = row.parsed.kind;
      for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
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
  }
}

$('tbody').addEventListener('change', (e) => {
  const role = e.target.dataset?.role;

  if (role === 'group-select') {
    const key = e.target.dataset.group;
    const on = e.target.checked;
    for (const row of rowsInGroup(key)) row.selected = on;
    renderTable();
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

  if (role === 'group-path') {
    const key = e.target.dataset.group;
    const path = e.target.value.trim();
    const base = path ? path.split(/[\\/]+/).filter(Boolean).filter((s) => !/^Season\s+\d+$/i.test(s)) : [];
    for (const row of rowsInGroup(key)) {
      if (row.companionOf) continue;
      const seasonSeg = (row.pathSegments || []).find((s) => /^Season\s+\d+$/i.test(s));
      row.pathSegments = seasonSeg ? [...base, seasonSeg] : [...base];
      row.pathDisplay = row.pathSegments.join('/');
      // companions share path
      for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
        c.pathSegments = [...row.pathSegments];
        c.pathDisplay = row.pathDisplay;
      }
    }
    refreshOrganizeStatus(state.rows);
    renderTable();
    return;
  }

  const tr = e.target.closest('tr');
  if (!tr?.dataset.id) return;
  syncRowFromDom(tr);
  if (role === 'select') {
    const row = state.rows.find((r) => r.id === tr.dataset.id);
    if (row && !row.companionOf) {
      for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
        c.selected = row.selected;
      }
    }
    renderTable();
  } else if (role === 'newName' || role === 'path') {
    refreshOrganizeStatus(state.rows);
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

$('btnSelectAll').addEventListener('click', () => {
  state.rows.forEach((r) => { r.selected = true; });
  renderTable();
});

$('btnSelectNone').addEventListener('click', () => {
  state.rows.forEach((r) => { r.selected = false; });
  renderTable();
});

$('btnSelectVisible').addEventListener('click', () => {
  const { visibleGroups } = getListContext();
  const visibleIds = new Set(
    visibleGroups.flatMap((g) => g.rows.filter((r) => !r.companionOf).map((r) => r.id)),
  );
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = visibleIds.has(row.id);
    for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
      c.selected = row.selected;
    }
  }
  renderTable();
  log(`已勾选可见 ${visibleIds.size} 项`, 'ok');
});

$('btnSelectNeed').addEventListener('click', () => {
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = !row.alreadyOrganized;
    for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
      c.selected = row.selected;
    }
  }
  renderTable();
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
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = isLowConfidence(row);
    for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
      c.selected = row.selected;
    }
  }
  renderTable();
  log(`已勾选低置信 ${state.rows.filter((r) => !r.companionOf && r.selected).length} 项`, 'ok');
});

$('btnRetryFailed').addEventListener('click', () => {
  const failed = new Set(state.lastFailedIds || []);
  if (!failed.size) return;
  for (const row of state.rows) {
    if (row.companionOf) continue;
    row.selected = failed.has(row.id);
    for (const c of state.rows.filter((r) => r.companionOf === row.id)) {
      c.selected = row.selected;
    }
  }
  renderTable();
  log(`已勾选上次失败 ${state.rows.filter((r) => !r.companionOf && r.selected).length} 项，可再次执行整理`, 'ok');
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
    .map((r) => `${r.pathDisplay ? `${r.pathDisplay}/` : ''}${r.newName}`);
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

$('tableFilter')?.addEventListener('input', () => {
  state.tableFilter = $('tableFilter').value || '';
  renderTable();
});

$('viewFilters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-chip');
  if (!btn?.dataset.view) return;
  setViewFilter(btn.dataset.view);
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
  if (e.key === 'Escape') {
    let changed = false;
    if (state.tableFilter) {
      state.tableFilter = '';
      if ($('tableFilter')) $('tableFilter').value = '';
      changed = true;
    }
    if (state.viewFilter && state.viewFilter !== 'all') {
      state.viewFilter = 'all';
      saveUiPrefs({ viewFilter: 'all' });
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
});

$('targetBasePath').addEventListener('change', async () => {
  await saveSettings(readOrganizeFields());
  rebuildPlans();
});

$('btnUseScanAsTarget').addEventListener('click', async () => {
  const cid = $('cidInput').value.trim() || '0';
  $('targetCid').value = cid;
  state.settings.targetCidName = cid === state.autoCid
    ? `当前扫描目录`
    : (cid === '0' ? '根目录' : `目录 ${cid}`);
  updateTargetCidLabel();
  await saveSettings(readOrganizeFields());
  log(`目标目录已设为当前扫描 cid=${cid}`, 'ok');
});

$('enableMeta').addEventListener('change', async () => {
  updateMetaHint();
  if ($('enableMeta').checked && !hasTmdbKey()) {
    log('已勾选 TMDB 校准（未配置 Key，将使用网页搜索）', 'info');
  }
  await saveSettings({ enableMetadata: $('enableMeta').checked });
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
  setStatus(`已选择最近目录 cid=${cid}`);
  log(`切换到最近目录 cid=${cid}`, 'ok');
});

$('cidInput').addEventListener('input', () => {
  state.cidDirty = true;
  state.rootCid = $('cidInput').value.trim() || '0';
});

$('btnRefreshCid').addEventListener('click', async () => {
  state.cidDirty = false;
  const cid = await loadCid({ quiet: false, force: true });
  log(cid != null ? `已从 115 页面同步 cid=${cid}` : '未能读取当前目录 cid', cid != null ? 'ok' : 'error');
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
  $('pickerList').innerHTML = '<li class="empty">加载中…</li>';
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
    $('pickerList').innerHTML = `<li class="empty">${escapeHtml(err.message || String(err))}</li>`;
  }
}

function pathDisplay(path) {
  return (path || []).map((p) => p.name).join(' / ') || '根目录';
}

function renderPicker() {
  const { cid, parentCid, path, folders } = state.picker;
  $('btnPickerUp').disabled = cid === '0';
  $('pickerStatus').textContent = `${folders.length} 个子文件夹`;
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
    list.innerHTML = '<li class="empty">此目录下没有子文件夹</li>';
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
  $('btnScan').disabled = scanning || state.running;
  $('btnStopScan').hidden = !scanning;
  $('btnRun').disabled = scanning || state.running || !state.rows.some((r) => r.selected);
}

function stopScan() {
  if (!state.scanning) return;
  state.scanAbort?.abort();
  log('正在停止扫描…');
  setStatus('正在停止…');
}

async function scan() {
  if (state.running || state.scanning) return;
  if (!state.cidDirty) {
    await loadCid({ quiet: true, force: true });
  }
  const cid = $('cidInput').value.trim() || '0';
  state.rootCid = cid;
  await send('SET_CID', { cid }).catch(() => {});
  await pushRecentCid(cid, cid === state.autoCid ? '当前 115 目录' : `目录 ${cid}`);

  const recursive = $('scanRecursive').checked;
  const abort = new AbortController();
  state.scanAbort = abort;
  const signal = abort.signal;
  let aborted = false;

  setStatus('正在检查登录…');
  log(`扫描目录 cid=${cid}${recursive ? '（含子文件夹）' : '（仅当前层）'}`);
  setScanningUi(true);

  try {
    const login = await send('CHECK_LOGIN');
    if (signal.aborted) throw Object.assign(new Error('已停止扫描'), { name: 'AbortError' });
    if (!login.loggedIn) {
      throw new Error(login.error || '未登录 115，请先在浏览器打开并登录 115.com');
    }
    setStatus(recursive ? '正在递归拉取文件…' : '正在拉取文件列表…');

    const delayMs = Number(state.settings.requestDelayMs) || 250;
    let files;
    if (recursive) {
      files = await api.listAllFilesRecursive(cid, {
        delayMs,
        signal,
        onProgress: (p) => {
          if (p.phase === 'list') {
            setStatus(`扫描中 · 目录 ${p.scannedDirs} · 文件 ${p.files}${p.path ? ` · ${p.path}` : ''}`);
          } else if (p.phase === 'aborted') {
            aborted = true;
            setStatus(`已停止 · 已扫到 ${p.files} 个文件`);
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
    log(
      `筛选：视频 ${filterStats.video} · 音频 ${filterStats.audio}` +
      (filterStats.junk ? ` · 样本/预告 ${filterStats.junk}` : '') +
      ` · 过小 ${filterStats.tooSmall} · 其他 ${filterStats.other} → 可整理 ${filterStats.kept}`,
    );
    if (filterStats.kept === 0 && files.length > 0) {
      const tips = [];
      if (filterStats.tooSmall) tips.push(`有 ${filterStats.tooSmall} 个小于 ${settings.minSizeMB || 0}MB`);
      if (filterStats.other) tips.push(`有 ${filterStats.other} 个非媒体扩展名`);
      if (filterStats.video === 0 && filterStats.audio === 0) tips.push('未识别到视频/音频');
      log(`没有可整理的媒体文件${tips.length ? `（${tips.join('；')}）` : ''}`, 'error');
    }

    await hydrateTmdbCache();
    state.rows = buildPreviewRows(files, settings, { enrichMap: new Map() });
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
    if (aborted) {
      setStatus(`扫描已停止 · ${state.rows.length} 个媒体文件${calHint}${targetHint}`);
      log(`已停止，可整理当前 ${state.rows.length} 项`, 'ok');
    } else {
      setStatus(`扫描完成 · ${state.rows.length} 个媒体文件${calHint}${targetHint}`);
      log(`可整理 ${state.rows.length} 项 · 结构「${FOLDER_LAYOUTS[org.folderLayout]?.label || org.folderLayout}」`, 'ok');
    }
  } catch (err) {
    if (err?.name === 'AbortError' || /已停止/.test(err?.message || '')) {
      setStatus('扫描已停止');
      log('已停止扫描', 'ok');
    } else {
      setStatus('扫描失败');
      log(err.message || String(err), 'error');
    }
  } finally {
    state.scanAbort = null;
    setScanningUi(false);
  }
}

function setOrganizeUi(running) {
  state.running = running;
  $('btnRun').disabled = running || state.scanning || !state.rows.some((r) => r.selected);
  $('btnStopRun').hidden = !running;
  $('btnScan').disabled = running || state.scanning;
  $('btnClean').disabled = running || state.scanning;
}

function stopOrganize() {
  if (!state.running) return;
  if (state.cleanupAbort) {
    state.cleanupAbort.abort();
    log('正在停止清理…');
    setStatus('正在停止清理…');
    return;
  }
  state.organizeAbort?.abort();
  log('正在停止整理…');
  setStatus('正在停止整理…');
}

async function runOrganize() {
  if (state.running || state.scanning) return;
  for (const tr of $('tbody').querySelectorAll('tr[data-id]')) {
    syncRowFromDom(tr);
  }
  const selected = state.rows.filter((r) => r.selected);
  if (!selected.length) return;

  const org = readOrganizeFields();
  const moveFiles = org.moveFiles;
  const targetRoot = resolveTargetRootCid(org.targetMode, state.rootCid || '0', org.targetCid);
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
    (doClean ? '完成后将清理无有效视频文件夹（广告/过小不计，进回收站）。\n' : '') +
    '是否继续？',
  );
  if (!okConfirm) return;

  const abort = new AbortController();
  state.organizeAbort = abort;
  setOrganizeUi(true);
  $('progress').hidden = false;
  $('barFill').style.width = '0%';
  $('progressText').textContent = `0 / ${selected.length}`;

  // Organize uses short pauses between batches only (not per file).
  // Scan/TMDB still honor the higher requestDelayMs setting.
  const delayMs = Math.min(Number(state.settings.requestDelayMs) || 80, 80);

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
      } else if (p.phase === 'mkdir') {
        setStatus(`创建目录 ${p.groupIndex}/${p.groupCount}: ${p.path || '(根)'}`);
        $('progressText').textContent = `建目录 ${p.groupIndex}/${p.groupCount}`;
      } else if (p.phase === 'rename') {
        setStatus(`批量重命名 ${p.renameCount} 个…`);
        $('progressText').textContent = `重命名 ${p.renameCount}`;
      } else if (p.phase === 'rename_fallback') {
        log(`批量重命名失败，改为逐个: ${p.error}`, 'error');
      } else if (p.phase === 'move') {
        setStatus(`批量移动 ${p.moveCount} → ${p.path}`);
        $('progressText').textContent = `移动 ${p.groupIndex}/${p.groupCount}（${p.moveCount} 个）`;
        log(`移动 ${p.moveCount} 个文件 → ${p.path}`, 'ok');
      } else if (p.phase === 'move_fallback') {
        log(`批量移动失败，改为逐个: ${p.error}`, 'error');
      } else if (p.phase === 'done' && p.row) {
        const done = p.done || 0;
        const pct = Math.round((done / selected.length) * 100);
        $('barFill').style.width = `${pct}%`;
        $('progressText').textContent = `${done} / ${selected.length}`;
        if (p.ok) {
          log(
            `${p.row.originalName} → ${p.row.pathDisplay ? `${p.row.pathDisplay}/` : ''}${p.row.newName}`,
            'ok',
          );
        }
      } else if (p.phase === 'error') {
        const done = p.done || 0;
        $('barFill').style.width = `${Math.round((done / selected.length) * 100)}%`;
        $('progressText').textContent = `${done} / ${selected.length}`;
        log(`${p.row?.originalName || '?'}: ${p.error}`, 'error');
        if (/验证|captcha|安全/i.test(p.error || '')) {
          log('可能触发了 115 安全验证，请在网盘页面完成验证后重试', 'error');
        }
      } else if (p.phase === 'finished') {
        $('barFill').style.width = '100%';
        $('progressText').textContent = `${p.ok || 0} 成功 / ${p.failed || 0} 失败`;
      }
    },
  });

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
  const failedIds = results.filter((r) => !r.ok).map((r) => r.id);
  // Items never reported (stopped mid-way) also count as pending retry
  for (const row of selected) {
    if (!row.companionOf && !okIds.has(row.id) && !failedIds.includes(row.id)) {
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
  if (failedIds.length) log(`可点「重试失败」再次勾选 ${failedIds.length} 项`, 'info');

  // Mark succeeded rows as already organized / unselected
  for (const row of state.rows) {
    if (!okIds.has(row.id) && !(row.companionOf && okIds.has(row.companionOf))) continue;
    row.alreadyOrganized = true;
    row.selected = false;
    // After move, treat current path as destination for status
    if (row.pathDisplay) {
      row.item = { ...row.item, _relPath: row.pathDisplay };
      row.originalName = row.newName || row.originalName;
    }
  }
  refreshOrganizeStatus(state.rows);
  renderTable();

  if (doClean && okCount > 0 && !aborted) {
    await runCleanup({ quietConfirm: true, reason: '整理后自动清理' });
  }

  state.organizeAbort = null;
  setOrganizeUi(false);
  setStatus(
    aborted
      ? `整理已停止（成功 ${okCount}）`
      : (failCount ? `完成（${failCount} 失败）` : '整理完成'),
  );
}

/**
 * Delete junk files + folders under current scan cid with no keepable video.
 */
async function runCleanup({ quietConfirm = false, reason = '手动清理' } = {}) {
  const scanCid = String($('cidInput').value.trim() || state.rootCid || '0');
  if (scanCid === '0') {
    log('跳过清理：扫描目录为网盘根目录（cid=0），过于危险', 'error');
    return null;
  }

  if (!quietConfirm) {
    const ok = confirm(
      `将扫描目录 cid=${scanCid} 下：\n` +
      '· 删除广告包 / 预告 / 过小视频等垃圾文件\n' +
      '· 删除整棵子树没有有效视频的文件夹（进回收站）\n' +
      '不会删除扫描根目录本身。是否继续？',
    );
    if (!ok) return null;
  }

  const org = readOrganizeFields();
  const targetRoot = resolveTargetRootCid(org.targetMode, state.rootCid || '0', org.targetCid);
  const delayMs = Number(state.settings.requestDelayMs) || 300;
  const protectCids = [scanCid, targetRoot, '0'];
  const minSizeMB = Number(state.settings.minSizeMB) || 50;
  const abort = new AbortController();
  state.cleanupAbort = abort;

  log(`${reason}：清理垃圾文件 + 无有效视频夹（cid=${scanCid}）…`);
  setStatus('清理中…');
  $('progress').hidden = false;
  $('btnStopRun').hidden = false;
  $('btnStopRun').textContent = '停止清理';

  try {
    const result = await cleanFoldersWithoutVideo(api, scanCid, {
      delayMs,
      minSizeMB,
      purgeJunkFiles: true,
      protectCids,
      signal: abort.signal,
      onProgress: (p) => {
        if (p.phase === 'scan') {
          $('progressText').textContent = `扫描目录 ${p.scanned}`;
          setStatus(`清理扫描: ${p.path || p.cid}`);
        } else if (p.phase === 'junk') {
          $('progressText').textContent = `删垃圾 ${p.done + 1}/${p.total}`;
          setStatus(`删垃圾: ${p.path || p.name}`);
        } else if (p.phase === 'delete') {
          $('progressText').textContent = `删空夹 ${p.done + 1}/${p.total}`;
          setStatus(`删除: ${p.path || p.name}`);
        } else if (p.phase === 'error') {
          log(`删除失败 ${p.path || p.name}: ${p.error}`, 'error');
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
    return null;
  } finally {
    state.cleanupAbort = null;
    $('btnStopRun').textContent = '停止整理';
    if (!$('btnStopRun').hidden && !state.organizeAbort) {
      $('btnStopRun').hidden = true;
    }
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
  try {
    await runCleanup({ quietConfirm: false });
  } finally {
    setOrganizeUi(false);
    $('progress').hidden = true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || area === 'session') {
    const ch = changes[STORAGE_KEYS.lastCid];
    if (ch?.newValue != null) {
      const cid = String(ch.newValue);
      state.autoCid = cid;
      if (!state.cidDirty) {
        $('cidInput').value = cid;
        state.rootCid = cid;
        setStatus(`已同步目录 cid=${cid}`);
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

setInterval(() => {
  if (document.visibilityState === 'visible' && !state.running && !state.cidDirty) {
    loadCid({ quiet: true, force: true });
  }
}, 2000);

(async function init() {
  await loadSettings();
  await hydrateTmdbCache();
  await loadUiPrefs();
  await loadRecentCids();
  await loadCid({ force: true });
  syncViewChips();
  try {
    const login = await send('CHECK_LOGIN');
    const cid = $('cidInput').value || '0';
    setStatus(
      login.loggedIn
        ? `已登录 · 当前目录 cid=${cid}`
        : '未登录 115，请先打开 115.com',
    );
  } catch {
    setStatus('准备就绪');
  }
})();
