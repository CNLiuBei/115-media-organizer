import { fileId, fileName, folderCid, isFolder } from './api115.js';
import { isCleanupJunkFile, isKeepableVideoFile } from './filter.js';

/**
 * Walk directory tree under rootCid:
 * 1) Delete ad/sample/tiny junk files (even beside real videos)
 * 2) Delete folders whose subtree has no keepable video
 * Never deletes rootCid itself or any cid in protectCids.
 *
 * @param {ReturnType<import('./api115.js').createApi115>} api
 * @param {string} rootCid
 * @param {{
 *   delayMs?: number,
 *   maxDepth?: number,
 *   minSizeMB?: number,
 *   purgeJunkFiles?: boolean,
 *   protectCids?: Iterable<string>,
 *   onProgress?: (p: object) => void,
 *   signal?: AbortSignal,
 *   shouldStop?: () => boolean,
 * }} [opts]
 * @returns {Promise<{
 *   scanned: number,
 *   deleted: Array<{cid:string,name:string,path:string}>,
 *   deletedJunk: Array<{id:string,name:string,path:string}>,
 *   skipped: number,
 *   aborted: boolean,
 * }>}
 */
export async function cleanFoldersWithoutVideo(api, rootCid, opts = {}) {
  const delayMs = Number(opts.delayMs) || 300;
  const maxDepth = Number(opts.maxDepth) || 40;
  const purgeJunk = opts.purgeJunkFiles !== false;
  const keepOpts = {
    minSizeMB: opts.minSizeMB != null ? Number(opts.minSizeMB) : 50,
    absoluteMinBytes: 5 * 1024 * 1024,
  };
  const protect = new Set(
    [...(opts.protectCids || [])].map(String).filter(Boolean),
  );
  const root = String(rootCid || '0');
  protect.add(root);
  protect.add('0');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stopped = () => !!(opts.signal?.aborted || (typeof opts.shouldStop === 'function' && opts.shouldStop()));

  /** @type {Map<string, {
   *   cid: string,
   *   name: string,
   *   parentCid: string,
   *   depth: number,
   *   path: string[],
   *   hasVideo: boolean,
   *   childCids: string[],
   *   junkFiles: Array<{ id: string, name: string }>,
   * }>} */
  const nodes = new Map();
  /** Junk files directly under scan root (root itself is never deleted). */
  const rootJunk = [];
  const queue = [{ cid: root, name: '', parentCid: '', depth: 0, path: [] }];
  const visited = new Set();
  let scanned = 0;
  let aborted = false;

  while (queue.length) {
    if (stopped()) {
      aborted = true;
      break;
    }
    const cur = queue.shift();
    if (!cur || visited.has(cur.cid) || cur.depth > maxDepth) continue;
    visited.add(cur.cid);
    scanned += 1;

    opts.onProgress?.({
      phase: 'scan',
      cid: cur.cid,
      path: cur.path.join('/'),
      scanned,
      queued: queue.length,
    });

    const items = await api.listAllFiles(cur.cid);
    let hasVideo = false;
    const childCids = [];
    /** @type {Array<{ id: string, name: string }>} */
    const junkFiles = [];

    for (const item of items) {
      if (isFolder(item)) {
        const child = folderCid(item);
        if (!child || visited.has(child)) continue;
        const name = fileName(item);
        childCids.push(child);
        nodes.set(child, {
          cid: child,
          name,
          parentCid: cur.cid,
          depth: cur.depth + 1,
          path: [...cur.path, name],
          hasVideo: false,
          childCids: [],
          junkFiles: [],
        });
        queue.push({
          cid: child,
          name,
          parentCid: cur.cid,
          depth: cur.depth + 1,
          path: [...cur.path, name],
        });
      } else if (isKeepableVideoFile(item, keepOpts)) {
        hasVideo = true;
      } else if (purgeJunk && isCleanupJunkFile(item, keepOpts)) {
        const id = fileId(item);
        const name = fileName(item);
        if (id) junkFiles.push({ id, name });
      }
    }

    if (cur.cid === root) {
      rootJunk.push(...junkFiles.map((j) => ({ ...j, path: j.name })));
    } else {
      const node = nodes.get(cur.cid);
      if (node) {
        node.hasVideo = hasVideo;
        node.childCids = childCids;
        node.junkFiles = junkFiles;
      }
    }

    if (queue.length && delayMs > 0) await sleep(Math.min(delayMs, 200));
  }

  // Propagate hasVideo from children to parents (deepest first)
  const ordered = [...nodes.values()].sort((a, b) => b.depth - a.depth);
  for (const node of ordered) {
    if (node.hasVideo) continue;
    for (const childId of node.childCids) {
      const child = nodes.get(childId);
      if (child?.hasVideo) {
        node.hasVideo = true;
        break;
      }
    }
  }

  const deletedJunk = [];
  let skipped = 0;

  // 1) Purge junk files (root + folders that still have keepable video).
  //    Folders with no video will be deleted wholesale — skip per-file there.
  if (purgeJunk && !aborted) {
    const junkJobs = [];
    for (const j of rootJunk) {
      junkJobs.push({ parentCid: root, path: j.path || j.name, ...j });
    }
    for (const node of ordered) {
      if (!node.hasVideo) continue; // whole folder goes later
      if (protect.has(node.cid)) continue;
      for (const j of node.junkFiles || []) {
        junkJobs.push({
          parentCid: node.cid,
          path: [...node.path, j.name].join('/'),
          id: j.id,
          name: j.name,
        });
      }
    }

    for (let i = 0; i < junkJobs.length; i++) {
      if (stopped()) {
        aborted = true;
        break;
      }
      const job = junkJobs[i];
      opts.onProgress?.({
        phase: 'junk',
        name: job.name,
        path: job.path,
        done: i,
        total: junkJobs.length,
      });
      try {
        await api.deleteFiles([job.id], job.parentCid);
        deletedJunk.push({ id: job.id, name: job.name, path: job.path });
      } catch (err) {
        opts.onProgress?.({
          phase: 'error',
          name: job.name,
          path: job.path,
          error: err?.message || String(err),
        });
        skipped += 1;
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  // 2) Delete maximal no-video folders (prefer deleting parent once)
  const toDelete = [];
  for (const node of ordered) {
    if (node.hasVideo) continue;
    if (protect.has(node.cid)) continue;
    let ancestorNoVideo = false;
    let pid = node.parentCid;
    while (pid && pid !== root) {
      const p = nodes.get(pid);
      if (!p) break;
      if (!p.hasVideo && !protect.has(p.cid)) {
        ancestorNoVideo = true;
        break;
      }
      pid = p.parentCid;
    }
    if (ancestorNoVideo) continue;
    toDelete.push(node);
  }

  toDelete.sort((a, b) => b.depth - a.depth);

  const deleted = [];
  const deletedSet = new Set();

  for (const node of toDelete) {
    if (stopped()) {
      aborted = true;
      break;
    }
    if (deletedSet.has(node.cid)) {
      skipped += 1;
      continue;
    }
    let gone = false;
    let pid = node.parentCid;
    while (pid) {
      if (deletedSet.has(pid)) {
        gone = true;
        break;
      }
      const p = nodes.get(pid);
      pid = p?.parentCid;
    }
    if (gone) {
      skipped += 1;
      continue;
    }

    opts.onProgress?.({
      phase: 'delete',
      cid: node.cid,
      name: node.name,
      path: node.path.join('/'),
      done: deleted.length,
      total: toDelete.length,
    });

    try {
      await api.deleteFiles([node.cid], node.parentCid || root);
      deletedSet.add(node.cid);
      deleted.push({
        cid: node.cid,
        name: node.name,
        path: node.path.join('/'),
      });
    } catch (err) {
      opts.onProgress?.({
        phase: 'error',
        cid: node.cid,
        name: node.name,
        path: node.path.join('/'),
        error: err?.message || String(err),
      });
      skipped += 1;
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  opts.onProgress?.({
    phase: 'done',
    scanned,
    deleted: deleted.length,
    deletedJunk: deletedJunk.length,
    skipped,
    aborted,
  });

  return { scanned, deleted, deletedJunk, skipped, aborted };
}
