import { DEFAULT_SETTINGS, FOLDER_LAYOUTS, resolveLayoutKey } from './types.js';
import { sanitizePathSegment } from './rename.js';

/**
 * Merge layout preset templates into settings for rename/path planning.
 */
export function resolveOrganizeSettings(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const layoutKey = resolveLayoutKey(s.folderLayout);
  const layout = FOLDER_LAYOUTS[layoutKey] || FOLDER_LAYOUTS.emby;
  s.folderLayout = layoutKey;

  if (layoutKey !== 'custom' && layout) {
    if (layout.tvPathTemplate != null) s.tvPathTemplate = layout.tvPathTemplate;
    if (layout.moviePathTemplate != null) s.moviePathTemplate = layout.moviePathTemplate;
    if (layout.unknownPathTemplate != null) s.unknownPathTemplate = layout.unknownPathTemplate;
    if (layout.mainlandTvPathTemplate != null) {
      s.mainlandTvPathTemplate = layout.mainlandTvPathTemplate;
    } else {
      delete s.mainlandTvPathTemplate;
    }
  } else {
    delete s.mainlandTvPathTemplate;
  }

  const base = String(s.targetBasePath || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(sanitizePathSegment)
    .filter(Boolean);

  s._basePathSegments = base;
  return s;
}
