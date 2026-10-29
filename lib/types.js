/** @typedef {'video'|'audio'|'subtitle'|'image'|'other'} MediaType */
/** @typedef {'tv'|'movie'|'unknown'} MediaKind */

export const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'ts', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'rmvb', 'iso'];
export const AUDIO_EXTS = ['mp3', 'flac', 'aac', 'wav', 'm4a', 'ogg', 'wma', 'ape'];
export const SUBTITLE_EXTS = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'nfo'];

/** Folder layout presets for organized output */
export const FOLDER_LAYOUTS = {
  cn_video: {
    label: '视频库（地区分类）',
    desc: '剧集/{地区}/剧名 (年) {tmdb-id}/Season N · 电影/片名 (年) {tmdb-id}。{folder}=片名+(年)+{tmdb-id}',
    tvPathTemplate: '剧集/{region}/{folder}/Season {season}',
    moviePathTemplate: '电影/{folder}',
    unknownPathTemplate: '剧集/其他剧集/{folder}',
  },
  cn_video_split: {
    label: '视频库（大陆→电视剧）',
    desc: '大陆剧→电视剧/{folder} · 其余→剧集/{地区}/{folder} · 电影→电影/{folder}',
    tvPathTemplate: '剧集/{region}/{folder}/Season {season}',
    moviePathTemplate: '电影/{folder}',
    unknownPathTemplate: '剧集/其他剧集/{folder}',
    mainlandTvPathTemplate: '电视剧/{folder}/Season {season}',
  },
  standard: {
    label: '标准',
    desc: '{folder}/Season N · Movies/{folder}',
    tvPathTemplate: '{folder}/Season {season}',
    moviePathTemplate: 'Movies/{folder}',
    unknownPathTemplate: 'Unsorted/{folder}',
  },
  typed: {
    label: '按类型分类',
    desc: '剧集/{folder} · 电影/{folder} · 其他/{folder}',
    tvPathTemplate: '剧集/{folder}/Season {season}',
    moviePathTemplate: '电影/{folder}',
    unknownPathTemplate: '其他/{folder}',
  },
  title_only: {
    label: '仅按片名',
    desc: '{folder}/',
    tvPathTemplate: '{folder}',
    moviePathTemplate: '{folder}',
    unknownPathTemplate: '{folder}',
  },
  jellyfin: {
    label: 'Jellyfin / Emby',
    desc: 'Shows/{folder}/Season N · Movies/{folder}（含年与 {tmdb-id}）',
    tvPathTemplate: 'Shows/{folder}/Season {season}',
    moviePathTemplate: 'Movies/{folder}',
    unknownPathTemplate: 'Unsorted/{folder}',
  },
  custom: {
    label: '自定义（设置页模板）',
    desc: '可用 {folder} {title} {year} {tmdbid} {tmdb} {region} {season} 等',
    tvPathTemplate: null,
    moviePathTemplate: null,
    unknownPathTemplate: null,
  },
};

export const DEFAULT_SETTINGS = {
  tmdbApiKey: '',
  enableMetadata: false, // sidepanel「TMDB 片名校准」
  preferDouban: false, // TMDB 为主；豆瓣仅作中文名补充
  minSizeMB: 50,
  /** Skip sample / trailer / 预告 as primary media */
  skipJunkMedia: true,
  /** During scan calibrate, skip files already at target with tmdb id */
  skipCalibrateOrganized: true,
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
  folderLayout: 'cn_video',
  tvPathTemplate: '剧集/{region}/{folder}/Season {season}',
  tvNameTemplate: '{title} - S{season:02d}E{episode:02d}',
  moviePathTemplate: '电影/{folder}',
  movieNameTemplate: '{title} ({year})',
  unknownPathTemplate: '剧集/其他剧集/{folder}',
  unknownNameTemplate: '{title}',
};

export const STORAGE_KEYS = {
  settings: 'settings',
  lastCid: 'lastCid',
  recentCids: 'recentScanCids',
};
