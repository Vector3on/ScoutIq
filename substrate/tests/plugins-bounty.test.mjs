import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../core/plugins.mjs';
import { openStore } from '../core/store.mjs';
import { runOnce } from '../core/worker.mjs';
import { Ledger } from '../core/ledger.mjs';
import { Policy } from '../policy/policy.mjs';
import { project } from '../core/projections.mjs';
import { memoryProjection, latestSignal, neighbors } from '../core/memory.mjs';
import { buildSpine, coverageChart, applicableTechniques } from '../plugins/bounty/spine.mjs';
import { fingerprintAsset } from '../plugins/bounty/fingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED = fs.readFileSync(path.join(ROOT, 'tests/fixtures/bounty-feed.json'), 'utf8');
const FEED_HOST = 'raw.githubusercontent.com';

// A fetch that serves the fixture feed + an allow-all robots.txt, and records every
// host contacted — so the test can PROVE the loop never touches a listed target.
function fakeFeed() {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u.hostname);
    const ok = (body, status = 200) => ({ status, ok: status < 300, headers: new Map(), text: async () => body });
    if (u.pathname === '/robots.txt') return ok('User-agent: *\nDisallow:\n');
    if (u.hostname === FEED_HOST) return ok(FEED);
    return ok('', 404);
  };
  f.calls = calls;
  return f;
}

const options = () => ({ feeds: [{ id: 'fx', platform: 'hackerone', url: `https://${FEED_HOST}/arkadiyt/bounty-targets-data/main/data/fx.json` }] });

test('bounty data + spine: atlas (19/95) and catalog (120) load; every seam joins to techniques; coverage chart is well-formed', () => {
  const spine = buildSpine();
  assert.equal(spine.anatomy.length, 19, '19 anatomy classes');
  const seams = spine.anatomy.reduce((n, c) => n + c.seams.length, 0);
  assert.equal(seams, 95, '95 seams');
  assert.equal(spine.techniques.length, 120, '120 techniques');
  assert.equal(spine.families.length, 10, '10 mechanism families (the join vocabulary)');
  // every seam retains the atlas fields the task requires, and joins to ≥1 technique
  for (const [, entry] of spine.seamIndex) {
    assert.ok(entry.seam.sideA_assumes && entry.seam.sideB_assumes, 'seam keeps sideA/sideB assumptions');
    assert.ok(Array.isArray(entry.seam.mechanismFamilies) && entry.seam.mechanismFamilies.length, 'seam keeps mechanismFamilies');
    assert.ok(entry.techniques.length > 0, `${entry.seam.id} joins to at least one technique`);
  }
  // every technique keeps its primary source link
  for (const t of spine.techniques) assert.match(t.sourceUrl, /^https?:\/\//, `${t.id} has a source link`);
  // coverage chart: a web+identity target exposes identity seams with invariants and untried techniques
  const cc = coverageChart(spine, { classIds: ['web', 'identity'], fingerprints: ['http', 'oauth-oidc-saml'], key: 't1' }, new Set());
  assert.ok(cc.exposedSeams >= 8 && cc.untriedTechniques > 0, 'exposes seams with untried techniques');
  const idSeam = cc.chart.find((c) => c.classId === 'identity').seams.find((s) => s.seamId === 'identity.S1');
  assert.ok(idSeam.invariant, 'seam carries the invariant that must hold');
  assert.ok(idSeam.techniques.every((t) => t.cell.startsWith('t1::')), 'cells are target-scoped');
});

test('bounty fingerprints assets to anatomy classes from public signals only (inference, not proof)', () => {
  const fp = (type, id, instruction) => fingerprintAsset({ type, identifier: id, instruction }, { name: 'X', website: 'https://x.example', instruction });
  assert.deepEqual(new Set(fp('SMART_CONTRACT', '0xabc', 'ERC-4626 vault on an optimistic L2 rollup').classes), new Set(['defi', 'l2']));
  assert.ok(fp('APPLE_STORE_APP_ID', 'https://apps.apple.com/app/x/id1', 'iOS app').classes.includes('mobile'));
  assert.ok(fp('API', 'https://api.x.example', 'graphql').classes.includes('api'));
  assert.ok(fp('URL', 'https://login.x.example', 'OAuth2 OIDC SAML SSO').classes.includes('identity'));
  // a program's https:// website must not bleed an http fingerprint onto a contract
  assert.ok(!fp('SMART_CONTRACT', '0xabc', 'vault accounting').fingerprints.includes('http'), 'no website http bleed onto contract');
});

test('bounty end-to-end heartbeat over a fixture feed: EV-ranked queue, spine-grounded, boundary respected', async () => {
  const plugin = await loadPlugin('./plugins/bounty/index.mjs', options(), { baseDir: ROOT });
  const fetchImpl = fakeFeed();
  const store = await openStore(':memory:');
  const now = Date.UTC(2026, 8, 5, 12);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-bounty-'));
  const res = await runOnce({ store, plugin, domain: 'bounty', node: 'test.node', env: { LOAM_AUTONOMOUS: '1' }, wall: () => now, sleep: async () => {}, fetchImpl, config: { budgetSeconds: 30, valueModel: true, judgmentsPerRun: 6, activeJudgments: true, maxFindings: 10 }, now, seed: 's1', outDir });

  // BOUNDARY: the only host ever contacted is the public feed (+ its robots.txt). No listed target.
  assert.ok(fetchImpl.calls.length > 0, 'the feed was fetched');
  assert.ok(fetchImpl.calls.every((h) => h === FEED_HOST), `only the feed host is contacted, got: ${[...new Set(fetchImpl.calls)]}`);

  const mem = (await project(store, memoryProjection, { domain: 'bounty', saveSnapshot: false })).state;
  // targets fingerprinted + spine wired into the graph
  const login = mem.entities.get('target:hackerone/northwind_id#https_//login.northwind.example');
  assert.ok(login, 'identity target observed');
  assert.ok(latestSignal(login, 'ev') > 0, 'has a ScoutIq EV');
  assert.ok(latestSignal(login, 'exposedSeams') > 0 && latestSignal(login, 'applicableTechniques') > 0, 'coverage signals present');
  assert.ok(neighbors(mem, login.id, 'fingerprints_as', 'out').size >= 1, 'target → anatomy class edges (the eyes)');
  assert.ok(neighbors(mem, login.id, 'applicable', 'out').size >= 1, 'target → technique edges (the spine)');
  // the non-paying program is EV-zeroed (ScoutIq stance: rank by payable value)
  const quiet = mem.entities.get('target:hackerone/quietlabs#https_//portal.quietlabs.example');
  assert.equal(latestSignal(quiet, 'ev'), 0, 'non-paying program has EV 0');

  // delivery: a ranked queue, top lead is a high-EV paying target, not the watch-list item
  assert.ok(res.findings.length >= 3, 'a queue was delivered');
  assert.notEqual(res.findings[0].entityId, quiet.id, 'the $0 watch-list item is not the top lead');
  assert.ok(res.findings.every((f) => f.entityType === 'target'), 'the queue is targets (context entities are not leads)');

  // the alpha-queue digest was written, grounded in anatomy + techniques + sources
  const md = fs.readFileSync(path.join(outDir, 'alpha-queue.md'), 'utf8');
  assert.match(md, /Alpha queue/);
  assert.match(md, /invariant:/, 'the queue names the invariant that must hold');
  assert.match(md, /https?:\/\//, 'the queue carries primary source links');
  fs.rmSync(outDir, { recursive: true, force: true });
  await store.close();
});

test('bounty judgment loop (the teacher): the substrate requests judgments; ingesting them trains the value model', async () => {
  const store = await openStore(':memory:');
  const domain = 'bounty';
  let clock = Date.UTC(2026, 8, 5, 12);
  const fetchImpl = fakeFeed();
  const common = { store, domain, node: 'test.node', env: { LOAM_AUTONOMOUS: '1' }, sleep: async () => {}, fetchImpl, config: { budgetSeconds: 30, valueModel: true, judgmentsPerRun: 6, activeJudgments: true, maxFindings: 8 } };

  const p1 = await loadPlugin('./plugins/bounty/index.mjs', options(), { baseDir: ROOT });
  const r1 = await runOnce({ ...common, plugin: p1, wall: () => clock, now: clock, seed: 'a', outDir: null });
  const reqs = (await store.readAll({ domain, kinds: ['judgment.requested'] })).filter((e) => e.body.runId === r1.summary.runId);
  const items = reqs.at(-1)?.body.items ?? [];
  assert.ok(items.length > 0, 'the substrate asked the operator to judge the most uncertain leads');
  assert.equal(r1.summary.valueModel.trained, 0, 'no judgments yet');

  // the operator answers (here: a fixed rating) — the reasoner becomes a sensor
  const policy = new Policy({}, { env: process.env });
  const ledger = await new Ledger({ store, node: 'operator.test', policy, domain, now: () => clock }).init();
  for (const it of items) await ledger.emit('judgment.recorded', { findingId: it.findingId ?? null, entityId: it.entityId, value: 0.8, note: 'test operator', by: 'operator', ts: clock + 1000 });

  clock += 86400000;
  const p2 = await loadPlugin('./plugins/bounty/index.mjs', options(), { baseDir: ROOT });
  const r2 = await runOnce({ ...common, plugin: p2, wall: () => clock, now: clock, seed: 'b', outDir: null });
  assert.ok(r2.summary.valueModel.trained >= items.length, `value model trained on the judgments (${r2.summary.valueModel.trained} ≥ ${items.length})`);
  await store.close();
});

test('bounty coverage never repeats a tried cell', () => {
  const spine = buildSpine();
  const target = { classIds: ['identity', 'web'], fingerprints: ['http', 'oauth-oidc-saml'], key: 'k' };
  const before = coverageChart(spine, target, new Set());
  // operator marks one applicable cell as tried
  const firstSeam = before.chart[0].seams[0];
  const cell = firstSeam.techniques[0].cell;
  const after = coverageChart(spine, target, new Set([cell]));
  assert.equal(after.untriedTechniques, before.untriedTechniques - 1, 'the tried cell drops out of untried');
  assert.equal(after.applicableTechniques, before.applicableTechniques, 'applicable is unchanged (tried is a subset)');
  const stillThere = after.chart[0].seams[0].techniques.find((t) => t.cell === cell);
  assert.equal(stillThere.tried, true, 'the cell is marked tried, not removed from the chart');
});
