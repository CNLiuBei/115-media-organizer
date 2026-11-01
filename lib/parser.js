import { getExt } from './filter.js';
import { detectRegion } from './region.js';

const JUNK_TAGS = [
  '1080p', '720p', '2160p', '4k', '8k', '480p', '360p', '576p',
  'bluray', 'blu-ray', 'web-dl', 'webdl', 'webrip', 'hdtv', 'hdrip', 'bdrip', 'brrip', 'dvdrip', 'hdtvrip',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'aac', 'ac3', 'eac3', 'ddp', 'dts', 'truehd', 'atmos', 'flac',
  'remux', 'proper', 'repack', 'extended', 'unrated', 'directors.cut', 'imax',
  'chinese', 'chs', 'cht', 'eng', 'multi', 'dual', 'subbed', 'dubbed',
  'hdr', 'hdr10', 'hdr10+', 'sdr', 'dv', 'dolby', 'vision', 'uhd',
  'sample', 'rarbg', 'yts', 'yify', 'sparks', 'ctrlhd', 'ntb', 'blacktv',
  '10bit', '8bit', 'ma', 'remastered', 'hybrid', 'amzn', 'nf', 'hulu', 'dsnp',
];

const JUNK_RE = new RegExp(
  `\\b(?:${JUNK_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

const CN_JUNK_RE = /(?:中字|简中|繁中|简体|繁体|国语|粤语|台配|内嵌|外挂|双语|中英|中日|无修|修复|高清|超清|蓝光|网盘|完整版|枪版|抢先|未删减|最终话|完结篇)/g;

const RELEASE_GROUP_RE = /[-.](?:BlackTV|RARBG|YTS|YIFY|SPARKS|CTRLHD|NTB|CMCT|WiKi|FRDS|HDS|CHD|ADWeb|HAiKU|NTb|FLUX|AMZN|NF|HULU|DSNP|ATVP|iP|CMCTV|PTer|HHWEB|DBTV|HAWK)\s*$/i;

const CN_SEASON_NUM = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
};

/**
 * @param {string} filename
 * @param {{ relPath?: string }} [opts]
 */
export function parseMediaFilename(filename, opts = {}) {
  const ext = getExt(filename);
  let name = String(filename || '');
  if (ext) name = name.slice(0, -(ext.length + 1));
  name = name
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[－—–]/g, '-')
    // Drop pixel dimensions so 1280x720 is not parsed as 1x02 / S80E720
    .replace(/(?:^|[.\s_\-])\d{3,4}[xX]\d{3,4}(?=$|[.\s_\-])/g, ' ');

  const relPath = opts.relPath || '';
  const pathSeason = seasonFromPath(relPath);
  const pathKind = kindHintFromPath(relPath);

  // Pull [字幕组][良医 第一季] off before SxxExx matching
  const bracketMeta = extractBracketMeta(name);
  name = bracketMeta.name;

  const tags = [...bracketMeta.tagTexts];
  const tagMatches = name.match(JUNK_RE) || [];
  for (const t of tagMatches) tags.push(t.toLowerCase());

  const finish = (parsed) => {
    if (!parsed.edition) {
      parsed.edition = extractEdition(filename) || extractEdition(name) || null;
    }
    if (parsed.kind === 'tv' && pathSeason != null) {
      if (parsed.season == null || parsed._seasonFromDefault) {
        parsed.season = pathSeason;
      }
    }
    // Bracket season e.g. [良医 第一季]
    if (parsed.kind === 'tv' && bracketMeta.season != null) {
      if (parsed.season == null || parsed._seasonFromDefault) {
        parsed.season = bracketMeta.season;
      }
    }
    delete parsed._seasonFromDefault;

    if (parsed.kind === 'unknown' && pathKind) {
      parsed.kind = pathKind;
      if (pathKind === 'tv' && parsed.season == null && (pathSeason != null || bracketMeta.season != null)) {
        parsed.season = pathSeason ?? bracketMeta.season;
      }
    }

    // Prefer Chinese title from [良医 第一季] / 【良医】 over English release name
    const latinTitle = parsed.title;
    if (bracketMeta.cnTitle) {
      parsed.originalTitle = parsed.originalTitle || latinTitle;
      // If parsed title is Latin / mixed junk, replace with clean CN
      if (!/[\u4e00-\u9fff]/.test(parsed.title || '') || isPollutedTitle(parsed.title, bracketMeta.cnTitle)) {
        parsed.title = bracketMeta.cnTitle;
      }
    }

    if (parsed.kind === 'tv') {
      parsed.region = detectRegion({
        filename,
        title: parsed.title,
        relPath,
        tags,
      });
    } else {
      parsed.region = null;
    }

    if (parsed.kind === 'tv' && parsed.year) {
      parsed.title = stripYearToken(parsed.title, parsed.year);
    }
    if (!parsed.title || parsed.title === 'unknown') {
      const hint = titleHintFromPath(relPath);
      if (hint) parsed.title = hint;
    }
    if (!parsed.title) parsed.title = 'unknown';
    return parsed;
  };

  // 第1季第2集
  let m = name.match(
    /^(.*?)[. _\-]*第\s*(\d{1,2})\s*季[. _\-]*第\s*(\d{1,3})\s*[集话話期](?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    return finish({
      kind: 'tv',
      title: cleanTitle(m[1]),
      year: extractYear(m[1]) || extractYear(m[4] || ''),
      season: Number(m[2]),
      episode: Number(m[3]),
      tags,
      ext: ext ? `.${ext}` : '',
      rawTitle: m[1],
    });
  }

  // S01E01-E02 / S01E01-02 (multi-episode file → use first ep)
  m = name.match(
    /^(.*?)[. _\-]*[Ss](\d{1,2})[. _\-]*[Ee][Pp]?[. _\-]*(\d{1,3})[. _\-]*(?:-|~|–|—)[. _\-]*(?:[Ee][Pp]?[. _\-]*)?(\d{1,3})(?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    return finish({
      kind: 'tv',
      title: cleanTitle(m[1]),
      year: extractYear(m[1]) || extractYear(m[5] || ''),
      season: Number(m[2]),
      episode: Number(m[3]),
      episodeEnd: Number(m[4]),
      tags,
      ext: ext ? `.${ext}` : '',
      rawTitle: m[1],
    });
  }

  // S01E02 / S01EP02 / S01E01E02
  m = name.match(
    /^(.*?)[. _\-]*[Ss](\d{1,2})[. _\-]*[Ee][Pp]?[. _\-]*(\d{1,3})(?:[. _\-]*(?:-|~)?[. _\-]*[Ee][Pp]?[. _\-]*\d{1,3})?(?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    return finish({
      kind: 'tv',
      title: cleanTitle(m[1]),
      year: extractYear(m[1]) || extractYear(m[4] || ''),
      season: Number(m[2]),
      episode: Number(m[3]),
      edition: extractEdition(filename),
      tags,
      ext: ext ? `.${ext}` : '',
      rawTitle: m[1],
    });
  }

  // EP01 / Episode 01 (season from path/brackets)
  m = name.match(
    /^(.*?)[. _\-]*(?:EP|Episode)[. _\-]*0*(\d{1,3})(?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    const ep = Number(m[2]);
    if (ep >= 1 && ep <= 999) {
      return finish({
        kind: 'tv',
        title: cleanTitle(m[1]),
        year: extractYear(m[1]) || extractYear(m[3] || ''),
        season: pathSeason ?? bracketMeta.season ?? 1,
        episode: ep,
        edition: extractEdition(filename),
        _seasonFromDefault: pathSeason == null && bracketMeta.season == null,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: m[1],
      });
    }
  }

  // 第01-03集 / 第1～3集
  m = name.match(
    /^(.*?)[. _\-]*第\s*(\d{1,3})\s*[~\-–—到至]\s*(\d{1,3})\s*[集话話期](?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    return finish({
      kind: 'tv',
      title: cleanTitle(m[1]),
      year: extractYear(m[1]) || extractYear(m[4] || ''),
      season: pathSeason ?? bracketMeta.season ?? 1,
      episode: Number(m[2]),
      episodeEnd: Number(m[3]),
      _seasonFromDefault: pathSeason == null && bracketMeta.season == null,
      tags,
      ext: ext ? `.${ext}` : '',
      rawTitle: m[1],
    });
  }

  // Specials
  m = name.match(
    /^(.*?)[. _\-]*(?:SP|Special|OVA|OAD|特别篇|番外|小剧场)[. _\-]*0*(\d{1,3})(?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    const title = cleanTitle(m[1].replace(/[. _\-]*(?:Special|特别篇|番外|小剧场)$/i, ''));
    return finish({
      kind: 'tv',
      title: title || cleanTitle(m[1]),
      year: extractYear(m[1]) || extractYear(m[3] || ''),
      season: 0,
      episode: Number(m[2]),
      tags,
      ext: ext ? `.${ext}` : '',
      rawTitle: m[1],
    });
  }

  // 1x02 (do not eat 1280x720 / 1920x1080)
  m = name.match(/^(.*?)[. _\-]*(?<!\d)(\d{1,2})[xX](\d{1,3})(?!\d)(?:[. _\-]+(.*))?$/);
  if (m) {
    const season = Number(m[2]);
    const episode = Number(m[3]);
    const rest = m[4] || '';
    if (season >= 1 && season <= 40 && episode >= 1 && episode <= 189) {
      return finish({
        kind: 'tv',
        title: cleanTitle(m[1]),
        year: extractYear(m[1]) || extractYear(rest),
        season,
        episode,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: m[1],
      });
    }
  }

  // 上/中/下集
  m = name.match(/^(.*?)[. _\-]*(上|中|下)\s*集(?:[. _\-]+(.*))?$/);
  if (m) {
    const map = { 上: 1, 中: 2, 下: 3 };
    return finish({
      kind: 'tv',
      title: cleanTitle(m[1]),
      year: extractYear(m[1]) || extractYear(m[3] || ''),
      season: pathSeason ?? bracketMeta.season ?? 1,
      episode: map[m[2]],
      _seasonFromDefault: pathSeason == null && bracketMeta.season == null,
      tags,
      ext: ext ? `.${ext}` : '',
      rawTitle: m[1],
    });
  }

  // 第02集 / 02集 / E02
  m = name.match(
    /^(.*?)[. _\-]*(?:第\s*(\d{1,3})\s*[集话話期]|(\d{1,3})\s*集|[Ee][Pp]?\.?\s*(\d{1,3}))(?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    const ep = Number(m[2] || m[3] || m[4]);
    if (ep >= 1 && ep <= 999) {
      return finish({
        kind: 'tv',
        title: cleanTitle(m[1]),
        year: extractYear(m[1]) || extractYear(m[5] || ''),
        season: pathSeason ?? bracketMeta.season ?? 1,
        episode: ep,
        _seasonFromDefault: pathSeason == null && bracketMeta.season == null,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: m[1],
      });
    }
  }

  // Bare episode under Season folder
  m = name.match(/^(\d{1,3})(?:\s*[vV]\d)?$/);
  if (m && (pathSeason != null || bracketMeta.season != null)) {
    const ep = Number(m[1]);
    if (ep >= 1 && ep <= 999) {
      return finish({
        kind: 'tv',
        title: bracketMeta.cnTitle || titleHintFromPath(relPath) || 'unknown',
        year: null,
        season: pathSeason ?? bracketMeta.season,
        episode: ep,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: name,
      });
    }
  }

  // Anime-style
  m = name.match(/^(?:\[.+?\]\s*)*(.+?)[. _\-]+(\d{1,3})(?:\s*[vV]\d)?(?:[. _\[\(].*)?$/);
  if (m) {
    const ep = Number(m[2]);
    const title = cleanTitle(m[1]);
    const looksAnime = /\[.+?\]/.test(String(filename || ''))
      || /动漫|动画|anime|アニメ/i.test(String(filename || ''))
      || /[\u4e00-\u9fff]{2,}/.test(title)
      || pathKind === 'tv';
    const falseChannel = /\b(?:aac|ddp|dts|ac3)[. _\-]*\d/i.test(name)
      && !/[Ss]\d{1,2}/.test(name)
      && ep <= 7;
    if (title && ep >= 1 && ep <= 190 && looksAnime && !falseChannel) {
      return finish({
        kind: 'tv',
        title,
        year: extractYear(name),
        season: pathSeason ?? bracketMeta.season ?? 1,
        episode: ep,
        _seasonFromDefault: pathSeason == null && bracketMeta.season == null,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: m[1],
      });
    }
  }

  // Daily / variety air-date: 奔跑吧.20240115 / Show.2024.01.15
  m = name.match(
    /^(.*?)[. _\-]*((?:19|20)\d{2})[.\-_ ]?(\d{2})[.\-_ ]?(\d{2})(?:[. _\-]+(.*))?$/i,
  );
  if (m) {
    const y = m[2];
    const mo = Number(m[3]);
    const day = Number(m[4]);
    const title = cleanTitle(m[1]);
    const validDay = mo >= 1 && mo <= 12 && day >= 1 && day <= 31;
    const dateLex = name.slice(m[1].length);
    const hasDateSep = /(?:19|20)\d{2}[.\-_ ]\d{2}/.test(dateLex);
    const blob = `${filename} ${relPath}`;
    const looksDaily = pathKind === 'tv'
      || /综艺|晚会|访谈|真人秀|期|日报|周刊/i.test(blob)
      || (
        hasDateSep
        && /[\u4e00-\u9fff]{2,}/.test(title)
        && !/\b(?:1080|2160|720)p\b/i.test(m[5] || '')
      );
    if (title && validDay && looksDaily) {
      const airDate = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return finish({
        kind: 'tv',
        title,
        year: y,
        season: pathSeason ?? bracketMeta.season ?? 1,
        episode: mo * 100 + day,
        airDate,
        _fromAirDate: true,
        _seasonFromDefault: pathSeason == null && bracketMeta.season == null,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: m[1],
      });
    }
    // Compact YYYYMMDD on a movie title (流浪地球.20190205) → year only
    if (title && validDay && !hasDateSep && pathKind !== 'tv') {
      return finish({
        kind: 'movie',
        title,
        year: y,
        season: null,
        episode: null,
        part: null,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: m[1],
      });
    }
  }

  let part = null;
  const partMatch = name.match(/[. _\-](?:Part|CD|Disc|DVD)[.\s _\-]*(\d{1,2})\b/i);
  if (partMatch) part = Number(partMatch[1]);

  m = name.match(/^(.*?)(?:[. _\-(【\[]+)((?:19|20)\d{2})(?:\s*年)?(?:[. _\-)】\]]+|$)(.*)$/);
  if (m) {
    const title = cleanTitle(m[1]);
    if (title && !/[Ss]\d{1,2}[Ee]\d/i.test(m[3] || '')) {
      return finish({
        kind: 'movie',
        title,
        year: m[2],
        season: null,
        episode: null,
        part,
        tags,
        ext: ext ? `.${ext}` : '',
        rawTitle: m[1],
      });
    }
  }

  if (pathKind === 'movie') {
    return finish({
      kind: 'movie',
      title: cleanTitle(name) || bracketMeta.cnTitle || titleHintFromPath(relPath) || 'unknown',
      year: extractYear(name),
      season: null,
      episode: null,
      part,
      tags,
      ext: ext ? `.${ext}` : '',
      rawTitle: name,
    });
  }

  return finish({
    kind: 'unknown',
    title: cleanTitle(name) || bracketMeta.cnTitle || name || 'unknown',
    year: extractYear(name),
    season: null,
    episode: null,
    part,
    tags,
    ext: ext ? `.${ext}` : '',
    rawTitle: name,
  });
}

/**
 * Strip 【】/[] tags; recover Chinese show title + season from them.
 * e.g. [浪漫的西红柿][良医 第一季]The.Good.Doctor → name=The.Good.Doctor, cnTitle=良医, season=1
 */
export function extractBracketMeta(raw = '') {
  let name = String(raw || '');
  const tagTexts = [];
  let cnTitle = '';
  let season = null;

  const consume = (inner, style) => {
    const text = String(inner || '').trim();
    if (!text) return;
    tagTexts.push(text);

    if (/www\.|http|\.com|\.net|发布|字幕组|论坛|\d+\s*G\b/i.test(text)) return;

    // [良医 第一季] / 【良医 第1季】
    const sm = text.match(
      /^(.+?)\s*第\s*([一二三四五六七八九十百零\d]+)\s*季\s*$/,
    );
    if (sm) {
      const title = sm[1].replace(/[\s·・]+/g, '').trim();
      const s = parseSeasonToken(sm[2]);
      if (title && /[\u4e00-\u9fff]{2,}/.test(title) && !isFansubGroupName(title)) {
        cnTitle = title;
        if (s != null) season = s;
      }
      return;
    }

    // 【良医】 pure short CJK title (fullwidth brackets more often hold titles)
    // Halfwidth [浪漫的西红柿] is usually a fansub — skip unless looks like a tight show name
    if (/^[\u4e00-\u9fffA-Za-z0-9·・]{2,16}$/.test(text) && /[\u4e00-\u9fff]{2,}/.test(text)) {
      if (isFansubGroupName(text)) return;
      if (style === 'square' && text.length >= 5 && /的/.test(text)) return; // 浪漫的西红柿
      if (!cnTitle) cnTitle = text.replace(/[\s·・]+/g, '');
    }
  };

  name = name.replace(/【\s*([^】]*?)\s*】/g, (_, inner) => {
    consume(inner, 'full');
    return ' ';
  });
  name = name.replace(/\[\s*([^\]]*?)\s*\]/g, (_, inner) => {
    consume(inner, 'square');
    return ' ';
  });

  return {
    name: name.replace(/\s+/g, ' ').trim(),
    tagTexts,
    cnTitle,
    season,
  };
}

function parseSeasonToken(tok) {
  const t = String(tok || '').trim();
  if (/^\d{1,2}$/.test(t)) return Number(t);
  if (CN_SEASON_NUM[t] != null) return CN_SEASON_NUM[t];
  return null;
}

function isFansubGroupName(text) {
  const t = String(text || '');
  if (/字幕|压制|工作室|联盟|字幕组|发布组|汉化/i.test(t)) return true;
  // Common playful group pattern: X的Y (浪漫的西红柿)
  if (t.length >= 5 && /的/.test(t) && !/第.+季/.test(t)) return true;
  return false;
}

/** Title looks like "group + cn + english" pollution */
function isPollutedTitle(title, cnTitle) {
  const t = String(title || '');
  if (!cnTitle) return false;
  if (t.includes(cnTitle) && t.length > cnTitle.length + 3) return true;
  if (/的/.test(t) && t.includes(cnTitle)) return true;
  return false;
}

export function seasonFromPath(relPath = '') {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    let m = p.match(/^(?:Season|Seasons|Saison)\s*0*(\d{1,2})$/i);
    if (m) return Number(m[1]);
    m = p.match(/^S0*(\d{1,2})$/i);
    if (m) return Number(m[1]);
    m = p.match(/第\s*([一二三四五六七八九十百零\d]+)\s*季/);
    if (m) {
      const s = parseSeasonToken(m[1]);
      if (s != null) return s;
    }
    m = p.match(/\bS0*(\d{1,2})\b/i);
    if (m && !/S\d{1,2}E\d/i.test(p)) return Number(m[1]);
  }
  return null;
}

export function kindHintFromPath(relPath = '') {
  const p = String(relPath || '');
  if (/电影|(?:^|[\\/])Movies?(?:[\\/]|$)/i.test(p)) return 'movie';
  if (/剧集|电视剧|动漫|番剧|美剧|韩剧|日剧|(?:^|[\\/])(?:TV Shows|Shows?|TV|Anime)(?:[\\/]|$)|Season\s*\d|第\s*\S+\s*季/i.test(p)) {
    return 'tv';
  }
  return null;
}

function titleHintFromPath(relPath = '') {
  const parts = String(relPath || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !/^(?:Season|Seasons|Saison)\s*\d+$/i.test(p))
    .filter((p) => !/^S\d{1,2}$/i.test(p))
    .filter((p) => !/^第\s*\S+\s*季$/.test(p))
    .filter((p) => !/^(?:剧集|电影|电视剧|动漫|视频|未分类|Movies|Movie|Shows|TV|TV Shows|Anime|Unsorted|Specials)$/i.test(p))
    .filter((p) => !/^(?:大陆剧|港台剧|日韩剧|欧美剧|其他剧集)$/.test(p));
  if (!parts.length) return '';
  // Prefer bracket Chinese title inside the segment
  const meta = extractBracketMeta(parts[parts.length - 1]);
  if (meta.cnTitle) return meta.cnTitle;
  return cleanTitle(parts[parts.length - 1]);
}

function extractYear(text) {
  const m = String(text || '').match(/(?:^|[^\d])((?:19|20)\d{2})(?:\s*年)?(?:[^\d]|$)/);
  return m ? m[1] : null;
}

/** Keep release edition tags for rename suffix. */
export function extractEdition(text = '') {
  const raw = String(text || '');
  const m = raw.match(
    /\b(EXTENDED(?:\s*CUT)?|DIRECTORS?(?:[.\s]*CUT)?|REMASTERED|UNRATED|PROPER|REPACK|IMAX|THEATRICAL|CRITERION|LIMITED)\b/i,
  );
  if (!m) return '';
  return m[1]
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bdirectors?\s*cut\b/i, "Director's Cut")
    .replace(/\bextended(?:\s*cut)?\b/i, 'Extended')
    .replace(/\brepack\b/i, 'REPACK')
    .replace(/\bproper\b/i, 'PROPER');
}

function stripYearToken(title, year) {
  if (!title || !year) return title;
  return String(title)
    .replace(new RegExp(`(?:^|[.\\s_\\-_(（])${year}(?:\\s*年)?(?:[.\\s_\\-_)）]|$)`), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(text) {
  let t = String(text || '');
  // Brackets should already be stripped; drop any leftovers without merging content
  t = t.replace(/【[^】]*】/g, ' ');
  t = t.replace(/\[[^\]]*]/g, ' ');
  t = t.replace(/\{\s*tmdb(?:id)?\s*[=:\-]?\s*\d+\s*\}/gi, ' ');
  t = t.replace(/\btmdb(?:id)?\s*[=:\-]?\s*\d+\b/gi, ' ');
  t = t.replace(/\(\s*([^)]*?)\s*\)/g, (_, inner) => {
    if (/^(?:19|20)\d{2}$/.test(inner)) return ' ';
    if (/^\d{3,4}p$/i.test(inner)) return ' ';
    return ' ';
  });
  t = t.replace(RELEASE_GROUP_RE, ' ');
  t = t.replace(JUNK_RE, ' ');
  t = t.replace(CN_JUNK_RE, ' ');
  t = t.replace(/[._]+/g, ' ');
  t = t.replace(/\bS\d{1,2}\b/gi, ' ');
  t = t.replace(/第\s*\S+\s*季/g, ' ');
  t = t.replace(/\b(?:Part|CD|Disc|DVD)[.\s _\-]*\d+\b/gi, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
  return t;
}
