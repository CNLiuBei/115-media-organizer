import { fileId, fileName, fileSize } from './api115.js';
import { filterMediaFiles, attachCompanions, getMediaType, basenameNoExt } from './filter.js';
import { parseMediaFilename } from './parser.js';
import { buildRenamePlan, sanitizePathSegment } from './rename.js';
import { detectRegion } from './region.js';
import { preferCleanPathTitle, preferSearchTitle, titleFromRelPath } from './pathTitle.js';
import { metaFromRelPath, parseFolderMeta, extractTmdbId } from './folderMeta.js';

/**
 * Build preview rows from 115 file list items.
 */
export function buildPreviewRows(allItems, settings, { enrichMap } = {}) {
  const media = filterMediaFiles(allItems, settings, { primaryOnly: true });
  const companions = (settings.includeSubtitle || settings.includeImage)
    ? attachCompanions(media, allItems).filter((item) => {
      const type = item._mediaType;
      if (type === 'subtitle' && !settings.includeSubtitle) return false;
      if (type === 'image' && !settings.includeImage) return false;
      return true;
    })
    : [];

  const rows = [];
  const videoRowsById = new Map();

  for (const item of media) {
    const name = fileName(item);
    const type = getMediaType(name);
    const relPath = item._relPath || '';
    let parsed = parseMediaFilename(name, { relPath });
    const localTitle = parsed.title;
    const pathMeta = metaFromRelPath(relPath);
    const fileMeta = parseFolderMeta(basenameNoExt(name));
    const extractedPathTitle = titleFromRelPath(relPath);
    // Prefer extracted CJK show title over messy release-folder parse
    const pathTitle = preferCleanPathTitle(pathMeta.title, extractedPathTitle);
    parsed.pathTitle = pathTitle || null;
    // Year / TMDB: path folder first, then filename markers
    if (pathMeta.year && !parsed.year) parsed.year = pathMeta.year;
    if (!parsed.year && fileMeta.year) parsed.year = fileMeta.year;
    const tid = pathMeta.tmdbId || fileMeta.tmdbId || extractTmdbId(name) || extractTmdbId(relPath);
    if (tid) parsed.tmdbId = tid;
    // Organized folder title wins when it carries tmdb id (stable series name)
    if (pathMeta.tmdbId && pathMeta.title) {
      if (
        /[\u4e00-\u9fff]/.test(pathMeta.title)
        || !parsed.title
        || parsed.title === 'unknown'
      ) {
        if (
          /[A-Za-z]{3,}/.test(parsed.title || '')
          && !/[\u4e00-\u9fff]/.test(parsed.title || '')
        ) {
          parsed.originalTitle = parsed.originalTitle || parsed.title;
        }
        parsed.title = pathMeta.title;
      }
    }
    // Keep English release name when path provides Chinese show title
    if (
      pathTitle
      && /[\u4e00-\u9fff]/.test(pathTitle)
      && /[A-Za-z]{3,}/.test(parsed.title || '')
      && !/[\u4e00-\u9fff]/.test(parsed.title || '')
    ) {
      parsed.originalTitle = parsed.originalTitle || parsed.title;
    }
    parsed.searchTitle = preferSearchTitle(parsed.title, parsed.pathTitle);
    parsed.relPath = relPath || '';
    let enrich = enrichMap?.get(fileId(item));
    // SxxExx locked as TV — never apply a movie TMDB hit (Strawman movie vs 稻草人 series)
    if (
      enrich
      && enrich.kind === 'movie'
      && parsed.kind === 'tv'
      && parsed.season != null
      && parsed.episode != null
    ) {
      enrich = null;
    }
    if (enrich) {
      parsed = {
        ...parsed,
        localTitle,
        pathTitle: parsed.pathTitle,
        searchTitle: parsed.searchTitle,
        title: enrich.title || parsed.title,
        year: enrich.year || parsed.year,
        kind: enrich.kind || parsed.kind,
        metaSource: enrich.source,
        metaScore: enrich.score,
        tmdbId: enrich.id || parsed.tmdbId,
        originalTitle: enrich.originalTitle || parsed.originalTitle,
        originCountries: enrich.originCountries || parsed.originCountries,
        originalLanguage: enrich.originalLanguage || parsed.originalLanguage,
        isAnime: enrich.isAnime || parsed.isAnime,
        posterUrl: enrich.posterUrl || parsed.posterUrl,
        calibrated: enrich.title && enrich.title !== localTitle,
      };
      // Episode markers always win over metadata kind
      if (parsed.season != null && parsed.episode != null) parsed.kind = 'tv';
    } else {
      parsed.localTitle = localTitle;
      // Already organized with {tmdb-id}: treat as calibrated before network round-trip
      if (parsed.tmdbId) {
        parsed.metaSource = 'path-tmdb';
        parsed.metaScore = 1;
      }
    }
    if (parsed.kind === 'tv') {
      // 地区：TMDB 产地优先（见 detectRegion）
      parsed.region = detectRegion({
        filename: name,
        title: parsed.title,
        relPath,
        tags: parsed.tags,
        originCountries: parsed.originCountries,
        originalLanguage: parsed.originalLanguage,
        isAnime: parsed.isAnime,
      });
    }
    const plan = buildRenamePlan(parsed, settings);
    const row = {
      id: fileId(item),
      selected: true,
      originalName: name,
      size: fileSize(item),
      mediaType: type,
      parsed,
      newName: plan.newName,
      pathSegments: plan.pathSegments,
      pathDisplay: plan.pathDisplay,
      kind: plan.kind,
      companionOf: null,
      item,
      alreadyOrganized: false,
    };
    row.alreadyOrganized = isAlreadyOrganized(row);
    // Already at target → default off so re-scan won't re-move
    if (row.alreadyOrganized) row.selected = false;
    rows.push(row);
    if (type === 'video') videoRowsById.set(row.id, row);
  }

  for (const item of companions) {
    const parent = videoRowsById.get(item._companionOf);
    if (!parent) continue;
    const name = fileName(item);
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    const parentBase = basenameNoExt(parent.newName);
    // keep language suffix from original subtitle if present
    const stem = basenameNoExt(name);
    const lang = stem.match(/\.(zh|zh-cn|chs|cht|en|eng|jp|jpn|sc|tc)$/i)?.[0] || '';
    const newName = `${parentBase}${lang}${ext}`;
    rows.push({
      id: fileId(item),
      selected: parent.selected,
      originalName: name,
      size: fileSize(item),
      mediaType: item._mediaType,
      parsed: { ...parent.parsed, ext },
      newName,
      pathSegments: [...parent.pathSegments],
      pathDisplay: parent.pathDisplay,
      kind: parent.kind,
      companionOf: parent.id,
      item,
      alreadyOrganized: parent.alreadyOrganized,
    });
  }

  return rows;
}

function normSeg(s) {
  return String(s || '').trim().toLowerCase();
}

function pathSegsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normSeg(a[i]) !== normSeg(b[i])) return false;
  }
  return true;
}

function isPathSuffix(longSegs, shortSegs) {
  if (!shortSegs.length || shortSegs.length > longSegs.length) return false;
  const offset = longSegs.length - shortSegs.length;
  for (let i = 0; i < shortSegs.length; i++) {
    if (normSeg(longSegs[offset + i]) !== normSeg(shortSegs[i])) return false;
  }
  return true;
}

/**
 * True when file already sits at (or under) the planned destination with the same name.
 * Handles scan-root being above or equal to the media library root.
 */
export function isAlreadyOrganized(row) {
  if (!row) return false;
  const nameSame = String(row.newName || '') === String(row.originalName || '');
  if (!nameSame) return false;

  const planned = (row.pathSegments || []).map((s) => String(s || '').trim()).filter(Boolean);
  const current = String(row.item?._relPath || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Rename-only / empty path → name match is enough
  if (!planned.length) return true;

  if (
    pathSegsEqual(planned, current)
    || isPathSuffix(current, planned)
    || isPathSuffix(planned, current)
  ) {
    return true;
  }

  // Strong signal: same {tmdb-id} folder + matching Season
  const tid = String(row.parsed?.tmdbId || '').trim();
  if (/^\d+$/.test(tid)) {
    const marker = `{tmdb-${tid}}`.toLowerCase();
    const inCurrent = current.some((s) => s.toLowerCase().includes(marker));
    const inPlanned = planned.some((s) => s.toLowerCase().includes(marker));
    if (inCurrent && inPlanned) {
      if (row.kind === 'tv') {
        const curSeason = current.find((s) => /^Season\s*\d+$/i.test(s));
        const planSeason = planned.find((s) => /^Season\s*\d+$/i.test(s));
        if (curSeason && planSeason) {
          return normSeg(curSeason) === normSeg(planSeason);
        }
      }
      return true;
    }
  }
  return false;
}

/** Refresh alreadyOrganized flags after rename/path edits. */
export function refreshOrganizeStatus(rows) {
  for (const row of rows || []) {
    if (row.companionOf) continue;
    row.alreadyOrganized = isAlreadyOrganized(row);
    for (const c of (rows || []).filter((r) => r.companionOf === row.id)) {
      c.alreadyOrganized = row.alreadyOrganized;
    }
  }
  return rows;
}

function pathKey(segments) {
  return (segments || []).map((s) => String(s || '').trim()).filter(Boolean).join('\u0001');
}

/**
 * Execute rename + move in batches (like official multi-select).
 * 1) ensurePath once per unique destination
 * 2) one/few batch_rename calls
 * 3) one move per destination folder (many fids)
 *
 * @param {object} api createApi115 instance
 * @param {object[]} rows
 * @param {object} options
 */
export async function executeOrganize(api, rows, {
  rootCid = '0',
  moveFiles = true,
  delayMs = 80,
  onProgress,
  signal,
  shouldStop,
} = {}) {
  // Skip empty / bogus ids (fid "0" is not a real file)
  const selected = rows.filter((r) => r.selected && r.id && String(r.id) !== '0');
  const total = selected.length;
  const results = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stopped = () => !!(signal?.aborted || (typeof shouldStop === 'function' && shouldStop()));
  const pause = async () => {
    if (delayMs > 0) await sleep(delayMs);
  };

  if (!total) return results;

  // Group by destination path
  /** @type {Map<string, { segments: string[], rows: object[] }>} */
  const groups = new Map();
  for (const row of selected) {
    const key = moveFiles ? pathKey(row.pathSegments) : '';
    if (!groups.has(key)) {
      groups.set(key, {
        segments: moveFiles ? (row.pathSegments || []) : [],
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }

  // Same destination + same newName → later rows would overwrite on 115; fail them early
  const claimedTargets = new Set();
  for (const [key, group] of groups) {
    for (const row of group.rows) {
      const name = String(row.newName || row.originalName || '').trim().toLowerCase();
      if (!name) continue;
      const targetKey = `${key}\u0001${name}`;
      if (claimedTargets.has(targetKey)) {
        results.push({ id: row.id, ok: false, error: `目标重名冲突: ${row.newName || row.originalName}` });
        onProgress?.({
          phase: 'error',
          done: results.length,
          total,
          row,
          ok: false,
          error: `目标重名冲突: ${row.newName || row.originalName}`,
        });
      } else {
        claimedTargets.add(targetKey);
      }
    }
  }
  const blockedIds = new Set(results.filter((r) => !r.ok).map((r) => r.id));

  onProgress?.({
    phase: 'plan',
    done: 0,
    total,
    groupCount: groups.size,
  });

  // Resolve destination cid per group (cached ensurePath)
  /** @type {Map<string, string>} */
  const destByKey = new Map();
  let gi = 0;
  for (const [key, group] of groups) {
    if (stopped()) {
      onProgress?.({ phase: 'aborted', done: results.length, total });
      break;
    }
    gi += 1;
    onProgress?.({
      phase: 'mkdir',
      done: 0,
      total,
      groupIndex: gi,
      groupCount: groups.size,
      path: group.segments.join('/'),
    });
    try {
      const dest = moveFiles && group.segments.length
        ? await api.ensurePath(group.segments, rootCid)
        : String(rootCid || '0');
      destByKey.set(key, dest);
    } catch (err) {
      for (const row of group.rows) {
        results.push({ id: row.id, ok: false, error: err.message || String(err) });
        onProgress?.({
          phase: 'error',
          done: results.length,
          total,
          row,
          ok: false,
          error: err.message || String(err),
        });
      }
      destByKey.set(key, null);
    }
    await pause();
  }

  // Batch rename all that need it (skip collision-blocked ids)
  const renameMap = {};
  if (!stopped()) {
    for (const row of selected) {
      if (blockedIds.has(row.id)) continue;
      if (row.newName && row.newName !== row.originalName) {
        renameMap[row.id] = row.newName;
      }
    }
  }
  const renameCount = Object.keys(renameMap).length;
  if (renameCount && !stopped()) {
    onProgress?.({ phase: 'rename', done: 0, total, renameCount });
    try {
      if (typeof api.batchRenameChunked === 'function') {
        await api.batchRenameChunked(renameMap, { chunkSize: 50 });
      } else {
        await api.batchRename(renameMap);
      }
      onProgress?.({ phase: 'rename_done', done: 0, total, renameCount });
    } catch (err) {
      // Fall back to per-file rename so one failure doesn't block the batch
      onProgress?.({ phase: 'rename_fallback', done: 0, total, error: err.message || String(err) });
      for (const [id, name] of Object.entries(renameMap)) {
        if (stopped()) break;
        try {
          await api.batchRename({ [id]: name });
        } catch (e2) {
          const row = selected.find((r) => r.id === id);
          results.push({ id, ok: false, error: e2.message || String(e2) });
          onProgress?.({
            phase: 'error',
            done: results.length,
            total,
            row,
            ok: false,
            error: e2.message || String(e2),
          });
        }
        await pause();
      }
    }
    await pause();
  }

  const failedIds = new Set(results.filter((r) => !r.ok).map((r) => r.id));

  // Batch move per destination
  if (moveFiles && !stopped()) {
    gi = 0;
    for (const [key, group] of groups) {
      if (stopped()) {
        onProgress?.({ phase: 'aborted', done: results.length, total });
        break;
      }
      gi += 1;
      const destCid = destByKey.get(key);
      if (!destCid) continue;
      const ids = group.rows.map((r) => r.id).filter((id) => !failedIds.has(id));
      if (!ids.length) continue;

      onProgress?.({
        phase: 'move',
        done: results.filter((r) => r.ok).length,
        total,
        groupIndex: gi,
        groupCount: groups.size,
        moveCount: ids.length,
        path: group.segments.join('/') || '(root)',
        destCid,
      });

      try {
        if (typeof api.moveFilesBatched === 'function') {
          await api.moveFilesBatched(ids, destCid, { chunkSize: 100 });
        } else {
          await api.moveFiles(ids, destCid);
        }
        for (const row of group.rows) {
          if (failedIds.has(row.id)) continue;
          results.push({ id: row.id, ok: true });
          onProgress?.({
            phase: 'done',
            done: results.length,
            total,
            row,
            ok: true,
          });
        }
      } catch (err) {
        // Fallback: move one-by-one for this group
        onProgress?.({
          phase: 'move_fallback',
          done: results.length,
          total,
          error: err.message || String(err),
          path: group.segments.join('/'),
        });
        for (const row of group.rows) {
          if (failedIds.has(row.id)) continue;
          try {
            await api.moveFiles([row.id], destCid);
            results.push({ id: row.id, ok: true });
            onProgress?.({ phase: 'done', done: results.length, total, row, ok: true });
          } catch (e2) {
            results.push({ id: row.id, ok: false, error: e2.message || String(e2) });
            onProgress?.({
              phase: 'error',
              done: results.length,
              total,
              row,
              ok: false,
              error: e2.message || String(e2),
            });
          }
          await pause();
        }
      }
      await pause();
    }
  } else {
    for (const row of selected) {
      if (failedIds.has(row.id)) continue;
      results.push({ id: row.id, ok: true });
      onProgress?.({ phase: 'done', done: results.length, total, row, ok: true });
    }
  }

  onProgress?.({
    phase: 'finished',
    done: results.length,
    total,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });

  return results;
}

export function summarizeRows(rows) {
  const selected = rows.filter((r) => r.selected);
  const byKind = { tv: 0, movie: 0, unknown: 0 };
  for (const r of selected) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  }
  return {
    total: rows.length,
    selected: selected.length,
    byKind,
  };
}

/** Detect duplicate SxxExx within a group of rows. */
export function findDuplicateEpisodes(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    if (row.companionOf || row.parsed?.kind !== 'tv') continue;
    const s = row.parsed.season ?? 1;
    const e = row.parsed.episode ?? 0;
    if (!e) continue;
    const key = `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([key, n]) => ({ key, count: n }));
}

/**
 * Find missing episode numbers within contiguous ranges per season.
 * e.g. E01,E02,E04 → missing E03 (ignores gaps larger than maxGap).
 */
export function findEpisodeGaps(rows = [], { maxGap = 20 } = {}) {
  /** @type {Map<number, Set<number>>} */
  const bySeason = new Map();
  for (const row of rows) {
    if (row.companionOf || row.parsed?.kind !== 'tv') continue;
    const s = Number(row.parsed.season ?? 1);
    const e = Number(row.parsed.episode ?? 0);
    if (!e) continue;
    if (!bySeason.has(s)) bySeason.set(s, new Set());
    bySeason.get(s).add(e);
    if (row.parsed.episodeEnd) {
      const end = Number(row.parsed.episodeEnd);
      for (let i = e; i <= end; i++) bySeason.get(s).add(i);
    }
  }
  const gaps = [];
  for (const [season, set] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
    const list = [...set].sort((a, b) => a - b);
    if (list.length < 2) continue;
    const min = list[0];
    const max = list[list.length - 1];
    if (max - min > maxGap * 3) continue; // too sparse, likely multi-pack noise
    for (let e = min; e <= max; e++) {
      if (set.has(e)) continue;
      // only report small holes
      const prev = list.filter((x) => x < e).pop();
      const next = list.find((x) => x > e);
      if (prev != null && next != null && next - prev <= maxGap) {
        gaps.push({
          key: `S${String(season).padStart(2, '0')}E${String(e).padStart(2, '0')}`,
          season,
          episode: e,
        });
      }
    }
  }
  return gaps;
}

/** Sort primary media rows by season/episode then name. */
export function sortRowsByEpisode(rows = []) {
  return [...rows].sort((a, b) => {
    if (a.companionOf && !b.companionOf) return 1;
    if (!a.companionOf && b.companionOf) return -1;
    const as = Number(a.parsed?.season ?? 0);
    const bs = Number(b.parsed?.season ?? 0);
    if (as !== bs) return as - bs;
    const ae = Number(a.parsed?.episode ?? 0);
    const be = Number(b.parsed?.episode ?? 0);
    if (ae !== be) return ae - be;
    return String(a.originalName || '').localeCompare(String(b.originalName || ''), 'zh');
  });
}

/**
 * Selected rows that share the same destination path + newName
 * (includes companions — two .zh.srt can overwrite each other on 115).
 * @returns {Array<{ path: string, name: string, ids: string[], count: number }>}
 */
export function findDestinationCollisions(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row.selected) continue;
    const path = (row.pathSegments || []).join('/');
    const name = String(row.newName || '').trim().toLowerCase();
    if (!name) continue;
    const key = `${path}\u0001${name}`;
    if (!map.has(key)) map.set(key, { path, name: row.newName, ids: [] });
    map.get(key).ids.push(row.id);
  }
  return [...map.values()]
    .filter((x) => x.ids.length > 1)
    .map((x) => ({ ...x, count: x.ids.length }));
}

export { sanitizePathSegment };
