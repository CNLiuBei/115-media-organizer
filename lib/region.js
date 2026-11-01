/** Region folder names matching 视频/剧集/* */
export const REGION_FOLDERS = [
  '大陆剧',
  '港台剧',
  '日韩剧',
  '欧美剧',
  '动漫',
  '其他剧集',
];

const REGION_SET = new Set(REGION_FOLDERS);

/** ISO / language → 剧集子目录 */
const COUNTRY_MAP = {
  CN: '大陆剧',
  HK: '港台剧',
  TW: '港台剧',
  MO: '港台剧',
  JP: '日韩剧',
  KR: '日韩剧',
  US: '欧美剧',
  GB: '欧美剧',
  UK: '欧美剧',
  CA: '欧美剧',
  AU: '欧美剧',
  NZ: '欧美剧',
  IE: '欧美剧',
  FR: '欧美剧',
  DE: '欧美剧',
  ES: '欧美剧',
  IT: '欧美剧',
  NL: '欧美剧',
  SE: '欧美剧',
  NO: '欧美剧',
  DK: '欧美剧',
  FI: '欧美剧',
  BE: '欧美剧',
  AT: '欧美剧',
  CH: '欧美剧',
  PT: '欧美剧',
  PL: '欧美剧',
  CZ: '欧美剧',
  RU: '其他剧集',
  IN: '其他剧集',
  TH: '其他剧集',
  VN: '其他剧集',
  ID: '其他剧集',
  MY: '其他剧集',
  PH: '其他剧集',
  SG: '其他剧集',
  BR: '其他剧集',
  MX: '其他剧集',
  AR: '其他剧集',
};

const LANG_MAP = {
  zh: '大陆剧',
  'zh-cn': '大陆剧',
  'zh-hans': '大陆剧',
  'zh-tw': '港台剧',
  'zh-hk': '港台剧',
  'zh-hant': '港台剧',
  yue: '港台剧',
  ja: '日韩剧',
  ko: '日韩剧',
  en: '欧美剧',
  fr: '欧美剧',
  de: '欧美剧',
  es: '欧美剧',
  it: '欧美剧',
};

/** Filename / path keyword rules (first match wins). */
const KEYWORD_RULES = [
  {
    region: '动漫',
    re: /动漫|动画|アニメ|anime|cartoon|\[ani\]|subsplease|nekmoe|nekomoe|lilith-raws|ohyee|baha|bilibili.?bangumi/i,
  },
  {
    region: '港台剧',
    re: /港台|港剧|台剧|粤语|tvb|翡翠台|中天|纬来|Hong\s*Kong|Taiwan/i,
  },
  {
    region: '日韩剧',
    re: /日剧|韩剧|日韩|韩语|日语|韩国|日本|japanese|korean|\bJP\b|\bKR\b|NHK|TBS|Fuji|SBS|KBS|MBC|tvN|TVING|Wavve|ENA|\bViu\b|유부녀|킬러|허수아비/i,
  },
  {
    // Do NOT match bare HBO/Netflix/Max — they distribute KR/JP titles too
    region: '欧美剧',
    re: /美剧|英剧|欧美|法语|德语|西语|\bAMC\b|\bBBC\b|SkyAtlantic/i,
  },
  {
    region: '大陆剧',
    re: /大陆|国产|内地|华语|央视|卫视|优酷|爱奇艺|腾讯视频|芒果/i,
  },
];

/** CJK-only title without region tags → assume 大陆剧 */
function looksLikeMainlandTitle(title = '') {
  const t = String(title || '').trim();
  if (!t) return false;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return cjk >= 2 && cjk > latin;
}

/**
 * Detect region folder name for a TV show.
 * @param {object} opts
 * @param {string} [opts.filename]
 * @param {string} [opts.title]
 * @param {string} [opts.relPath] relative path from scan (parent folders)
 * @param {string[]} [opts.tags]
 * @param {string[]} [opts.originCountries] ISO codes from metadata
 * @param {string} [opts.originalLanguage]
 * @param {boolean} [opts.isAnime]
 * @returns {string} one of REGION_FOLDERS
 */
export function detectRegion(opts = {}) {
  const {
    filename = '',
    title = '',
    relPath = '',
    tags = [],
    originCountries = [],
    originalLanguage = '',
    isAnime = false,
  } = opts;

  // 1) Already under a region folder → keep (S2 dumped into 日韩剧 stays there)
  const fromPath = regionFromPath(relPath);
  if (fromPath) return fromPath;

  // 2) TMDB origin / language — before filename tags so S02 packs with
  //    「美剧」/SubsPlease still land with S01 (e.g. KR → 日韩剧)
  for (const code of originCountries || []) {
    const hit = COUNTRY_MAP[String(code || '').toUpperCase()];
    if (hit) return hit;
  }
  const lang = String(originalLanguage || '').toLowerCase();
  if (lang && LANG_MAP[lang]) return LANG_MAP[lang];

  if (isAnime) return '动漫';

  // 3) Path/filename keywords when metadata has no country
  const blob = [filename, title, relPath, ...(tags || [])].filter(Boolean).join(' ');
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(blob)) return rule.region;
  }

  // 4) 启发式：纯中文 → 大陆；纯拉丁英文名 → 欧美
  if (looksLikeMainlandTitle(title)) return '大陆剧';
  if (looksLikeWesternTitle(title) || looksLikeWesternTitle(filename)) return '欧美剧';

  return '其他剧集';
}

function looksLikeWesternTitle(title = '') {
  const t = String(title || '').trim();
  if (!t) return false;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return latin >= 4 && cjk === 0;
}

/** If path already contains a known region folder, keep it. */
export function regionFromPath(relPath = '') {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (REGION_SET.has(parts[i])) return parts[i];
  }
  return null;
}

export function regionFromCountries(countries = [], originalLanguage = '', isAnime = false) {
  if (isAnime) return '动漫';
  for (const code of countries || []) {
    const hit = COUNTRY_MAP[String(code || '').toUpperCase()];
    if (hit) return hit;
  }
  const lang = String(originalLanguage || '').toLowerCase();
  if (lang && LANG_MAP[lang]) return LANG_MAP[lang];
  return null;
}
