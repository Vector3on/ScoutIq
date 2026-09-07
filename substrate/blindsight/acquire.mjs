import fs from 'node:fs';
import path from 'node:path';
import { Policy } from '../policy/policy.mjs';
import { sanitize } from '../policy/data.mjs';
import { shortHash } from '../core/events.mjs';
import { excluded, safePath } from './config.mjs';

export function cleanText(text) {
  // Generic assignments catch credentials that are not vendor-token shaped.
  // Evidence spans address the sanitized captured source, not raw source lines.
  const assignments = text.replace(/((?:["']?)(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|secret|token)(?:["']?)\s*[:=]\s*)(["'])([^\n]*?)\2/gi, '$1$2[REDACTED:assignment]$2');
  const { value, redactions } = sanitize(assignments, { maxStringLength: Math.max(20000, assignments.length) });
  return { text: value, redacted: assignments !== text || redactions.length > 0 };
}
function priority(name) {
  return /(?:package\.json|Cargo\.toml|go\.mod|pyproject\.toml|openapi|swagger|schema|Dockerfile|README|compose)/i.test(name) ? 10 : /\.(?:[cm]?[jt]sx?|py|go|rs|sql|json|ya?ml|toml|md|html|css)$/i.test(name) ? 5 : 1;
}

export async function acquire(config, { emit = async () => {}, fetchImpl, deadline = Date.now() + config.budget.seconds * 1000 } = {}) {
  const artifacts = [], skipped = [], limits = new Set();
  let bytes = 0, revision = null, network = null;
  const add = (name, raw, meta = {}) => {
    if (!safePath(name) || excluded(name)) { skipped.push({ path: name, reason: 'excluded' }); return; }
    if (artifacts.length >= config.budget.files) { limits.add('files'); return; }
    if (raw.byteLength > config.budget.fileBytes) { skipped.push({ path: name, reason: 'fileBytes' }); limits.add('fileBytes'); return; }
    if (bytes + raw.byteLength > config.budget.totalBytes) { limits.add('totalBytes'); return; }
    if (raw.includes(0)) { skipped.push({ path: name, reason: 'binary' }); return; }
    const decoded = new TextDecoder('utf-8', { fatal: true });
    let original;
    try { original = decoded.decode(raw); } catch { skipped.push({ path: name, reason: 'non-utf8' }); return; }
    const clean = cleanText(original);
    bytes += raw.byteLength;
    artifacts.push({ path: name, text: clean.text, meta: { ...meta, bytes: raw.byteLength, redacted: clean.redacted } });
  };
  const timeUp = () => { if (Date.now() >= deadline) { limits.add('seconds'); return true; } return false; };
  if (config.source.kind === 'local') {
    const root = fs.realpathSync(config.source.root), stat = fs.statSync(root);
    const candidates = [];
    let visited = 0;
    const walk = (dir, prefix = '', depth = 0) => {
      if (depth > config.budget.depth) { limits.add('depth'); return; }
      const handle = fs.opendirSync(dir);
      try {
        for (;;) {
          const entry = handle.readSync(); if (!entry) break;
          if (++visited > 50000 || timeUp()) { limits.add('inventory'); return; }
          const name = prefix + entry.name;
          if (excluded(name)) { skipped.push({ path: name, reason: 'excluded' }); continue; }
          if (entry.isSymbolicLink()) { skipped.push({ path: name, reason: 'symlink' }); continue; }
          if (entry.isDirectory()) walk(path.join(dir, entry.name), `${name}/`, depth + 1);
          else if (entry.isFile()) candidates.push(name);
        }
      } finally { handle.closeSync(); }
    };
    if (stat.isDirectory()) walk(root); else if (stat.isFile()) candidates.push(path.basename(root)); else throw Error('Target must be a regular file or directory');
    for (const name of candidates.sort((a, b) => priority(b) - priority(a) || a.localeCompare(b))) {
      if (timeUp() || artifacts.length >= config.budget.files || bytes >= config.budget.totalBytes) { limits.add('inventory-not-exhausted'); break; }
      const file = stat.isDirectory() ? path.join(root, name) : root;
      let fd;
      try {
        // O_NOFOLLOW plus realpath containment prevents symlink escape, including
        // a directory swapped after enumeration. Target code is never executed.
        const real = fs.realpathSync(file);
        if (stat.isDirectory() && !real.startsWith(root + path.sep)) throw Error('path escaped root');
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        if (process.platform === 'linux' && stat.isDirectory()) {
          const opened = fs.realpathSync(`/proc/self/fd/${fd}`);
          if (!opened.startsWith(root + path.sep)) throw Error('opened file escaped root');
        }
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw Error('not a regular file');
        if (st.size > config.budget.fileBytes) { skipped.push({ path: name, reason: 'fileBytes' }); limits.add('fileBytes'); continue; }
        // Bounded read also handles a file growing after fstat.
        const buf = Buffer.alloc(config.budget.fileBytes + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        add(name, buf.subarray(0, n), { origin: 'local' });
      } catch (e) { skipped.push({ path: name, reason: String(e.code || e.message) }); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  } else {
    const gh = config.source.kind === 'github';
    const host = gh ? 'api.github.com' : new URL(config.source.url).hostname;
    const prefix = gh ? `/repos/${config.source.repo}/` : new URL(config.source.url).pathname;
    const policy = new Policy({ maxRequestsPerRun: config.budget.requests, maxRequestsPerHostPerDay: 10000, timeoutMs: Math.min(15000, Math.max(1, deadline - Date.now())), authorizedTokens: { 'blindsight-source': 'GH_PAT' } }, { fetchImpl, emit });
    policy.registerManifest({ id: 'blindsight-source', version: '1', description: 'Read only the explicitly assigned source', dataClasses: ['text', 'public-metadata'], terms: { url: gh ? 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service' : config.source.url, officialApi: gh }, auth: gh ? 'token-optional' : 'none', ...(gh ? { tokenEnv: 'GH_PAT' } : {}), endpoints: [{ host, pathPrefix: prefix, methods: ['GET'], minIntervalMs: 100, dailyCap: 10000, maxBytes: gh ? 8 * 1024 * 1024 : Math.max(1024, config.budget.fileBytes) }], scale: { maxRequestsPerRun: config.budget.requests } });
    await policy.network.withScope('blindsight-source', { domain: 'blindsight' }, async () => {
      const get = async url => {
        if (timeUp()) throw Error('Acquisition time budget exhausted');
        const r = await policy.network.fetchGuarded(url, { auth: gh, headers: { accept: 'application/vnd.github+json' } });
        if (!r.ok) throw Error(`Source read failed: HTTP ${r.status} ${r.error ?? ''}`);
        return r;
      };
      if (gh) {
        const api = `https://api.github.com/repos/${config.source.repo}`;
        const commit = (await get(`${api}/commits/${encodeURIComponent(config.ref || 'HEAD')}`)).json();
        revision = commit.sha;
        if (!/^[0-9a-f]{40}$/.test(revision ?? '')) throw Error('GitHub did not return a pinned revision');
        const tree = (await get(`${api}/git/trees/${revision}?recursive=1`)).json();
        if (tree.truncated) limits.add('github-tree-truncated');
        const entries = (tree.tree ?? []).filter(x => x.type === 'blob').sort((a, b) => priority(b.path) - priority(a.path) || a.path.localeCompare(b.path));
        for (const entry of entries) {
          if (timeUp() || artifacts.length >= config.budget.files || bytes >= config.budget.totalBytes) { limits.add('inventory-not-exhausted'); break; }
          if (!safePath(entry.path) || excluded(entry.path) || entry.mode === '120000') { skipped.push({ path: entry.path, reason: 'excluded-or-symlink' }); continue; }
          if (entry.path.split('/').length > config.budget.depth) { limits.add('depth'); continue; }
          if (entry.size > config.budget.fileBytes) { skipped.push({ path: entry.path, reason: 'fileBytes' }); limits.add('fileBytes'); continue; }
          try {
            const blob = (await get(`${api}/git/blobs/${entry.sha}`)).json();
            if (blob.encoding !== 'base64') throw Error('Unexpected blob encoding');
            add(entry.path, Buffer.from(blob.content, 'base64'), { origin: `https://github.com/${config.source.repo}/blob/${revision}/${entry.path}`, revision });
          } catch (e) { skipped.push({ path: entry.path, reason: String(e.message) }); limits.add('source-read-failure'); break; }
        }
      } else {
        const res = await get(config.source.url);
        const type = res.headers['content-type'] || '';
        const name = /html/.test(type) ? 'page.html' : /json/.test(type) ? 'document.json' : 'document.txt';
        add(name, Buffer.from(res.text), { origin: config.source.url, contentType: type });
      }
    });
    network = policy.network.summary();
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const snapshot = shortHash(artifacts.map(a => [a.path, shortHash(a.text)]));
  return { artifacts, snapshot, revision, bytes, skipped, limits: [...limits], network };
}
