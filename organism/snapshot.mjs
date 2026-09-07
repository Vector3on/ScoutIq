import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { redactString } from '../substrate/policy/data.mjs';
import { extract, linkImports } from '../substrate/blindsight/extract.mjs';
import { shortHash } from '../substrate/core/events.mjs';

export const digest = data => createHash('sha256').update(data).digest('hex');
export const LIMITS = Object.freeze({ files: 128, bytes: 2_000_000, fileBytes: 200_000, targets: 32 });
export function safePath(root, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(name) ||
      name.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(name)) throw new Error('Unsafe snapshot path');
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink in snapshot');
  }
  if (!fs.statSync(current).isFile()) throw new Error('Snapshot entry is not a file');
  return current;
}

// Manifests are operator-reviewed data, never a request to crawl or execute.
export function loadSnapshot(manifestPath) {
  const absolute = fs.realpathSync(manifestPath), root = path.dirname(absolute);
  if (fs.statSync(absolute).size > 200_000) throw new Error('Manifest too large');
  const manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (manifest.format !== 'organism-snapshot-1' || manifest.publicAuthorized !== true ||
      !Array.isArray(manifest.files) || manifest.files.length > LIMITS.files ||
      !Array.isArray(manifest.targets) || manifest.targets.length > LIMITS.targets) throw new Error('Invalid or unauthorized manifest');
  const files = new Map(); let total = 0;
  for (const item of manifest.files) {
    if (!/^[a-f0-9]{40}$/.test(item.revision) || !/^[a-f0-9]{64}$/.test(item.sha256) || files.has(item.path)) throw new Error('Invalid provenance or duplicate path');
    const source = safePath(root, item.path), size = fs.statSync(source).size;
    total += size;
    if (size > LIMITS.fileBytes || total > LIMITS.bytes) throw new Error('Snapshot byte budget exceeded');
    const bytes = fs.readFileSync(source);
    if (digest(bytes) !== item.sha256) throw new Error('Snapshot digest mismatch');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (decoded.includes('\0')) throw new Error('Binary snapshot');
    const redactions = [], text = redactString(decoded, redactions, item.path);
    files.set(item.path, { id: shortHash([item.path, digest(text)]), path: item.path, text,
      meta: { redacted: redactions.length > 0 }, sha256: item.sha256, revision: item.revision });
  }
  const ids = new Set();
  for (const target of manifest.targets) {
    if (!/^[a-z0-9-]{1,64}$/.test(target.id) || ids.has(target.id) || !files.has(target.entry) ||
        !['research', 'bounty'].includes(target.purpose) || !target.program || !target.asset ||
        (target.triedCells !== undefined && (!Array.isArray(target.triedCells) || target.triedCells.length > 20000 ||
          target.triedCells.some(c => typeof c !== 'string' || !/^[a-z0-9]+\.S[0-9]+::T[0-9]+$/.test(c))))) throw new Error('Invalid target');
    ids.add(target.id);
  }
  return { manifest, files, bytes: total, identity: shortHash(manifest) };
}

export function indexSnapshot(snapshot) {
  // Cheap index only. Symbol observations are deliberately deferred until selected.
  const facts = [...snapshot.files.values()].flatMap(a => ['dependencies', 'operations'].flatMap(w => extract(w, a)));
  const links = linkImports(facts, [...snapshot.files.values()]);
  const lexical = new Map([...snapshot.files.values()].map(a => [a.path,
    a.text.split('\n').map((text, i) => ({ text, evidence: { artifact: a.id, start: i + 1, end: i + 1 } }))
      .filter(row => !/^\s*(?:\/\/|\*|\/\*)/.test(row.text))]));
  return { facts, links, lexical, omittedImports: links.filter(f => f.predicate === 'unresolvedImport').length };
}

export function neighborhood(entry, files, links) {
  return [...new Set(links.filter(f => f.entity === `file:${entry}` && f.predicate === 'dependsOn')
    .map(f => f.value.slice(5)).filter(p => p !== entry && files.has(p)))].sort();
}
