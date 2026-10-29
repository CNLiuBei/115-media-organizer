import {
  VIDEO_EXTS,
  AUDIO_EXTS,
  SUBTITLE_EXTS,
  IMAGE_EXTS,
} from './types.js';
import { fileName, fileSize, isFolder } from './api115.js';

export function getExt(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  if (i <= 0 || i === n.length - 1) return '';
  return n.slice(i + 1).toLowerCase();
}

export function getMediaType(name) {
  const ext = getExt(name);
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (SUBTITLE_EXTS.includes(ext)) return 'subtitle';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  return 'other';
}

/** Site promo / fake media dumps (often left after real episodes are moved). */
export function isAdDumpName(name = '') {
  const stem = basenameNoExt(name);
  const compact = String(name || '').replace(/\s+/g, '');
  if (/更多(?:无水印|高品质)|无水印高品质|高品质资源|更多资源请|点击(?:下载|访问)|加(?:微信|QQ|群)|防失联|最新地址|官网地址/i.test(stem)) {
    return true;
  }
  // Entire stem is 【…www.xxx.com…】 / 【…xxx.com】 promo wrapper
  if (
    /^[【\[][^】\]]*www\.[^】\]]+\.(?:com|net|org|cc|top|xyz|vip|me|tv)[^】\]]*[】\]]$/i.test(stem)
    || /^[【\[][^】\]]*(?:\.com|\.net|\.cc|\.top|\.xyz)[^】\]]*[】\]]$/i.test(stem)
  ) {
    if (!/\bS\d{1,2}E\d{1,3}\b/i.test(stem) && !/第\s*\d+\s*[集期]/.test(stem)) return true;
  }
  if (
    /^[【\[][^】\]]*www\.[^】\]]+\.(?:com|net|org|cc|top|xyz|vip)[^】\]]*[】\]]\.\w+$/i.test(compact)
  ) {
    return true;
  }
  return false;
}

/** Sample / trailer / 预告 / 广告包 — skip as primary media (default on). */
export function isJunkMediaName(name = '') {
  const stem = basenameNoExt(name);
  if (/(?:^|[.\s_\-\[(（])(?:sample|trailer|preview|teaser|预告|预告片|花絮|片花|精华|样片)(?:[.\s_\-\])）]|$)/i.test(stem)) {
    return true;
  }
  // Tiny scene samples often named `...-sample.mkv`
  if (/-sample$/i.test(stem) || /\bsample\b/i.test(stem)) return true;
  if (isAdDumpName(name)) return true;
  return false;
}

/**
 * Real episode/movie that should keep a folder from cleanup.
 * Ignores ad dumps, samples, and tiny promo clips.
 * @param {object} item 115 file item
 * @param {{ minSizeMB?: number, absoluteMinBytes?: number }} [opts]
 */
export function isKeepableVideoFile(item, opts = {}) {
  const name = fileName(item);
  if (getMediaType(name) !== 'video') return false;
  if (isJunkMediaName(name)) return false;
  const size = fileSize(item);
  const minMB = opts.minSizeMB != null ? Number(opts.minSizeMB) : 0;
  const minBytes = Math.max(0, minMB) * 1024 * 1024;
  // Even with minSizeMB=0, ignore sub-5MB clips during cleanup (ad stubs)
  const floor = Math.max(minBytes, opts.absoluteMinBytes ?? 5 * 1024 * 1024);
  if (size > 0 && size < floor) return false;
  return true;
}

/**
 * Leftover junk safe to delete during cleanup (ads / samples / tiny promo clips).
 * Does not touch normal subtitles, nfo, or real media.
 * @param {object} item
 * @param {{ minSizeMB?: number, absoluteMinBytes?: number }} [opts]
 */
export function isCleanupJunkFile(item, opts = {}) {
  if (isFolder(item)) return false;
  const name = fileName(item);
  if (isAdDumpName(name) || isJunkMediaName(name)) return true;
  const type = getMediaType(name);
  if (type === 'video' || type === 'audio') {
    // Tiny clips that failed keepable check
    if (!isKeepableVideoFile(item, opts)) {
      const size = fileSize(item);
      const floor = opts.absoluteMinBytes ?? 5 * 1024 * 1024;
      // Only size-based junk when we have a known small size (avoid deleting unknown-size)
      if (size > 0 && size < floor) return true;
    }
  }
  return false;
}

/**
 * Primary media targets (video/audio). Subtitles/images are attached as companions.
 * @param {object[]} items
 * @param {object} settings
 * @param {{ primaryOnly?: boolean }} opts
 */
export function filterMediaFiles(items, settings, opts = {}) {
  const primaryOnly = opts.primaryOnly !== false;
  const minBytes = Math.max(0, Number(settings.minSizeMB || 0)) * 1024 * 1024;
  const skipJunk = settings.skipJunkMedia !== false;
  const allow = {
    video: settings.includeVideo !== false,
    audio: !!settings.includeAudio,
    subtitle: !primaryOnly && !!settings.includeSubtitle,
    image: !primaryOnly && !!settings.includeImage,
  };

  return (items || []).filter((item) => {
    if (isFolder(item)) return false;
    const name = fileName(item);
    const type = getMediaType(name);
    if (type === 'other' || !allow[type]) return false;
    if (skipJunk && (type === 'video' || type === 'audio') && isJunkMediaName(name)) return false;
    // 体积未知(0)时不过滤，避免接口缺 size 字段导致全部被丢掉
    if ((type === 'video' || type === 'audio') && minBytes > 0) {
      const size = fileSize(item);
      if (size > 0 && size < minBytes) return false;
    }
    return true;
  });
}

/** Explain why scanned files did not become preview rows. */
export function summarizeFilter(items, settings) {
  const list = items || [];
  const minBytes = Math.max(0, Number(settings.minSizeMB || 0)) * 1024 * 1024;
  const skipJunk = settings.skipJunkMedia !== false;
  const stats = {
    total: list.length,
    folder: 0,
    other: 0,
    tooSmall: 0,
    junk: 0,
    video: 0,
    audio: 0,
    subtitle: 0,
    image: 0,
    kept: 0,
  };
  for (const item of list) {
    if (isFolder(item)) {
      stats.folder += 1;
      continue;
    }
    const name = fileName(item);
    const type = getMediaType(name);
    if (type === 'other') {
      stats.other += 1;
      continue;
    }
    stats[type] = (stats[type] || 0) + 1;
    if (skipJunk && (type === 'video' || type === 'audio') && isJunkMediaName(name)) {
      stats.junk += 1;
      continue;
    }
    if ((type === 'video' || type === 'audio') && minBytes > 0) {
      const size = fileSize(item);
      if (size > 0 && size < minBytes) {
        stats.tooSmall += 1;
        continue;
      }
    }
    if (type === 'video' && settings.includeVideo !== false) stats.kept += 1;
    else if (type === 'audio' && settings.includeAudio) stats.kept += 1;
  }
  return stats;
}

export function basenameNoExt(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
}

/** Extract SxxExx / 第N集 token for companion matching across renamed stems. */
function episodeKey(stem = '') {
  const s = String(stem || '');
  let m = s.match(/[Ss](\d{1,2})[. _\-]*[Ee][Pp]?[. _\-]*(\d{1,3})/i);
  if (m) return `s${Number(m[1])}e${Number(m[2])}`;
  m = s.match(/第\s*(\d{1,3})\s*[集话話期]/);
  if (m) return `e${Number(m[1])}`;
  m = s.match(/(?:^|[.\s_\-])(\d{1,3})(?:\s*[vV]\d)?(?:[.\s_\-]|$)/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 190) return `e${n}`;
  }
  return '';
}

/**
 * Pair subtitles/images with videos sharing the same basename stem
 * (or same folder + episode token when stems differ after rename).
 */
export function attachCompanions(mediaItems, allItems) {
  const videos = mediaItems.filter((i) => getMediaType(fileName(i)) === 'video');
  const byStem = new Map();
  /** folder|epKey → video id (only when unique in that folder) */
  const byFolderEp = new Map();
  const folderEpCount = new Map();

  for (const v of videos) {
    const stem = basenameNoExt(fileName(v)).toLowerCase();
    byStem.set(stem, fileIdSafe(v));
    const folder = String(v._relPath || v._parentCid || '');
    const ep = episodeKey(stem);
    if (!ep) continue;
    const key = `${folder}\u0001${ep}`;
    folderEpCount.set(key, (folderEpCount.get(key) || 0) + 1);
    byFolderEp.set(key, fileIdSafe(v));
  }

  const extras = [];
  for (const item of allItems || []) {
    if (isFolder(item)) continue;
    const name = fileName(item);
    const type = getMediaType(name);
    if (type !== 'subtitle' && type !== 'image') continue;
    const stem = basenameNoExt(name).toLowerCase();
    // strip common lang suffixes: name.zh.srt -> name
    const stem2 = stem.replace(/\.(zh|zh-cn|chs|cht|en|eng|jp|jpn|sc|tc)$/i, '');
    let videoId = byStem.get(stem) || byStem.get(stem2);
    if (!videoId) {
      const folder = String(item._relPath || item._parentCid || '');
      const ep = episodeKey(stem2) || episodeKey(stem);
      if (ep) {
        const key = `${folder}\u0001${ep}`;
        if (folderEpCount.get(key) === 1) videoId = byFolderEp.get(key);
      }
    }
    if (videoId) {
      extras.push({ ...item, _companionOf: videoId, _mediaType: type });
    }
  }
  return extras;
}

function fileIdSafe(item) {
  return String(item.fid || item.cid || '');
}
