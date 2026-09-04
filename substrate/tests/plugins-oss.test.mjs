import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../core/plugins.mjs';
import { openStore } from '../core/store.mjs';
import { runOnce } from '../core/worker.mjs';
import { project } from '../core/projections.mjs';
import { memoryProjection, latestSignal, neighbors } from '../core/memory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (n) => fs.readFileSync(path.join(ROOT, 'tests/fixtures', n), 'utf8');
const SALT = 'unit-test-salt-0123456789';

function fakeApis({ githubStatus = 200 } = {}) {
  const calls = [];
  const f = async (url, opts) => {
    const u = new URL(url);
    calls.push({ host: u.hostname, path: u.pathname, auth: !!opts.headers?.authorization });
    const ok = (body, status = 200) => ({ status, ok: status < 300, headers: new Map(), text: async () => body, body: null });
    if (u.pathname === '/robots.txt') return ok('User-agent: *\nDisallow:\n');
    if (u.hostname === 'registry.npmjs.org') {
      const name = decodeURIComponent(u.pathname.slice(1));
      if (name === 'hono') return ok(fx('npm-hono.json'));
      const doc = JSON.parse(fx('npm-hono.json')); doc.name = name; doc._id = name; doc.maintainers = [{ name: 'other-maintainer', email: 'o@example.com' }]; doc.repository = { url: `git+https://github.com/example/${name}.git` }; doc.versions = { '4.13.7': { name, version: '4.13.7', dependencies: {} } };
      return ok(JSON.stringify(doc));
    }
    if (u.hostname === 'api.npmjs.org') return ok(fx('npm-downloads-range.json'));
    if (u.hostname === 'api.deps.dev') return ok(u.pathname.includes('/projects/') ? fx('depsdev-project.json') : fx('depsdev-version.json'));
    if (u.hostname === 'api.github.com') { if (githubStatus !== 200) return ok('nope', githubStatus); return ok(u.pathname.endsWith('/commits') ? fx('github-commits.json') : fx('github-repo.json')); }
    return ok('', 404);
  };
  f.calls = calls;
  return f;
}

test('oss-health end to end: registry → downloads → deps.dev → github over three heartbeats; pseudonyms only; findings', async () => {
  const plugin = await loadPlugin('./plugins/oss-health/index.mjs', { packages: ['hono'], github: true, expandDependencies: true }, { baseDir: ROOT });
  const fetchImpl = fakeApis();
  let clock = Date.UTC(2026, 8, 4, 12);
  const store = await openStore(':memory:');
  const env = { LOAM_PSEUDONYM_SALT: SALT, LOAM_AUTONOMOUS: '1', GH_PAT: 'ghp_TESTTOKENTESTTOKENTESTTOKEN1234' };
  const common = { store, plugin, domain: 'oss-health', node: 'test.node', env, wall: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, config: { budgetSeconds: 60 }, policyConfig: { authorizedTokens: { 'github-repos': 'GH_PAT' } } };
  let res;
  for (let i = 0; i < 3; i++) { res = await runOnce({ ...common, now: clock, seed: `s${i}` }); clock += 4 * 86400e3; }
  const mem = (await project(store, memoryProjection, { domain: 'oss-health', saveSnapshot: false })).state;
  const hono = mem.entities.get('package:npm/hono');
  assert.ok(hono, 'watched package observed');
  assert.equal(latestSignal(hono, 'versionsTotal'), 40);
  assert.ok(latestSignal(hono, 'downloadsWeek') > 0, 'downloads observed');
  assert.equal(latestSignal(hono, 'advisories'), 1, 'deps.dev advisory observed');
  const repo = mem.entities.get('repo:github/honojs/hono');
  assert.ok(repo && latestSignal(repo, 'stars') === 26543, 'repo linked via package metadata and enriched');
  assert.ok(latestSignal(repo, 'topContributorShare') > 0.3 && latestSignal(repo, 'commits30d') > 0, 'github cadence + bus factor');
  assert.equal(neighbors(mem, 'package:npm/hono', 'maintained_by', 'out').size, JSON.parse(fx('npm-hono.json')).maintainers.length);
  const dump = JSON.stringify(await store.readAll());
  for (const leak of ['maintainer0', 'Yusuke Example', 'yusukebe-example', '@example.com', 'ghp_TESTTOKEN', 'owner@']) assert.ok(!dump.includes(leak), `leaked ${leak}`);
  assert.ok([...mem.byType.get('maintainer')].every((id) => /^maintainer:p_[0-9a-f]{16}$/.test(id)));
  assert.ok([...mem.byType.get('contributor')].every((id) => /^contributor:p_[0-9a-f]{16}$/.test(id)));
  const gh = fetchImpl.calls.filter((c) => c.host === 'api.github.com' && c.path !== '/robots.txt');
  assert.ok(gh.length >= 2 && gh.every((c) => c.auth), 'authorized token used for GitHub API calls (robots.txt stays anonymous)');
  assert.ok(fetchImpl.calls.filter((c) => c.host !== 'api.github.com' && c.path !== '/robots.txt').every((c) => !c.auth), 'no token leaks to other hosts');
  assert.ok(dump.includes('"location":"env:GH_PAT"'));
  const findings = (await store.readAll({ kinds: ['finding.emitted'] })).map((e) => e.body);
  assert.ok(findings.length > 0, 'findings delivered');
  assert.ok(findings.some((f) => f.entityId === 'package:npm/hono' || f.entityId === 'repo:github/honojs/hono'), JSON.stringify(findings.map((f) => f.entityId)));
});

test('oss-health: without operator authorization the GitHub sensor runs anonymously; a 401 blocks the host', async () => {
  const plugin = await loadPlugin('./plugins/oss-health/index.mjs', { packages: ['hono'], github: true, expandDependencies: false }, { baseDir: ROOT });
  const fetchImpl = fakeApis({ githubStatus: 401 });
  let clock = Date.UTC(2026, 8, 4, 12);
  const store = await openStore(':memory:');
  const env = { LOAM_PSEUDONYM_SALT: SALT, LOAM_AUTONOMOUS: '1', GH_PAT: 'ghp_TESTTOKENTESTTOKENTESTTOKEN1234' };
  const common = { store, plugin, domain: 'oss-health', node: 'test.node', env, wall: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, config: { budgetSeconds: 60 } };
  await runOnce({ ...common, now: clock, seed: 'a' }); clock += 4 * 86400e3;
  const r2 = await runOnce({ ...common, now: clock, seed: 'b' });
  const gh = fetchImpl.calls.filter((c) => c.host === 'api.github.com' && c.path !== '/robots.txt');
  assert.ok(gh.length >= 1 && gh.every((c) => !c.auth), 'no authorization → anonymous only');
  assert.ok((await store.readAll({ kinds: ['policy.warning'] })).some((e) => e.body.code === 'auth-not-authorized'), 'anonymous fallback is logged');
  assert.ok(r2.summary.denials >= 1 || r2.blocks.some((b) => b.host === 'api.github.com'), 'blocked after 401');
  const blocked = (await store.readAll({ kinds: ['source.blocked'] })).map((e) => e.body.host);
  assert.ok(blocked.includes('api.github.com'));
});
