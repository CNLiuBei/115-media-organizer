/**
 * Extract a useful show/movie title from the parent folder path.
 * e.g. `美剧【良医】1-6季…/[良医 第一季]The.Good.Doctor.S01…` → `良医`
 * e.g. `【站点】/杀手妈咪[全14集]` → `杀手妈咪`
 */

import { extractBracketMeta } from './parser.js';

/** Pull first solid CJK title token from messy release folder names. */
export function extractCjkTitle(text = '') {
  const raw = String(text || '');

  // Prefer titles inside 【良医】 / [良医 第一季]
  const meta = extractBracketMeta(raw);
  if (meta.cnTitle && !isJunkFolderName(meta.cnTitle)) return meta.cnTitle;

  // Also accept short pure CJK inside brackets that extractBracketMeta skipped (groups)
  for (const m of raw.matchAll(/【\s*([^】]+?)\s*】|\[\s*([^\]]+?)\s*\]/g)) {
    const inner = (m[1] || m[2] || '').trim();
    if (/www\.|http|\.com|发布|字幕|\d+\s*G|中字|全\s*\d+\s*集/i.test(inner)) continue;
    const stripped = inner
      .replace(/\s*第\s*[一二三四五六七八九十百零\d]+\s*季\s*/g, '')
      .replace(/[\s·・]+/g, '')
      .trim();
    if (/^[\u4e00-\u9fff]{2,16}$/.test(stripped) && !isJunkFolderName(stripped) && !/的/.test(stripped)) {
      return stripped;
    }
  }

  let t = raw;
  t = t.replace(/【[^】]*】/g, ' ');
  t = t.replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(/\([^)]*\)/g, ' ');
  // Drop region prefixes like 美剧/韩剧 before matching
  t = t.replace(/^(?:美剧|韩剧|日剧|国产剧|港剧|台剧|英剧)\s*/i, '');
  const m = t.match(/[\u4e00-\u9fff]{2,}(?:[\u4e00-\u9fff·・\s]{0,12}[\u4e00-\u9fff]{1,})?/);
  if (!m) return '';
  const hit = stripEpisodePackSuffix(m[0].replace(/[\s·・]+/g, '').trim());
  if (isJunkFolderName(hit)) return '';
  return hit;
}

/** `中头奖还是要上班全10集` / trailing bare `全` → `中头奖还是要上班` */
function stripEpisodePackSuffix(name = '') {
  return String(name || '')
    .replace(/全\s*\d+\s*集$/u, '')
    .replace(/共\s*\d+\s*集$/u, '')
    .replace(/全$/u, '')
    .trim();
}

export function titleFromRelPath(relPath = '') {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  for (let i = parts.length - 1; i >= 0; i--) {
    const raw = parts[i];
    // Site-only banner folder
    if (/^[【\[]/.test(raw) && /www\.|http|\.com|\.net|发布/i.test(raw)) {
      const cjkInBanner = extractCjkTitle(raw);
      if (cjkInBanner) return cjkInBanner;
      continue;
    }

    const cjk = extractCjkTitle(raw);
    if (cjk && !isJunkFolderName(cjk)) return cjk;

    const cleaned = cleanFolderTitle(raw);
    if (!cleaned || isJunkFolderName(cleaned)) continue;
    const trimmed = stripReleaseJunk(cleaned);
    if (trimmed && !isJunkFolderName(trimmed)) return trimmed;
  }
  return null;
}

export function cleanFolderTitle(name = '') {
  let t = String(name || '');
  // Strip organized markers: (2017) {tmdb-71712}
  t = t.replace(/\{\s*tmdb(?:id)?\s*[=:\-]?\s*\d+\s*\}/gi, ' ');
  t = t.replace(/\[\s*tmdb(?:id)?\s*[=:\-]?\s*\d+\s*\]/gi, ' ');
  t = t.replace(/\((?:19|20)\d{2}\)/g, ' ');

  // Keep usable Chinese from brackets via extractCjkTitle first
  const fromBrackets = extractCjkTitle(t);
  if (fromBrackets) return fromBrackets;

  t = t.replace(/【[^】]*】/g, ' ');
  t = t.replace(/\[[^\]]*全\s*\d+\s*集[^\]]*\]/gi, ' ');
  t = t.replace(/\[[^\]]*(中字|字幕|简体|繁体|国语|粤语)[^\]]*\]/gi, ' ');
  t = t.replace(/\[[^\]]*www\.[^\]]+\]/gi, ' ');
  t = t.replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(/\([^\)]*全\s*\d+\s*集[^\)]*\)/gi, ' ');
  t = t.replace(/^(?:美剧|韩剧|日剧|国产剧|港剧|台剧|英剧)\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[_\-.]?\s*全\s*\d+\s*集.*$/i, '').trim();
  t = t.replace(/[_\-.]?\s*共\s*\d+\s*集.*$/i, '').trim();
  t = t.replace(/[_\-.]?\s*1\s*[-~～到至]\s*\d+\s*季.*$/i, '').trim();
  t = stripEpisodePackSuffix(t);
  return stripReleaseJunk(t).slice(0, 120) || '';
}

/** Remove English scene/release tails: `.S01.1080p.WEB-DL...` */
function stripReleaseJunk(name = '') {
  let t = String(name || '').trim();
  t = t.replace(
    /[\s._-]+(?:S\d{1,2}(?:E\d{1,3})?|\d{3,4}p|WEB-?DL|WEBRip|BluRay|HDTV|x264|x265|H\.?264|H\.?265|AAC|DDP|DTS|BlackTV|RARBG|AMZN).*$/i,
    '',
  );
  const cjk = extractCjkTitle(t);
  if (cjk) return cjk;
  t = t.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

function isJunkFolderName(name) {
  const n = String(name || '').trim();
  if (!n || n.length < 2) return true;
  if (/^(剧集|电影|电视剧|动漫|视频|未分类|unsorted|movies?|shows?|tv|season\s*\d+)$/i.test(n)) return true;
  if (/^(大陆剧|港台剧|日韩剧|欧美剧|其他剧集|美剧|韩剧|日剧|英剧|国产剧)$/.test(n)) return true;
  if (/^www\./i.test(n)) return true;
  return false;
}

/**
 * Prefer a short extracted show title over a raw release-folder parse.
 * e.g. meta "【站点】稻草人[全12集].Strawman.S01…" vs extracted "稻草人"
 */
export function preferCleanPathTitle(metaTitle, extractedTitle) {
  const a = String(metaTitle || '').trim();
  const b = String(extractedTitle || '').trim();
  if (!a) return b || null;
  if (!b) return a;
  const aMessy = /www\.|\.com|WEB-?DL|1080p|720p|BlackTV|全\s*\d+\s*集|简繁|字幕|S\d{1,2}(?:E\d{1,3})?/i.test(a)
    || a.length > 40;
  if (aMessy && b) return b;
  if (/[\u4e00-\u9fff]/.test(b) && a.length > b.length + 6) return b;
  return a;
}

/** Prefer Chinese folder title when filename title is mostly Latin. */
export function preferSearchTitle(filenameTitle, pathTitle) {
  const file = String(filenameTitle || '').trim();
  const path = String(pathTitle || '').trim();
  if (!path) return file;
  if (!file) return path;
  const fileCjk = (file.match(/[\u4e00-\u9fff]/g) || []).length;
  const pathCjk = (path.match(/[\u4e00-\u9fff]/g) || []).length;
  if (pathCjk >= 2 && pathCjk >= fileCjk) return path;
  if (fileCjk >= 2) return file;
  return file;
}
