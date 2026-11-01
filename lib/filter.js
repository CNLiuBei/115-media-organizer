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

function looksLikeEpisodeStem(stem = '') {
  if (/\bS\d{1,2}[. _\-]*E[Pp]?\d{1,3}\b/i.test(stem)) return true;
  if (/第\s*\d+\s*[集话話期季]/.test(stem)) return true;
  const nx = String(stem || '').match(/(?<!\d)(\d{1,2})[xX](\d{1,3})(?!\d)/);
  if (nx) {
    const season = Number(nx[1]);
    const episode = Number(nx[2]);
    if (season >= 1 && season <= 40 && episode >= 1 && episode <= 189) return true;
  }
  return false;
}

/** Lone quality / source tags — not a movie title by themselves. */
const LONE_QUALITY_RE = /^(?:HD|CAM|TS|TC|R5|UHD|HDR|HDR10|WEB|HDTV|Bluray|Blu-?Ray|REMUX|Sample|Trailer|MOVIE|FILM|VIDEO|MP4|MKV)$/i;

const QUALITY_TOKEN_SRC = String.raw`1080p|2160p|720p|480p|4K|BluRay|Blu-?ray|WEB-?DL|WEBRip|REMUX|HDR10|DV|Atmos|x264|x265|h\.?264|h\.?265|HEVC|AVC|AAC|DDP|DTS|TrueHD`;
const QUALITY_TOKEN_TEST_RE = new RegExp(String.raw`\b(?:${QUALITY_TOKEN_SRC})\b`, 'i');
const QUALITY_TOKEN_RE = new RegExp(String.raw`\b(?:${QUALITY_TOKEN_SRC})\b`, 'gi');

/**
 * Domains in ad filenames.
 * - Always allow www.xxx.tld (including .me/.tv)
 * - Bare xxx.com / xxx.net OK
 * - Do NOT treat Love.Me / Call.Me / Find.Me as domains (.me/.tv/.co/.io need www.)
 */
const DOMAIN_RE = /(?:www\.[a-z0-9][-a-z0-9]{0,61}\.(?:com|net|org|cc|top|xyz|vip|me|tv|cn|icu|info|club|site|online|live|app|co|uk|io)|[a-z0-9][-a-z0-9]{1,61}\.(?:com|net|org|cc|top|xyz|vip|cn|icu|info|club|site|online|live|app))\b/i;

/** Strip 【…】 / […] / （www…） wrappers often used by release groups & ads. */
function stripPromoWrappers(stem = '') {
  return String(stem || '')
    .replace(/[【\[][^】\]]*[】\]]/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove domains + quality tokens to expose a leftover title. */
function titleRemnant(text = '') {
  return String(text || '')
    .replace(DOMAIN_RE, ' ')
    .replace(QUALITY_TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasTitleRemnant(text = '') {
  const t = titleRemnant(text);
  if (!t || t.length < 2) return false;
  if (isPromoOnlyText(t)) return false;
  if (/[\u4e00-\u9fff]{2,}/.test(t)) return true;
  if (/\b(?:19|20)\d{2}\b/.test(t)) return true;
  if (/[A-Za-z]{3,}/.test(t) && !LONE_QUALITY_RE.test(t.replace(/[^A-Za-z0-9]+/g, ' ').trim())) {
    return true;
  }
  return false;
}

/**
 * Real episode/movie signal — never treat as pure ad dump (release-group prefixes OK).
 * Quality tags alone (…1080p / …AAC) do NOT count if the rest is only promo text.
 */
export function hasRealMediaSignal(name = '') {
  const stem = basenameNoExt(name);
  if (looksLikeEpisodeStem(stem)) return true;
  if (/magnet:\?|ed2k:\/\//i.test(stem)) return false;
  if (AD_BASENAME_RE.test(stem)) return false;

  const stripped = stripPromoWrappers(stem);
  // Episode after stripping 【发布组】
  if (stripped && looksLikeEpisodeStem(stripped)) return true;

  // Ad CTA / promo-only (even if fake .1080p/.AAC tacked on) → not real
  if (AD_PHRASE_RE.test(stem) || AD_PHRASE_RE.test(stripped || '')) {
    return hasTitleRemnant(stripped || stem);
  }
  if (!stripped || isPromoOnlyText(stripped)) {
    // Entire name was wrappers / domain / bait — quality tags don't rescue it
    return hasTitleRemnant(stem) && hasTitleRemnant(stripped || stem);
  }

  if (/全\s*\d+\s*集/.test(stem) && hasTitleRemnant(stripped)) return true;

  // Resolution / encode only count with a real title remnant
  if (QUALITY_TOKEN_TEST_RE.test(stem) && hasTitleRemnant(stripped)) return true;

  // Chinese movie/show title (e.g. 流浪地球 / 哪吒之魔童闹海)
  if (/[\u4e00-\u9fff]{2,}/.test(stripped) && !isPromoOnlyText(stripped)) return true;
  // Year is a strong movie signal
  if (/\b(?:19|20)\d{2}\b/.test(stripped)) return true;

  // Multi-word Latin title: Call.Me.By.Your.Name (avoids ≤30MB size-junk)
  // Need ≥3 tokens so Love.Me / www stubs stay out
  if (!DOMAIN_RE.test(stripped) && !/[:?\/\\]/.test(stripped)) {
    const latinParts = stripped
      .split(/[^A-Za-z0-9]+/)
      .filter((p) => /[A-Za-z]{2,}/.test(p) && !LONE_QUALITY_RE.test(p));
    if (latinParts.length >= 3) return true;
  }

  // Bare Latin title ONLY when a 【发布组】 wrapper was stripped
  const hadReleaseWrapper = /[【\[][^】\]]*[】\]]/.test(stem) && stripped !== stem;
  const latin = stripped.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (
    hadReleaseWrapper
    && /[A-Za-z]{4,}/.test(latin)
    && !LONE_QUALITY_RE.test(latin)
    && !/[:?\/\\]/.test(stripped)
    && !DOMAIN_RE.test(stripped)
  ) {
    return true;
  }
  return false;
}

/** CTA / contact / bait phrases common in 网盘广告. */
const AD_PHRASE_RE = new RegExp(
  [
    // visit / more resources
    String.raw`更多(?:无水印|高品质|电视剧|电影|综艺|动漫|资源|下载|影片|剧集)`,
    String.raw`(?:无水印高品质|高品质资源|更多资源请|资源请(?:访问|下载)|下载请访问|请(?:访问|到).{0,24}官网)`,
    String.raw`请(?:点击)?(?:下载|访问|前往)|点击(?:下载|访问|前往|打开)`,
    String.raw`(?:唯一|最新|永久|备用)(?:官网|网址|地址|链接)`,
    String.raw`(?:官网地址|最新地址|永久地址|备用地址|防失联|防迷路|最新网址|官方网站)`,
    String.raw`(?:高清)?剧集网(?:官网)?|影视(?:官网|网站)|片库官网`,
    String.raw`(?:完整版请|高清请|无删减请).{0,12}(?:访问|下载|加)`,
    String.raw`(?:提取码|保存到网盘|转存到|分享链接|磁力链接|ed2k)`,
    String.raw`(?:开通VIP|加入会员|免费观看|付费解锁|获取密码)`,
    // contact / social — short Latin tokens need word boundaries (avoid Outgunned→TG)
    String.raw`加(?:微信|微信号|QQ|扣扣|群|V\b|vx\b|VX\b|WX\b|wx\b)`,
    String.raw`(?:微信|微信号|v信|V信|威信|扣扣|QQ群)[:：\s]`,
    String.raw`(?:\bvx\b|\bVX\b|\bwx\b|\bWX\b|\bQQ\b)[:：\s]`,
    String.raw`微信二维码|加微|二维码`,
    String.raw`(?:扫码|扫一扫).{0,8}(?:关注|加|领|进)`,
    String.raw`关注(?:公众号|微博|抖音|我)`,
    String.raw`电报(?:群|频道)?|(?:\bTG\b|Telegram)(?:群|频道)?`,
    String.raw`(?:领|送|免费).{0,6}(?:福利|资源|合集|课程|资料)`,
    String.raw`(?:福利合集|免费福利|课程福利|内部资源|获取完整)`,
    String.raw`(?:联系客服|咨询客服|私聊|加我)`,
    String.raw`必看(?:说明|通知|文件)?|重要(?:通知|说明)`,
    // bait labels
    String.raw`(?:^|[.【\s_\-])(?:广告|推广|营销|引流)(?:[】.\s_\-]|$)`,
  ].join('|'),
  'i',
);

const SHELL_AD_EXT_RE = /^(?:url|html?|mhtml?|txt|docx?|pdf|rtf|webloc|mht|lnk)$/i;
const IMAGE_AD_EXT_RE = /^(?:png|jpe?g|gif|webp|bmp|svg|nfo)$/i;
const FAKE_MEDIA_EXT_RE = /^(?:mkv|mp4|avi|ts|wmv|flv|mov|m4v|rmvb|mpg|mpeg|iso|mp3|flac)$/i;

/** Short names that are almost always ad images / notes on 网盘. */
const AD_BASENAME_RE = /^(?:广告|推广|福利|微信(?:号|二维码|群)?|微信号|二维码|加群|加微信|扫码|关注|QQ群|qq群|vx|wx|电报|TG群|必看(?:说明|通知|文件)?|重要(?:通知|说明)?|下载说明|资源说明|使用说明|readme|READ\s*ME)(?:[\s_\-.(（].*)?$/i;

/** Filename is only promo / domain after wrappers removed. */
function isPromoOnlyText(text = '') {
  const t = String(text || '').replace(/[\s._\-—–·•|]+/g, '').trim();
  if (!t) return true;
  if (AD_PHRASE_RE.test(text)) return true;
  if (AD_BASENAME_RE.test(String(text || '').trim())) return true;
  if (DOMAIN_RE.test(text) && !/[\u4e00-\u9fff]{2,}/.test(stripDomains(text))) return true;
  // bare site banner stems
  if (/^(?:更多|请访问|访问官网|官网|资源下载)/.test(text) && DOMAIN_RE.test(text)) return true;
  return false;
}

function stripDomains(text = '') {
  return String(text || '')
    .replace(DOMAIN_RE, ' ')
    .replace(/www\./gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Site promo / fake media dumps (often left after real episodes are moved).
 * Real releases like「【高清剧集网发布 www.x.com】剧名.S01E01.mkv」are NOT ads.
 */
export function isAdDumpName(name = '') {
  const raw = String(name || '');
  const stem = basenameNoExt(raw);
  const compact = raw.replace(/\s+/g, '');
  const ext = getExt(raw);

  // Critical: release-group prefixes must not sink real episodes/movies
  if (hasRealMediaSignal(raw)) return false;

  if (AD_PHRASE_RE.test(stem) || AD_PHRASE_RE.test(compact)) return true;
  if (AD_BASENAME_RE.test(stem)) return true;

  const stripped = stripPromoWrappers(stem);
  if (!stripped || isPromoOnlyText(stripped)) {
    // Entire name was wrappers / promo / domain
    if (
      DOMAIN_RE.test(stem)
      || AD_PHRASE_RE.test(stem)
      || /[【\[][^】\]]*www\./i.test(stem)
      || /[【\[][^】\]]*\.(?:com|net|cc|top|xyz|vip|tv)[^】\]]*[】\]]/i.test(stem)
    ) {
      return true;
    }
  }

  // Promo + domain together (banner PNG / DOC / tiny fake MKV)
  if (
    (/(?:官网|请访问|下载请|更多|资源|访问|发布|福利|防失联)/.test(stem) || AD_PHRASE_RE.test(stem))
    && DOMAIN_RE.test(stem)
  ) {
    return true;
  }

  // Magnet / share leftover notes
  if (SHELL_AD_EXT_RE.test(ext) && /(?:magnet:\?|ed2k:\/\/|提取码|分享码|密码[:：])/i.test(stem)) {
    return true;
  }

  // Shell docs / shortcuts whose name is a domain or contact bait
  if (SHELL_AD_EXT_RE.test(ext)) {
    if (DOMAIN_RE.test(stem) || AD_PHRASE_RE.test(stem) || AD_BASENAME_RE.test(stem)) return true;
    if (/^(?:更多|请访问|访问|官网|福利|加)/.test(stem)) return true;
  }

  // Image banners: domain + CTA, or classic short ad names
  if (IMAGE_AD_EXT_RE.test(ext)) {
    if (AD_BASENAME_RE.test(stem)) return true;
    if (DOMAIN_RE.test(stem) && /(?:访问|下载|官网|资源|更多|发布|福利|微信|扫码|加群)/.test(stem)) {
      return true;
    }
    // Domain is the whole image name: www.xxx.com.png / xxx.com.jpg
    if (/^(?:www\.)?[a-z0-9][-a-z0-9.]*\.(?:com|net|org|cc|top|xyz|vip|me|tv)$/i.test(stem)) {
      return true;
    }
  }

  // Fake media whose entire stem is 【domain】 / domain promo
  if (FAKE_MEDIA_EXT_RE.test(ext)) {
    if (
      /^[【\[][^】\]]*www\.[^】\]]+\.(?:com|net|org|cc|top|xyz|vip|me|tv)[^】\]]*[】\]]$/i.test(stem)
      || /^[【\[][^】\]]*(?:\.com|\.net|\.cc|\.top|\.xyz|\.vip|\.tv)[^】\]]*[】\]]$/i.test(stem)
    ) {
      return true;
    }
    if (/^[【\[][^】\]]*www\.[^】\]]+[】\]]\.\w+$/i.test(compact)) return true;
  }

  // Entire stem is a single 【…www…】 wrapper
  if (
    /^[【\[][^】\]]*www\.[^】\]]+\.(?:com|net|org|cc|top|xyz|vip|me|tv)[^】\]]*[】\]]$/i.test(stem)
    || /^[【\[][^】\]]*(?:\.com|\.net|\.cc|\.top|\.xyz)[^】\]]*[】\]]$/i.test(stem)
  ) {
    return true;
  }

  return false;
}

const JUNK_EN_TAGS = new Set(['sample', 'trailer', 'preview', 'teaser']);
const TRAILING_QUALITY_TAGS = new Set([
  '1080p', '2160p', '720p', '480p', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'atmos',
  'bluray', 'blu-ray', 'web', 'web-dl', 'webdl', 'webrip', 'remux', 'hdtv', 'pdtv',
  'hdrip', 'dvdrip', 'bdrip', 'brrip', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc',
  'aac', 'ddp', 'dts', 'truehd', 'proper', 'repack', 'internal', 'readnfo', 'multi',
]);

/** Last filename token after stripping trailing encode/quality tags (not years). */
function lastNonQualityToken(stem = '') {
  const tokens = String(stem || '').split(/[.\s_\-\[\]()（）]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i].toLowerCase();
    if (TRAILING_QUALITY_TAGS.has(t) || /^\d{3,4}p$/.test(t)) continue;
    return t;
  }
  return '';
}

/** Sample / trailer / 预告 / 广告包 — skip as primary media (default on). */
export function isJunkMediaName(name = '') {
  const stem = basenameNoExt(name);
  // Chinese tags as whole tokens — not 精华集锦
  if (/(?:^|[.\s_\-\[(（])(?:预告片|预告|花絮|片花|样片|精华)(?:[.\s_\-\])）]|$)/.test(stem)) {
    return true;
  }
  // Scene samples: Movie-sample / last token sample|trailer after quality tags
  if (/-sample$/i.test(stem)) return true;
  if (JUNK_EN_TAGS.has(lastNonQualityToken(stem))) return true;
  if (isAdDumpName(name)) return true;
  return false;
}

/** Typical 网盘广告音视频/假媒体上限（正片几乎总是更大）. */
export const AD_MAX_SIZE_BYTES = 30 * 1024 * 1024;

/**
 * Real episode/movie that should keep a folder from cleanup.
 * Ignores ad dumps, samples, and tiny promo clips.
 * @param {object} item 115 file item
 * @param {{ minSizeMB?: number, absoluteMinBytes?: number, adMaxBytes?: number }} [opts]
 */
export function isKeepableVideoFile(item, opts = {}) {
  const name = fileName(item);
  if (getMediaType(name) !== 'video') return false;
  if (isJunkMediaName(name)) return false;
  const size = fileSize(item);
  const minMB = opts.minSizeMB != null ? Number(opts.minSizeMB) : 0;
  const minBytes = Math.max(0, minMB) * 1024 * 1024;
  const adMax = opts.adMaxBytes != null ? Number(opts.adMaxBytes) : AD_MAX_SIZE_BYTES;
  const absMin = opts.absoluteMinBytes != null ? Number(opts.absoluteMinBytes) : 5 * 1024 * 1024;
  // Hard floor for stub clips
  if (size > 0 && size < absMin) return false;
  // ≤30MB without episode/title/res → treat as ad stub, not folder-keeping media
  if (size > 0 && size <= adMax && !hasRealMediaSignal(name)) return false;
  if (minBytes > 0 && size > 0 && size < minBytes) return false;
  return true;
}

/**
 * Leftover junk safe to delete during cleanup (ads / samples / tiny promo clips).
 * Does not touch normal subtitles, nfo, or real media.
 * Name-matched ads are junk at any size; unnamed video/audio stubs use ≤30MB.
 * @param {object} item
 * @param {{ minSizeMB?: number, absoluteMinBytes?: number, adMaxBytes?: number }} [opts]
 */
export function isCleanupJunkFile(item, opts = {}) {
  if (isFolder(item)) return false;
  const name = fileName(item);
  if (isAdDumpName(name) || isJunkMediaName(name)) return true;
  const type = getMediaType(name);
  const ext = getExt(name);
  const stem = basenameNoExt(name);
  const size = fileSize(item);
  const adMax = opts.adMaxBytes != null ? Number(opts.adMaxBytes) : AD_MAX_SIZE_BYTES;
  const absMin = opts.absoluteMinBytes != null ? Number(opts.absoluteMinBytes) : 5 * 1024 * 1024;
  // Shell leftovers with contact/domain bait even if phrase regex missed a variant
  if (SHELL_AD_EXT_RE.test(ext) && (DOMAIN_RE.test(stem) || AD_BASENAME_RE.test(stem))) {
    return true;
  }
  if (type === 'video' || type === 'audio') {
    const real = hasRealMediaSignal(name);
    // ≤30MB + no episode/title/res signal → typical fake media / site dump
    if (size > 0 && size <= adMax && !real) return true;
    // Sub-5MB unnamed stubs (broken samples). Named SxxExx / titles are kept.
    if (size > 0 && size < absMin && !real) return true;
    // Domain-only fake media of any size (rare large ad dumps)
    if (
      !isKeepableVideoFile(item, opts)
      && DOMAIN_RE.test(stem)
      && !hasRealMediaSignal(name)
      && isPromoOnlyText(stripPromoWrappers(stem) || stem)
    ) {
      return true;
    }
  }
  // Promo images / docs under ad size with a site domain (missed by phrase edge cases)
  if (
    size > 0
    && size <= adMax
    && (IMAGE_AD_EXT_RE.test(ext) || SHELL_AD_EXT_RE.test(ext))
    && DOMAIN_RE.test(stem)
    && !hasRealMediaSignal(name)
  ) {
    return true;
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

const COMPANION_LANG_RE = /\.(zh|zh-cn|zh-hans|zh-hant|chs|cht|en|eng|jp|jpn|sc|tc|und)$/i;

/** Extract SxxExx / 1x02 / 第N集 token for companion matching across renamed stems. */
function episodeKey(stem = '') {
  const s = String(stem || '');
  let m = s.match(/[Ss](\d{1,2})[. _\-]*[Ee][Pp]?[. _\-]*(\d{1,3})/i);
  if (m) return `s${Number(m[1])}e${Number(m[2])}`;
  m = s.match(/(?<!\d)(\d{1,2})[xX](\d{1,3})(?!\d)/);
  if (m) {
    const season = Number(m[1]);
    const episode = Number(m[2]);
    if (season >= 1 && season <= 40 && episode >= 1 && episode <= 189) {
      return `s${season}e${episode}`;
    }
  }
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
 * Matching is scoped per folder so identical names in different dirs
 * do not steal each other's companions.
 */
export function attachCompanions(mediaItems, allItems) {
  const videos = mediaItems.filter((i) => getMediaType(fileName(i)) === 'video');
  /** folder|stem → video id */
  const byFolderStem = new Map();
  /** folder|epKey → video id (only when unique in that folder) */
  const byFolderEp = new Map();
  const folderEpCount = new Map();

  for (const v of videos) {
    const stem = basenameNoExt(fileName(v)).toLowerCase();
    const folder = String(v._relPath || v._parentCid || '');
    byFolderStem.set(`${folder}\u0001${stem}`, fileIdSafe(v));
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
    const stem2 = stem.replace(COMPANION_LANG_RE, '');
    const folder = String(item._relPath || item._parentCid || '');
    let videoId = byFolderStem.get(`${folder}\u0001${stem}`)
      || byFolderStem.get(`${folder}\u0001${stem2}`);
    if (!videoId) {
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
  return String(item.fid || item.file_id || '').trim();
}
