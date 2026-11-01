import { formatMediaFolderName } from './folderMeta.js';

/**
 * Render template with placeholders:
 * {title} {year} {season} {episode} {season:02d} {episode:02d} {ext} {region} {part}
 * {tmdbid} {tmdb} {folder} {date} {edition}
 * - {tmdb} → `{tmdb-71712}` or empty
 * - {folder} → `良医 (2017) {tmdb-71712}` (year/id omitted when missing)
 * - {date} → `2024-01-15` (air-date shows)
 * - {edition} → Extended / PROPER / REPACK …
 */
export function renderTemplate(template, ctx) {
  const src = String(template || '');
  return src.replace(/\{([a-zA-Z_]+)(?::(\d+)d)?\}/g, (_, key, pad) => {
    let val = ctx[key];
    if (val === undefined || val === null || val === '') {
      if (key === 'year') return '未知年份';
      if (key === 'season' || key === 'episode') return pad ? '0'.repeat(Number(pad)) : '0';
      if (key === 'region') return '其他剧集';
      if (key === 'part' || key === 'tmdbid' || key === 'tmdb' || key === 'folder' || key === 'date' || key === 'edition') return '';
      return '';
    }
    if (pad) {
      const n = Number(val);
      if (!Number.isNaN(n)) return String(n).padStart(Number(pad), '0');
    }
    return String(val);
  });
}

/** Series folder year: TMDB/path year, not SxxExx release year on the filename. */
export function folderYear(parsed = {}) {
  if (parsed.kind === 'tv') {
    const series = String(parsed.seriesYear || '').trim();
    if (/^(19|20)\d{2}$/.test(series)) return series;
    if (parsed.season != null && parsed.episode != null) return '';
  }
  return String(parsed.year || '').trim();
}

export function sanitizePathSegment(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '_')
    .slice(0, 200) || 'unnamed';
}

/**
 * @param {object} parsed from parser
 * @param {object} settings already resolved via resolveOrganizeSettings when possible
 * @param {{ moveFiles?: boolean }} opts
 */
export function buildRenamePlan(parsed, settings, opts = {}) {
  const moveFiles = opts.moveFiles !== undefined ? opts.moveFiles : settings.moveFiles !== false;
  const region = sanitizePathSegment(parsed.region || '其他剧集');
  const part = parsed.part != null && Number(parsed.part) > 0 ? Number(parsed.part) : '';
  const tmdbId = parsed.tmdbId != null && String(parsed.tmdbId).trim() !== ''
    ? String(parsed.tmdbId).trim()
    : '';
  const seriesFolderYear = folderYear(parsed);
  const title = sanitizePathSegment(parsed.title || 'unknown');
  const folder = formatMediaFolderName(parsed.title || 'unknown', seriesFolderYear, tmdbId);

  const airDate = String(parsed.airDate || '').trim();
  const edition = String(parsed.edition || '').trim();
  const ctx = {
    title,
    year: seriesFolderYear || parsed.year || '',
    season: parsed.season ?? 1,
    episode: parsed.episode ?? 0,
    part,
    ext: parsed.ext || '',
    region,
    tmdbid: tmdbId,
    tmdb: tmdbId ? `{tmdb-${tmdbId}}` : '',
    folder,
    date: airDate,
    edition,
  };

  let pathTemplate;
  let nameTemplate;
  if (parsed.kind === 'tv') {
    if (region === '大陆剧' && settings.mainlandTvPathTemplate) {
      pathTemplate = settings.mainlandTvPathTemplate;
    } else {
      pathTemplate = settings.tvPathTemplate;
    }
    nameTemplate = settings.tvNameTemplate;
  } else if (parsed.kind === 'movie') {
    pathTemplate = settings.moviePathTemplate;
    nameTemplate = settings.movieNameTemplate;
  } else {
    pathTemplate = settings.unknownPathTemplate;
    nameTemplate = settings.unknownNameTemplate;
  }

  let newBase;
  // Air-date shows: prefer `Title - 2024-01-15` unless template already uses {date}
  if (airDate && parsed._fromAirDate && !/\{date\}/i.test(String(nameTemplate || ''))) {
    newBase = sanitizePathSegment(`${title} - ${airDate}`);
  } else {
    newBase = sanitizePathSegment(renderTemplate(nameTemplate, ctx));
  }
  if (part && !/\{part/i.test(String(nameTemplate || '')) && !/\bPart\s*\d+/i.test(newBase)) {
    newBase = sanitizePathSegment(`${newBase} - Part ${part}`);
  }
  // Multi-episode file: S01E01 → S01E01-E02
  const epEnd = parsed.episodeEnd != null ? Number(parsed.episodeEnd) : 0;
  const ep = parsed.episode != null ? Number(parsed.episode) : 0;
  if (!parsed._fromAirDate && epEnd > ep && ep > 0) {
    const e2 = String(epEnd).padStart(2, '0');
    if (!new RegExp(`E0*${epEnd}\\b`, 'i').test(newBase)) {
      newBase = sanitizePathSegment(
        newBase.replace(/(E\d{1,3})\b/i, `$1-E${e2}`),
      );
    }
  }
  if (
    edition
    && !/\{edition\}/i.test(String(nameTemplate || ''))
    && !new RegExp(edition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(newBase)
  ) {
    newBase = sanitizePathSegment(`${newBase} - ${edition}`);
  }
  const newName = `${newBase}${ctx.ext}`;
  const pathStr = moveFiles ? renderTemplate(pathTemplate, ctx) : '';
  let pathSegments = pathStr
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((seg) => {
      // Keep {tmdb-123} braces; only strip forbidden filesystem chars
      return String(seg || '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    })
    .filter(Boolean);

  const base = settings._basePathSegments
    || String(settings.targetBasePath || '')
      .split(/[\\/]+/)
      .filter(Boolean)
      .map(sanitizePathSegment)
      .filter(Boolean);
  if (moveFiles && base.length) {
    pathSegments = [...base, ...pathSegments];
  }

  return {
    newName,
    pathSegments,
    pathDisplay: pathSegments.join('/'),
    kind: parsed.kind,
    ctx,
  };
}
