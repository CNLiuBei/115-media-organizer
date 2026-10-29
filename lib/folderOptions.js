import { DEFAULT_SETTINGS, FOLDER_LAYOUTS } from './types.js';
import { sanitizePathSegment } from './rename.js';

/**
 * Resolve path templates from folderLayout preset (or custom settings templates).
 */
export function resolvePathTemplates(settings = {}) {
  const layoutKey = settings.folderLayout || 'standard';
  const layout = FOLDER_LAYOUTS[layoutKey] || FOLDER_LAYOUTS.standard;
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

  return {
    ...settings,
    tvPathTemplate: prefix(resolved.tvPathTemplate),
    moviePathTemplate: prefix(resolved.moviePathTemplate),
    unknownPathTemplate: prefix(resolved.unknownPathTemplate),
  };
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
