/** @typedef {'video'|'audio'|'subtitle'|'image'|'other'} MediaType */
/** @typedef {'tv'|'movie'|'unknown'} MediaKind */

export const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'ts', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'rmvb', 'iso'];
export const AUDIO_EXTS = ['mp3', 'flac', 'aac', 'wav', 'm4a', 'ogg', 'wma', 'ape'];
export const SUBTITLE_EXTS = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'nfo'];

/**
 * Folder layout presets.
 * Emby/Jellyfin: Movies + TV Shows libraries, `Title (Year) {tmdb-id}`, `Season 01`.
 * https://emby.media/support/articles/Movie-Naming.html
 * https://emby.media/support/articles/TV-Naming.html
 */
export const FOLDER_LAYOUTS = {
  emby: {
    label: 'Emby 标准',
    desc: '电影 / 剧集 两个库。片名 (年) {tmdb-id}，季文件夹 Season 01。在 Emby 分别添加「电影」「剧集」媒体库即可。',
    tvPathTemplate: '剧集/{folder}/Season {season:02d}',
    moviePathTemplate: '电影/{folder}',
    unknownPathTemplate: '未分类/{folder}',
  },
  emby_en: {
    label: 'Emby (English)',
    desc: 'Movies / TV Shows libraries. Title (Year) {tmdb-id} / Season 01.',
    tvPathTemplate: 'TV Shows/{folder}/Season {season:02d}',
    moviePathTemplate: 'Movies/{folder}',
    unknownPathTemplate: 'Unsorted/{folder}',
  },
  cn_video: {
    label: '视频库（按地区）',
    desc: '剧集下再分大陆剧/欧美剧等。适合沿用旧目录；Emby 需把各地区文件夹都加入剧集库。',
    tvPathTemplate: '剧集/{region}/{folder}/Season {season:02d}',
    moviePathTemplate: '电影/{folder}',
    unknownPathTemplate: '剧集/其他剧集/{folder}',
  },
  cn_video_split: {
    label: '视频库（大陆→电视剧）',
    desc: '大陆剧→电视剧/{folder} · 其余→剧集/{地区}/{folder} · 电影→电影/{folder}',
    tvPathTemplate: '剧集/{region}/{folder}/Season {season:02d}',
    moviePathTemplate: '电影/{folder}',
    unknownPathTemplate: '剧集/其他剧集/{folder}',
    mainlandTvPathTemplate: '电视剧/{folder}/Season {season:02d}',
  },
  standard: {
    label: '无类型根目录',
    desc: '不建「电影/剧集」根，直接 {folder}/Season 01。适合扫描目录本身就是某个媒体库。',
    tvPathTemplate: '{folder}/Season {season:02d}',
    moviePathTemplate: '{folder}',
    unknownPathTemplate: '{folder}',
  },
  title_only: {
    label: '仅按片名',
    desc: '所有文件只进 {folder}/，不建 Season。',
    tvPathTemplate: '{folder}',
    moviePathTemplate: '{folder}',
    unknownPathTemplate: '{folder}',
  },
  custom: {
    label: '自定义（设置页模板）',
    desc: '用设置页路径模板。变量：{folder} {title} {year} {tmdb} {region} {season:02d} 等。',
    tvPathTemplate: null,
    moviePathTemplate: null,
    unknownPathTemplate: null,
  },
};

/** Old preset keys kept so existing settings still resolve. */
export const LAYOUT_ALIASES = {
  jellyfin: 'emby_en',
  typed: 'emby',
};

export function resolveLayoutKey(key) {
  const raw = String(key || '').trim();
  if (raw === 'custom') return 'custom';
  if (FOLDER_LAYOUTS[raw]) return raw;
  return LAYOUT_ALIASES[raw] || 'emby';
}

export const DEFAULT_SETTINGS = {
  tmdbApiKey: '',
  enableMetadata: true, // sidepanel「TMDB 片名校准」默认开
  preferDouban: false, // TMDB 为主；豆瓣仅作中文名补充
  minSizeMB: 50,
  /** Skip sample / trailer / 预告 as primary media */
  skipJunkMedia: true,
  /** During scan calibrate, skip files already at target with tmdb id */
  skipCalibrateOrganized: true,
  /** Sidepanel「含子文件夹」 */
  scanRecursive: true,
  includeVideo: true,
  includeAudio: false,
  includeSubtitle: true,
  includeImage: false,
  moveFiles: true,
  /** After move-organize, delete source folders that no longer contain any video */
  cleanEmptyFolders: true,
  /** Delay for scan/TMDB pacing; organize uses ≤80ms between batches */
  requestDelayMs: 200,
  // Where organized folders are created
  targetMode: 'scan', // 'scan' | 'cid'
  targetCid: '0',
  targetCidName: '根目录', // display name for selected target folder
  targetBasePath: '', // optional prefix under target root, e.g. 媒体库
  folderLayout: 'emby',
  tvPathTemplate: '剧集/{folder}/Season {season:02d}',
  tvNameTemplate: '{title} - S{season:02d}E{episode:02d}',
  moviePathTemplate: '电影/{folder}',
  movieNameTemplate: '{title} ({year})',
  unknownPathTemplate: '未分类/{folder}',
  unknownNameTemplate: '{title}',
  /** Optional URL of a version JSON ({version,url,notes}) for update checks */
  updateCheckUrl: '',
};

/** Compare dotted numeric versions ("0.0.56" vs "0.0.100"). Returns -1 | 0 | 1. */
export function cmpVersion(a, b) {
  const pa = String(a || '').trim().split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').trim().split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export const STORAGE_KEYS = {
  settings: 'settings',
  lastCid: 'lastCid',
  recentCids: 'recentScanCids',
};
