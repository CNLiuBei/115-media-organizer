/**
 * Run: node tools/folder-meta-selftest.js
 */
import { formatMediaFolderName, parseFolderMeta, metaFromRelPath, extractTmdbId } from '../lib/folderMeta.js';
import { calibrationKey, cleanSearchQuery, isEpisodeLockedTv } from '../lib/metadata.js';
import { buildPreviewRows, isAlreadyOrganized, executeOrganize } from '../lib/organizer.js';
import { DEFAULT_SETTINGS, cmpVersion, resolveLayoutKey } from '../lib/types.js';
import { resolveOrganizeSettings } from '../lib/settings.js';
import { buildRenamePlan } from '../lib/rename.js';
import { buildLayoutTreePreview } from '../lib/folderOptions.js';
import { parseMediaFilename } from '../lib/parser.js';
import {
  isJunkMediaName,
  isAdDumpName,
  isKeepableVideoFile,
  isCleanupJunkFile,
  hasRealMediaSignal,
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
import { fileId, seasonNumberFromFolderName, tmdbIdFromFolderName } from '../lib/api115.js';
import { folderYear, renderTemplate, sanitizePathSegment } from '../lib/rename.js';

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
  parsed.seriesYear = '2017';
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
  check(
    'scan root above library still organized',
    isAlreadyOrganized({
      ...row,
      item: { _relPath: `媒体库/${rel}` },
    }) === true,
  );
  check(
    'Season-only current path not organized',
    isAlreadyOrganized({
      ...row,
      item: { _relPath: 'Season 1' },
    }) === false,
  );
}

{
  const movieRow = {
    originalName: '流浪地球 (2019).mkv',
    newName: '流浪地球 (2019).mkv',
    kind: 'movie',
    parsed: { tmdbId: '535167', title: '流浪地球', year: '2019', kind: 'movie' },
    pathSegments: ['电影', '流浪地球 (2019) {tmdb-535167}'],
    item: { _relPath: '电影/错误片名 (2019) {tmdb-535167}' },
  };
  check(
    'same tmdb wrong movie folder not organized',
    isAlreadyOrganized(movieRow) === false,
  );
  check(
    'same tmdb matching movie folder organized',
    isAlreadyOrganized({
      ...movieRow,
      item: { _relPath: '电影/流浪地球 (2019) {tmdb-535167}' },
    }) === true,
  );
}

{
  const settings = resolveOrganizeSettings({ ...DEFAULT_SETTINGS, moveFiles: true });
  const rel = '剧集/欧美剧/良医 (2017) {tmdb-71712}/Season 01';
  const name = '良医 - S01E01.mkv';
  const parsed = parseMediaFilename(name, { relPath: rel });
  parsed.tmdbId = '71712';
  parsed.year = '2017';
  parsed.seriesYear = '2017';
  parsed.title = '良医';
  parsed.region = '欧美剧';
  const plan = buildRenamePlan(parsed, settings);
  check(
    'Season 01 matches Season 1',
    isAlreadyOrganized({
      originalName: name,
      newName: plan.newName,
      pathSegments: plan.pathSegments,
      kind: 'tv',
      parsed,
      item: { _relPath: rel },
    }) === true,
    JSON.stringify({ planned: plan.pathSegments, newName: plan.newName }),
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
check('junk trailer after year', isJunkMediaName('Movie.2023.Trailer.1080p.mkv') === true);
check('junk 预告', isJunkMediaName('电影名-预告片.mkv') === true);
check('not junk', isJunkMediaName('良医 - S01E01.mkv') === false);
check('Trailer Park Boys not junk', isJunkMediaName('Trailer.Park.Boys.S01E01.mkv') === false);
check('The.Trailer.2023 not junk', isJunkMediaName('The.Trailer.2023.mkv') === false);
check('Preview.Show not junk', isJunkMediaName('Preview.Show.S01E01.mkv') === false);
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
  'tiny named episode not size-junk',
  isCleanupJunkFile({ n: 'Show.S01E01.mkv', s: 800_000 }, { minSizeMB: 50 }) === false,
);
check(
  'tiny unnamed clip still junk',
  isCleanupJunkFile({ n: 'random_clip.mkv', s: 800_000 }) === true,
);
check(
  '40MB named episode keepable without minSize',
  isKeepableVideoFile({ n: 'Show.S01E01.mkv', s: 40 * 1024 * 1024 }, { minSizeMB: 0 }) === true,
);
check(
  '25MB no-signal video is cleanup junk',
  isCleanupJunkFile({ n: 'random_clip.mkv', s: 25 * 1024 * 1024 }) === true,
);
check(
  '25MB episode with signal not size-junk',
  isCleanupJunkFile({ n: 'Show.S01E01.mkv', s: 25 * 1024 * 1024 }, { minSizeMB: 50 }) === false,
);
check(
  '40MB no-signal not ad-sized junk',
  isCleanupJunkFile({ n: 'random_clip.mkv', s: 40 * 1024 * 1024 }, { minSizeMB: 50 }) === false,
);
check(
  'named ad over 30MB still junk',
  isCleanupJunkFile({
    n: '【更多无水印高品质资源请访问 www.bthdting.com】.MKV',
    s: 40 * 1024 * 1024,
  }) === true,
);
check(
  '25MB titled episode keepable when minSizeMB=0',
  isKeepableVideoFile({ n: 'Show.S01E01.mkv', s: 25 * 1024 * 1024 }, { minSizeMB: 0 }) === true,
);
check(
  '25MB no-signal not keepable',
  isKeepableVideoFile({ n: 'random_clip.mkv', s: 25 * 1024 * 1024 }, { minSizeMB: 0 }) === false,
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
  'ad png promo is junk',
  isAdDumpName('更多电视剧集下载请访问 高清剧集网官网 (www.BTHDTV.com) .png') === true,
);
check(
  'ad png is cleanup junk',
  isCleanupJunkFile({
    n: '更多电视剧集下载请访问 高清剧集网官网 (www.BTHDTV.com) .png',
    s: 1_860_000,
  }) === true,
);
check(
  'ad url shell is junk',
  isAdDumpName('请访问官网 www.PTHDTV.com.url') === true,
);
check(
  'poster.jpg not ad',
  isAdDumpName('poster.jpg') === false,
);
check(
  'real poster not cleanup junk',
  isCleanupJunkFile({ n: 'poster.jpg', s: 120_000 }) === false,
);
check(
  'real episode not cleanup junk',
  isCleanupJunkFile({ n: 'The.Ordinary.Jackpot.S01E01.mkv', s: 400_000_000 }, { minSizeMB: 50 }) === false,
);
check(
  'subtitle not cleanup junk',
  isCleanupJunkFile({ n: 'Show.S01E01.zh.srt', s: 40_000 }) === false,
);
// Real release-group prefixes must NOT be ads
check(
  'BTHDTV episode not ad',
  isAdDumpName('【高清剧集网发布 www.BTHDTV.com】杀手妈咪.S01E14.mkv') === false,
);
check(
  'BTHDTV episode keepable',
  isKeepableVideoFile(
    { n: '【高清剧集网发布 www.BTHDTV.com】杀手妈咪.S01E14.mkv', s: 500_000_000 },
    { minSizeMB: 50 },
  ) === true,
);
check(
  'BTHDTV strawman not ad',
  isAdDumpName(
    '【高清剧集网发布 www.BTHDTV.com】稻草人[全12集][简繁英字幕].Strawman.S01E01.1080p.Viu.WEB-DL.mkv',
  ) === false,
);
// Broad ad coverage samples
const AD_SAMPLES = [
  '更多电视剧集下载请访问 高清剧集网官网 (www.BTHDTV.com) .png',
  '【更多无水印高品质资源请访问 www.bthdting.com】.DOC',
  '【更多无水印高品质资源请访问 www.bthdting.com】.MKV',
  '加微信领福利.jpg',
  '微信二维码.png',
  '扫码关注公众号.gif',
  '防失联最新地址.txt',
  '官网地址.url',
  '福利合集.html',
  'QQ群：123456.txt',
  '关注公众号领资源.pdf',
  'www.PTHDTV.com.png',
  '广告.png',
  '必看说明.txt',
  '【www.example-site.com】.mp4',
  '请访问唯一官网 www.foo.cc.doc',
  'TG群资源合集.url',
  '加V免费课程.jpg',
];
for (const sample of AD_SAMPLES) {
  check(`ad cover: ${sample.slice(0, 28)}`, isAdDumpName(sample) === true);
}
check(
  'wechat qr cleanup junk',
  isCleanupJunkFile({ n: '微信二维码.png', s: 80_000 }) === true,
);
check(
  'readme media not ad',
  isAdDumpName('Show.S01E01.mkv') === false,
);
check(
  'Outgunned not TG false positive',
  isAdDumpName('Outgunned.2024.mkv') === false,
);
// Regression: quality tags must not launder ads; .me must not sink Love.Me
check(
  'ad with fake 1080p still ad',
  isAdDumpName('更多资源请访问官网 www.evil.com.1080p.mkv') === true,
);
check(
  'ad bracket with fake 1080p still ad',
  isAdDumpName('【更多无水印高品质资源请访问 www.bthdting.com】.1080p.mkv') === true,
);
check(
  '广告.AAC still ad',
  isAdDumpName('广告.AAC.mp4') === true,
);
check(
  'Call.Me.By.Your.Name not ad',
  isAdDumpName('Call.Me.By.Your.Name.mkv') === false,
);
check(
  'Call.Me.By.Your.Name has real signal',
  hasRealMediaSignal('Call.Me.By.Your.Name.mkv') === true,
);
check(
  'Call.Me 25MB not size-junk',
  isCleanupJunkFile({ n: 'Call.Me.By.Your.Name.mkv', s: 25 * 1024 * 1024 }, { minSizeMB: 50 }) === false,
);
check(
  'Love.Me not ad',
  isAdDumpName('Love.Me.mkv') === false,
);
check(
  'Find.Me.2022 not ad',
  isAdDumpName('Find.Me.2022.mkv') === false,
);
check(
  'Find.Me.2022 keepable',
  isKeepableVideoFile({ n: 'Find.Me.2022.mkv', s: 2e9 }, { minSizeMB: 50 }) === true,
);
check(
  'normal srt not junk',
  isCleanupJunkFile({ n: 'Show.S01E01.zh.srt', s: 40_000 }) === false,
);
check(
  'normal nfo not junk',
  isCleanupJunkFile({ n: 'Show.S01E01.nfo', s: 2_000 }) === false,
);
check(
  'poster not junk',
  isCleanupJunkFile({ n: 'poster.jpg', s: 120_000 }) === false,
);
// Movies (no SxxExx) with release-group prefix
check(
  'CN movie with BTHDTV prefix not ad',
  isAdDumpName('【高清剧集网发布 www.BTHDTV.com】流浪地球.mkv') === false,
);
check(
  'EN movie bare title with BTHDTV prefix not ad',
  isAdDumpName('【高清剧集网发布 www.BTHDTV.com】Oppenheimer.mkv') === false,
);
check(
  'EN movie with year/res not ad',
  isAdDumpName('【高清剧集网发布 www.BTHDTV.com】Oppenheimer.2023.1080p.BluRay.mkv') === false,
);
check(
  'movie promo png still ad',
  isAdDumpName('更多电影下载请访问 高清剧集网官网 (www.BTHDTV.com) .png') === true,
);
check(
  'movie keepable after prefix',
  isKeepableVideoFile(
    { n: '【高清剧集网发布 www.BTHDTV.com】Oppenheimer.mkv', s: 2_000_000_000 },
    { minSizeMB: 50 },
  ) === true,
);
check(
  'Catalog.txt not ad',
  isAdDumpName('Catalog.txt') === false,
);
check(
  'VIP unlock ad',
  isAdDumpName('开通VIP免费观看完整版.txt') === true,
);
check(
  'extract code ad',
  isAdDumpName('提取码abc123.txt') === true,
);
check(
  'magnet note ad',
  isAdDumpName('magnet:?xt=urn:btih:abcdef.txt') === true,
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
  const videos = [{ fid: 'v1', n: 'Show.1x02.mkv', _relPath: 'A', fc: '1' }];
  const extras = attachCompanions(videos, [
    ...videos,
    { fid: 's1', n: 'Show.S01E02.zh-hans.srt', _relPath: 'A', fc: '1' },
  ]);
  check(
    'companion 1x02 to S01E02',
    extras.length === 1 && extras[0]._companionOf === 'v1',
    JSON.stringify(extras),
  );
}

{
  // Same filename in different folders must not cross-wire subtitles
  const videos = [
    { fid: 'va', n: 'Show.S01E01.mkv', _relPath: 'A', fc: '1' },
    { fid: 'vb', n: 'Show.S01E01.mkv', _relPath: 'B', fc: '1' },
  ];
  const all = [
    ...videos,
    { fid: 'sa', n: 'Show.S01E01.zh.srt', _relPath: 'A', fc: '1' },
    { fid: 'sb', n: 'Show.S01E01.zh.srt', _relPath: 'B', fc: '1' },
  ];
  const extras = attachCompanions(videos, all);
  const byId = Object.fromEntries(extras.map((e) => [e.fid, e._companionOf]));
  check(
    'companion scoped per folder',
    byId.sa === 'va' && byId.sb === 'vb',
    JSON.stringify(byId),
  );
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
  const subCollide = findDestinationCollisions([
    { id: 's1', selected: true, companionOf: 'v1', newName: 'Show - S01E01.zh.srt', pathSegments: ['Show'] },
    { id: 's2', selected: true, companionOf: 'v1', newName: 'Show - S01E01.zh.srt', pathSegments: ['Show'] },
  ]);
  check(
    'companion destination collisions',
    subCollide.length === 1 && subCollide[0].count === 2,
    JSON.stringify(subCollide),
  );
}

{
  // executeOrganize should block later duplicate newNames in same dest
  const calls = [];
  const api = {
    async ensurePath(segs) { calls.push(['mkdir', segs.join('/')]); return 'd1'; },
    async batchRenameChunked(map) { calls.push(['rename', { ...map }]); },
    async moveFilesBatched(ids, dest) { calls.push(['move', ids.slice(), dest]); },
  };
  const results = await executeOrganize(api, [
    { id: 'a', selected: true, originalName: 'A.mkv', newName: 'Same.mkv', pathSegments: ['Show'] },
    { id: 'b', selected: true, originalName: 'B.mkv', newName: 'Same.mkv', pathSegments: ['Show'] },
  ], { rootCid: 'root', moveFiles: true, delayMs: 0 });
  check(
    'organize blocks rename collision',
    results.some((r) => r.id === 'b' && !r.ok)
      && results.some((r) => r.id === 'a' && r.ok)
      && !calls.some((c) => c[0] === 'move' && c[1].includes('b')),
    JSON.stringify({ results, calls }),
  );
}

{
  const calls = [];
  const api = {
    async ensurePath() { throw new Error('mkdir fail'); },
    async batchRenameChunked(map) { calls.push(['rename', { ...map }]); },
    async batchRename(map) { calls.push(['rename', { ...map }]); },
    async moveFilesBatched() { calls.push(['move']); },
    async moveFiles() { calls.push(['move']); },
  };
  const results = await executeOrganize(api, [
    { id: 'a', selected: true, originalName: 'A.mkv', newName: 'B.mkv', pathSegments: ['Show'] },
  ], { rootCid: 'root', moveFiles: true, delayMs: 0 });
  check(
    'mkdir fail does not rename',
    results.some((r) => r.id === 'a' && !r.ok)
      && !calls.some((c) => c[0] === 'rename'),
    JSON.stringify({ results, calls }),
  );
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

{
  const settings = resolveOrganizeSettings({ ...DEFAULT_SETTINGS, moveFiles: true, folderLayout: 'cn_video' });
  const withSeries = buildRenamePlan(
    {
      kind: 'tv', title: '良医', year: '2024', seriesYear: '2017', tmdbId: '71712',
      region: '欧美剧', season: 2, episode: 1, ext: '.mkv',
    },
    settings,
  );
  check(
    'S02 folder uses series year not filename year',
    withSeries.pathSegments.some((s) => s.includes('2017') && s.includes('tmdb-71712'))
      && !withSeries.pathSegments.some((s) => /\(2024\)/.test(s)),
    JSON.stringify(withSeries.pathSegments),
  );
  check(
    'tv folderYear prefers seriesYear',
    folderYear({ kind: 'tv', year: '2024', seriesYear: '2017', season: 2, episode: 1 }) === '2017',
  );
  check(
    'tv folderYear omits episode filename year',
    folderYear({ kind: 'tv', year: '2024', season: 2, episode: 1 }) === '',
  );
}

check(
  'tmdb id from existing show folder',
  tmdbIdFromFolderName('良医 (2017) {tmdb-71712}') === '71712'
    && tmdbIdFromFolderName('The Good Doctor (2017) {tmdb-71712}') === '71712',
);
check('Season 01 number is 1', seasonNumberFromFolderName('Season 01') === 1);
check('Season 1 number is 1', seasonNumberFromFolderName('Season 1') === 1);

check(
  'subtitle without fid is not parent cid',
  fileId({ n: 'Show.S01E01.zh.srt', cid: 'parent', fc: '1' }) === '',
);
check(
  'file fid still used',
  fileId({ n: 'Show.S01E01.mkv', fid: 'abc', cid: 'parent', fc: '1' }) === 'abc',
);

{
  const emby = resolveOrganizeSettings({ ...DEFAULT_SETTINGS, moveFiles: true, folderLayout: 'emby' });
  const tv = buildRenamePlan(
    {
      kind: 'tv', title: '良医', year: '2017', seriesYear: '2017', tmdbId: '71712',
      region: '欧美剧', season: 1, episode: 1, ext: '.mkv',
    },
    emby,
  );
  const movie = buildRenamePlan(
    { kind: 'movie', title: '流浪地球', year: '2019', tmdbId: '535167', ext: '.mkv' },
    emby,
  );
  check(
    'emby tv tree',
    tv.pathDisplay === '剧集/良医 (2017) {tmdb-71712}/Season 01'
      && tv.newName === '良医 - S01E01.mkv',
    `${tv.pathDisplay} :: ${tv.newName}`,
  );
  check(
    'emby movie tree',
    movie.pathDisplay === '电影/流浪地球 (2019) {tmdb-535167}'
      && movie.newName === '流浪地球 (2019).mkv',
    `${movie.pathDisplay} :: ${movie.newName}`,
  );
  check('jellyfin alias → emby_en', resolveLayoutKey('jellyfin') === 'emby_en');
  check('typed alias → emby', resolveLayoutKey('typed') === 'emby');
  const tree = buildLayoutTreePreview({ folderLayout: 'emby' });
  check(
    'emby preview tree',
    /电影/.test(tree) && /剧集/.test(tree) && /Season 01/.test(tree) && /流浪地球/.test(tree),
    tree,
  );
}

check(
  'KR origin beats 美剧 filename',
  detectRegion({
    filename: '【美剧】Show.S02E01.mkv',
    title: 'Show',
    originCountries: ['KR'],
  }) === '日韩剧',
);
check(
  'SubsPlease + KR stays 日韩 not 动漫',
  detectRegion({
    filename: '[SubsPlease] Show - 12 (1080p).mkv',
    originCountries: ['KR'],
    isAnime: true,
  }) === '日韩剧',
);
check(
  'region folder in path still wins',
  detectRegion({
    relPath: '剧集/欧美剧/良医',
    originCountries: ['KR'],
  }) === '欧美剧',
);

/* ---------- rename: template rendering & edge cases ---------- */
{
  check(
    'renderTemplate pads numbers',
    renderTemplate('S{season:02d}E{episode:02d}', { season: 1, episode: 5 }) === 'S01E05',
  );
  check(
    'renderTemplate missing season/episode pad to 00',
    renderTemplate('S{season:02d}E{episode:02d}', {}) === 'S00E00',
  );
  check(
    'renderTemplate unknown key renders empty',
    renderTemplate('{title} ({year})', { title: 'X' }) === 'X ()',
  );
  check('sanitizePathSegment dots-only', sanitizePathSegment('...') === '_');
  check('sanitizePathSegment empty fallback', sanitizePathSegment('') === 'unnamed');

  // 全角空括号：自定义模板 {title}（{year}） 年份缺失时不残留 （）
  const cnBracket = resolveOrganizeSettings({
    ...DEFAULT_SETTINGS,
    movieNameTemplate: '{title}（{year}）',
  });
  check(
    'strip full-width empty brackets',
    buildRenamePlan({ kind: 'movie', title: 'Film', ext: '.mkv' }, cnBracket).newName === 'Film.mkv',
  );
  check(
    'keep full-width brackets when year exists',
    buildRenamePlan({ kind: 'movie', title: 'Film', year: '2020', ext: '.mkv' }, cnBracket).newName
      === 'Film（2020）.mkv',
  );

  // Part 追加：模板无 {part} 时追加 - Part N
  check(
    'append Part when template lacks {part}',
    buildRenamePlan(
      { kind: 'tv', title: 'Show', region: '欧美剧', season: 1, episode: 3, part: 2, ext: '.mkv' },
      resolveOrganizeSettings({ ...DEFAULT_SETTINGS }),
    ).newName === 'Show - S01E03 - Part 2.mkv',
  );

  // moveFiles=false → 不生成路径
  check(
    'no path when moveFiles off',
    buildRenamePlan(
      { kind: 'tv', title: 'Show', region: '欧美剧', season: 1, episode: 1, ext: '.mkv' },
      resolveOrganizeSettings({ ...DEFAULT_SETTINGS, moveFiles: false }),
    ).pathSegments.length === 0,
  );

  // targetBasePath 前置到路径段最前
  const withBase = buildRenamePlan(
    { kind: 'tv', title: '良医', seriesYear: '2017', region: '欧美剧', season: 1, episode: 1, ext: '.mkv' },
    resolveOrganizeSettings({ ...DEFAULT_SETTINGS, moveFiles: true, targetBasePath: '媒体库/新剧' }),
  );
  check(
    'targetBasePath prepended',
    withBase.pathSegments[0] === '媒体库' && withBase.pathSegments[1] === '新剧',
    withBase.pathDisplay,
  );
}

/* ---------- types: cmpVersion dotted version compare ---------- */
{
  check('cmpVersion 0.0.100 > 0.0.56', cmpVersion('0.0.100', '0.0.56') === 1);
  check('cmpVersion 0.0.56 < 0.0.100', cmpVersion('0.0.56', '0.0.100') === -1);
  check('cmpVersion equal', cmpVersion('0.0.56', '0.0.56') === 0);
  check('cmpVersion 0.1 == 0.1.0', cmpVersion('0.1', '0.1.0') === 0);
  check('cmpVersion 0.2 > 0.1.9', cmpVersion('0.2', '0.1.9') === 1);
  check('cmpVersion 1.0 > 0.9.9', cmpVersion('1.0', '0.9.9') === 1);
  check('cmpVersion empty treated as 0', cmpVersion('', '0.0.1') === -1);
  check('cmpVersion both empty equal', cmpVersion('', '') === 0);
  check('cmpVersion ignores junk parts', cmpVersion('0.0.56a', '0.0.56') === 0);
}

console.log(fail ? `\nFAILED ${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
