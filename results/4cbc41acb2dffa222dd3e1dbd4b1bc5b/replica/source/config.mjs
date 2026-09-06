import path from 'node:path';
import fs from 'node:fs';
import { shortHash } from '../core/events.mjs';

export const VERSION = 'blindsight-1';
export const DEFAULT_BUDGET = { seconds: 180, files: 300, fileBytes: 262144, totalBytes: 16777216, tasks: 1500, facts: 30000, depth: 24, requests: 400 };
const MAX = { seconds: 1800, files: 10000, fileBytes: 2097152, totalBytes: 268435456, tasks: 50000, facts: 200000, depth: 64, requests: 10000 };
export function readConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateConfig(config, path.dirname(path.resolve(file)));
}
export function validateConfig(input, base = process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('TARGET.json must contain an object');
  const target = input.target ?? '';
  if (typeof target !== 'string') throw Error('target must be a string');
  const mode = input.mode ?? 'anatomy';
  if (!['anatomy', 'replica'].includes(mode)) throw Error('mode must be anatomy or replica');
  const budget = { ...DEFAULT_BUDGET, ...input.budget };
  for (const [k, v] of Object.entries(budget)) {
    if (!(k in MAX) || !Number.isInteger(v) || v < 1 || v > MAX[k]) throw Error(`Invalid budget.${k}`);
  }
  const ref = input.ref || '';
  if (typeof ref !== 'string' || ref.length > 200) throw Error('ref must be a Git revision string');
  const llm = { enabled: false, endpoint: 'http://[REDACTED:ipv4]:11434/v1/chat/completions', model: '', maxCalls: 4, ...input.llm };
  if (typeof llm.enabled !== 'boolean' || !Number.isInteger(llm.maxCalls) || llm.maxCalls < 0 || llm.maxCalls > 100) throw Error('Invalid llm settings');
  if (llm.enabled) {
    const u = new URL(llm.endpoint);
    if (u.username || u.password || u.search || u.hash) throw Error('LLM endpoint must not contain credentials, query or fragment');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '[REDACTED:ipv4]', '[::1]'].includes(u.hostname))) throw Error('LLM requires HTTPS or local HTTP');
    if (!llm.model || typeof llm.model !== 'string') throw Error('Set llm.model before enabling it');
  }
  let source = null;
  if (target.trim()) {
    if (/^https?:\/\//.test(target)) {
      const u = new URL(target);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('Use a clean HTTPS URL without credentials or query');
      const parts = u.pathname.split('/').filter(Boolean);
      if (u.hostname === 'github.com') {
        if (parts.length !== 2 || !parts.every(p => /^[\w.-]+$/.test(p))) throw Error('Use https://github.com/OWNER/REPO and set ref separately');
        source = { kind: 'github', repo: parts.join('/').replace(/\.git$/, ''), ref };
      } else source = { kind: 'url', url: u.href };
    } else source = { kind: 'local', root: path.resolve(base, target) };
  }
  return { target, source, mode, ref, refresh: input.refresh ?? 0, budget, llm, base, id: shortHash({ source, refresh: input.refresh ?? 0, version: VERSION }) };
}

export function safePath(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0') && !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..');
}
export function excluded(name) {
  return name.split('/').some(p => /^(?:\.git|\.loam|node_modules|vendor|dist|build|coverage|\.next|\.venv|__pycache__|out)$/.test(p)) || /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?)$|\.(?:pem|key|p12|pfx|db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(name);
}
