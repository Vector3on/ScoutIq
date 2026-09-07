import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig, safePath } from '../blindsight/config.mjs';
import { AnatomyStore } from '../blindsight/store.mjs';
import { acquire } from '../blindsight/acquire.mjs';
import { runAnatomy, importModelResults } from '../blindsight/engine.mjs';
import { validateProposals } from '../blindsight/llm.mjs';
import { topology } from '../blindsight/topology.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blindsight-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'app.mjs'), `import { value } from './util.mjs';\nexport function handler() {}\napp.get('/items/:id', handler);\nconst tenant = process.env.TENANT;\n`);
  fs.writeFileSync(path.join(src, 'util.mjs'), `import './app.mjs';\nexport const value = 1;\n`);
  fs.writeFileSync(path.join(src, 'openapi.json'), JSON.stringify({ openapi: '3.1.0', paths: { '/items/{id}': { get: { responses: { 200: { description: 'OK' } } } } } }));
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { alpha: '1', beta: '2' }, scripts: { postinstall: 'DO_NOT_EXECUTE' } }));
  return { dir, src, out: path.join(dir, 'out'), config: validateConfig({ target: src, mode: 'replica' }) };
}

test('full local anatomy, topology, dynamic fields, replica and unchanged snapshot idempotency', async t => {
  const f = fixture(t), db = new AnatomyStore(); t.after(() => db.close());
  const first = await runAnatomy(f.config, db, { out: f.out });
  assert.equal(first.status, 'quiescent');
  const facts = db.facts(first.runId);
  assert.ok(facts.some(x => x.predicate === 'importCycle' && x.value.length === 2));
  assert.ok(facts.some(x => x.predicate === 'route' && x.status === 'observed'));
  assert.ok(facts.some(x => x.predicate === 'route' && x.status === 'inferred'));
  assert.ok(facts.some(x => x.status === 'unknown' && x.predicate === 'runtimeBehavior'));
  const attrs = JSON.parse(db.db.prepare("SELECT attributes FROM bs_entity_attributes WHERE entity='file:package.json'").get().attributes);
  assert.equal(attrs.dependencies.length, 2);
  const mod = await import(pathToFileURL(path.join(first.out, 'replica/mock.mjs')));
  assert.equal(mod.respond('GET','/items/123').status, 501);
  assert.equal(mod.respond('GET','/not-captured').status, 404);
  assert.equal(fs.readFileSync(path.join(first.out, 'replica/source/app.mjs'), 'utf8'), fs.readFileSync(path.join(f.src, 'app.mjs'), 'utf8'));
  const count = facts.length;
  const second = await runAnatomy(f.config, db, { out: f.out });
  assert.equal(first.runId, second.runId); assert.equal(second.newFacts, 0); assert.equal(db.facts(first.runId).length, count);
  fs.appendFileSync(path.join(f.src,'app.mjs'), '\nexport function newFunction() {}');
  const third = await runAnatomy(f.config, db, { out: f.out });
  assert.notEqual(third.runId, first.runId);
  assert.ok(db.facts(third.runId).some(x => x.value?.name === 'newFunction'));
});

test('source omissions, symlink escape, oversized files and secret redaction are explicit', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.src, '.env'), 'TOP_SECRET=never read');
  fs.writeFileSync(path.join(f.dir, 'outside.txt'), 'outside-only-data');
  fs.symlinkSync(path.join(f.dir, 'outside.txt'), path.join(f.src, 'escape.txt'));
  fs.writeFileSync(path.join(f.src, 'secret.json'), '{"api_key":"sensitive-fixture-value"}');
  fs.writeFileSync(path.join(f.src, 'big.txt'), 'x'.repeat(300000));
  const r = await acquire(f.config);
  assert.ok(r.skipped.some(s => s.reason === 'symlink'));
  assert.ok(r.skipped.some(s => s.path === '.env'));
  assert.ok(r.limits.includes('fileBytes'));
  assert.ok(!JSON.stringify(r.artifacts).includes('sensitive-fixture-value'));
  assert.ok(!JSON.stringify(r.artifacts).includes('outside-only-data'));
  assert.ok(r.artifacts.find(a => a.path === 'secret.json').meta.redacted);
});

test('budget checkpoint resumes pending tasks after reopening database', async t => {
  const f = fixture(t), dbFile = path.join(f.dir, 'state.db');
  let db = new AnatomyStore(dbFile);
  const first = await runAnatomy({ ...f.config, budget: { ...f.config.budget, tasks: 1 } }, db, { out: f.out });
  assert.equal(first.status, 'budget'); assert.ok(first.pending > 0);
  await db.close(); db = new AnatomyStore(dbFile); t.after(() => db.close());
  const second = await runAnatomy(f.config, db, { out: f.out });
  assert.equal(second.runId, first.runId); assert.equal(second.status, 'quiescent');
});

test('expired task lease can be reclaimed but live lease cannot', t => {
  const db = new AnatomyStore(); t.after(() => db.close());
  db.enqueue('run','worker',{ x: 1 });
  const a = db.claim('run'); assert.ok(a); assert.equal(db.claim('run'), undefined);
  db.db.prepare('UPDATE bs_tasks SET lease_until=0 WHERE id=?').run(a.id);
  const b = db.claim('run'); assert.equal(b.id, a.id); assert.equal(b.attempts, 2);
});

test('GitHub acquisition pins a revision, refuses symlinks and uses scoped reads', async t => {
  const f = fixture(t), sha = 'a'.repeat(40), requested = [];
  const fetchImpl = async (url, options) => {
    requested.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    if (url.includes('/commits/')) return Response.json({ sha });
    if (url.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'a.json', sha: 'b'.repeat(40), size: 7 }, { type: 'blob', mode: '120000', path: 'escape', sha: 'c'.repeat(40), size: 7 }] });
    return Response.json({ encoding: 'base64', content: Buffer.from('{"a":1}').toString('base64') });
  };
  const r = await acquire(validateConfig({ target: 'https://github.com/example/project' }), { fetchImpl });
  assert.equal(r.revision, sha); assert.equal(r.artifacts.length, 1);
  assert.ok(requested.some(u => u.includes(`/git/trees/${sha}`)));
  assert.ok(!requested.some(u => u.includes('c'.repeat(40))));
});

test('network 403 stops without falling through to another host or transport', async () => {
  const requested = [];
  await assert.rejects(acquire(validateConfig({ target: 'https://github.com/example/project' }), { fetchImpl: async url => { requested.push(url); return new Response('', { status: url.endsWith('/robots.txt') ? 404 : 403 }); } }), /403/);
  assert.equal(requested.length, 2);
});

test('LLM worker accepts quotes only as inferences, rejects invented evidence, and imports no commands', async t => {
  const f = fixture(t), db = new AnatomyStore(); t.after(() => db.close());
  const run = await runAnatomy(f.config, db, { out: f.out });
  const a = db.artifacts(run.runId).find(a => a.path === 'app.mjs');
  const fact = { entity: 'handler', layer: 'semantics', predicate: 'declares', value: 'A request handler is declared', start: 2, end: 2, quote: 'export function handler' };
  assert.equal(validateProposals({ facts: [fact] }, a)[0].status, 'inferred');
  assert.throws(() => validateProposals({ facts: [{ ...fact, quote: 'invented function' }] }, a), /grounded/);
  assert.throws(() => validateProposals({ facts: [{ ...fact, start: 999, end: 999 }] }, a), /span/);
  const results = path.join(f.dir, 'model.jsonl'); fs.writeFileSync(results, JSON.stringify({ artifact: a.id, facts: [fact], command: 'DO_NOT_EXECUTE' }));
  assert.equal((await importModelResults(db, run.runId, results)).added, 1);
  assert.equal((await importModelResults(db, run.runId, results)).added, 0);
});

test('enabled model worker is automatically scheduled from evidence and stays within its call budget', async t => {
  const f = fixture(t), db = new AnatomyStore(); t.after(() => db.close()); let calls = 0;
  const config = validateConfig({ target: f.src, llm: { enabled: true, model: 'test-model', maxCalls: 1 } });
  const r = await runAnatomy(config, db, { out: f.out, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, config.llm.endpoint); assert.equal(options.method, 'POST');
    return Response.json({ choices: [{ message: { content: '{"facts":[]}' } }] });
  } });
  assert.equal(r.status, 'quiescent'); assert.equal(calls, 1);
  await runAnatomy(config, db, { out: f.out, fetchImpl: async () => { throw Error('must not repeat same task'); } });
  assert.equal(calls, 1);
});

test('config rejects unsafe paths and out-of-range budgets', () => {
  for (const name of ['../x','/absolute','a/../../b','a\\b','a/./b']) assert.equal(safePath(name), false);
  assert.throws(() => validateConfig({ target: 'https://github.com/a/b/tree/main' }), /set ref/);
  assert.throws(() => validateConfig({ target: '.', budget: { tasks: -1 } }), /budget/);
  assert.throws(() => validateConfig({ target: '.', llm: { enabled: true, model: 'x', endpoint: 'http://example.com/api' } }), /HTTPS/);
});

test('iterative topology handles deep import chains without recursion overflow', () => {
  const facts = Array.from({ length: 15000 }, (_, i) => ({ entity: `file:${i}`, predicate: 'dependsOn', value: `file:${i + 1}`, evidence: [] }));
  assert.deepEqual(topology(facts), []);
});

test('watch starts idle and saving target activates worker automatically', async t => {
  const f = fixture(t), target = path.join(f.dir, 'TARGET.json'), out = path.join(f.dir, 'watch-out');
  fs.writeFileSync(target, '{"target":""}');
  const cli = fileURLToPath(new URL('../bin/blindsight.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli,'watch','--target',target,'--db',path.join(f.dir,'watch.db'),'--out',out], { stdio: ['ignore','pipe','pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let logs = '';
  child.stderr.on('data', d => { logs += d; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('watch did not activate: ' + logs)), 12000);
    const poll = setInterval(() => {
      if (fs.existsSync(path.join(out,'latest.json'))) { clearInterval(poll); clearTimeout(timeout); resolve(); }
    }, 100);
    t.after(() => { clearTimeout(timeout); clearInterval(poll); });
    fs.writeFileSync(target, JSON.stringify({ target: f.src }));
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'latest.json'))).status, 'quiescent');
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
});
