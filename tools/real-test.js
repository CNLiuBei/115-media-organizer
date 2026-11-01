import { createApi115 } from '../lib/api115.js';
import { titleFromRelPath } from '../lib/pathTitle.js';
import { buildRenamePlan } from '../lib/rename.js';
import { resolveOrganizeSettings } from '../lib/settings.js';
import { enrichParsed, calibrationKey } from '../lib/metadata.js';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../lib/types.js';
import { summarizeFilter } from '../lib/filter.js';
import { buildPreviewRows } from '../lib/organizer.js';
import { detectRegion } from '../lib/region.js';

const out = document.getElementById('out');
const log = (msg, cls = '') => {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  out.appendChild(line);
};
out.textContent = '';

const params = new URLSearchParams(location.search);
const cid = params.get('cid') || '3505828754125489567';

try {
  const api = createApi115(fetch);
  log(`CID=${cid}`);
  log('检查登录…');
  const loginPage = await api.listFiles(cid, { offset: 0, limit: 5 });
  log(`登录 OK · count=${loginPage.count ?? '?'}`, 'ok');

  log('递归拉取文件…');
  const files = await api.listAllFilesRecursive(cid, {
    delayMs: 150,
    onProgress: (p) => {
      if (p.phase === 'list') {
        document.title = `扫描 ${p.scannedDirs} 目录 / ${p.files} 文件`;
      }
    },
  });
  log(`拉取到 ${files.length} 个文件`, 'ok');

  const rels = [...new Set(files.map((f) => f._relPath || '').filter(Boolean))].slice(0, 10);
  log('相对路径样例:');
  for (const r of rels) {
    const pt = titleFromRelPath(r);
    log(`  path=${r}`);
    log(`  → pathTitle=${pt}`, pt ? 'ok' : 'err');
  }

  let settings = { ...DEFAULT_SETTINGS };
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
    settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  } catch (e) {
    log(`读取设置失败: ${e.message}`, 'err');
  }
  settings = resolveOrganizeSettings({
    ...settings,
    folderLayout: settings.folderLayout || 'emby',
    moveFiles: true,
    enableMetadata: true,
  });
  log(
    `TMDB key: ${settings.tmdbApiKey ? `已配置(${settings.tmdbApiKey.slice(0, 6)}…)` : '未配置'}`,
    settings.tmdbApiKey ? 'ok' : 'err',
  );
  log(`minSizeMB=${settings.minSizeMB} layout=${settings.folderLayout}`);

  const stats = summarizeFilter(files, settings);
  log(
    `筛选: video=${stats.video} tooSmall=${stats.tooSmall} other=${stats.other} kept=${stats.kept}`,
    stats.kept ? 'ok' : 'err',
  );

  const rows = buildPreviewRows(files, { ...settings, enableMetadata: false });
  log(`预览行 ${rows.length}`);

  for (const row of rows.filter((r) => !r.companionOf).slice(0, 5)) {
    log('---');
    log(`原名: ${row.originalName}`);
    log(`解析: ${row.parsed.title} S${row.parsed.season}E${row.parsed.episode} region=${row.parsed.region}`);
    log(`pathTitle=${row.parsed.pathTitle} searchTitle=${row.parsed.searchTitle}`);
    log(`新名: ${row.newName}`);
    log(`路径: ${row.pathDisplay}`);
  }

  if (settings.enableMetadata && rows.length) {
    log('开始 TMDB 校准（API → 网页兜底）…');
    const targets = rows.filter((r) => !r.companionOf && r.mediaType === 'video');
    const seen = new Set();
    let hits = 0;
    for (const row of targets) {
      const key = calibrationKey(row.parsed);
      if (seen.has(key)) continue;
      seen.add(key);
      const q = row.parsed.searchTitle || row.parsed.pathTitle || row.parsed.title;
      log(`查询: ${q}`);
      try {
        const hit = await enrichParsed(
          fetch,
          { ...settings, enableMetadata: true, preferDouban: false },
          row.parsed,
        );
        if (hit) {
          hits += 1;
          log(
            `  → ${hit.title} (${hit.year || '?'}) lang=${hit.originalLanguage || ''} countries=${(hit.originCountries || []).join(',')} score=${hit.score?.toFixed?.(2)} via=${hit.queriedAs || hit.source}`,
            'ok',
          );
        } else {
          log('  → 未命中', 'err');
        }
      } catch (e) {
        log(`  → 失败 ${e.message}`, 'err');
      }
    }
    log(`TMDB 命中 ${hits}/${seen.size}`, hits ? 'ok' : 'err');

    const sample = targets[0];
    if (sample) {
      const hit = await enrichParsed(
        fetch,
        { ...settings, enableMetadata: true, preferDouban: false },
        sample.parsed,
      );
      if (hit) {
        const parsed = {
          ...sample.parsed,
          title: hit.title,
          year: hit.year || sample.parsed.year,
          kind: hit.kind || sample.parsed.kind,
          originCountries: hit.originCountries,
          originalLanguage: hit.originalLanguage,
          isAnime: hit.isAnime,
          region: null,
        };
        parsed.region = detectRegion({
          filename: sample.originalName,
          title: parsed.title,
          relPath: sample.item?._relPath || '',
          originCountries: parsed.originCountries,
          originalLanguage: parsed.originalLanguage,
          isAnime: parsed.isAnime,
        });
        const plan = buildRenamePlan(parsed, settings);
        log('校准后样例:');
        log(`  片名 ${sample.parsed.title} → ${parsed.title}`, 'ok');
        log(`  地区 ${sample.parsed.region} → ${parsed.region}`, 'ok');
        log(`  新名 ${plan.newName}`, 'ok');
        log(`  路径 ${plan.pathDisplay}`, 'ok');
      }
    }
  } else {
    log('跳过 TMDB：无预览行或未开启校准', 'err');
  }

  log('测试结束', 'ok');
  document.title = '测试完成';
} catch (err) {
  log(`失败: ${err.message || err}`, 'err');
  console.error(err);
  document.title = '测试失败';
}
