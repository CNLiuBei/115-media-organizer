/**
 * Run: node tools/folder-meta-selftest.js
 */
import { formatMediaFolderName, parseFolderMeta, metaFromRelPath, extractTmdbId } from '../lib/folderMeta.js';
import { calibrationKey, cleanSearchQuery, isEpisodeLockedTv } from '../lib/metadata.js';
import { buildPreviewRows, isAlreadyOrganized } from '../lib/organizer.js';
import { DEFAULT_SETTINGS } from '../lib/types.js';
import { resolveOrganizeSettings } from '../lib/settings.js';
import { buildRenamePlan } from '../lib/rename.js';
import { parseMediaFilename } from '../lib/parser.js';
import {
  isJunkMediaName,
  isAdDumpName,
  isKeepableVideoFile,
  isCleanupJunkFile,
  attachCompanions,
  filterMediaFiles,
} from '../lib/filter.js';
import {
  findDuplicateEpisodes,
  findEpisodeGaps,
  findDestinationCollisions,
  sortRowsByEpisode,
} from '../lib/organizer.js';
import {
  extractCjkTitle,
  titleFromRelPath,
  cleanFolderTitle,
  preferCleanPathTitle,
} from '../lib/pathTitle.js';
import { detectRegion } from '../lib/region.js';

let fail = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('ok', name);
  else {
    fail += 1;
    console.log('FAIL', name, detail);
  }
}

check(
  'format folder',
  formatMediaFolderName('良医', '2017', '71712') === '良医 (2017) {tmdb-71712}',
);

check(
  'format omit missing',
  formatMediaFolderName('良医', '', '') === '良医'
    && formatMediaFolderName('良医', '2017', '') === '良医 (2017)',
);

{
  const m = parseFolderMeta('良医 (2017) {tmdb-71712}');
  check('parse jellyfin folder', m.title === '良医' && m.year === '2017' && m.tmdbId === '71712', JSON.stringify(m));
}

{
  const m = parseFolderMeta('The Good Doctor (2017) [tmdbid=71712]');
  check('parse emby bracket', m.tmdbId === '71712' && m.year === '2017', JSON.stringify(m));
}

{
  const m = parseFolderMeta('良医.2017.{tmdb-71712}');
  check('parse dotted year+id', m.tmdbId === '71712' && m.year === '2017' && m.title.includes('良医'), JSON.stringify(m));
}

check('extract id loose', extractTmdbId('foo tmdbid:71712 bar') === '71712');

{
  const m = metaFromRelPath('剧集/欧美剧/良医 (2017) {tmdb-71712}/Season 1');
  check(
    'metaFromRelPath season skip',
    m.tmdbId === '71712' && m.year === '2017' && m.title === '良医',
    JSON.stringify(m),
  );
}

{
  const key = calibrationKey({ kind: 'tv', tmdbId: '71712', title: 'x', pathTitle: '良医' });
  check('calibrationKey by id', key === 'tv|tmdb:71712', key);
}

{
  const settings = resolveOrganizeSettings({ ...DEFAULT_SETTINGS, enableMetadata: false, moveFiles: true });
  const rows = buildPreviewRows(
    [{
      fid: '1',
      n: 'The.Good.Doctor.S01E01.mkv',
      s: 500_000_000,
      _relPath: '剧集/欧美剧/良医 (2017) {tmdb-71712}/Season 1',
      _mediaType: 'video',
    }],
    settings,
  );
  const p = rows[0]?.parsed;
  check(
    'preview path-tmdb provisional',
    p?.tmdbId === '71712' && p?.year === '2017' && p?.title === '良医' && p?.metaSource === 'path-tmdb',
    JSON.stringify({ title: p?.title, year: p?.year, tmdbId: p?.tmdbId, metaSource: p?.metaSource, path: rows[0]?.pathDisplay }),
  );
  check(
    'preview folder in path',
    /良医 \(2017\) \{tmdb-71712\}/.test(rows[0]?.pathDisplay || ''),
    rows[0]?.pathDisplay,
  );
}

{
  const settings = resolveOrganizeSettings({ ...DEFAULT_SETTINGS, moveFiles: true });
  const rel = '剧集/欧美剧/良医 (2017) {tmdb-71712}/Season 1';
  const name = '良医 - S01E01.mkv';
  const parsed = parseMediaFilename(name, { relPath: rel });
  parsed.tmdbId = '71712';
  parsed.year = '2017';
  parsed.title = '良医';
  parsed.region = '欧美剧';
  const plan = buildRenamePlan(parsed, settings);
  const row = {
    originalName: name,
    newName: plan.newName,
    pathSegments: plan.pathSegments,
    pathDisplay: plan.pathDisplay,
    kind: 'tv',
    parsed,
    item: { _relPath: rel },
  };
  check(
    'already organized same path',
    isAlreadyOrganized(row) === true,
    JSON.stringify({ newName: row.newName, path: row.pathDisplay }),
  );
}

{
  const p = parseMediaFilename('Show.S01E01-E02.mkv');
  check('episode range end', p.episode === 1 && p.episodeEnd === 2, JSON.stringify(p));
  const plan = buildRenamePlan(
    { ...p, title: 'Show', region: '欧美剧' },
    resolveOrganizeSettings({ ...DEFAULT_SETTINGS }),
  );
  check('episode range rename', /E01-E02/i.test(plan.newName), plan.newName);
}

check('junk sample', isJunkMediaName('Movie.Sample.mkv') === true);
check('junk trailer', isJunkMediaName('Show.Trailer.mp4') === true);
check('junk 预告', isJunkMediaName('电影名-预告片.mkv') === true);
check('not junk', isJunkMediaName('良医 - S01E01.mkv') === false);
check(
  'ad dump name',
  isAdDumpName('【更多无水印高品质资源请访问 www.bthdting.com】.MKV') === true,
);
check(
  'ad dump is junk',
  isJunkMediaName('【更多无水印高品质资源请访问 www.bthdting.com】.MP4') === true,
);
check(
  'ad dump not keepable',
  isKeepableVideoFile(
    { n: '【更多无水印高品质资源请访问 www.bthdting.com】.MKV', s: 622_000 },
    { minSizeMB: 50 },
  ) === false,
);
check(
  'tiny clip not keepable',
  isKeepableVideoFile({ n: 'Show.S01E01.mkv', s: 800_000 }, { minSizeMB: 0 }) === false,
);
check(
  'real episode keepable',
  isKeepableVideoFile({ n: 'The.Ordinary.Jackpot.S01E01.mkv', s: 400_000_000 }, { minSizeMB: 50 }) === true,
);
check(
  'ad doc is cleanup junk',
  isCleanupJunkFile({ n: '【更多无水印高品质资源请访问 www.bthdting.com】.DOC', s: 289000 }) === true,
);
check(
  'real episode not cleanup junk',
  isCleanupJunkFile({ n: 'The.Ordinary.Jackpot.S01E01.mkv', s: 400_000_000 }, { minSizeMB: 50 }) === false,
);
check(
  'subtitle not cleanup junk',
  isCleanupJunkFile({ n: 'Show.S01E01.zh.srt', s: 40_000 }) === false,
);

{
  const settings = { ...DEFAULT_SETTINGS, minSizeMB: 0 };
  const kept = filterMediaFiles(
    [
      { fid: '1', n: 'Show.S01E01.mkv', s: 1e9, fc: '1' },
      { fid: '2', n: 'Show.S01E01-sample.mkv', s: 1e7, fc: '1' },
    ],
    settings,
  );
  check('filter skips sample', kept.length === 1 && kept[0].fid === '1', kept.map((x) => x.n).join(','));
}

{
  const videos = [{ fid: 'v1', n: '良医 - S01E01.mkv', _relPath: 'Season 1', fc: '1' }];
  const all = [
    ...videos,
    { fid: 's1', n: 'The.Good.Doctor.S01E01.zh.srt', _relPath: 'Season 1', fc: '1' },
  ];
  const extras = attachCompanions(videos, all);
  check('companion by episode key', extras.length === 1 && extras[0]._companionOf === 'v1', JSON.stringify(extras));
}

{
  const dups = findDuplicateEpisodes([
    { parsed: { kind: 'tv', season: 1, episode: 1 } },
    { parsed: { kind: 'tv', season: 1, episode: 1 } },
    { parsed: { kind: 'tv', season: 1, episode: 2 } },
  ]);
  check('dup episodes', dups.length === 1 && dups[0].key === 'S01E01' && dups[0].count === 2, JSON.stringify(dups));
}

{
  const gaps = findEpisodeGaps([
    { parsed: { kind: 'tv', season: 1, episode: 1 } },
    { parsed: { kind: 'tv', season: 1, episode: 2 } },
    { parsed: { kind: 'tv', season: 1, episode: 4 } },
  ]);
  check('episode gaps', gaps.some((g) => g.key === 'S01E03'), JSON.stringify(gaps));
}

{
  const sorted = sortRowsByEpisode([
    { originalName: 'b', parsed: { season: 1, episode: 3 } },
    { originalName: 'a', parsed: { season: 1, episode: 1 } },
  ]);
  check('sort by episode', sorted[0].parsed.episode === 1, JSON.stringify(sorted.map((r) => r.parsed.episode)));
}

{
  const collisions = findDestinationCollisions([
    { id: '1', selected: true, newName: 'A.mkv', pathSegments: ['剧集', 'Show'] },
    { id: '2', selected: true, newName: 'A.mkv', pathSegments: ['剧集', 'Show'] },
    { id: '3', selected: true, newName: 'B.mkv', pathSegments: ['剧集', 'Show'] },
  ]);
  check('destination collisions', collisions.length === 1 && collisions[0].count === 2, JSON.stringify(collisions));
}

{
  const p = parseMediaFilename('奔跑吧.20240115.mkv', { relPath: '综艺' });
  check('air date parse', p.kind === 'tv' && p.airDate === '2024-01-15' && p._fromAirDate, JSON.stringify(p));
  const plan = buildRenamePlan(
    { ...p, title: '奔跑吧', region: '大陆剧' },
    resolveOrganizeSettings({ ...DEFAULT_SETTINGS }),
  );
  check('air date rename', plan.newName === '奔跑吧 - 2024-01-15.mkv', plan.newName);
}

{
  const p = parseMediaFilename('Film.Name.2020.REPACK.1080p.mkv');
  check('edition REPACK', /repack/i.test(p.edition || ''), JSON.stringify(p.edition));
  const plan = buildRenamePlan(
    { ...p, title: 'Film Name', kind: 'movie', year: '2020', edition: p.edition },
    resolveOrganizeSettings({ ...DEFAULT_SETTINGS }),
  );
  check('edition in rename', /REPACK/i.test(plan.newName), plan.newName);
}

{
  const folder = '中头奖还是要上班全10集';
  check('strip 全N集 cjk', extractCjkTitle(folder) === '中头奖还是要上班', extractCjkTitle(folder));
  check('strip 全N集 folder', cleanFolderTitle(folder) === '中头奖还是要上班', cleanFolderTitle(folder));
  check(
    'strip 全N集 path',
    titleFromRelPath(`BTHDTV.com/${folder}`) === '中头奖还是要上班',
    titleFromRelPath(`BTHDTV.com/${folder}`),
  );
  check(
    'cleanSearchQuery drops 全N集',
    cleanSearchQuery('中头奖还是要上班全') === '中头奖还是要上班',
    cleanSearchQuery('中头奖还是要上班全'),
  );
  check(
    'HBOMax not force 欧美 when KR',
    detectRegion({
      filename: 'The.Ordinary.Jackpot.S01E01.HBOMax.WEB-DL.mkv',
      title: '中头奖还是要上班',
      originCountries: ['KR'],
      originalLanguage: 'ko',
    }) === '日韩剧',
  );
}

{
  const pack = '【高清剧集网发布 www.BTHDTV.com】稻草人[全12集][简繁英字幕].Strawman.S01.1080p.Viu.WEB-DL.AAC2.0.H.264-BlackTV';
  check('strawman pack cjk', extractCjkTitle(pack) === '稻草人', extractCjkTitle(pack));
  check('strawman pack path', titleFromRelPath(pack) === '稻草人', titleFromRelPath(pack));
  check('strawman pack meta', parseFolderMeta(pack).title === '稻草人', JSON.stringify(parseFolderMeta(pack)));
  check('strawman pack metaPath', metaFromRelPath(pack).title === '稻草人', JSON.stringify(metaFromRelPath(pack)));
  check(
    'preferCleanPathTitle',
    preferCleanPathTitle('【站点】稻草人.Strawman.S01.1080p', '稻草人') === '稻草人',
  );
  const ep = parseMediaFilename('Strawman.S01E01.1080p.Viu.WEB-DL.mkv');
  check('strawman episode locked tv', isEpisodeLockedTv(ep) === true && ep.kind === 'tv');
  const rows = buildPreviewRows(
    [{
      fid: 's1',
      n: 'Strawman.S01E01.1080p.Viu.WEB-DL.AAC2.0.H.264-BlackTV.mkv',
      s: 400_000_000,
      fc: '1',
      _relPath: pack,
      _mediaType: 'video',
    }],
    resolveOrganizeSettings({ ...DEFAULT_SETTINGS, enableMetadata: false, moveFiles: true }),
  );
  check(
    'strawman preview pathTitle',
    rows[0]?.parsed?.pathTitle === '稻草人' && rows[0]?.parsed?.kind === 'tv',
    JSON.stringify(rows[0]?.parsed),
  );
  check(
    'Viu + CJK path → 日韩',
    detectRegion({
      filename: 'Strawman.S01E01.1080p.Viu.WEB-DL.mkv',
      title: '稻草人',
      relPath: pack,
    }) === '日韩剧',
  );
}

console.log(fail ? `\nFAILED ${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
