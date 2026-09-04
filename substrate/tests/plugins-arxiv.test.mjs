import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArxivAtom, categoryDistance } from '../plugins/arxiv-lit/atom.mjs';
import { loadPlugin } from '../core/plugins.mjs';
import { openStore } from '../core/store.mjs';
import { runOnce } from '../core/worker.mjs';
import { Policy } from '../policy/policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATOM = fs.readFileSync(path.join(ROOT, 'tests/fixtures/arxiv-cs.CR.atom'), 'utf8');
const SALT = 'unit-test-salt-0123456789';

test('arXiv Atom parser extracts ids, versions, categories, authors, entities', () => {
  const feed = parseArxivAtom(ATOM);
  assert.equal(feed.total, 41237);
  assert.equal(feed.entries.length, 5);
  const e = feed.entries[0];
  assert.equal(e.id, '2609.01234'); assert.equal(e.version, 2); assert.equal(e.idWithVersion, '2609.01234v2');
  assert.equal(e.title, 'Verifying Agentic Tool Use with Formal Contracts: A Supply-Chain Perspective');
  assert.deepEqual(e.authors, ['Alice Example', 'Bob Muster', 'Chen Wei']);
  assert.equal(e.primary, 'cs.CR'); assert.deepEqual(e.categories, ['cs.CR', 'cs.SE', 'cs.LO']);
  assert.equal(feed.entries[1].doi, '10.1000/example.2026.777');
  assert.equal(feed.entries[4].authors[0], 'Grégoire Lefèvre');
  assert.equal(feed.entries[4].title, 'Notes on Lattice Reduction <with> Applications');
  assert.equal(categoryDistance('cs.CR', 'q-bio.QM'), 1); assert.equal(categoryDistance('cs.CR', 'cs.LG'), 0.4); assert.equal(categoryDistance('cs.CR', 'cs.CR'), 0);
});

test('arxiv-lit plug-in refuses to load without a pseudonym salt (person data class)', async () => {
  const plugin = await loadPlugin('./plugins/arxiv-lit/index.mjs', {}, { baseDir: ROOT });
  const policy = new Policy({}, { env: {} });
  assert.throws(() => policy.registerManifest(plugin.sensors[0].manifest), /salt-required/);
  const ok = new Policy({}, { env: { LOAM_PSEUDONYM_SALT: SALT } });
  assert.ok(ok.registerManifest(plugin.sensors[0].manifest));
});

test('arxiv-lit end to end against a fake API: names never stored, secrets/PII redacted, findings produced, robots + rate limit honoured', async () => {
  const plugin = await loadPlugin('./plugins/arxiv-lit/index.mjs', { categories: ['cs.CR'], interests: ['verification', 'supply chain', 'agent'] }, { baseDir: ROOT });
  const calls = [];
  let clock = Date.UTC(2026, 8, 3, 12);
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), t: clock });
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { status: 200, ok: true, headers: new Map(), text: async () => 'User-agent: *\nDisallow: /abs/\nAllow: /api/\n', body: null };
    if (u.pathname === '/api/query') { assert.equal(opts.headers['user-agent'].includes('loam'), true); return { status: 200, ok: true, headers: new Map(), text: async () => ATOM, body: null }; }
    return { status: 404, ok: false, headers: new Map(), text: async () => '', body: null };
  };
  const store = await openStore(':memory:');
  const res = await runOnce({
    store, plugin, domain: 'arxiv-lit', node: 'test.node', env: { LOAM_PSEUDONYM_SALT: SALT, LOAM_AUTONOMOUS: '1' }, now: clock,
    wall: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, config: { budgetSeconds: 30 }, seed: 'x',
  });
  assert.ok(res.summary.newObservations >= 5, `observations ${res.summary.newObservations}`);
  assert.ok(res.summary.requests >= 2);
  const all = await store.readAll();
  const dump = JSON.stringify(all);
  for (const leak of ['Alice Example', 'Bob Muster', 'Chen Wei', 'Lefèvre', 'alice.example@', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ']) assert.ok(!dump.includes(leak), `leaked: ${leak}`);
  const obs = all.filter((e) => e.kind === 'observation.seen');
  const authors = new Set(obs.flatMap((e) => e.body.entities.filter((x) => x.type === 'author').map((x) => x.key)));
  assert.ok([...authors].every((k) => /^p_[0-9a-f]{16}$/.test(k)));
  assert.equal(authors.size, 7, 'Chen Wei and Alice Example each appear twice but map to one pseudonym');
  assert.ok(obs.some((e) => e.body.relations.some((r) => r.rel === 'coauthor')));
  assert.ok(all.some((e) => e.kind === 'policy.redacted'));
  assert.ok(res.findings.length > 0, 'findings delivered');
  assert.ok(res.findings.some((f) => f.entityId === 'paper:2609.01234' || f.entityId === 'paper:2609.00777'), JSON.stringify(res.findings.map((f) => [f.entityId, f.score])));
  // rate limit: consecutive API calls to the host are ≥ 3 s apart
  const api = calls.filter((c) => c.url.includes('/api/query'));
  for (let i = 1; i < api.length; i++) assert.ok(api[i].t - api[i - 1].t >= 3000, 'min interval 3s');
  // second run on the same data: everything is a duplicate → no new observations, no repeated findings
  const res2 = await runOnce({ store, plugin, domain: 'arxiv-lit', node: 'test.node', env: { LOAM_PSEUDONYM_SALT: SALT, LOAM_AUTONOMOUS: '1' }, now: clock + 3600e3, wall: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, config: { budgetSeconds: 30 }, seed: 'y' });
  const paperObs = (await store.readAll({ kinds: ['observation.seen'] })).filter((e) => e.body.entities.some((x) => x.type === 'paper'));
  assert.equal(paperObs.length, 5, 'no paper is observed twice; only feed-size observations of newly discovered categories are new');
  const ids1 = new Set(res.findings.map((f) => f.entityId));
  assert.ok(res2.findings.every((f) => !ids1.has(f.entityId)), 'no finding is delivered twice');
});

test('arxiv-lit: a 403 from the API stops the run and blocks the host for later runs', async () => {
  const plugin = await loadPlugin('./plugins/arxiv-lit/index.mjs', { categories: ['cs.CR', 'cs.LG'] }, { baseDir: ROOT });
  let clock = Date.UTC(2026, 8, 3, 12), apiCalls = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { status: 404, ok: false, headers: new Map(), text: async () => '', body: null };
    apiCalls++;
    return { status: 403, ok: false, headers: new Map(), text: async () => 'forbidden', body: null };
  };
  const store = await openStore(':memory:');
  const common = { store, plugin, domain: 'arxiv-lit', node: 'test.node', env: { LOAM_PSEUDONYM_SALT: SALT, LOAM_AUTONOMOUS: '1' }, wall: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, config: { budgetSeconds: 30 } };
  const r1 = await runOnce({ ...common, now: clock, seed: 'a' });
  assert.equal(apiCalls, 1, 'first 403 stops all further requests to the host in this run');
  assert.equal(r1.blocks.length, 1);
  const r2 = await runOnce({ ...common, now: clock + 3600e3, seed: 'b' });
  assert.equal(apiCalls, 1, 'the block is remembered across runs (projected from the log)');
  assert.ok(r2.summary.denials >= 1);
});
