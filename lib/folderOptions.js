import { DEFAULT_SETTINGS, FOLDER_LAYOUTS, resolveLayoutKey } from './types.js';
import { sanitizePathSegment, buildRenamePlan } from './rename.js';
import { resolveOrganizeSettings } from './settings.js';

/**
 * Resolve path templates from folderLayout preset (or custom settings templates).
 */
export function resolvePathTemplates(settings = {}) {
  const layoutKey = resolveLayoutKey(settings.folderLayout);
  const layout = FOLDER_LAYOUTS[layoutKey] || FOLDER_LAYOUTS.emby;
  const useCustom = layoutKey === 'custom' || !layout.tvPathTemplate;

  return {
    layoutKey,
    layout,
    tvPathTemplate: useCustom
      ? (settings.tvPathTemplate || DEFAULT_SETTINGS.tvPathTemplate)
      : layout.tvPathTemplate,
    moviePathTemplate: useCustom
      ? (settings.moviePathTemplate || DEFAULT_SETTINGS.moviePathTemplate)
      : layout.moviePathTemplate,
    unknownPathTemplate: useCustom
      ? (settings.unknownPathTemplate || DEFAULT_SETTINGS.unknownPathTemplate)
      : layout.unknownPathTemplate,
    mainlandTvPathTemplate: useCustom ? null : (layout.mainlandTvPathTemplate || null),
  };
}

/**
 * Settings object used by buildRenamePlan / buildPreviewRows,
 * with layout templates + optional base path prefix applied.
 */
export function withFolderOptions(settings = {}) {
  const resolved = resolvePathTemplates(settings);
  const base = String(settings.targetBasePath || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(sanitizePathSegment)
    .filter(Boolean)
    .join('/');

  const prefix = (tpl) => (base ? `${base}/${tpl}` : tpl);

  const out = {
    ...settings,
    folderLayout: resolved.layoutKey,
    tvPathTemplate: prefix(resolved.tvPathTemplate),
    moviePathTemplate: prefix(resolved.moviePathTemplate),
    unknownPathTemplate: prefix(resolved.unknownPathTemplate),
  };
  if (resolved.mainlandTvPathTemplate) {
    out.mainlandTvPathTemplate = prefix(resolved.mainlandTvPathTemplate);
  } else {
    delete out.mainlandTvPathTemplate;
  }
  return out;
}

const TREE_SAMPLES = [
  {
    kind: 'movie', title: '流浪地球', year: '2019', tmdbId: '535167', ext: '.mkv',
  },
  {
    kind: 'tv', title: '良医', year: '2017', seriesYear: '2017', tmdbId: '71712',
    region: '欧美剧', season: 1, episode: 1, ext: '.mkv',
  },
  {
    kind: 'tv', title: '良医', year: '2017', seriesYear: '2017', tmdbId: '71712',
    region: '欧美剧', season: 1, episode: 2, ext: '.mkv',
  },
  {
    kind: 'tv', title: '庆余年', year: '2019', seriesYear: '2019', tmdbId: '87739',
    region: '大陆剧', season: 1, episode: 1, ext: '.mkv',
  },
];

function insertTreePath(root, segs) {
  let node = root;
  for (const seg of segs) {
    const name = String(seg || '').trim();
    if (!name) continue;
    if (!node.children[name]) node.children[name] = { children: {} };
    node = node.children[name];
  }
}

function formatTreeLevel(children, prefix = '') {
  const names = Object.keys(children);
  const lines = [];
  names.forEach((name, i) => {
    const last = i === names.length - 1;
    const branch = last ? '└─ ' : '├─ ';
    const hang = last ? '   ' : '│  ';
    lines.push(`${prefix}${branch}${name}`);
    lines.push(...formatTreeLevel(children[name].children, `${prefix}${hang}`));
  });
  return lines;
}

/**
 * ASCII directory tree for the selected layout (sample movie + TV).
 */
export function buildLayoutTreePreview(settings = {}) {
  const resolved = resolveOrganizeSettings({ ...settings, moveFiles: true });
  const root = { children: {} };
  for (const sample of TREE_SAMPLES) {
    const plan = buildRenamePlan(sample, resolved);
    insertTreePath(root, [...(plan.pathSegments || []), plan.newName]);
  }
  const roots = Object.keys(root.children);
  if (!roots.length) return '';
  const lines = [];
  for (const name of roots) {
    lines.push(name);
    lines.push(...formatTreeLevel(root.children[name].children));
  }
  return lines.join('\n');
}

/**
 * Root cid where organized folders should be created.
 * @param {'scan'|'cid'} mode
 * @param {string} scanCid
 * @param {string} targetCid
 */
export function resolveTargetRootCid(mode, scanCid, targetCid) {
  if (mode === 'cid') return String(targetCid || '0');
  return String(scanCid || '0');
}
