import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, makePseudonymizer, PolicyError } from '../policy/data.mjs';
import { validateManifest } from '../policy/manifest.mjs';
import { NetworkGate, parseRobots, robotsAllows } from '../policy/network.mjs';
import { ActionGate, applyProposalEvent, isAutonomousEnv } from '../policy/actions.mjs';
import { Policy } from '../policy/policy.mjs';
import { Ledger } from '../core/ledger.mjs';
import { openStore } from '../core/store.mjs';

const SALT = 'unit-test-salt-0123456789';

test('data gate: secrets are replaced by type+location markers, never stored', () => {
  const { value, redactions } = sanitize({
    note: 'use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 or sk-ant-api03-abcdefghijklmnop and AKIAIOSFODNN7EXAMPLE',
    nested: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', url: 'https://user:pw@host.example/x', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  });
  const s = JSON.stringify(value);
  for (const leak of ['ghp_ABC', 'sk-ant', 'AKIAIOSFODNN7', 'abcdefghijklmnopqrstuvwxyz', 'user:pw', 'MIIEow', 'eyJhbGci']) assert.ok(!s.includes(leak), `leaked ${leak}`);
  const types = redactions.map((r) => r.type).sort();
  for (const t of ['github-token', 'anthropic-key', 'aws-access-key', 'key:authorization', 'url-credentials', 'jwt', 'private-key']) assert.ok(types.includes(t), `missing ${t} in ${types}`);
  assert.ok(redactions.every((r) => typeof r.location === 'string' && !('value' in r)));
});

test('data gate: PII patterns are redacted, ordinary identifiers survive', () => {
  const { value, redactions } = sanitize({ t: 'mail alice@example.org, call +1 (555) 123-4567, ip 10.1.2.3, ssn 123-45-6789, card 4111 1111 1111 1111, arXiv 2409.01234v2, version 4.17.21' });
  assert.ok(!value.t.includes('alice@'));
  assert.ok(!value.t.includes('555'));
  assert.ok(!value.t.includes('10.1.2.3'));
  assert.ok(!value.t.includes('123-45-6789'));
  assert.ok(!value.t.includes('4111 1111'));
  assert.ok(value.t.includes('2409.01234v2') && value.t.includes('4.17.21'), 'identifiers/versions are not phone numbers');
  assert.deepEqual([...new Set(redactions.map((r) => r.type))].sort(), ['email', 'ipv4', 'payment-card', 'phone', 'ssn']);
});

test('data gate: person fields become keyed pseudonyms; no salt → refusal', () => {
  const pseudonym = makePseudonymizer(SALT);
  const { value, redactions } = sanitize({ entities: [{ type: 'author', key: 'José García' }, { type: 'author', key: 'jose garcia' }] }, { personFields: ['entities[].key'], pseudonym });
  assert.equal(value.entities[0].key, value.entities[1].key, 'diacritics/case-insensitive identity');
  assert.match(value.entities[0].key, /^p_[0-9a-f]{16}$/);
  assert.equal(redactions.filter((r) => r.type === 'person').length, 2);
  assert.notEqual(makePseudonymizer('another-salt-value')('José García'), value.entities[0].key, 'salt-dependent');
  assert.throws(() => sanitize({ authors: ['x'] }, { personFields: ['authors'] }), /person-field-without-pseudonymizer/);
  assert.throws(() => makePseudonymizer('short'), /salt-required/);
});

const good = () => ({ id: 'sensor-x', version: '1', description: 'test', terms: { url: 'https://example.org/tos', officialApi: true }, endpoints: [{ host: 'api.example.org', pathPrefix: '/v1/', methods: ['GET'], minIntervalMs: 500, dailyCap: 100 }], dataClasses: ['public-metadata'], scale: { maxRequestsPerRun: 10 } });

test('manifest gate: undeclared capabilities and unsafe declarations are refused at load', () => {
  assert.ok(validateManifest(good()));
  const refuse = (mut, re) => { const m = good(); mut(m); assert.throws(() => validateManifest(m), re); };
  refuse((m) => { m.bypassRobots = true; }, /unknown key "bypassRobots"/);
  refuse((m) => { m.endpoints[0].cookies = 'x'; }, /unknown key "cookies"/);
  refuse((m) => { m.endpoints[0].host = '10.0.0.1'; }, /manifest-host/);
  refuse((m) => { m.endpoints[0].host = '*.example.org'; }, /manifest-host/);
  refuse((m) => { m.endpoints[0].host = 'localhost'; }, /manifest-host/);
  refuse((m) => { m.endpoints[0].methods = ['POST']; }, /readOnly/);
  refuse((m) => { m.endpoints[0].methods = ['DELETE']; }, /not permitted/);
  refuse((m) => { m.endpoints[0].minIntervalMs = 10; }, /minIntervalMs/);
  refuse((m) => { m.endpoints[0].dailyCap = 999999; }, /dailyCap/);
  refuse((m) => { m.auth = 'token-required'; }, /tokenEnv/);
  refuse((m) => { m.auth = 'token-required'; m.tokenEnv = 'ghp_looksLikeAValue'; }, /environment variable NAME/);
  refuse((m) => { m.auth = 'token-required'; m.tokenEnv = 'GH_PAT'; m.terms.officialApi = false; }, /authenticated scraping is refused/);
  refuse((m) => { m.dataClasses = ['person']; }, /salt/);
  refuse((m) => { m.terms.url = 'http://example.org/tos'; }, /https/);
  refuse((m) => { m.scale.maxRequestsPerRun = 100000; }, /manifest-scale/);
  assert.ok(validateManifest({ ...good(), dataClasses: ['person'], personFields: ['a.b'] }, { hasSalt: true }));
  assert.ok(validateManifest({ ...good(), endpoints: [{ host: 'localhost', pathPrefix: '/api/', methods: ['POST'], readOnly: true }] }, { localServices: ['localhost'] }));
});

test('robots.txt: longest match wins, Allow wins ties, specific group replaces wildcard', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 2\n\nUser-agent: Googlebot\nDisallow: /\n');
  assert.equal(robotsAllows(r, '/public'), true);
  assert.equal(robotsAllows(r, '/private/x'), false);
  assert.equal(robotsAllows(r, '/private/ok/1'), true);
  assert.equal(r.crawlDelay, 2);
  const specific = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: loam\nDisallow: /api/x\n', 'loam');
  assert.equal(robotsAllows(specific, '/api/query'), true);
  assert.equal(robotsAllows(specific, '/api/x/1'), false);
  const wild = parseRobots('User-agent: *\nDisallow: /*.json$\nDisallow: /tmp/*\n');
  assert.equal(robotsAllows(wild, '/a/b.json'), false);
  assert.equal(robotsAllows(wild, '/a/b.jsonl'), true);
  assert.equal(robotsAllows(wild, '/tmp/x'), false);
});

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const u = new URL(url);
    const route = routes[u.pathname] ?? routes['*'];
    const r = typeof route === 'function' ? route(u, opts) : route ?? { status: 404, body: '' };
    return {
      status: r.status, ok: r.status >= 200 && r.status < 300,
      headers: new Map(Object.entries(r.headers ?? {})),
      text: async () => r.body ?? '', body: null,
    };
  };
  f.calls = calls;
  return f;
}

function gateWith(routes, { env = {}, config = {}, manifestMut = null, blocks = new Map(), dailyCounts = new Map(), robotsCache = new Map() } = {}) {
  const events = [];
  const m = good(); if (manifestMut) manifestMut(m);
  const manifest = validateManifest(m);
  let now = 1_000_000;
  const gate = new NetworkGate({
    config: { ...config, authorizedTokens: config.authorizedTokens ?? {} }, manifests: new Map([[manifest.id, manifest]]), env,
    now: () => now, sleep: async (ms) => { now += ms; }, fetchImpl: fakeFetch(routes), emit: async (k, b) => { events.push({ kind: k, body: b }); },
    blocks, dailyCounts, robotsCache,
  });
  gate.events = events;
  gate.advance = (ms) => { now += ms; };
  return gate;
}

test('network gate: only inside a sensing scope, only declared endpoints, https only, no credentials in URLs/headers', async () => {
  const g = gateWith({ '/robots.txt': { status: 404 }, '/v1/items': { status: 200, body: '{"ok":1}' } });
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v1/items'), /no-sensing-scope/);
  g.enterScope('sensor-x');
  await assert.rejects(() => g.fetchGuarded('https://other.example.org/v1/items'), /undeclared-endpoint/);
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v2/items'), /undeclared-endpoint/);
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v1/items', { method: 'POST' }), /undeclared-endpoint/);
  await assert.rejects(() => g.fetchGuarded('http://api.example.org/v1/items'), /insecure-scheme/);
  await assert.rejects(() => g.fetchGuarded('https://u:p@api.example.org/v1/items'), /url-credentials/);
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v1/items?api_key=abc'), /secret-in-query/);
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v1/items', { headers: { Authorization: 'Bearer x' } }), /caller-credentials/);
  const res = await g.fetchGuarded('https://api.example.org/v1/items?q=1');
  assert.equal(res.status, 200); assert.deepEqual(res.json(), { ok: 1 });
  assert.equal(g.events.filter((e) => e.kind === 'policy.denied').length, 8, 'every denial is logged');
  assert.ok(g.events.some((e) => e.kind === 'robots.fetched'));
  const polled = g.events.filter((e) => e.kind === 'source.polled' && !e.body.robots);
  assert.equal(polled.length, 1);
  assert.equal(polled[0].body.auth.used, false);
  assert.equal(g.fetchImpl.calls.at(-1).opts.headers['user-agent'].includes('loam'), true);
  assert.equal(g.fetchImpl.calls.at(-1).opts.redirect, 'manual');
  g.exitScope();
});

test('network gate: robots disallow and crawl-delay are enforced; robots unavailability fails closed', async () => {
  const g = gateWith({ '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /v1/secret\nCrawl-delay: 3\n' }, '*': { status: 200, body: 'x' } });
  g.enterScope('sensor-x');
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v1/secret/1'), /robots-disallow/);
  const t0 = g.now();
  await g.fetchGuarded('https://api.example.org/v1/a');
  await g.fetchGuarded('https://api.example.org/v1/b');
  assert.ok(g.now() - t0 >= 3000, 'crawl-delay of 3s respected between requests to the host');
  g.exitScope();
  const g2 = gateWith({ '/robots.txt': { status: 503 }, '*': { status: 200, body: 'x' } });
  g2.enterScope('sensor-x');
  await assert.rejects(() => g2.fetchGuarded('https://api.example.org/v1/a'), /robots-unavailable/);
  const g3 = gateWith({ '/robots.txt': { status: 200, body: 'User-agent: *\nCrawl-delay: 600\n' }, '*': { status: 200, body: 'x' } });
  g3.enterScope('sensor-x');
  await assert.rejects(() => g3.fetchGuarded('https://api.example.org/v1/a'), /crawl-delay-too-large/);
});

test('network gate: 403/401/429 are stop signals that block the host for every worker; 5xx trips a breaker', async () => {
  const blocks = new Map();
  const g = gateWith({ '/robots.txt': { status: 404 }, '/v1/a': { status: 403, body: 'nope' }, '/v1/b': { status: 200, body: 'ok' } }, { blocks });
  g.enterScope('sensor-x');
  const r = await g.fetchGuarded('https://api.example.org/v1/a');
  assert.equal(r.blocked, true);
  assert.ok(g.events.some((e) => e.kind === 'source.blocked' && e.body.host === 'api.example.org' && e.body.reason === 'forbidden'));
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v1/b'), /host-blocked/);
  assert.ok(blocks.get('api.example.org').until > g.now(), 'block persists in the shared map (projected from the log)');
  g.exitScope();
  // 429 with Retry-After
  const g2 = gateWith({ '/robots.txt': { status: 404 }, '/v1/a': { status: 429, headers: { 'retry-after': '120' } } });
  g2.enterScope('sensor-x');
  await g2.fetchGuarded('https://api.example.org/v1/a');
  const b = g2.events.find((e) => e.kind === 'source.blocked').body;
  assert.equal(b.reason, 'rate-limited');
  assert.equal(b.until - g2.now(), 120 * 1000);
  g2.exitScope();
  // breaker
  const g3 = gateWith({ '/robots.txt': { status: 404 }, '/v1/a': { status: 500 } });
  g3.enterScope('sensor-x');
  await g3.fetchGuarded('https://api.example.org/v1/a'); await g3.fetchGuarded('https://api.example.org/v1/a');
  const third = await g3.fetchGuarded('https://api.example.org/v1/a');
  assert.equal(third.blocked, true);
  assert.equal(g3.events.find((e) => e.kind === 'source.blocked').body.reason, 'server-errors');
});

test('network gate: run, sensor and daily caps; responses are size-capped; redirects not followed', async () => {
  const g = gateWith({ '/robots.txt': { status: 404 }, '*': { status: 200, body: 'ok' } }, { config: { maxRequestsPerRun: 3 } });
  g.enterScope('sensor-x');
  await g.fetchGuarded('https://api.example.org/v1/a'); // + robots = 2 requests
  await g.fetchGuarded('https://api.example.org/v1/b');
  await assert.rejects(() => g.fetchGuarded('https://api.example.org/v1/c'), /run-cap/);
  g.exitScope();
  const daily = new Map([['api.example.org', 100]]);
  const g2 = gateWith({ '/robots.txt': { status: 404 }, '*': { status: 200, body: 'ok' } }, { dailyCounts: daily });
  g2.enterScope('sensor-x');
  await assert.rejects(() => g2.fetchGuarded('https://api.example.org/v1/a'), /daily-cap/);
  const g3 = gateWith({ '/robots.txt': { status: 404 }, '*': { status: 200, body: 'x'.repeat(5000) } }, { manifestMut: (m) => { m.endpoints[0].maxBytes = 1024; } });
  g3.enterScope('sensor-x');
  const r = await g3.fetchGuarded('https://api.example.org/v1/a');
  assert.equal(r.ok, false); assert.equal(r.error, 'body-too-large');
  const g4 = gateWith({ '/robots.txt': { status: 404 }, '*': { status: 302, headers: { location: 'https://evil.example/x' } } });
  g4.enterScope('sensor-x');
  const rr = await g4.fetchGuarded('https://api.example.org/v1/a');
  assert.equal(rr.ok, false); assert.equal(rr.status, 302);
  assert.equal(g4.fetchImpl.calls.filter((c) => c.url.includes('evil')).length, 0);
});

test('network gate: tokens come only from the environment, only when declared AND operator-authorized, and are never logged', async () => {
  const routes = { '/robots.txt': { status: 404 }, '*': (u, o) => ({ status: 200, body: o.headers.authorization ? 'auth' : 'anon' }) };
  const mut = (m) => { m.auth = 'token-optional'; m.tokenEnv = 'TEST_TOKEN'; };
  const g = gateWith(routes, { env: { TEST_TOKEN: 'ghp_SECRETSECRETSECRETSECRET12345' }, manifestMut: mut });
  g.enterScope('sensor-x');
  const anon = await g.fetchGuarded('https://api.example.org/v1/a', { auth: true });
  assert.equal(anon.text, 'anon', 'token-optional without operator authorization proceeds anonymously');
  assert.ok(g.events.some((e) => e.kind === 'policy.warning' && e.body.code === 'auth-not-authorized'));
  assert.ok(!JSON.stringify(g.events).includes('SECRETSECRET'));
  g.exitScope();
  const gr = gateWith(routes, { env: { TEST_TOKEN: 'ghp_SECRETSECRETSECRETSECRET12345' }, manifestMut: (m) => { m.auth = 'token-required'; m.tokenEnv = 'TEST_TOKEN'; } });
  gr.enterScope('sensor-x');
  await assert.rejects(() => gr.fetchGuarded('https://api.example.org/v1/a'), /auth-not-authorized/);
  gr.exitScope();
  const g2 = gateWith(routes, { env: { TEST_TOKEN: 'ghp_SECRETSECRETSECRETSECRET12345' }, manifestMut: mut, config: { authorizedTokens: { 'sensor-x': 'TEST_TOKEN' } } });
  g2.enterScope('sensor-x');
  const r = await g2.fetchGuarded('https://api.example.org/v1/a', { auth: true });
  assert.equal(r.text, 'auth');
  const logged = JSON.stringify(g2.events);
  assert.ok(!logged.includes('SECRETSECRET'), 'token value never appears in events');
  assert.ok(logged.includes('"location":"env:TEST_TOKEN"'), 'only the token location is recorded');
  g2.exitScope();
  const g3 = gateWith(routes, { env: {}, manifestMut: (m) => { m.auth = 'token-required'; m.tokenEnv = 'TEST_TOKEN'; }, config: { authorizedTokens: { 'sensor-x': 'TEST_TOKEN' } } });
  g3.enterScope('sensor-x');
  await assert.rejects(() => g3.fetchGuarded('https://api.example.org/v1/a'), /token-missing/);
  const g4 = gateWith(routes, { env: {} });
  g4.enterScope('sensor-x');
  await assert.rejects(() => g4.fetchGuarded('https://api.example.org/v1/a', { auth: true }), /auth-not-declared/);
});

test('action gate: proposals are recorded, never executed autonomously; approval is human-only', async () => {
  const events = [];
  const emit = async (k, b) => events.push({ kind: k, body: b });
  const ci = new ActionGate({ emit, env: { GITHUB_ACTIONS: 'true' }, now: () => 1 });
  const id = await ci.propose({ kind: 'notify', target: 'https://hooks.example/x', rationale: 'because', payload: { a: 1 } });
  assert.equal(events[0].kind, 'proposal.created');
  await assert.rejects(() => ci.approve(id), /approval-in-autonomous-context/);
  const proposals = new Map();
  for (const e of events) applyProposalEvent(proposals, { kind: e.kind, body: e.body });
  await assert.rejects(() => ci.executeApproved(id, async () => 'ran', { proposals, confirm: true }), /execution-in-autonomous-context/);
  const human = new ActionGate({ emit, env: {}, now: () => 2 });
  await assert.rejects(() => human.executeApproved(id, async () => 'ran', { proposals, confirm: true }), /proposal-not-approved/);
  await human.approve(id, { by: 'alice' });
  for (const e of events.slice(1)) applyProposalEvent(proposals, { kind: e.kind, body: e.body });
  assert.equal(proposals.get(id).status, 'approved');
  await assert.rejects(() => human.executeApproved(id, async () => 'ran', { proposals }), /execution-not-confirmed/);
  let ran = 0;
  assert.equal(await human.executeApproved(id, async () => { ran++; return 'ran'; }, { proposals, confirm: true }), 'ran');
  assert.equal(ran, 1);
  for (const e of events) applyProposalEvent(proposals, { kind: e.kind, body: e.body });
  assert.equal(proposals.get(id).status, 'executed');
  // rejected is terminal
  const id2 = await human.propose({ kind: 'x', target: 'y', rationale: 'z' });
  await human.reject(id2, { by: 'alice' });
  await human.approve(id2, { by: 'alice' });
  const p2 = new Map();
  for (const e of events) applyProposalEvent(p2, { kind: e.kind, body: e.body });
  assert.equal(p2.get(id2).status, 'rejected');
  assert.equal(isAutonomousEnv({ CI: '1' }), true);
  assert.equal(isAutonomousEnv({}), false);
});

test('ledger: every stored body is sanitized, redactions are logged without content, dedup skips', async () => {
  const store = await openStore(':memory:');
  const policy = new Policy({}, { env: { LOAM_PSEUDONYM_SALT: SALT } });
  const ledger = await new Ledger({ store, node: 'n1', policy, domain: 'd', now: () => 1000 }).init();
  const ev = await ledger.emit('note.recorded', { text: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 mail x@y.org', authors: ['Ada Lovelace'] }, { personFields: ['authors'] });
  assert.ok(!JSON.stringify(ev.body).includes('ghp_ABC'));
  assert.match(ev.body.authors[0], /^p_/);
  const all = await store.readAll();
  const red = all.find((e) => e.kind === 'policy.redacted');
  assert.ok(red);
  assert.deepEqual(red.body.redactions.map((r) => r.type).sort(), ['email', 'github-token']);
  assert.ok(!JSON.stringify(all).includes('ghp_ABC'));
  const a = await ledger.emit('observation.seen', { x: 1 }, { dedupKey: 'k', skipIfDedupKeyExists: true });
  const b = await ledger.emit('observation.seen', { x: 1 }, { dedupKey: 'k', skipIfDedupKeyExists: true });
  assert.ok(a && b === null);
});

test('global fetch guard: a plug-in calling fetch() directly still hits the gate', async () => {
  const policy = new Policy({}, { env: {} });
  const restore = policy.installGlobalFetchGuard();
  try {
    await assert.rejects(() => globalThis.fetch('https://api.example.org/v1/a'), PolicyError);
  } finally { restore(); }
});
