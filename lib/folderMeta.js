/**
 * Show/movie folder naming with year + TMDB id for stable re-identification.
 * Format (Jellyfin-compatible): `良医 (2017) {tmdb-71712}`
 */

import { cleanFolderTitle, extractCjkTitle } from './pathTitle.js';

function cleanSegment(title) {
  return String(title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '_')
    .slice(0, 180) || 'unknown';
}

/**
 * Build a media folder segment: Title (year) {tmdb-id}
 * Omits missing year / id rather than writing placeholders.
 */
export function formatMediaFolderName(title, year, tmdbId) {
  let name = cleanSegment(title);
  const y = String(year || '').trim();
  if (/^(19|20)\d{2}$/.test(y)) name += ` (${y})`;
  const id = String(tmdbId || '').trim();
  if (/^\d+$/.test(id)) name += ` {tmdb-${id}}`;
  return name;
}

/** Extract TMDB numeric id from folder / file text. */
export function extractTmdbId(text = '') {
  const raw = String(text || '');
  const m = raw.match(
    /(?:\{|\(|\[)\s*tmdb(?:id)?\s*[=:\-]?\s*(\d+)\s*(?:\}|\)|\])/i,
  ) || raw.match(/\btmdb(?:id)?\s*[=:\-]?\s*(\d+)\b/i);
  return m ? m[1] : null;
}

/**
 * Parse title / year / tmdb id from a single folder (or file stem) name.
 * @returns {{ title: string, year: string|null, tmdbId: string|null }}
 */
export function parseFolderMeta(folderName = '') {
  let raw = String(folderName || '').trim();
  let year = null;
  let tmdbId = null;

  // {tmdb-71712} / {tmdb:71712} / [tmdb-71712] / [tmdbid=71712]
  const idMatch = raw.match(
    /(?:\{|\(|\[)\s*tmdb(?:id)?\s*[=:\-]?\s*(\d+)\s*(?:\}|\)|\])/i,
  ) || raw.match(/\btmdb(?:id)?\s*[=:\-]?\s*(\d+)\b/i);
  if (idMatch) {
    tmdbId = idMatch[1];
    raw = raw.replace(idMatch[0], ' ').trim();
  }

  // Trailing / embedded (2017) — also accept `.2017.` / `_2017_` before season markers
  const yearMatch = raw.match(/(?:^|[\s._\-])\(((?:19|20)\d{2})\)\s*$/)
    || raw.match(/\(((?:19|20)\d{2})\)/)
    || raw.match(/(?:^|[\s._\-])((?:19|20)\d{2})(?=[\s._\-]*(?:\{|\[|S\d|$))/i);
  if (yearMatch) {
    year = yearMatch[1];
    raw = raw.replace(yearMatch[0], ' ').trim();
  }

  // Strip leftover braces / season / episode tails so stem titles stay clean
  raw = raw
    .replace(/\{\s*tmdb[^}]*\}/gi, ' ')
    .replace(/\[\s*tmdb[^\]]*\]/gi, ' ')
    .replace(/[. _\-]*[Ss]\d{1,2}[. _\-]*[Ee][Pp]?\d{1,3}.*$/i, ' ')
    .replace(/[. _\-]*第\s*\d+\s*季.*$/i, ' ')
    .replace(/[.\s_-]+/g, ' ')
    .trim();

  // Release packs like `【站点】稻草人[全12集].Strawman.S01.1080p…` → prefer 稻草人
  const original = String(folderName || '').trim();
  const cjk = extractCjkTitle(original) || extractCjkTitle(raw);
  const cleaned = cleanFolderTitle(original);
  let title = raw;
  const looksLikeRelease = /www\.|\.com|WEB-?DL|1080p|720p|BlackTV|全\s*\d+\s*集|简繁|字幕/i.test(title)
    || title.length > 40;
  if (cjk && (looksLikeRelease || !title || title.length > cjk.length * 2)) {
    title = cjk;
  } else if (cleaned && looksLikeRelease && cleaned.length < title.length) {
    title = cleaned;
  }

  return {
    title,
    year,
    tmdbId,
  };
}

/**
 * Walk relative path bottom-up; return best title/year/tmdb from folder names.
 * Skips Season N / region / library roots.
 */
export function metaFromRelPath(relPath = '') {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let best = { title: '', year: null, tmdbId: null, folder: '' };

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (/^(?:Season|Seasons|Saison)\s*\d+$/i.test(part)) continue;
    if (/^S\d{1,2}$/i.test(part)) continue;
    if (/^第\s*\S+\s*季$/.test(part)) continue;
    if (/^(?:剧集|电影|电视剧|动漫|视频|未分类|Movies|Movie|Shows|TV|TV Shows|Anime|Unsorted|Specials)$/i.test(part)) continue;
    if (/^(?:大陆剧|港台剧|日韩剧|欧美剧|其他剧集)$/.test(part)) continue;

    const meta = parseFolderMeta(part);
    // Prefer segment that already carries tmdb id
    if (meta.tmdbId) {
      return { ...meta, folder: part };
    }
    if (!best.title && meta.title) {
      best = { ...meta, folder: part };
    } else if (best.title && meta.year && !best.year) {
      best.year = meta.year;
    }
  }
  return best.title ? best : { title: '', year: null, tmdbId: null, folder: '' };
}
