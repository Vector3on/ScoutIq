#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../blindsight/config.mjs';
import { AnatomyStore } from '../blindsight/store.mjs';
import { runAnatomy, importModelResults } from '../blindsight/engine.mjs';
import { exportRun } from '../blindsight/export.mjs';
import { openStore } from '../core/store.mjs';
import { push } from '../core/sync.mjs';
import { sanitize } from '../policy/data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [command = 'run', ...args] = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const targetFile = path.resolve(opt('target', path.join(root, 'TARGET.json')));
const dbFile = path.resolve(opt('db', path.join(root, 'substrate/.loam/blindsight.db')));
const output = path.resolve(opt('out', path.join(root, 'substrate/out/blindsight')));
const log = message => console.error(`[blindsight] ${sanitize(String(message)).value}`);

async function execute() {
  const config = readConfig(targetFile);
  if (!config.source) { log(`Waiting for target in ${targetFile}`); return { status: 'idle' }; }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const lock = `${dbFile}.lock`;
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let live = false;
    try { const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); if (pid > 0) { process.kill(pid, 0); live = true; } } catch (error) { if (error.code === 'EPERM') live = true; }
    // A just-created lock may not have its PID yet. Don't steal it.
    if (live || Date.now() - fs.statSync(lock).mtimeMs < 60000) throw Error('Another Blindsight run holds this database lock');
    fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  const store = new AnatomyStore(dbFile);
  try {
    const result = await runAnatomy(config, store, { out: output, log });
    if (process.env.LOAM_DB_URL) {
      const hub = await openStore(process.env.LOAM_DB_URL, { token: process.env.LOAM_DB_TOKEN });
      try { result.hub = await push(store, hub); } finally { await hub.close(); }
    }
    console.log(JSON.stringify(result, null, 2)); return result;
  } finally { await store.close(); fs.rmSync(lock, { recursive: true, force: true }); }
}

async function main() {
  if (command === 'run') { const r = await execute(); if (['partial','budget','empty'].includes(r.status)) process.exitCode = 2; }
  else if (command === 'watch') {
    let last = null, busy = false, stopping = false;
    const tick = async () => {
      if (busy || stopping) return;
      let text; try { text = fs.readFileSync(targetFile, 'utf8'); JSON.parse(text); } catch (e) { log(`Target not ready: ${e.message}`); return; }
      if (text === last) return;
      busy = true; last = text;
      try { await execute(); } catch (e) { log(`Run failed: ${e.message}. Edit target or refresh to retry.`); }
      finally { busy = false; }
    };
    const timer = setInterval(tick, 500);
    const stop = () => { stopping = true; clearInterval(timer); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    log(`Watching ${targetFile}; saving valid JSON triggers a run. Ctrl-C stops watching.`);
    await tick();
  } else if (command === 'status' || command === 'export' || command === 'import') {
    const store = new AnatomyStore(dbFile);
    try {
      const id = opt('run', store.db.prepare('SELECT id FROM bs_runs ORDER BY started DESC LIMIT 1').get()?.id);
      if (!id || !store.run(id)) throw Error('No such run');
      if (command === 'status') console.log(JSON.stringify(store.run(id), null, 2));
      else {
        if (command === 'import') { const file = opt('input'); if (!file) throw Error('import requires --input RESULTS.jsonl'); console.log(await importModelResults(store, id, file)); }
        console.log(exportRun(store, id, path.join(output, id), { replica: readConfig(targetFile).mode === 'replica' }));
      }
    } finally { await store.close(); }
  } else throw Error('Commands: run | watch | status | export | import. Options: --target FILE --db FILE --out DIR --run ID --input FILE');
}
main().catch(e => { log(e.message); process.exitCode = 1; });
