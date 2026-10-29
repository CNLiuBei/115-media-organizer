/**
 * Run: node tools/parser-selftest.js
 */
import { parseMediaFilename } from '../lib/parser.js';

const cases = [
  ['A.Bona.Fide.Killer.S01E01.1080p.WEB-DL.AAC.2.0.H.264-BlackTV.mkv', '', { kind: 'tv', title: 'A Bona Fide Killer', S: 1, E: 1 }],
  ['杀手妈咪.S01E01.mkv', '', { kind: 'tv', title: '杀手妈咪', S: 1, E: 1 }],
  ['杀手妈咪 第01集.mkv', '', { kind: 'tv', title: '杀手妈咪', S: 1, E: 1 }],
  ['杀手妈咪.第1季.第2集.mkv', '', { kind: 'tv', title: '杀手妈咪', S: 1, E: 2 }],
  ['杀手妈咪 03集.mkv', '', { kind: 'tv', title: '杀手妈咪', S: 1, E: 3 }],
  ['【伪装者】第08集.mp4', '', { kind: 'tv', title: '伪装者', S: 1, E: 8 }],
  ['Show.Name.S01EP03.mkv', '', { kind: 'tv', title: 'Show Name', S: 1, E: 3 }],
  ['Some.Show.S01E01E02.mkv', '', { kind: 'tv', title: 'Some Show', S: 1, E: 1 }],
  ['Title.2024.S02E10.WEB-DL.mkv', '', { kind: 'tv', title: 'Title', S: 2, E: 10, y: '2024' }],
  ['纪录片.上集.mkv', '', { kind: 'tv', title: '纪录片', S: 1, E: 1 }],
  ['纪录片.下集.mkv', '', { kind: 'tv', title: '纪录片', S: 1, E: 3 }],
  ['Show.特别篇01.mkv', '', { kind: 'tv', S: 0, E: 1 }],
  ['01.mkv', 'Show/Season 2', { kind: 'tv', title: 'Show', S: 2, E: 1 }],
  ['第05集.mkv', '杀手妈咪/第2季', { kind: 'tv', title: '杀手妈咪', S: 2, E: 5 }],
  ['Movie.Name.2023.1080p.BluRay.mkv', '', { kind: 'movie', title: 'Movie Name', y: '2023' }],
  ['电影名.2021年.mkv', '', { kind: 'movie', title: '电影名', y: '2021' }],
  ['Film.Name.2020.Part.2.1080p.mkv', '', { kind: 'movie', title: 'Film Name', y: '2020', part: 2 }],
  ['无年份电影.mkv', '电影/华语', { kind: 'movie' }],
  ['[SubsPlease] Anime Title - 12 (1080p).mkv', '', { kind: 'tv', title: 'Anime Title', S: 1, E: 12 }],
  ['【高清剧集网发布 www.BTHDTV.com】杀手妈咪.S01E14.mkv', '', { kind: 'tv', title: '杀手妈咪', S: 1, E: 14 }],
  [
    '[浪漫的西红柿][良医 第一季]The.Good.Doctor.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H265.mp4',
    '美剧【良医】1-6季 1080P中字【64G】/[良医 第一季]The.Good.Doctor.S01.1080p.AMZN.WEB-DL.DDP5.1.H265',
    { kind: 'tv', title: '良医', S: 1, E: 1 },
  ],
  [
    '[浪漫的西红柿][良医 第二季]The.Good.Doctor.S02E03.1080p.mkv',
    '',
    { kind: 'tv', title: '良医', S: 2, E: 3 },
  ],
  ['Show.S01E01-E02.mkv', '', { kind: 'tv', title: 'Show', S: 1, E: 1 }],
  ['剧名 第01-03集.mkv', '', { kind: 'tv', title: '剧名', S: 1, E: 1 }],
  ['奔跑吧.20240115.mkv', '综艺', { kind: 'tv', title: '奔跑吧', y: '2024' }],
  ['节目.2024.01.15.mkv', '', { kind: 'tv', title: '节目', y: '2024' }],
  ['Show Name EP03.mkv', 'Show/Season 1', { kind: 'tv', title: 'Show Name', S: 1, E: 3 }],
  ['Show.Episode.12.mkv', '', { kind: 'tv', title: 'Show', S: 1, E: 12 }],
  ['Movie.2020.REPACK.1080p.mkv', '', { kind: 'movie', title: 'Movie', y: '2020' }],
];

let fail = 0;
for (const [file, rel, exp] of cases) {
  const p = parseMediaFilename(file, { relPath: rel });
  const checks = [];
  if (exp.kind && exp.kind !== p.kind) checks.push(`kind ${p.kind}!=${exp.kind}`);
  if (exp.title && exp.title !== p.title) checks.push(`title "${p.title}"!="${exp.title}"`);
  if (exp.S != null && exp.S !== p.season) checks.push(`S ${p.season}!=${exp.S}`);
  if (exp.E != null && exp.E !== p.episode) checks.push(`E ${p.episode}!=${exp.E}`);
  if (exp.y && exp.y !== p.year) checks.push(`y ${p.year}!=${exp.y}`);
  if (exp.part != null && exp.part !== p.part) checks.push(`part ${p.part}!=${exp.part}`);
  if (checks.length) {
    fail += 1;
    console.log('FAIL', file, checks.join('; '));
  } else {
    console.log('ok', file);
  }
}
console.log(fail ? `\nFAILED ${fail}/${cases.length}` : `\nALL PASS ${cases.length}`);
process.exit(fail ? 1 : 0);
