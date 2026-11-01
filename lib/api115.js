const API_BASE = 'https://webapi.115.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable115Error(err, httpStatus) {
  if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return true;
  const code = Number(err?.code);
  // Common transient / rate-limit style codes seen on 115
  if ([99, 990001, 990006, 500].includes(code)) return true;
  const msg = String(err?.message || err || '');
  return /频率|繁忙|稍后|太多|timeout|network|Failed to fetch|网络/i.test(msg);
}

/**
 * @param {typeof fetch} fetchFn
 */
export function createApi115(fetchFn = fetch) {
  const folderCache = new Map();

  async function request(path, { method = 'GET', params, body, form, retries = 3 } = {}) {
    let url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    if (params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        q.set(k, String(v));
      }
      url += (url.includes('?') ? '&' : '?') + q.toString();
    }

    /** @type {RequestInit} */
    const init = {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    };

    if (form) {
      const fd = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'object' && !Array.isArray(v)) {
          // batch_rename style: files_new_name[fid]=name
          for (const [sk, sv] of Object.entries(v)) {
            fd.set(`${k}[${sk}]`, String(sv));
          }
        } else {
          fd.set(k, String(v));
        }
      }
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      init.body = fd.toString();
    } else if (body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const maxAttempts = Math.max(1, Number(retries) || 3);
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetchFn(url, init);
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          const err = new Error(`115 响应非 JSON (${res.status}): ${text.slice(0, 200)}`);
          err.httpStatus = res.status;
          throw err;
        }
        if (data.state === false || data.errno) {
          const msg = data.error || data.message || data.msg || `errno ${data.errno || data.errCode}`;
          const err = new Error(String(msg));
          err.code = data.errno || data.errCode;
          err.data = data;
          err.httpStatus = res.status;
          throw err;
        }
        return data;
      } catch (err) {
        lastErr = err;
        const retryable = isRetryable115Error(err, err?.httpStatus);
        if (!retryable || attempt >= maxAttempts) throw err;
        await sleep(400 * attempt + Math.floor(Math.random() * 200));
      }
    }
    throw lastErr || new Error('115 请求失败');
  }

  async function listFiles(cid = '0', { offset = 0, limit = 1000, showDir = 1 } = {}) {
    return request('/files', {
      params: {
        aid: 1,
        cid,
        o: 'user_ptime',
        asc: 0,
        offset,
        show_dir: showDir,
        limit,
        code: '',
        scid: '',
        snap: 0,
        natsort: 1,
        record_open_time: 1,
        source: '',
        format: 'json',
      },
    });
  }

  async function listAllFiles(cid = '0', { onPage } = {}) {
    const all = [];
    let offset = 0;
    const limit = 1000;
    for (;;) {
      const page = await listFiles(cid, { offset, limit });
      const items = page.data || page.list || [];
      if (!items.length) break;
      all.push(...items);
      if (onPage) onPage(items, all.length, page.count ?? page.count_total);
      offset += items.length;
      const count = Number(page.count ?? page.count_total);
      // count=0 is untrusted (?? would keep 0 and stop after the first page)
      if (Number.isFinite(count) && count > 0 && offset >= count) break;
      if (!(Number.isFinite(count) && count > 0) && items.length < limit) break;
    }
    return all;
  }

  /**
   * List only immediate child folders under cid, with breadcrumb path.
   * Used by the target-folder picker.
   */
  async function listFolders(cid = '0') {
    const all = [];
    let offset = 0;
    const limit = 1000;
    let firstPage = null;
    for (;;) {
      const page = await listFiles(cid, { offset, limit, showDir: 1 });
      if (!firstPage) firstPage = page;
      const items = page.data || page.list || [];
      if (!items.length) break;
      for (const item of items) {
        if (isFolder(item)) all.push(item);
      }
      offset += items.length;
      const count = Number(page.count ?? page.count_total);
      if (Number.isFinite(count) && count > 0 && offset >= count) break;
      if (!(Number.isFinite(count) && count > 0) && items.length < limit) break;
      // Cap deep pages for picker responsiveness
      if (offset >= 5000) break;
    }

    const folders = all
      .map((item) => ({
        cid: folderCid(item),
        name: fileName(item),
        raw: item,
      }))
      .filter((f) => f.cid)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    const page = firstPage || {};
    const path = normalizePathBreadcrumb(page.path, cid, page);
    return {
      cid: String(page.cid ?? cid),
      parentCid: String(page.pid ?? path[path.length - 2]?.cid ?? '0'),
      path,
      folders,
      raw: page,
    };
  }

  /**
   * Recursively list files under cid (includes nested folders).
   * Folder entries are omitted from the result; each file may carry `_relPath` / `_parentCid`.
   */
  async function listAllFilesRecursive(cid = '0', {
    onProgress,
    delayMs = 250,
    maxDepth = 30,
    signal,
    shouldStop,
  } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const stopped = () => !!(signal?.aborted || (typeof shouldStop === 'function' && shouldStop()));
    const root = String(cid || '0');
    const files = [];
    const queue = [{ cid: root, depth: 0, path: [] }];
    const visited = new Set();
    let scannedDirs = 0;

    while (queue.length) {
      if (stopped()) {
        onProgress?.({
          phase: 'aborted',
          scannedDirs,
          files: files.length,
        });
        return files;
      }

      const current = queue.shift();
      if (!current || visited.has(current.cid) || current.depth > maxDepth) continue;
      visited.add(current.cid);
      scannedDirs += 1;

      onProgress?.({
        phase: 'list',
        cid: current.cid,
        path: current.path.join('/'),
        scannedDirs,
        queued: queue.length,
        files: files.length,
      });

      const items = await listAllFiles(current.cid);
      for (const item of items) {
        if (isFolder(item)) {
          const childCid = folderCid(item);
          if (!childCid || visited.has(childCid)) continue;
          queue.push({
            cid: childCid,
            depth: current.depth + 1,
            path: [...current.path, fileName(item)],
          });
        } else {
          files.push({
            ...item,
            _relPath: current.path.join('/'),
            _parentCid: current.cid,
          });
        }
      }

      if (queue.length && delayMs > 0) await sleep(delayMs);
    }

    onProgress?.({
      phase: 'done',
      scannedDirs,
      files: files.length,
    });
    return files;
  }

  async function searchFiles(keyword, { cid = '0', offset = 0, limit = 100 } = {}) {
    return request('/files/search', {
      params: {
        search_value: keyword,
        cid,
        offset,
        limit,
        format: 'json',
      },
    });
  }

  async function createFolder(name, pid = '0') {
    const data = await request('/files/add', {
      method: 'POST',
      form: {
        pid,
        cname: name,
      },
    });
    // Never fall back to aid (115 area id, usually 1)
    const cid = String(data.cid || data.file_id || data.id || '').trim();
    if (!cid || cid === '0') {
      const err = new Error(data.error || data.message || '创建目录未返回 cid');
      err.code = data.errno || data.errCode;
      err.data = data;
      throw err;
    }
    return { cid, name: data.cname || name, raw: data };
  }

  /**
   * @param {Record<string, string>} filesNewName map fid -> new name
   */
  async function batchRename(filesNewName) {
    const entries = Object.entries(filesNewName || {}).filter(([id, name]) => id && name);
    if (!entries.length) return { state: true, skipped: true };
    return request('/files/batch_rename', {
      method: 'POST',
      form: {
        files_new_name: Object.fromEntries(entries),
      },
    });
  }

  /** Rename in chunks (115 batch_rename accepts many, keep payloads modest). */
  async function batchRenameChunked(filesNewName, { chunkSize = 50 } = {}) {
    const entries = Object.entries(filesNewName || {}).filter(([id, name]) => id && name);
    const size = Math.max(1, Number(chunkSize) || 50);
    for (let i = 0; i < entries.length; i += size) {
      await batchRename(Object.fromEntries(entries.slice(i, i + size)));
    }
    return { state: true, count: entries.length };
  }

  /**
   * Move files/folders (same as official web UI).
   * Pass many ids in one call — 115 moves the whole set in one request.
   */
  async function moveFiles(fileIds, toCid) {
    const list = (Array.isArray(fileIds) ? fileIds : String(fileIds).split(','))
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!list.length) return { state: true, skipped: true };

    const form = { pid: String(toCid) };
    if (list.length === 1) {
      form.fid = list[0];
    } else {
      list.forEach((id, i) => {
        form[`fid[${i}]`] = id;
      });
    }
    return request('/files/move', {
      method: 'POST',
      form,
    });
  }

  /** Move in chunks (official UI also batches large selections). */
  async function moveFilesBatched(fileIds, toCid, { chunkSize = 500, delayMs = 0 } = {}) {
    const list = (Array.isArray(fileIds) ? fileIds : [fileIds])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    const size = Math.max(1, Number(chunkSize) || 500);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];
    for (let i = 0; i < list.length; i += size) {
      const chunk = list.slice(i, i + size);
      results.push(await moveFiles(chunk, toCid));
      if (delayMs > 0 && i + size < list.length) await sleep(delayMs);
    }
    return results;
  }

  /**
   * Move files/folders to recycle bin.
   * @param {string[]|string} fileIds folder cid or file fid
   * @param {string} [parentCid] parent directory of the items
   */
  async function deleteFiles(fileIds, parentCid = '0') {
    const list = (Array.isArray(fileIds) ? fileIds : [fileIds])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!list.length) return { state: true, skipped: true };

    const form = {
      pid: String(parentCid || '0'),
      ignore_warn: '1',
    };
    // 115 accepts fid / fid[0] / comma-separated; use indexed form for reliability
    if (list.length === 1) {
      form.fid = list[0];
    } else {
      list.forEach((id, i) => {
        form[`fid[${i}]`] = id;
      });
    }
    return request('/rb/delete', {
      method: 'POST',
      form,
    });
  }

  function clearFolderCache() {
    folderCache.clear();
  }

  /**
   * Ensure nested folders exist under parentCid. Returns final folder cid.
   * @param {string[]} segments
   * @param {string} parentCid
   */
  async function cacheChildFolders(parentCid) {
    const children = await listAllFiles(parentCid);
    for (const f of children.filter((item) => isFolder(item))) {
      const n = fileName(f);
      const id = String(folderCid(f));
      if (!n || !id) continue;
      folderCache.set(`${parentCid}/${n}`, id);
      const tid = tmdbIdFromFolderName(n);
      if (tid && !folderCache.has(`${parentCid}\u0001tmdb:${tid}`)) {
        folderCache.set(`${parentCid}\u0001tmdb:${tid}`, id);
      }
      const sn = seasonNumberFromFolderName(n);
      if (sn != null && !folderCache.has(`${parentCid}\u0001season:${sn}`)) {
        folderCache.set(`${parentCid}\u0001season:${sn}`, id);
      }
    }
  }

  function aliasedChildCid(parentCid, name) {
    const tid = tmdbIdFromFolderName(name);
    if (tid) {
      const id = folderCache.get(`${parentCid}\u0001tmdb:${tid}`);
      if (id) return id;
    }
    const sn = seasonNumberFromFolderName(name);
    if (sn != null) {
      const id = folderCache.get(`${parentCid}\u0001season:${sn}`);
      if (id) return id;
    }
    return '';
  }

  async function ensurePath(segments, parentCid = '0') {
    let cid = String(parentCid || '0');
    const clean = segments.map((s) => String(s || '').trim()).filter(Boolean);
    for (const name of clean) {
      const cacheKey = `${cid}/${name}`;
      if (folderCache.has(cacheKey)) {
        cid = folderCache.get(cacheKey);
        continue;
      }
      await cacheChildFolders(cid);
      if (folderCache.has(cacheKey)) {
        cid = folderCache.get(cacheKey);
        continue;
      }
      const aliased = aliasedChildCid(cid, name);
      if (aliased) {
        folderCache.set(cacheKey, aliased);
        cid = aliased;
        continue;
      }
      try {
        const created = await createFolder(name, cid);
        cid = String(created.cid);
        folderCache.set(cacheKey, cid);
      } catch (err) {
        const msg = String(err?.message || err || '');
        const code = Number(err?.code);
        if (code === 20004 || /已存在|exist|重复/i.test(msg)) {
          await cacheChildFolders(cid);
          if (folderCache.has(cacheKey)) {
            cid = folderCache.get(cacheKey);
            continue;
          }
          const retryAlias = aliasedChildCid(cid, name);
          if (retryAlias) {
            folderCache.set(cacheKey, retryAlias);
            cid = retryAlias;
            continue;
          }
        }
        throw err;
      }
    }
    return cid;
  }

  return {
    request,
    listFiles,
    listAllFiles,
    listAllFilesRecursive,
    listFolders,
    searchFiles,
    createFolder,
    batchRename,
    batchRenameChunked,
    moveFiles,
    moveFilesBatched,
    deleteFiles,
    ensurePath,
    clearFolderCache,
    folderCache,
  };
}

/** Normalize 115 /files `path` array into [{cid,name}, ...]. */
export function normalizePathBreadcrumb(pathArr, fallbackCid = '0', page = {}) {
  const out = [];
  if (Array.isArray(pathArr)) {
    for (const p of pathArr) {
      if (!p) continue;
      const rawCid = p.cid ?? p.file_id ?? p.fid;
      if (rawCid === undefined || rawCid === null || rawCid === '') continue;
      const cid = String(rawCid);
      const name = String(p.name || p.n || (cid === '0' ? '根目录' : cid));
      out.push({ cid, name: name || '根目录' });
    }
  }
  if (!out.length) {
    out.push({ cid: '0', name: '根目录' });
    const cur = String(page.cid ?? fallbackCid ?? '0');
    if (cur !== '0') out.push({ cid: cur, name: String(page.name || page.n || cur) });
  } else {
    // Ensure root label
    if (out[0] && out[0].cid === '0' && (!out[0].name || out[0].name === '0')) {
      out[0].name = '根目录';
    }
  }
  return out;
}

/** 115 directory entry id (folder's own cid). */
export function folderCid(item) {
  if (!item) return '';
  // Folder rows usually expose self id as cid; some payloads use fid.
  if (String(item.fc) === '0') return String(item.cid || item.fid || '');
  if (!item.fid && item.cid) return String(item.cid);
  return String(item.cid || item.fid || '');
}

export function isFolder(item) {
  if (!item) return false;
  // Standard: fc "0" = folder, "1" = file
  if (item.fc !== undefined && item.fc !== null && item.fc !== '') {
    return String(item.fc) === '0';
  }
  // Explicit file markers
  if (item.sha || item.pc || item.pick_code) return false;
  if (item.itype !== undefined && Number(item.itype) === 1) return false;
  // Has video/audio extension in name → treat as file
  const name = String(item.n || item.file_name || item.name || '');
  if (/\.(mp4|mkv|avi|ts|mov|wmv|flv|webm|m4v|mpg|mpeg|rmvb|iso|mp3|flac|aac|wav|m4a|srt|ass|ssa)$/i.test(name)) {
    return false;
  }
  if (item.cid && !item.fid) return true;
  // Size > 0 usually means file
  if (Number(item.s || item.file_size || item.size || 0) > 0) return false;
  return false;
}

export function tmdbIdFromFolderName(name = '') {
  const raw = String(name || '');
  const m = raw.match(/\{tmdb-(\d+)\}/i)
    || raw.match(/\[\s*tmdb(?:id)?\s*[=:\-]?\s*(\d+)\s*\]/i);
  return m ? m[1] : '';
}

export function seasonNumberFromFolderName(name = '') {
  const m = String(name || '').trim().match(/^Season\s*0*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

export function fileId(item) {
  if (!item) return '';
  if (isFolder(item)) return folderCid(item);
  const fid = String(item.fid || item.file_id || '').trim();
  if (!fid || fid === '0') return '';
  return fid;
}

export function fileName(item) {
  return String(item.n || item.file_name || item.name || '');
}

export function fileSize(item) {
  const raw = item?.s ?? item?.file_size ?? item?.size ?? item?.fs ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function parentCid(item) {
  return String(item.pid || item.cid || '0');
}
