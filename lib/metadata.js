/**
 * Similarity between 0 and 1 (Dice on bigrams).
 * Exact normalized match = 1. Do NOT treat CJK substring containment as near-equal
 * (e.g. 良医 ⊂ 善良医生 must NOT score 0.85).
 */
export function similarity(a, b) {
  const s1 = normalize(a);
  const s2 = normalize(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const cjkCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const cjk1 = cjkCount(s1);
  const cjk2 = cjkCount(s2);
  // Latin titles: keep mild containment boost (full phrase inside another)
  if (cjk1 < 2 && cjk2 < 2) {
    if (s1.includes(s2) || s2.includes(s1)) {
      const ratio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
      return Math.min(0.88, 0.55 + ratio * 0.33);
    }
  }

  const bigrams = (s) => {
    const set = new Map();
    if (s.length < 2) {
      set.set(s, 1);
      return set;
    }
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const A = bigrams(s1);
  const B = bigrams(s2);
  let overlap = 0;
  for (const [g, c] of A) {
    if (B.has(g)) overlap += Math.min(c, B.get(g));
  }
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return total ? (2 * overlap) / total : 0;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clean title for TMDB search query. */
export function cleanSearchQuery(title) {
  return String(title || '')
    .replace(/[\[\(].*?[\]\)]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/全\s*\d+\s*集/gi, ' ')
    .replace(/共\s*\d+\s*集/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/全$/u, '');
}

function isLatinQuery(title = '') {
  const t = String(title || '');
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin >= 4 && cjk < 2;
}

function isV4Token(key) {
  return /^eyJ[A-Za-z0-9_-]+\./.test(String(key || '').trim());
}

/** If user pasted v4 JWT, also extract embedded v3 api key (aud). */
function v3KeyFromToken(key) {
  if (!isV4Token(key)) return '';
  try {
    const payload = key.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return String(json.aud || '');
  } catch {
    return '';
  }
}

async function fetchWithTimeout(fetchFn, url, init = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`请求超时 (${timeoutMs / 1000}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TMDB API fetch with v3 api_key or v4 Read Access Token.
 * Domestic networks often cannot reach api.themoviedb.org — callers should fallback to web search.
 */
async function tmdbFetch(fetchFn, apiKey, path, params = {}, timeoutMs = 8000) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('未配置 TMDB API Key');

  const attempts = [];
  if (isV4Token(key)) {
    attempts.push({ mode: 'v4', key });
    const v3 = v3KeyFromToken(key);
    if (v3) attempts.push({ mode: 'v3', key: v3 });
  } else {
    attempts.push({ mode: 'v3', key });
  }

  let lastErr;
  for (const attempt of attempts) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      q.set(k, String(v));
    }
    /** @type {RequestInit} */
    const init = {
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
    if (attempt.mode === 'v4') {
      init.headers.Authorization = `Bearer ${attempt.key}`;
    } else {
      q.set('api_key', attempt.key);
    }
    const url = `https://api.themoviedb.org/3${path}?${q}`;
    try {
      const res = await fetchWithTimeout(fetchFn, url, init, timeoutMs);
      if (res.status === 401) {
        lastErr = new Error('TMDB API Key 无效，请到设置页检查');
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`TMDB 请求失败 HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('TMDB API 不可用');
}

const COUNTRY_NAME_TO_ISO = {
  韩国: 'KR', 韓囯: 'KR', 南韩: 'KR', Korea: 'KR', 'South Korea': 'KR',
  日本: 'JP', Japan: 'JP',
  中国: 'CN', 大陆: 'CN', 内地: 'CN', China: 'CN',
  中国香港: 'HK', 香港: 'HK', 'Hong Kong': 'HK',
  中国台湾: 'TW', 台湾: 'TW', Taiwan: 'TW',
  美国: 'US', 'United States': 'US', USA: 'US',
  英国: 'GB', 'United Kingdom': 'GB', UK: 'GB',
};

/** In-memory search cache (same show title → one network round-trip per session). */
const tmdbSearchCache = new Map();
/** In-memory detail-by-id cache (`tv|71712` → detail hit). */
const tmdbDetailCache = new Map();

function tmdbSearchCacheKey(query) {
  const kind = query.kind === 'movie' ? 'movie' : query.kind === 'tv' ? 'tv' : '';
  const title = normalize(cleanSearchQuery(query.title));
  // TV: ignore year so episodes still share cache
  const year = kind === 'movie' ? String(query.year || '') : '';
  return `${kind}|${title}|${year}`;
}

export function clearTmdbSearchCache() {
  tmdbSearchCache.clear();
  tmdbDetailCache.clear();
}

/** Seed detail cache (e.g. from chrome.storage.local). */
export function primeTmdbDetailCache(entries = {}) {
  for (const [key, value] of Object.entries(entries || {})) {
    if (!key || !value || typeof value !== 'object') continue;
    if (!value.title) continue;
    tmdbDetailCache.set(key, value);
  }
}

/** Export detail cache for persistence (cap size). */
export function exportTmdbDetailCache({ max = 400 } = {}) {
  const entries = [...tmdbDetailCache.entries()]
    .filter(([, v]) => v && v.title)
    .slice(-Math.max(50, Number(max) || 400));
  return Object.fromEntries(entries);
}

export const TMDB_DETAIL_STORAGE_KEY = 'tmdbDetailCacheV1';

/**
 * Search via www.themoviedb.org HTML (works when api.themoviedb.org is blocked).
 */
export async function searchTmdbWeb(fetchFn, query) {
  const qTitle = cleanSearchQuery(query.title);
  if (!qTitle) return null;
  const kind = query.kind === 'movie' ? 'movie' : query.kind === 'tv' ? 'tv' : null;
  const types = kind ? [kind] : ['tv', 'movie'];
  // Latin queries: prefer en so card title matches "The Ordinary Jackpot";
  // CJK queries: zh first for 中头奖还是要上班.
  const languages = isLatinQuery(qTitle) ? ['en-US', 'zh-CN'] : ['zh-CN', 'en-US'];
  let best = null;

  for (const type of types) {
    for (const language of languages) {
      const url = `https://www.themoviedb.org/search/${type}?query=${encodeURIComponent(qTitle)}&language=${language}`;
      let html;
      try {
        const res = await fetchWithTimeout(fetchFn, url, {
          headers: {
            Accept: 'text/html',
            'Accept-Language': language.startsWith('zh') ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
          },
        }, 12000);
        if (!res.ok) continue;
        html = await res.text();
      } catch {
        continue;
      }

      // TMDB card: data-media-type before href on <a>
      const re = /data-media-type="(tv|movie)"[^>]*href="\/(?:tv|movie)\/(\d+)(?:-[^"?]*)?(?:\?[^"]*)?"/g;
      let m;
      const seen = new Set();
      /** @type {object[]} */
      const pageHits = [];
      while ((m = re.exec(html))) {
        const mediaType = m[1];
        const id = Number(m[2]);
        // /search/tv pages still embed movie cards — never cross-accept
        if (mediaType !== type) continue;
        if (seen.has(`${mediaType}:${id}`)) continue;
        seen.add(`${mediaType}:${id}`);

        const slice = html.slice(m.index, m.index + 2800);
        const alt = slice.match(/<img[^>]*\salt="([^"]*)"/i)?.[1]?.trim() || '';
        const h2 = slice.match(
          /<h2[^>]*>[\s\S]*?<span>([^<]*)<\/span>(?:[\s\S]*?<span[^>]*>\s*\(([^)]*)\)\s*<\/span>)?/,
        );
        const title = (h2?.[1] || alt || '').trim();
        const originalTitle = (h2?.[2] || title).trim();
        if (!title) continue;

        const dateText = slice.match(/class="[^"]*release_date[^"]*"[^>]*>([^<]*)</)?.[1]?.trim() || '';
        const yearMatch = dateText.match(/(19|20)\d{2}/);
        const year = yearMatch ? yearMatch[0] : null;
        const posterUrl = extractPosterUrl(slice);
        const slug = String(m[0].match(/\/(?:tv|movie)\/\d+-([^"?]*)/)?.[1] || '')
          .replace(/-/g, ' ');

        const scoreZh = similarity(qTitle, title);
        const scoreOrig = similarity(qTitle, originalTitle);
        const scoreAlt = alt ? similarity(qTitle, alt) : 0;
        const scoreSlug = slug ? similarity(qTitle, slug) : 0;
        let score = Math.max(scoreZh, scoreOrig, scoreAlt, scoreSlug);
        // Exact title / poster alt win hard (良医 === 良医 → 1.0 beats 善良医生)
        if (
          normalize(title) === normalize(qTitle)
          || (alt && normalize(alt) === normalize(qTitle))
          || (slug && normalize(slug) === normalize(qTitle))
        ) {
          score = 1;
        }
        if (query.year && year && year === String(query.year)) score = Math.min(1, score + 0.12);

        let originalLanguage = '';
        let originCountries = [];
        if (/[\uac00-\ud7af]/.test(originalTitle)) {
          originalLanguage = 'ko';
          originCountries = ['KR'];
        } else if (/[\u3040-\u30ff]/.test(originalTitle)) {
          originalLanguage = 'ja';
          originCountries = ['JP'];
        }

        const cand = {
          title: title || originalTitle,
          originalTitle,
          year,
          kind: mediaType === 'tv' ? 'tv' : 'movie',
          source: 'tmdb-web',
          score,
          id,
          originCountries,
          originalLanguage,
          isAnime: false,
          popularity: score,
          posterUrl: posterUrl || undefined,
        };
        pageHits.push(cand);
        // Prefer higher score; on ties keep earlier (more relevant) result
        if (!best || cand.score > best.score) best = cand;
        if (best.score >= 1) break;
      }

      // TMDB already filtered by our query: sole hit with weak title-locale score still counts
      // (en query vs zh-CN card title used to score ~0 and get dropped).
      if (pageHits.length === 1 && pageHits[0].score < 0.72) {
        pageHits[0].score = Math.max(pageHits[0].score, 0.84);
        if (!best || pageHits[0].score >= best.score) best = pageHits[0];
      } else if (pageHits.length > 1 && pageHits[0].score < 0.55 && isLatinQuery(qTitle)) {
        pageHits[0].score = Math.max(pageHits[0].score, 0.7);
        if (!best || pageHits[0].score > best.score) best = pageHits[0];
      }

      if (best?.score >= 1) break;
    }
    if (best?.score >= 1) break;
  }

  if (!best || best.score < 0.35) return null;
  if (kind && best.kind !== kind) return null;

  // Enrich country/year from detail page schema.org when possible
  try {
    const detail = await fetchTmdbWebDetail(fetchFn, best.kind, best.id);
    if (detail) {
      const titleLooksBad = !detail.title
        || /^the movie database$/i.test(detail.title)
        || /^tmdb$/i.test(detail.title);
      best = {
        ...best,
        title: titleLooksBad ? best.title : detail.title,
        year: detail.year || best.year,
        originCountries: detail.originCountries?.length
          ? detail.originCountries
          : best.originCountries,
        originalLanguage: detail.originalLanguage || best.originalLanguage,
        posterUrl: detail.posterUrl || best.posterUrl,
        score: best.score,
        source: 'tmdb-web',
      };
    }
  } catch {
    /* ignore */
  }
  return best;
}

/** Strip CDATA / HTML comments so schema.org JSON can parse. */
function parseLdJson(raw) {
  const cleaned = String(raw || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  if (!cleaned) return null;
  return JSON.parse(cleaned);
}

async function fetchTmdbWebDetail(fetchFn, kind, id) {
  const type = kind === 'movie' ? 'movie' : 'tv';
  const url = `https://www.themoviedb.org/${type}/${id}?language=zh-CN`;
  const res = await fetchWithTimeout(fetchFn, url, {
    headers: { Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
  }, 12000);
  if (!res.ok) return null;
  const html = await res.text();
  // Cloudflare interstitial
  if (/just a moment/i.test(html) || /cf-browser-verification/i.test(html)) return null;

  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  let schema = null;
  for (const block of blocks) {
    try {
      const obj = parseLdJson(block[1]);
      if (!obj || typeof obj !== 'object') continue;
      const t = obj['@type'];
      if (t === 'TVSeries' || t === 'Movie') {
        schema = obj;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  if (!schema) return null;

  const title = String(schema.name || '').trim();
  if (!title || /^the movie database$/i.test(title)) return null;

  const year = String(schema.startDate || schema.datePublished || '').slice(0, 4) || null;
  const countries = [];
  const origins = schema.countryOfOrigin || [];
  for (const c of Array.isArray(origins) ? origins : [origins]) {
    const name = c?.name || c;
    const iso = COUNTRY_NAME_TO_ISO[name] || COUNTRY_NAME_TO_ISO[String(name || '').trim()];
    if (iso) countries.push(iso);
  }
  let originalLanguage = '';
  if (countries.includes('KR')) originalLanguage = 'ko';
  else if (countries.includes('JP')) originalLanguage = 'ja';
  else if (countries.includes('CN') || countries.includes('HK') || countries.includes('TW')) originalLanguage = 'zh';
  const posterUrl = extractPosterUrl(html)
    || normalizePosterUrl(schema.image?.url || schema.image || schema.thumbnailUrl);

  return {
    title,
    year: year && /^(19|20)\d{2}$/.test(year) ? year : undefined,
    originCountries: countries,
    originalLanguage,
    posterUrl: posterUrl || undefined,
  };
}

/**
 * Load title/year/poster/countries by TMDB id (API → web). Cached per session.
 */
export async function fetchTmdbById(fetchFn, apiKey, kind, id) {
  const type = kind === 'movie' ? 'movie' : 'tv';
  const tid = String(id || '').trim();
  if (!/^\d+$/.test(tid)) return null;
  const cacheKey = `${type}|${tid}`;
  if (tmdbDetailCache.has(cacheKey)) return tmdbDetailCache.get(cacheKey);

  let hit = null;
  const key = String(apiKey || '').trim();
  if (key) {
    try {
      const detail = await tmdbFetch(fetchFn, key, `/${type}/${tid}`, { language: 'zh-CN' }, 8000);
      const { title, originalTitle } = pickTitle(detail, type);
      const year = (detail.first_air_date || detail.release_date || '').slice(0, 4) || null;
      const originCountries = Array.isArray(detail.origin_country)
        ? detail.origin_country
        : (detail.production_countries || []).map((c) => c.iso_3166_1).filter(Boolean);
      const genres = detail.genres || [];
      const isAnime = genres.some((g) => g.id === 16)
        && ((originCountries || []).includes('JP') || detail.original_language === 'ja');
      if (title) {
        hit = {
          title,
          originalTitle,
          year: year && /^(19|20)\d{2}$/.test(year) ? year : undefined,
          originCountries: originCountries || [],
          originalLanguage: detail.original_language || '',
          isAnime,
          posterUrl: detail.poster_path
            ? `https://image.tmdb.org/t/p/w185${detail.poster_path}`
            : undefined,
          source: 'tmdb-id',
        };
      }
    } catch {
      /* fall through to web */
    }
  }

  if (!hit) {
    try {
      const detail = await fetchTmdbWebDetail(fetchFn, type, tid);
      if (detail?.title) {
        hit = {
          ...detail,
          originalTitle: detail.title,
          isAnime: false,
          source: 'tmdb-web-id',
        };
      }
    } catch {
      hit = null;
    }
  }

  tmdbDetailCache.set(cacheKey, hit);
  return hit;
}

/** Pull TMDB poster URL from HTML snippet or absolute/relative image path. */
function extractPosterUrl(html = '') {
  const srcset = String(html).match(
    /srcset="([^"]*media\.themoviedb\.org[^"]+)"/i,
  )?.[1];
  if (srcset) {
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (first) return first.replace(/\/w\d+_and_h\d+_face\//, '/w185/');
  }
  const src = String(html).match(
    /(?:src|content)="(https?:\/\/(?:media|image)\.themoviedb\.org[^"]+)"/i,
  )?.[1];
  if (src) return src.replace(/\/w\d+_and_h\d+_face\//, '/w185/');
  const og = String(html).match(/property="og:image"\s+content="([^"]+)"/i)
    || String(html).match(/content="([^"]+)"\s+property="og:image"/i);
  if (og?.[1]) return og[1];
  return '';
}

function normalizePosterUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `https://image.tmdb.org/t/p/w185${s}`;
  return `https://image.tmdb.org/t/p/w185/${s.replace(/^\//, '')}`;
}

function pickTitle(item, type) {
  const localized = type === 'tv' ? item.name : item.title;
  const original = type === 'tv' ? item.original_name : item.original_title;
  // Prefer Chinese / localized when different & non-empty
  const title = (localized && String(localized).trim()) || original || '';
  return {
    title: String(title).trim(),
    originalTitle: String(original || title || '').trim(),
  };
}

function scoreCandidate(queryTitle, item, type, queryYear) {
  const { title, originalTitle } = pickTitle(item, type);
  const year = (item.first_air_date || item.release_date || '').slice(0, 4) || null;

  const scoreZh = similarity(queryTitle, title);
  const scoreOrig = similarity(queryTitle, originalTitle);
  let score = Math.max(scoreZh, scoreOrig);

  // Light bonus if year matches
  if (queryYear && year && year === String(queryYear)) score = Math.min(1, score + 0.12);
  // Soft penalty for year mismatch (still allow — filenames often wrong)
  if (queryYear && year && Math.abs(Number(year) - Number(queryYear)) >= 3) {
    score = Math.max(0, score - 0.08);
  }

  const originCountries = Array.isArray(item.origin_country) ? item.origin_country : [];
  const originalLanguage = item.original_language || '';
  const genreIds = item.genre_ids || [];
  const isAnime = genreIds.includes(16) && (originCountries.includes('JP') || originalLanguage === 'ja');

  return {
    title,
    originalTitle,
    year,
    kind: type === 'tv' ? 'tv' : 'movie',
    source: 'tmdb',
    score,
    id: item.id,
    originCountries,
    originalLanguage,
    isAnime,
    popularity: Number(item.popularity) || 0,
    posterUrl: item.poster_path
      ? `https://image.tmdb.org/t/p/w185${item.poster_path}`
      : undefined,
  };
}

/**
 * Search TMDB and pick best match for title calibration.
 * Tries official API first; falls back to www.themoviedb.org when API is blocked/timeout.
 * @param {typeof fetch} fetchFn
 * @param {string} apiKey
 * @param {{ title: string, year?: string|null, kind?: string }} query
 */
export async function searchTmdb(fetchFn, apiKey, query) {
  const qTitle = cleanSearchQuery(query.title);
  if (!qTitle) return null;

  const cacheKey = tmdbSearchCacheKey(query);
  if (tmdbSearchCache.has(cacheKey)) {
    return tmdbSearchCache.get(cacheKey);
  }

  const kind = query.kind === 'tv' ? 'tv' : query.kind === 'movie' ? 'movie' : null;
  const types = kind ? [kind] : ['tv', 'movie'];
  let best = null;
  let apiError = null;

  if (apiKey) {
    const runSearch = async (type, withYear) => {
      const params = {
        query: qTitle,
        language: 'zh-CN',
        include_adult: 'false',
        page: 1,
      };
      if (withYear && query.year) {
        if (type === 'movie') params.year = query.year;
        else params.first_air_date_year = query.year;
      }
      const data = await tmdbFetch(fetchFn, apiKey, `/search/${type}`, params, 8000);
      for (const item of data.results || []) {
        const cand = scoreCandidate(qTitle, item, type, query.year);
        if (!best || cand.score > best.score || (cand.score === best.score && cand.popularity > best.popularity)) {
          best = cand;
        }
      }
    };

    try {
      for (const type of types) {
        await runSearch(type, !!query.year);
      }
      if (!best || best.score < 0.55) {
  for (const type of types) {
          await runSearch(type, false);
        }
      }
    } catch (err) {
      apiError = err;
      if (/API Key 无效/.test(err.message || '')) {
        // still try web fallback for title match; key only needed for API
      }
    }
  }

  // Strong API hit — cache and return (previously skipped cache on early return)
  if (best && best.score >= 0.72) {
    tmdbSearchCache.set(cacheKey, best);
    return best;
  }

  // Web fallback (国内可访问 www，常不可访问 api)
  try {
    const webHit = await searchTmdbWeb(fetchFn, query);
    if (webHit && (!best || webHit.score >= (best?.score || 0))) {
      best = webHit;
    }
  } catch (err) {
    if (!best && apiError) throw apiError;
    if (!best) throw err;
  }

  const result = best && best.score >= 0.42 ? best : null;
  tmdbSearchCache.set(cacheKey, result);
  return result;
}

/**
 * Optionally refine Chinese title via detail + translations endpoint.
 */
export async function refineTmdbTitle(fetchFn, apiKey, hit) {
  if (!hit?.id || !hit?.kind) return hit;
  const type = hit.kind === 'tv' ? 'tv' : 'movie';
  try {
    const detail = await tmdbFetch(fetchFn, apiKey, `/${type}/${hit.id}`, {
      language: 'zh-CN',
    });
    const { title, originalTitle } = pickTitle(detail, type);
    const year = (detail.first_air_date || detail.release_date || '').slice(0, 4) || hit.year;
    const originCountries = Array.isArray(detail.origin_country)
      ? detail.origin_country
      : (detail.production_countries || []).map((c) => c.iso_3166_1).filter(Boolean);
    const genres = detail.genres || [];
    const isAnime = genres.some((g) => g.id === 16)
      && ((originCountries || []).includes('JP') || detail.original_language === 'ja');

    // If zh title still equals original Latin title, try translations
    let finalTitle = title;
    if (finalTitle && originalTitle && normalize(finalTitle) === normalize(originalTitle)) {
      try {
        const tr = await tmdbFetch(fetchFn, apiKey, `/${type}/${hit.id}/translations`);
        const list = tr.translations || [];
        const zh = list.find((t) => t.iso_639_1 === 'zh' && (t.iso_3166_1 === 'CN' || t.iso_3166_1 === 'SG'))
          || list.find((t) => t.iso_639_1 === 'zh');
        const data = zh?.data || {};
        const translated = (data.name || data.title || '').trim();
        if (translated) finalTitle = translated;
      } catch {
        /* ignore */
      }
    }

    return {
      ...hit,
      title: finalTitle || hit.title,
      originalTitle: originalTitle || hit.originalTitle,
      year: year || hit.year,
      originCountries: originCountries?.length ? originCountries : hit.originCountries,
      originalLanguage: detail.original_language || hit.originalLanguage,
      isAnime: isAnime || hit.isAnime,
      overview: detail.overview || '',
      refined: true,
    };
  } catch {
    return hit;
  }
}

/**
 * Douban search suggestion (unofficial, best-effort).
 */
export async function searchDouban(fetchFn, query) {
  const q = encodeURIComponent(cleanSearchQuery(query.title));
  const url = `https://movie.douban.com/j/subject_suggest?q=${q}`;
  try {
    const res = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        Referer: 'https://movie.douban.com/',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    let best = null;
    const qTitle = cleanSearchQuery(query.title);
    for (const item of data || []) {
      if (!item || (item.type !== 'movie' && item.type !== 'tv')) continue;
      const title = item.title || '';
      const year = item.year ? String(item.year) : null;
      let score = similarity(qTitle, title);
      if (query.year && year === String(query.year)) score = Math.min(1, score + 0.1);
      if (!best || score > best.score) {
        best = {
          title,
          originalTitle: title,
          year,
          kind: item.type === 'tv' ? 'tv' : 'movie',
          source: 'douban',
          score,
          id: item.id,
        };
      }
    }
    return best && best.score >= 0.4 ? best : null;
  } catch {
    return null;
  }
}

/**
 * Canonical series/movie title used for TMDB dedupe + query.
 * Prefer Chinese parent-folder title so all episodes of one pack share one query.
 */
export function seriesQueryTitle(parsed) {
  const path = String(parsed?.pathTitle || '').trim();
  if (path && /[\u4e00-\u9fff]/.test(path)) return cleanSearchQuery(path);
  const search = String(parsed?.searchTitle || '').trim();
  if (search) return cleanSearchQuery(search);
  return cleanSearchQuery(parsed?.title || parsed?.localTitle || parsed?.originalTitle || '');
}

/**
 * Release-group English titles that don't match TMDB primary name.
 * Key = normalize(cleanSearchQuery(title)) without spaces.
 */
const TV_SEARCH_ALIASES = {
  strawman: ['The Scarecrow', 'Scarecrow', '허수아비', '稻草人'],
  稻草人: ['The Scarecrow', 'Scarecrow', '허수아비'],
  scarecrow: ['The Scarecrow', '稻草人', '허수아비'],
  thescarecrow: ['稻草人', '허수아비'],
};

/** Filename has SxxExx / episode markers → never accept a movie TMDB hit. */
export function isEpisodeLockedTv(parsed) {
  if (!parsed) return false;
  if (parsed.kind === 'tv' && parsed.season != null && parsed.episode != null) return true;
  if (parsed.season != null && parsed.episode != null) return true;
  return false;
}

/**
 * Build ordered TMDB search titles.
 * Prefer exact Chinese title; also try Latin original (The Good Doctor) so remakes don't steal the hit.
 */
function buildSearchTitles(parsed) {
  const titles = [];
  const push = (t) => {
    const s = cleanSearchQuery(t);
    if (!s) return;
    if (titles.some((x) => normalize(x) === normalize(s))) return;
    titles.push(s);
  };

  const primary = seriesQueryTitle(parsed);
  const latin = [parsed.originalTitle, parsed.localTitle, parsed.title]
    .map((t) => cleanSearchQuery(t))
    .find((t) => t && /^[\t\x20]*[A-Za-z]/.test(t) && (t.match(/[A-Za-z]/g) || []).length >= 4);
  const pathCjk = /[\u4e00-\u9fff]{2,}/.test(String(parsed.pathTitle || parsed.searchTitle || ''));

  // Path already has Chinese show title (稻草人) → search CJK first; Latin remakes second.
  // Only prefer Latin first for explicit 美剧/欧美 packs without CJK path title.
  const westernHint = /美剧|英剧|欧美|HBO|AMZN|Netflix/i.test(
    `${parsed.relPath || ''} ${parsed.rawTitle || ''} ${parsed.pathTitle || ''} ${parsed.title || ''}`,
  );
  if (pathCjk) {
    push(primary);
    if (latin) push(latin);
  } else {
    if (westernHint && latin) push(latin);
    push(primary);
    if (latin) push(latin);
  }
  push(parsed.pathTitle);
  push(parsed.searchTitle);
  push(parsed.title);
  push(parsed.originalTitle);
  push(parsed.localTitle);

  // Known release-name ≠ TMDB name (Strawman → The Scarecrow)
  for (const seed of [...titles]) {
    const key = normalize(seed).replace(/\s+/g, '');
    for (const alt of TV_SEARCH_ALIASES[key] || []) push(alt);
  }
  return titles;
}

/**
 * Calibrate title via TMDB first, optional Douban only as supplement.
 */
export async function enrichParsed(fetchFn, settings, parsed, { refine = true } = {}) {
  if (!settings.enableMetadata) return null;

  const hasTmdb = !!String(settings.tmdbApiKey || '').trim();
  const lockedTv = isEpisodeLockedTv(parsed);
  const kind = lockedTv
    ? 'tv'
    : (parsed.kind === 'unknown' ? null : parsed.kind);
  // Folder year is reliable; use for scoring / remake disambiguation (API may soft-filter)
  const year = parsed.year || null;
  let douban = null;
  let tmdb = null;

  // 0) Folder/file already has {tmdb-123} → load by id (no ambiguous search)
  const existingId = String(parsed.tmdbId || '').trim();
  if (/^\d+$/.test(existingId)) {
    const idKind = lockedTv ? 'tv' : (kind === 'movie' ? 'movie' : 'tv');
    try {
      const detail = await fetchTmdbById(
        fetchFn,
        settings.tmdbApiKey || '',
        idKind,
        existingId,
      );
      if (detail?.title) {
        return {
          title: detail.title,
          originalTitle: detail.originalTitle || parsed.originalTitle || detail.title,
          year: detail.year || parsed.year || null,
          kind: idKind,
          source: detail.source === 'tmdb-id' ? 'tmdb-path' : 'tmdb-path',
          score: 1,
          id: Number(existingId),
          originCountries: detail.originCountries || [],
          originalLanguage: detail.originalLanguage || '',
          isAnime: !!detail.isAnime,
          posterUrl: detail.posterUrl,
          queriedAs: `tmdb-${existingId}`,
        };
      }
    } catch {
      /* fall through to local path meta */
    }
    return {
      title: parsed.pathTitle || parsed.title,
      originalTitle: parsed.originalTitle || parsed.title,
      year: parsed.year || null,
      kind: idKind,
      source: 'path-tmdb',
      score: 1,
      id: Number(existingId),
      originCountries: parsed.originCountries || [],
      originalLanguage: parsed.originalLanguage || '',
      isAnime: !!parsed.isAnime,
      posterUrl: parsed.posterUrl,
      queriedAs: `tmdb-${existingId}`,
    };
  }

  // 1) TMDB 优先（API → 网页兜底）；有中文剧名时只查一次
  {
    const candidates = buildSearchTitles(parsed);
    for (const title of candidates) {
      try {
        const hit = await searchTmdb(fetchFn, settings.tmdbApiKey || '', { title, year, kind });
        // Never accept movie hit for episode-locked / explicit TV query
        if (hit && kind && hit.kind && hit.kind !== kind) continue;
        if (hit && (!tmdb || hit.score > tmdb.score)) {
          tmdb = { ...hit, queriedAs: title };
        }
        if (tmdb && tmdb.score >= 0.72) break;
      } catch {
        /* try next candidate / web already handled inside searchTmdb */
      }
    }
    if (tmdb && kind && tmdb.kind && tmdb.kind !== kind) tmdb = null;
    // API 命中且无中文名时再 refine；网页命中通常已是中文
    const needRefine = refine && hasTmdb && tmdb && tmdb.source === 'tmdb'
      && !/[\u4e00-\u9fff]/.test(tmdb.title || '');
    if (needRefine) {
      try {
        tmdb = await refineTmdbTitle(fetchFn, settings.tmdbApiKey, tmdb);
      } catch {
        /* ignore */
      }
    }
  }

  // 2) 仅在明确开启时才查豆瓣，且只作中文名补充
  if (settings.preferDouban === true) {
    const doubanTitle = tmdb?.title || parsed.pathTitle || parsed.title;
    douban = await searchDouban(fetchFn, { title: doubanTitle, year: tmdb?.year || year, kind: tmdb?.kind || kind });
  }

  if (tmdb && douban) {
    const doubanHasCjk = /[\u4e00-\u9fff]/.test(douban.title || '');
    const tmdbHasCjk = /[\u4e00-\u9fff]/.test(tmdb.title || '');
    if (doubanHasCjk && !tmdbHasCjk) {
      return {
        ...tmdb,
        title: douban.title,
        year: douban.year || tmdb.year,
        source: 'tmdb+douban',
        score: Math.max(tmdb.score, douban.score),
        doubanId: douban.id,
      };
    }
    return tmdb;
  }

  return tmdb || douban;
}

/**
 * Stable cache key: one TV series → one key (ignore episode year / filename noise).
 */
export function calibrationKey(parsed) {
  const kind = parsed?.kind === 'movie'
    ? 'movie'
    : parsed?.kind === 'tv'
      ? 'tv'
      : (parsed?.kind || 'unknown');
  const tid = String(parsed?.tmdbId || '').trim();
  if (/^\d+$/.test(tid)) return `${kind}|tmdb:${tid}`;
  const title = normalize(seriesQueryTitle(parsed));
  if (kind === 'movie') return `${kind}|${title}|${parsed?.year || ''}`;
  return `${kind}|${title}`;
}

/**
 * Batch calibrate unique titles with cache + limited concurrency.
 * Same series (path title / tmdb id) is queried once and reused for all episodes.
 * Path `{tmdb-id}` lookups use a shorter delay.
 */
export async function calibrateTitles(fetchFn, settings, parsedList, {
  delayMs = 350,
  concurrency = 3,
  onProgress,
  signal,
  shouldStop,
} = {}) {
  const cache = new Map();
  const results = new Map(); // key -> hit|null
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stopped = () => !!(signal?.aborted || (typeof shouldStop === 'function' && shouldStop()));

  const unique = [];
  const seen = new Set();
  for (const parsed of parsedList) {
    const key = calibrationKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ key, parsed });
  }

  onProgress?.({
    index: 0,
    total: unique.length,
    title: '',
    unique: unique.length,
    files: parsedList.length,
  });

  let done = 0;
  let cursor = 0;
  const workers = Math.max(1, Math.min(Number(concurrency) || 3, unique.length || 1));

  async function runOne({ key, parsed }) {
    const label = seriesQueryTitle(parsed) || parsed.title;
    const hasId = /^\d+$/.test(String(parsed?.tmdbId || '').trim());
    if (cache.has(key)) {
      results.set(key, cache.get(key));
      done += 1;
      onProgress?.({
        index: done,
        total: unique.length,
        title: label,
        unique: unique.length,
        files: parsedList.length,
      });
      return;
    }
    try {
      const hit = await enrichParsed(fetchFn, settings, parsed);
      cache.set(key, hit);
      results.set(key, hit);
    } catch (err) {
      cache.set(key, null);
      results.set(key, null);
      onProgress?.({
        index: done,
        total: unique.length,
        title: label,
        error: err.message || String(err),
      });
    }
    done += 1;
    onProgress?.({
      index: done,
      total: unique.length,
      title: label,
      unique: unique.length,
      files: parsedList.length,
    });
    const wait = hasId ? Math.min(delayMs, 60) : delayMs;
    if (wait > 0 && done < unique.length && !stopped()) await sleep(wait);
  }

  async function worker() {
    while (!stopped()) {
      const idx = cursor;
      cursor += 1;
      if (idx >= unique.length) return;
      await runOne(unique[idx]);
    }
    if (stopped() && done < unique.length) {
      onProgress?.({
        index: done,
        total: unique.length,
        title: '',
        aborted: true,
      });
    }
  }

  if (!unique.length) return results;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
