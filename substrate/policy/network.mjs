// policy/network.mjs — the network gate.
//
// All outbound HTTP goes through `fetchGuarded`. Rules (each one tested):
//   N1. Only inside a sensing scope, only for the scoped sensor, only to
//       endpoints (host + path prefix + method) that sensor's manifest declares.
//   N2. https only (http only for explicitly configured local services).
//   N3. robots.txt is fetched, cached as an event, and obeyed (longest-match,
//       Allow wins ties, Crawl-delay respected up to a cap).
//   N4. Per-host minimum interval, one in-flight request per host, per-run and
//       per-host-per-day caps that are shared across workers via the log.
//   N5. 401 / 403 / 429 are STOP signals: the host is blocked (backoff written
//       to the log so every worker sees it), and the run stops touching it.
//       Repeated 5xx trips a circuit breaker.
//   N6. Credentials never travel in URLs or caller headers. A token is used only
//       when the manifest declares an official API with an auth mode AND the
//       operator authorized that sensor's tokenEnv in config. The value is read
//       from the environment at request time and never stored or logged.
//   N7. Response bodies are capped in size and reads time out.
import { PolicyError } from './data.mjs';
import { sanitize } from './data.mjs';

const SENSITIVE_QUERY = /^(?:token|access_token|api_key|apikey|key|secret|password|auth|authorization|client_secret|sig|signature)$/i;
const STRIPPED_HEADERS = /^(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-auth-token)$/i;
const DAY = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
export function parseRobots(text, productToken = 'loam') {
  const token = productToken.toLowerCase();
  const groups = [];
  let cur = null, expectingAgents = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !expectingAgents) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      expectingAgents = true;
    } else if (cur && (field === 'allow' || field === 'disallow')) {
      expectingAgents = false;
      if (field === 'disallow' && value === '') continue; // empty disallow = allow all
      cur.rules.push({ allow: field === 'allow', pattern: value });
    } else if (cur && field === 'crawl-delay') {
      expectingAgents = false;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
    } else {
      expectingAgents = false;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && (token.includes(a) || a.includes(token))));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = specific.length ? specific : wildcard;
  const rules = chosen.flatMap((g) => g.rules);
  const crawlDelay = chosen.reduce((m, g) => (g.crawlDelay !== null ? Math.max(m ?? 0, g.crawlDelay) : m), null);
  return { rules, crawlDelay, groups: groups.length };
}

function patternToRegex(pattern) {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re);
}

export function robotsAllows(parsed, pathWithQuery) {
  let best = null, bestLen = -1;
  for (const r of parsed.rules) {
    if (patternToRegex(r.pattern).test(pathWithQuery)) {
      const len = r.pattern.length;
      if (len > bestLen || (len === bestLen && r.allow && !best.allow)) { best = r; bestLen = len; }
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// NetworkGate
// ---------------------------------------------------------------------------
export class NetworkGate {
  constructor({
    config = {}, manifests = new Map(), env = process.env, now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetchImpl = globalThis.fetch,
    emit = async () => {}, blocks = new Map(), dailyCounts = new Map(), robotsCache = new Map(), log = () => {},
  } = {}) {
    this.config = {
      userAgent: config.userAgent || 'loam-substrate/0.1 (+https://github.com/vector3on/scoutiq; observe-only research crawler)',
      productToken: config.productToken || 'loam',
      maxRequestsPerRun: config.maxRequestsPerRun ?? 200,
      maxRequestsPerHostPerDay: config.maxRequestsPerHostPerDay ?? 1000,
      localServices: config.localServices ?? [],
      authorizedTokens: config.authorizedTokens ?? {},
      timeoutMs: config.timeoutMs ?? 20000,
      maxCrawlDelaySec: config.maxCrawlDelaySec ?? 120,
      robotsTtlMs: config.robotsTtlMs ?? DAY,
    };
    this.manifests = manifests;
    this.env = env;
    this.now = now;
    this.sleep = sleep;
    this.fetchImpl = fetchImpl;
    this.emit = emit;
    this.blocks = blocks;            // host -> { until, reason, status }
    this.dailyCounts = dailyCounts;  // host -> count in the trailing 24h (from the log) + this run
    this.robotsCache = robotsCache;  // host -> { text, fetchedAt, status }
    this.log = log;
    this.scope = null;
    this.runCounts = { total: 0, bySensor: new Map(), byHost: new Map() };
    this.lastAt = new Map();
    this.queues = new Map();
    this.serverErrors = new Map();
    this.denials = [];
  }

  enterScope(sensorId, { domain = null } = {}) {
    if (this.scope) throw new PolicyError('scope-nested', `already in sensing scope ${this.scope.sensorId}`);
    if (!this.manifests.has(sensorId)) throw new PolicyError('unknown-sensor', `no manifest registered for ${sensorId}`);
    this.scope = { sensorId, domain, requests: 0 };
    return this.scope;
  }
  exitScope() { const s = this.scope; this.scope = null; return s; }
  async withScope(sensorId, opts, fn) {
    this.enterScope(sensorId, opts);
    try { return await fn(); } finally { this.exitScope(); }
  }

  isBlocked(host) {
    const b = this.blocks.get(host);
    return !!(b && b.until > this.now());
  }

  async deny(code, message, details = {}) {
    this.denials.push({ code, message, ...details });
    this.log(`policy denied ${code}: ${message}`);
    await this.emit('policy.denied', { code, message, ...details });
    throw new PolicyError(code, message, details);
  }

  async block(host, { status, reason, untilMs, sensor }) {
    const until = untilMs;
    const prev = this.blocks.get(host);
    if (!prev || prev.until < until) this.blocks.set(host, { until, reason, status });
    await this.emit('source.blocked', { host, status: status ?? null, reason, until, sensor: sensor ?? null });
  }

  resolveEndpoint(manifest, u, method) {
    return manifest.endpoints.find((e) => e.host === u.hostname.toLowerCase() && u.pathname.startsWith(e.pathPrefix) && e.methods.includes(method)) || null;
  }

  async throttle(host, intervalMs) {
    const prev = this.queues.get(host) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    this.queues.set(host, prev.then(() => gate));
    await prev;
    const wait = Math.max(0, (this.lastAt.get(host) ?? -Infinity) + intervalMs - this.now());
    if (wait > 0) await this.sleep(wait);
    this.lastAt.set(host, this.now());
    return release;
  }

  /** Resolve the robots rules for a host (cached ≤ TTL, persisted as an event). */
  async robotsFor(host, manifest, endpoint) {
    const cached = this.robotsCache.get(host);
    if (cached && cached.fetchedAt + this.config.robotsTtlMs > this.now()) return parseRobots(cached.text, this.config.productToken);
    const scheme = endpoint.local ? 'http' : 'https';
    const res = await this.rawFetch(`${scheme}://${host}/robots.txt`, { method: 'GET', host, intervalMs: endpoint.minIntervalMs, maxBytes: 256 * 1024, sensor: manifest.id, isRobots: true });
    if (res.stop) return null;
    if (res.status === 404 || res.status === 410) {
      this.robotsCache.set(host, { text: '', fetchedAt: this.now(), status: res.status });
      await this.emit('robots.fetched', { host, status: res.status, text: '', fetchedAt: this.now() });
      return parseRobots('', this.config.productToken);
    }
    if (!res.ok) return null; // 5xx / network: unknown → fail closed
    const text = res.text.slice(0, 64 * 1024);
    this.robotsCache.set(host, { text, fetchedAt: this.now(), status: res.status });
    await this.emit('robots.fetched', { host, status: res.status, text, fetchedAt: this.now() });
    return parseRobots(text, this.config.productToken);
  }

  /** Low-level fetch with throttle, timeout, size cap, stop-signal handling. */
  async rawFetch(url, { method, host, intervalMs, maxBytes, headers = {}, sensor, isRobots = false }) {
    const release = await this.throttle(host, intervalMs);
    const started = this.now();
    let status = 0, bytes = 0, text = '', ok = false, stop = false, error = null, resHeaders = {};
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { method, headers, signal: ctrl.signal, redirect: 'manual' });
        status = res.status;
        resHeaders = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
        if (status >= 300 && status < 400) {
          // Redirects are not followed automatically: the target may be an undeclared host.
          ok = false;
        } else {
          text = await readCapped(res, maxBytes);
          bytes = Buffer.byteLength(text);
          ok = status >= 200 && status < 300;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = e?.name === 'AbortError' ? 'timeout' : e?.code === 'BODY_TOO_LARGE' ? 'body-too-large' : `network:${(e?.message || 'error').slice(0, 120)}`;
    } finally {
      release();
    }
    const ms = this.now() - started;
    this.runCounts.total++;
    this.runCounts.byHost.set(host, (this.runCounts.byHost.get(host) ?? 0) + 1);
    if (sensor) this.runCounts.bySensor.set(sensor, (this.runCounts.bySensor.get(sensor) ?? 0) + 1);
    this.dailyCounts.set(host, (this.dailyCounts.get(host) ?? 0) + 1);
    if (this.scope) this.scope.requests++;
    const u = new URL(url);
    const q = sanitize(Object.fromEntries(u.searchParams.entries())).value;
    await this.emit('source.polled', { sensor: sensor ?? null, host, path: u.pathname, query: q, method, status, bytes, ms, error, robots: isRobots, auth: headers.authorization ? { used: true, location: `env:${this._authLocation ?? '?'}` } : { used: false } });

    if (status === 401 || status === 403 || status === 429) {
      stop = true;
      const retryAfter = Number(resHeaders['retry-after']);
      const backoff = status === 429 ? Math.min(6 * 3600 * 1000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3600 * 1000) : DAY;
      await this.block(host, { status, reason: status === 429 ? 'rate-limited' : 'forbidden', untilMs: this.now() + backoff, sensor });
    } else if (status >= 500 || error) {
      const n = (this.serverErrors.get(host) ?? 0) + 1;
      this.serverErrors.set(host, n);
      if (n >= 3) {
        stop = true;
        await this.block(host, { status: status || null, reason: 'server-errors', untilMs: this.now() + 3600 * 1000, sensor });
      }
    }
    return { ok, status, text, bytes, ms, stop, error, headers: resHeaders };
  }

  /**
   * The guarded fetch handed to sensors. Resolves to
   *   { ok, status, text, json(), headers, blocked }.
   * Throws PolicyError on any policy denial (never silently bypasses).
   */
  async fetchGuarded(url, { method = 'GET', headers = {}, auth = false, purpose = null } = {}) {
    method = String(method).toUpperCase();
    const scope = this.scope;
    if (!scope) await this.deny('no-sensing-scope', `network access outside a sensing scope: ${String(url).slice(0, 120)}`);
    const manifest = this.manifests.get(scope.sensorId);
    let u;
    try { u = new URL(String(url)); } catch { await this.deny('bad-url', `unparseable URL`); }
    const host = u.hostname.toLowerCase();
    const endpoint = this.resolveEndpoint(manifest, u, method);
    if (!endpoint) await this.deny('undeclared-endpoint', `${manifest.id}: ${method} ${host}${u.pathname} is not a declared endpoint`, { sensor: manifest.id, host, path: u.pathname, method });
    if (u.protocol !== 'https:' && !(endpoint.local && u.protocol === 'http:')) await this.deny('insecure-scheme', `${u.protocol} not permitted for ${host}`, { sensor: manifest.id, host });
    if (u.username || u.password) await this.deny('url-credentials', 'credentials in URL are never permitted', { sensor: manifest.id, host });
    for (const k of u.searchParams.keys()) if (SENSITIVE_QUERY.test(k)) await this.deny('secret-in-query', `query parameter "${k}" looks like a credential`, { sensor: manifest.id, host });
    for (const k of Object.keys(headers)) if (STRIPPED_HEADERS.test(k)) await this.deny('caller-credentials', `header ${k} may not be supplied by a sensor; declare auth in the manifest`, { sensor: manifest.id, host });
    if (this.isBlocked(host)) await this.deny('host-blocked', `${host} is blocked until ${new Date(this.blocks.get(host).until).toISOString()} (${this.blocks.get(host).reason})`, { sensor: manifest.id, host });
    if (this.runCounts.total >= this.config.maxRequestsPerRun) await this.deny('run-cap', `run request cap ${this.config.maxRequestsPerRun} reached`, { sensor: manifest.id, host });
    if ((this.runCounts.bySensor.get(manifest.id) ?? 0) >= manifest.scale.maxRequestsPerRun) await this.deny('sensor-run-cap', `${manifest.id} reached its per-run cap ${manifest.scale.maxRequestsPerRun}`, { sensor: manifest.id, host });
    if ((this.dailyCounts.get(host) ?? 0) >= Math.min(endpoint.dailyCap, this.config.maxRequestsPerHostPerDay)) await this.deny('daily-cap', `${host} reached its daily cap`, { sensor: manifest.id, host });

    // robots.txt (N3)
    const robots = await this.robotsFor(host, manifest, endpoint);
    if (!robots) await this.deny('robots-unavailable', `${host}: robots.txt unavailable or host blocked; failing closed`, { sensor: manifest.id, host });
    if (!robotsAllows(robots, u.pathname + u.search)) await this.deny('robots-disallow', `${host}${u.pathname} disallowed by robots.txt`, { sensor: manifest.id, host, path: u.pathname });
    let intervalMs = endpoint.minIntervalMs;
    if (robots.crawlDelay !== null) {
      if (robots.crawlDelay > this.config.maxCrawlDelaySec) await this.deny('crawl-delay-too-large', `${host} asks for Crawl-delay ${robots.crawlDelay}s`, { sensor: manifest.id, host });
      intervalMs = Math.max(intervalMs, robots.crawlDelay * 1000);
    }

    // headers + auth (N6)
    const outHeaders = { 'user-agent': this.config.userAgent, accept: headers.accept || 'application/json, application/atom+xml, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.5' };
    for (const [k, v] of Object.entries(headers)) if (!STRIPPED_HEADERS.test(k)) outHeaders[k.toLowerCase()] = v;
    this._authLocation = null;
    if (auth || manifest.auth === 'token-required') {
      if (manifest.auth === 'none') await this.deny('auth-not-declared', `${manifest.id} did not declare an auth mode`, { sensor: manifest.id, host });
      const authorizedEnv = this.config.authorizedTokens[manifest.id];
      const authorized = authorizedEnv === manifest.tokenEnv;
      const value = authorized ? this.env[manifest.tokenEnv] : null;
      if (value && String(value).trim()) {
        outHeaders.authorization = `Bearer ${String(value).trim()}`;
        this._authLocation = manifest.tokenEnv;
      } else if (manifest.auth === 'token-required') {
        await this.deny(authorized ? 'token-missing' : 'auth-not-authorized', authorized ? `${manifest.id} requires ${manifest.tokenEnv} but it is not set` : `operator has not authorized ${manifest.id} to use ${manifest.tokenEnv} (config.policy.authorizedTokens)`, { sensor: manifest.id, host });
      } else if (!this._warnedAnon?.has(manifest.id)) {
        // token-optional without operator authorization: proceed anonymously, say so once per run
        (this._warnedAnon ??= new Set()).add(manifest.id);
        await this.emit('policy.warning', { code: authorized ? 'token-unset' : 'auth-not-authorized', sensor: manifest.id, message: `${manifest.id}: proceeding anonymously (${authorized ? manifest.tokenEnv + ' unset' : 'token not authorized in config.policy.authorizedTokens'})` });
      }
    }

    const res = await this.rawFetch(u.toString(), { method, host, intervalMs, maxBytes: endpoint.maxBytes, headers: outHeaders, sensor: manifest.id });
    this._authLocation = null;
    return {
      ok: res.ok, status: res.status, text: res.text, bytes: res.bytes, ms: res.ms, headers: res.headers, error: res.error,
      blocked: res.stop, json: () => JSON.parse(res.text),
    };
  }

  summary() {
    return { requests: this.runCounts.total, bySensor: Object.fromEntries(this.runCounts.bySensor), byHost: Object.fromEntries(this.runCounts.byHost), denials: this.denials.length, blocks: [...this.blocks.entries()].filter(([, b]) => b.until > this.now()).map(([h, b]) => ({ host: h, ...b })) };
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    if (Buffer.byteLength(t) > maxBytes) { const e = new Error('body too large'); e.code = 'BODY_TOO_LARGE'; throw e; }
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch {} const e = new Error('body too large'); e.code = 'BODY_TOO_LARGE'; throw e; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
