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
import { memoryProjection, latestSignal } from '../core/memory.mjs';
import { archiveProjection } from '../core/archive.mjs';
import { fetchFeedCached, readCache } from '../plugins/bounty/feedcache.mjs';
import { loadTried, markTriedCell, readTriedFile, writeTriedFile } from '../plugins/bounty/tried.mjs';
import { outcomeValue } from '../plugins/bounty/outcomes.mjs';
import { emitOutcomeJudgment } from '../plugins/bounty/journal.mjs';
import { estimatePriorArt } from '../plugins/bounty/priorart.mjs';
import { buildSpine, coverageChart } from '../plugins/bounty/spine.mjs';
import { collectLead, advanceToTerminal } from '../plugins/bounty/investigation.mjs';
import { Prepstore } from '../plugins/bounty/prepstore.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED = fs.readFileSync(path.join(ROOT, 'tests/fixtures/bounty-feed.json'), 'utf8');
const FEED_HOST = 'raw.githubusercontent.com';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loam-prep-'));

function fakeFeed() {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url); calls.push(u.hostname);
    const ok = (body, status = 200) => ({ status, ok: status < 300, headers: new Map(), text: async () => body });
    if (u.pathname === '/robots.txt') return ok('User-agent: *\nDisallow:\n');
    if (u.hostname === FEED_HOST) return ok(FEED);
    return ok('', 404);
  };
  f.calls = calls; return f;
}
const opts = (extra = {}) => ({ feeds: [{ id: 'fx', platform: 'hackerone', url: `https://${FEED_HOST}/arkadiyt/bounty-targets-data/main/data/fx.json` }], ...extra });

async function heartbeat(store, plugin, now, seed) {
  return runOnce({ store, plugin, domain: 'bounty', node: 'test.node', env: { LOAM_AUTONOMOUS: '1' }, wall: () => now, sleep: async () => {}, fetchImpl: fakeFeed(), config: { budgetSeconds: 30, valueModel: true, maxFindings: 12 }, now, seed, outDir: null });
}
function pickTarget(memory, pred) { for (const id of memory.byType.get('target') ?? []) { const e = memory.entities.get(id); if (pred(e)) return e; } return null; }

// ── 1. real-feed adapter: the polite cache ────────────────────────────────────
test('feedcache: TTL serves without a request; a stale hit revalidates (304); an error falls back to the last snapshot', async () => {
  const dir = tmp();
  let served = 0;
  const stub = (body, { status = 200, etag = 'v1' } = {}) => async () => { served++; return { ok: status < 300, status, text: body, headers: { etag }, blocked: false }; };
  const url = 'https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/x.json';

  const a = await fetchFeedCached(stub('[1]'), { dir, id: 'x', url, now: 1000, ttlMs: 10000 });
  assert.equal(a.source, 'fetched'); assert.equal(served, 1);
  assert.ok(readCache(dir, 'x', 1000, 10000)?.fresh, 'snapshot cached');

  const b = await fetchFeedCached(stub('[2]'), { dir, id: 'x', url, now: 2000, ttlMs: 10000 });
  assert.equal(b.source, 'cache-fresh'); assert.equal(served, 1, 'fresh TTL made NO request');
  assert.equal(b.body, '[1]');

  const c = await fetchFeedCached(async (u, h) => { served++; assert.equal(h['if-none-match'], 'v1', 'sends conditional header when stale'); return { ok: false, status: 304, text: '', headers: {}, blocked: false }; }, { dir, id: 'x', url, now: 99999, ttlMs: 10000 });
  assert.equal(c.source, 'revalidated-304'); assert.equal(c.body, '[1]', '304 reused the snapshot');

  const d = await fetchFeedCached(async () => ({ ok: false, status: 403, text: '', headers: {}, blocked: true }), { dir, id: 'x', url, now: 999999, ttlMs: 10000 });
  assert.equal(d.source, 'stale-if-error'); assert.equal(d.body, '[1]', 'a block reused the last good snapshot rather than losing the run');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real-feed enrichment: opt-in GitHub-source enrichment populates freshCodeIndex and lifts pFindable — observe-only, allowed hosts only', async () => {
  const commits = Array.from({ length: 80 }, (_, i) => ({ sha: `sha${i}`, commit: { committer: { date: new Date(Date.UTC(2026, 7, 1) + i * 3600e3).toISOString() } } }));
  const calls = [];
  const okJson = (body) => ({ status: 200, ok: true, headers: new Map(), text: async () => JSON.stringify(body) });
  const gh = async (url) => {
    const u = new URL(url); calls.push(u.hostname);
    if (u.pathname === '/robots.txt') return { status: 200, ok: true, headers: new Map(), text: async () => 'User-agent: *\nDisallow:\n' };
    if (u.hostname === FEED_HOST) return { status: 200, ok: true, headers: new Map(), text: async () => FEED };
    if (u.hostname === 'api.github.com') {
      if (/\/compare\//.test(u.pathname)) return okJson({ files: [{ status: 'added' }, { status: 'modified' }, { status: 'added' }] });
      if (/\/commits/.test(u.pathname)) return okJson(commits);
      return okJson({ default_branch: 'main', stargazers_count: 12, created_at: '2024-01-01T00:00:00Z', pushed_at: '2026-08-30T00:00:00Z', archived: false, language: 'Go' });
    }
    return { status: 404, ok: false, headers: new Map(), text: async () => '' };
  };
  const store = await openStore(':memory:');
  const now = Date.UTC(2026, 8, 5, 12);
  const plugin = await loadPlugin('./plugins/bounty/index.mjs', { ...opts(), enrichSource: true, maxEnrich: 4 }, { baseDir: ROOT });
  await runOnce({ store, plugin, domain: 'bounty', node: 't', env: { LOAM_AUTONOMOUS: '1' }, wall: () => now, sleep: async () => {}, fetchImpl: gh, config: { budgetSeconds: 30, valueModel: true, maxFindings: 12 }, now, seed: 'e', outDir: null });
  const memory = (await project(store, memoryProjection, { domain: 'bounty', saveSnapshot: false })).state;
  const src = pickTarget(memory, (e) => e.attrs?.assetType === 'SOURCE_CODE');
  assert.ok(src, 'the source-code asset was observed');
  assert.ok(latestSignal(src, 'freshCodeIndex') >= 30, `freshCodeIndex populated by enrichment (${latestSignal(src, 'freshCodeIndex')})`);
  assert.ok(latestSignal(src, 'pFindable') > 0.3, `pFindable lifted well above the unenriched ~0.06 (${latestSignal(src, 'pFindable')})`);
  assert.ok(src.attrs.repoRevision?.revision, 'the pinned repo revision was recorded');
  // observe-only: the public repo API was read, but never a listed target host
  assert.ok(calls.includes('api.github.com'), 'enrichment read the public GitHub repo');
  assert.ok(calls.every((h) => h === FEED_HOST || h === 'api.github.com'), `only public-data hosts contacted, got: ${[...new Set(calls)]}`);
  await store.close();
});

// ── 2. tried-journal: cell + coverage + judgment feedback ─────────────────────
test('tried-journal: a marked cell drops from coverage and loadTried reads rich entries', () => {
  const spine = buildSpine();
  const target = { classIds: ['identity', 'web'], fingerprints: ['http', 'oauth-oidc-saml'], key: 'k' };
  const before = coverageChart(spine, target, new Set());
  const seam = before.chart[0].seams[0];
  const [seamId, techId] = seam.techniques[0].cell.split('::').slice(-2);

  const file = path.join(tmp(), 'tried.json');
  const obj = readTriedFile(file);
  markTriedCell(obj, { targetKey: 'k', seamId, techId, outcome: 'intended', note: 'safeguard' });
  writeTriedFile(obj, file);

  const tried = loadTried(file);                       // reads the {cell,outcome,...} entry
  assert.ok(tried.has(`k::${seamId}::${techId}`), 'rich entry parsed to a full cell key');
  const after = coverageChart(spine, target, tried);
  assert.equal(after.untriedTechniques, before.untriedTechniques - 1, 'the tried cell left untried');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('outcome→judgment: emitOutcomeJudgment records a value keyed to the outcome (positive high, negative low)', async () => {
  const store = await openStore(':memory:');
  const policy = new Policy({}, { env: {} });
  const ledger = await new Ledger({ store, node: 'op.test', policy, domain: 'bounty', now: () => 1000 }).init();
  await emitOutcomeJudgment(ledger, { targetKey: 'p/h#a', seamId: 'web.S1', techId: 'T007', outcome: 'real-defect', by: 'op' });
  await emitOutcomeJudgment(ledger, { targetKey: 'p/h#b', seamId: 'web.S1', techId: 'T007', outcome: 'intended', by: 'op' });
  const archive = (await project(store, archiveProjection, { domain: 'bounty', saveSnapshot: false })).state;
  assert.equal(archive.judgments.get('target:p/h#a').value, outcomeValue('real-defect'));
  assert.equal(archive.judgments.get('target:p/h#b').value, outcomeValue('intended'));
  assert.ok(outcomeValue('real-defect') > 0.8 && outcomeValue('intended') < 0.2, 'positive vs negative separation');
  await store.close();
});

// ── 3. prior-art / dedup ──────────────────────────────────────────────────────
test('prior-art: mature/crowded public signals → likely-known; sparse → plausibly-novel; always low visibility', () => {
  const known = estimatePriorArt({ program: { progEfficiency: 95, progResolveDays: 20, progManaged: true, crowd: 0.9 }, technique: { year: 2022 }, nowYear: 2026 });
  assert.equal(known.verdict, 'likely-known');
  assert.ok(known.probability >= 0.7 && known.evidence.length >= 3);
  const novel = estimatePriorArt({ program: {}, technique: { year: 2026 }, nowYear: 2026 });
  assert.equal(novel.verdict, 'plausibly-novel');
  for (const r of [known, novel]) assert.equal(r.visibility, 'low', 'always a clue, not proof');
});

// ── 4. investigation record + prep loop ───────────────────────────────────────
test('investigation: a paying, eligible, technique-rich lead → ready_for_human_test with every bounded question filled and the invariant pulled from the seam', async () => {
  const store = await openStore(':memory:');
  const now = Date.UTC(2026, 8, 5, 12);
  await heartbeat(store, await loadPlugin('./plugins/bounty/index.mjs', opts(), { baseDir: ROOT }), now, 's');
  const memory = (await project(store, memoryProjection, { domain: 'bounty', saveSnapshot: false })).state;
  const entity = pickTarget(memory, (e) => (e.attrs?.classIds ?? []).includes('identity') && e.attrs?.offersBounties);
  assert.ok(entity, 'an identity target was observed');

  const spine = buildSpine();
  const rec = await advanceToTerminal(collectLead(entity, { spine, tried: new Set(), budget: 4, now }));
  assert.equal(rec.state, 'ready_for_human_test', 'stops at the human handoff');
  const q = rec.questions;
  assert.ok(q.scopeEvidence.asset && q.observedChange.detail && q.repoRevision, 'scope/observed/revision present');
  assert.ok(q.competingExplanations.map((c) => c.kind).join() === 'defect,safeguard,intended,misunderstanding', 'all four competing explanations');
  assert.ok(q.nextDiscriminatingCheck && /read-only|observe|check/i.test(q.nextDiscriminatingCheck), 'a described, read-only discriminating check');
  assert.equal(rec.outcome.kind, 'ready');
  assert.match(rec.outcome.claim, /HYPOTHESIS/, 'a testable hypothesis, not a confirmed finding');
  // the invariant is the seam's, verbatim — never invented
  const seamInv = spine.seamIndex.get(rec.seamId).invariants[0].statement;
  assert.equal(q.expectedInvariant, seamInv, 'expected invariant is pulled from the seam');
  await store.close();
});

test('investigation: a non-paying lead is rejected before any prep (EV 0), never handed to a human', async () => {
  const store = await openStore(':memory:');
  const now = Date.UTC(2026, 8, 5, 12);
  await heartbeat(store, await loadPlugin('./plugins/bounty/index.mjs', opts(), { baseDir: ROOT }), now, 's');
  const memory = (await project(store, memoryProjection, { domain: 'bounty', saveSnapshot: false })).state;
  const quiet = pickTarget(memory, (e) => e.attrs?.offersBounties === false);
  assert.ok(quiet, 'the points-only program was observed');
  const rec = await advanceToTerminal(collectLead(quiet, { spine: buildSpine(), tried: new Set(), now }));
  assert.equal(rec.state, 'rejected');
  assert.match(rec.outcome.reason, /bounties|EV 0/);
  await store.close();
});

// ── 5. persistence + recovery ─────────────────────────────────────────────────
test('persistence + recovery: records survive a new instance; an atomic claim is exclusive, expires, and is then stealable', () => {
  const dir = tmp();
  const A = new Prepstore(dir);
  const now = 10_000;
  assert.equal(A.claim('lead-1', 'nodeA', 60_000, now), true, 'first claim wins');
  assert.equal(A.claim('lead-1', 'nodeB', 60_000, now + 1), false, 'a live claim is exclusive');
  A.saveRecord({ leadId: 'lead-1', state: 'investigating', questions: {}, budget: { total: 4, remaining: 2 } }, now + 2);

  // interrupt: a fresh process/instance over the same dir
  const B = new Prepstore(dir);
  const recovered = B.load().records;
  assert.ok(recovered.has('lead-1') && recovered.get('lead-1').state === 'investigating', 'record recovered from the journal');
  assert.equal(B.claim('lead-1', 'nodeB', 60_000, now + 100), false, 'still held before expiry — not double-processed');
  assert.equal(B.claim('lead-1', 'nodeB', 60_000, now + 60_001), true, 'expired claim is stealable after TTL');
  B.saveRecord({ leadId: 'lead-1', state: 'ready_for_human_test', questions: {}, budget: { total: 4, remaining: 1 } }, now + 60_002);

  // a torn trailing line must not corrupt recovery
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"type":"record","leadId":"lead-2","reco');
  const C = new Prepstore(dir).load().records;
  assert.equal(C.get('lead-1').state, 'ready_for_human_test', 'last snapshot wins');
  assert.ok(!C.has('lead-2'), 'a half-written line is ignored, not fatal');
  fs.rmSync(dir, { recursive: true, force: true });
});
