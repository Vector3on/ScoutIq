import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, indexSnapshot, digest, safePath } from '../snapshot.mjs';
import { candidateSeams, lens, mutate, questions, observe, entropy, descriptor, HYPOTHESES } from '../lenses.mjs';
import { partition } from '../frozen.mjs';
import { run, attentionScore } from '../engine.mjs';
import { observerPolicy, requireObservation } from '../policy.mjs';
import { LocalStore } from '../../substrate/core/store.mjs';
import { buildSpine } from '../../substrate/plugins/bounty/spine.mjs';
import { Policy } from '../../substrate/policy/policy.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const example = path.join(root, 'organism/examples/snapshot.json');
const fixed = () => 1_800_000_000_000;
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organism-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function copyExample(t) {
  const dir = workspace(t);
  fs.cpSync(path.dirname(example), dir, { recursive: true });
  return { dir, manifest: path.join(dir, 'snapshot.json') };
}
function editManifest(file, fn) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')); fn(value);
  fs.writeFileSync(file, JSON.stringify(value));
}

test('snapshot verifies pinned bytes, bounds and authorization', t => {
  const { manifest, dir } = copyExample(t);
  const s = loadSnapshot(manifest); assert.equal(s.files.size, 7);
  editManifest(manifest, m => { m.publicAuthorized = false; });
  assert.throws(() => loadSnapshot(manifest), /unauthorized/);
  editManifest(manifest, m => { m.publicAuthorized = true; });
  const p = path.join(dir, JSON.parse(fs.readFileSync(manifest)).files[0].path);
  fs.appendFileSync(p, '\n'); assert.throws(() => loadSnapshot(manifest), /digest/);
});
test('snapshot rejects oversized, binary and invalid utf8 content', t => {
  for (const bytes of [Buffer.alloc(200_001), Buffer.from([0]), Buffer.from([0xff])]) {
    const { manifest, dir } = copyExample(t);
    editManifest(manifest, m => { const p = path.join(dir, m.files[0].path); fs.writeFileSync(p, bytes); m.files[0].sha256 = digest(bytes); });
    assert.throws(() => loadSnapshot(manifest));
  }
});
test('paths reject traversal, URLs, symlinks and nonfiles', t => {
  const dir = workspace(t); fs.writeFileSync(path.join(dir, 'ok'), 'yes');
  fs.symlinkSync(path.join(dir, 'ok'), path.join(dir, 'link'));
  fs.mkdirSync(path.join(dir, 'folder'));
  for (const value of ['../ok', '/etc/passwd', 'https://example.org/x', 'link', 'folder', 'a//b']) assert.throws(() => safePath(dir, value));
  assert.equal(fs.readFileSync(safePath(dir, 'ok'), 'utf8'), 'yes');
});
test('secrets are sanitized before static extraction', t => {
  const { manifest, dir } = copyExample(t), secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  editManifest(manifest, m => {
    const p = path.join(dir, m.files[0].path), bytes = Buffer.from(`const value = '${secret}';\n`);
    fs.writeFileSync(p, bytes); m.files[0].sha256 = digest(bytes);
  });
  const snapshot = loadSnapshot(manifest);
  assert.ok(![...snapshot.files.values()].some(a => a.text.includes(secret)));
  assert.ok([...snapshot.files.values()].some(a => a.meta.redacted));
});
test('catalog join preserves 120 records, 19 classes, 95 seams and only real family keys', () => {
  const spine = buildSpine(); assert.equal(spine.techniques.length, 120); assert.equal(spine.anatomy.length, 19); assert.equal(spine.seamIndex.size, 95);
  const s = loadSnapshot(example), index = indexSnapshot(s);
  for (const t of s.manifest.targets) for (const c of candidateSeams(t, index, spine)) {
    assert.ok(c.anchors.length); assert.equal(c.applicability, 'unverified');
    for (const id of c.referenceIds) assert.ok(spine.techById.get(id).mechanismFamilies.includes(c.family));
    for (const id of c.seamIds) assert.ok(spine.seamIndex.get(id).seam.mechanismFamilies.includes(c.family));
  }
});
test('lens grammar grows once, stays typed, and observes only captured files', () => {
  const s = loadSnapshot(example), i = indexSnapshot(s), t = s.manifest.targets[0];
  const a = lens('trust-binding failure'), b = mutate(a);
  assert.equal(questions(t, s, i, a).length, 1); assert.equal(questions(t, s, i, b).length, 2);
  assert.equal(mutate(b), null); assert.notEqual(a.id, b.id);
  assert.throws(() => lens('made-up')); assert.throws(() => lens(a.family, 2));
  for (const q of questions(t, s, i, b)) {
    const x = observe(q, s); assert.ok(['yes','no'].includes(x.answer));
    assert.ok(x.evidence.every(e => e.start > 0 && e.sha256 && e.revision));
  }
  assert.throws(() => observe({ kind: 'local-symbol', family: a.family, paths: ['missing'] }, s));
  assert.notEqual(descriptor(a, 1).cell, descriptor(b, 1).cell);
});
test('a no observation preserves the distinction between lexical absence and enforcement', () => {
  const s = loadSnapshot(example), family = 'semantic/parser differential';
  const q = { kind: 'local-symbol', family, paths: ['source/substrate/policy/actions.mjs'] };
  const result = observe(q, s); assert.equal(result.answer, 'no'); assert.match(result.meaning, /not absence/);
});
test('frozen partitions agree with an independent filter over every partial observation', () => {
  const rows = HYPOTHESES.map(h => [h.local, h.neighbor]);
  for (const a of [null, 'no', 'yes']) for (const b of [null, 'no', 'yes']) {
    const observed = { ...(a ? { 0: a } : {}), ...(b ? { 1: b } : {}) };
    const result = partition(rows, observed);
    const expected = rows.map((r, i) => ({ r, i })).filter(({r}) => (!a || r[0] === a) && (!b || r[1] === b)).map(x => x.i);
    assert.deepEqual(result.survivors, expected);
    for (let j = 0; j < 2; j++) assert.equal(result.partitions[j].reduce((a,b) => a+b, 0), expected.length);
  }
  assert.throws(() => partition([['yes']], { 9: 'no' }));
  assert.throws(() => partition([['yes'],[]]));
  assert.deepEqual(partition([['yes']], { 0: 'no' }).survivors, []);
});
test('question information gain beats random on a separating versus constant observation', () => {
  const p = partition([['same','a'],['same','a'],['same','b'],['same','b']]);
  const gains = p.partitions.map(entropy);
  assert.deepEqual(gains, [0,1]); assert.equal(Math.max(...gains), 1); assert.equal((gains[0]+gains[1])/2, 0.5);
  assert.equal(entropy([]), 0); assert.equal(entropy([4]), 0);
});
test('EV modulates attention, but cannot outweigh the informative read in a bounded comparison', () => {
  const plain = { ig: 1, modelIg: 0, predictedGain: 0, cost: 1 };
  assert.ok(attentionScore({ ...plain, ev: 1000 }) > attentionScore({ ...plain, ev: 0 }));
  assert.equal(attentionScore({ ...plain, ig: 0, ev: 1_000_000 }), 0);
  assert.ok(attentionScore({ ...plain, ev: 0 }) > attentionScore({ ...plain, ev: 50_000, cost: 2 }));
});
test('organism refuses network, credential setup and execution even outside CI', async () => {
  const p = observerPolicy(); assert.equal(p.hasSalt, false);
  assert.throws(() => p.registerManifest({}), /offline-only/);
  await assert.rejects(() => p.network.fetchGuarded('https://github.com/Vector3on/ScoutIq'), /policy/);
  await assert.rejects(() => p.actions.approve('x'), /autonomous/);
  let called = false;
  await assert.rejects(() => p.actions.executeApproved('x', () => { called = true; }, { confirm: true, proposals: new Map([['x',{status:'approved'}]]) }), /autonomous/);
  assert.equal(called, false);
  for (const op of ['probe','fetch','exploit','shell','scan','approve']) assert.throws(() => requireObservation(op));
});
test('all inherited policy files match the inspected source revision byte for byte', () => {
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'organism/POLICY-PINS.json')));
  for (const [file, hash] of Object.entries(pins)) assert.equal(digest(fs.readFileSync(path.join(root, file))), hash, file);
});
test('401, 403 and 429 stop the inherited network gate with no second target request', async () => {
  for (const status of [401,403,429]) {
    let calls = 0;
    const p = new Policy({}, { env: {}, now: fixed, sleep: async () => {}, fetchImpl: async url => {
      if (String(url).endsWith('/robots.txt')) return { status:404, ok:false, headers:new Map(), text:async()=>'',body:null };
      calls++; return {status,ok:false,headers:new Map(),text:async()=>'',body:null};
    }});
    const m = p.registerManifest({ id:'example',version:'1',description:'read public metadata',
      terms:{url:'https://example.org/tos',officialApi:true},dataClasses:['public-metadata'],scale:{maxRequestsPerRun:10},
      endpoints:[{host:'api.example.org',pathPrefix:'/v1/',methods:['GET'],maxBytes:1024,minIntervalMs:500,dailyCap:100}] });
    p.network.enterScope(m.id);
    const response = await p.network.fetchGuarded('https://api.example.org/v1/a');
    assert.equal(response.status, status);
    await assert.rejects(() => p.network.fetchGuarded('https://api.example.org/v1/b'));
    assert.equal(calls,1);
  }
});
test('real end-to-end: wider vocabulary breaks local ceilings without executing source or using fetch', async t => {
  const dir = workspace(t), original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network'); };
  t.after(() => { globalThis.fetch = original; });
  const baseline = await run({ manifestPath:example, db:path.join(dir,'base.db'), allowGrowth:false, budget:32, now:fixed });
  const adaptive = await run({ manifestPath:example, db:path.join(dir,'adaptive.db'), budget:32, now:fixed });
  assert.ok(baseline.records.every(r => r.status === 'information-ceiling'));
  assert.ok(adaptive.records.every(r => r.status === 'static-pattern-distinguished'));
  assert.ok(adaptive.stats.grownLenses > 0); assert.ok(adaptive.archive.cells > baseline.archive.cells);
  assert.ok(adaptive.stats.bitsReduced > baseline.stats.bitsReduced);
  assert.ok(adaptive.records.every(r => r.runtimeSafety === 'unknown' && r.evScore === 0 && r.hardeningIndex === null));
  assert.equal(adaptive.stats.networkRequests, 0);
  const again = await run({ manifestPath:example, db:path.join(dir,'adaptive.db'), budget:32, now:fixed });
  assert.equal(again.stats.fileObservations, 0); assert.equal(again.stats.newConclusions, 0);
  assert.equal(again.stats.reusedConclusions, adaptive.records.length);
  const store = new LocalStore(path.join(dir,'adaptive.db'));
  const events = await store.readAll(); await store.close();
  assert.equal(events.filter(e => e.kind === 'proposal.created').length, adaptive.records.length);
  assert.ok(!events.some(e => e.kind === 'proposal.executed' || e.kind === 'source.polled'));
  assert.ok(events.some(e => e.kind === 'observation.seen' && e.body.entities[0].signals.informationBits > 0));
  const text = JSON.stringify(adaptive);
  assert.ok(!text.includes('howFound')); assert.ok(!text.includes('excerpt'));
});
test('persistent archive transfers lenses to held-out entrypoints', async t => {
  const dir = workspace(t), db = path.join(dir,'memory.db');
  await run({manifestPath:path.join(root,'organism/examples/train.json'),db,budget:32,now:fixed});
  const warm = await run({manifestPath:path.join(root,'organism/examples/heldout.json'),db,budget:32,now:fixed});
  const cold = await run({manifestPath:path.join(root,'organism/examples/heldout.json'),budget:32,now:fixed});
  assert.ok(warm.stats.transferredLenses > 0); assert.equal(warm.stats.grownLenses, 0);
  assert.ok(cold.stats.grownLenses > 0);
  assert.deepEqual(warm.records.map(r=>r.hypotheses),cold.records.map(r=>r.hypotheses));
  assert.ok(warm.stats.fileObservations <= cold.stats.fileObservations);
});
test('changed imported source invalidates dependent conclusions and reuses unchanged observations', async t => {
  const { manifest, dir } = copyExample(t), db = path.join(dir,'memory.db');
  const before = await run({manifestPath:manifest,db,budget:32,now:fixed});
  editManifest(manifest, m => {
    const f=m.files.find(f=>f.path.endsWith('/data.mjs')); const p=path.join(dir,f.path);
    fs.appendFileSync(p,'\nexport function validateAddedMarker() {}\n'); f.sha256=digest(fs.readFileSync(p));
  });
  const after = await run({manifestPath:manifest,db,budget:32,now:fixed});
  assert.ok(after.stats.newConclusions > 0); assert.ok(after.stats.cachedQueries > 0);
  assert.equal(after.records.length,before.records.length);
});
test('an unrelated file change preserves completed evidence closures', async t => {
  const {manifest,dir}=copyExample(t),db=path.join(dir,'memory.db');
  await run({manifestPath:manifest,db,budget:32,now:fixed});
  editManifest(manifest,m=>{
    const f=m.files.find(f=>f.path.endsWith('/ledger.mjs')),p=path.join(dir,f.path);
    fs.appendFileSync(p,'\n// unrelated change\n');f.sha256=digest(fs.readFileSync(p));
  });
  const result=await run({manifestPath:manifest,db,budget:32,now:fixed});
  assert.equal(result.stats.newConclusions,0);assert.equal(result.stats.fileObservations,0);
});
test('tried cells are excluded without writing the operator journal', async t => {
  const {manifest}=copyExample(t);
  const snapshot=loadSnapshot(manifest),index=indexSnapshot(snapshot);
  editManifest(manifest,m=>{
    for(const target of m.targets)target.triedCells=candidateSeams(target,index).flatMap(s=>s.untriedCells);
  });
  const before=fs.readFileSync(manifest,'utf8');
  const result=await run({manifestPath:manifest,budget:32,now:fixed});
  assert.equal(result.records.length,0);assert.equal(result.stats.fileObservations,0);
  assert.equal(fs.readFileSync(manifest,'utf8'),before);
});
test('one persistent writer owns the event sequence and releases its lock', async t => {
  const db=path.join(workspace(t),'memory.db');
  const a=run({manifestPath:example,db,budget:1,now:fixed});
  await assert.rejects(()=>run({manifestPath:example,db,budget:1,now:fixed}),/EEXIST/);
  await a;assert.ok(!fs.existsSync(db+'.lock'));
  await run({manifestPath:example,db,budget:1,now:fixed});
});
test('malicious source text is never imported or executed', async t => {
  const {manifest,dir}=copyExample(t),marker=path.join(dir,'executed');
  editManifest(manifest,m=>{
    m.targets=m.targets.slice(0,1);const f=m.files.find(f=>f.path===m.targets[0].entry),p=path.join(dir,f.path);
    fs.writeFileSync(p,`import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'executed');\nexport function validateLocal() {}\n`);
    f.sha256=digest(fs.readFileSync(p));
  });
  await run({manifestPath:manifest,budget:32,now:fixed});assert.ok(!fs.existsSync(marker));
});
test('budgets stop cleanly and persistent cached observations permit later progress', async t => {
  const db=path.join(workspace(t),'memory.db');
  const zero = await run({manifestPath:example,db,budget:0,now:fixed});
  assert.equal(zero.stats.queries,0);assert.ok(zero.records.every(r=>r.status==='budget-deferred'));
  const tiny = await run({manifestPath:example,db,budget:1,now:fixed}); assert.ok(tiny.stats.fileObservations<=1);
  const full = await run({manifestPath:example,db,budget:32,now:fixed}); assert.ok(full.coverage.exhausted);
  for (const budget of [-1,NaN,129,1.5]) await assert.rejects(()=>run({manifestPath:example,budget}));
});
test('missing imports preserve an information ceiling instead of asserting no guard', async t => {
  const {manifest}=copyExample(t);
  editManifest(manifest,m=>{m.targets=m.targets.slice(0,1);m.files=m.files.filter(f=>f.path===m.targets[0].entry);});
  const result=await run({manifestPath:manifest,budget:32,now:fixed});
  assert.ok(result.coverage.unresolvedRelativeImports>0);
  assert.ok(result.records.every(r=>r.status==='information-ceiling'&&r.hypotheses.length===2));
});
test('frozen capsule runs away from repository with an empty credential environment', t => {
  const dir=workspace(t), src=path.join(root,'organism/frozen/partition.py');
  fs.copyFileSync(src,path.join(dir,'partition.py'));
  const output=spawnSync('python3',['-I',path.join(dir,'partition.py')],{cwd:dir,env:{PATH:process.env.PATH},input:JSON.stringify({rows:[['a'],['b']]}),encoding:'utf8'});
  assert.equal(output.status,0);assert.equal(JSON.parse(output.stdout).result.survivors.length,2);
});
test('fixed clocks and fresh state reproduce the whole report', async () => {
  const a=await run({manifestPath:example,budget:32,now:fixed});
  const b=await run({manifestPath:example,budget:32,now:fixed});
  assert.deepEqual(a,b);
});
