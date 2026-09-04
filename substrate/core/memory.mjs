// core/memory.mjs — the compounding long-term memory: a knowledge graph with
// signal time-series and corpus term statistics, as a pure projection of
// `observation.seen` events. Everything here is order-independent under the
// HLC total order and idempotent per observation dedup key.
import { Projection, mapToArr, arrToMap, setToArr, arrToSet } from './projections.mjs';
import { tokenize, HashEmbedder } from './embed.mjs';

export const DAY_MS = 86400000;
export const MAX_POINTS = 64;
export const BURST_HALF_LIFE_MS = 30 * DAY_MS;
const MAX_TEXT = 1200;

export const entityId = (type, key) => `${type}:${key}`;
export const splitId = (id) => { const i = id.indexOf(':'); return { type: id.slice(0, i), key: id.slice(i + 1) }; };

function newEntity(id) {
  const { type, key } = splitId(id);
  return { id, type, key, firstSeen: Infinity, lastSeen: 0, n: 0, text: '', textAt: -1, attrs: {}, attrsAt: -1, signals: new Map(), sensors: new Set() };
}

function addPoint(series, t, v) {
  if (!Number.isFinite(v) || !Number.isFinite(t)) return;
  series.n++;
  const pts = series.points;
  // binary search insert by t; equal t → overwrite (HLC order makes this deterministic)
  let lo = 0, hi = pts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid + 1; else hi = mid; }
  if (lo < pts.length && pts[lo][0] === t) pts[lo][1] = v;
  else pts.splice(lo, 0, [t, v]);
  if (pts.length > MAX_POINTS) pts.splice(1, pts.length - MAX_POINTS); // keep first + last (MAX-1)
}

export function seriesLatest(series) { return series && series.points.length ? series.points[series.points.length - 1] : null; }
export function seriesFirst(series) { return series && series.points.length ? series.points[0] : null; }

function upsertRelation(state, from, rel, to, t) {
  const rk = `${from}|${rel}|${to}`;
  let r = state.relations.get(rk);
  if (!r) {
    r = { from, rel, to, firstSeen: t, lastSeen: t, n: 0 };
    state.relations.set(rk, r);
    link(state.out, from, rel, to);
    link(state.in, to, rel, from);
  }
  r.n++;
  if (t < r.firstSeen) r.firstSeen = t;
  if (t > r.lastSeen) r.lastSeen = t;
}

function link(index, a, rel, b) {
  let m = index.get(a);
  if (!m) { m = new Map(); index.set(a, m); }
  let s = m.get(rel);
  if (!s) { s = new Set(); m.set(rel, s); }
  s.add(b);
}

function ensureEntity(state, id) {
  let e = state.entities.get(id);
  if (!e) {
    e = newEntity(id);
    state.entities.set(id, e);
    let s = state.byType.get(e.type);
    if (!s) { s = new Set(); state.byType.set(e.type, s); }
    s.add(id);
  }
  return e;
}

function updateTerms(terms, text, t) {
  const toks = new Set(tokenize(text));
  if (!toks.size) return;
  terms.docs++;
  const day = Math.floor(t / DAY_MS);
  for (const tok of toks) {
    terms.df.set(tok, (terms.df.get(tok) ?? 0) + 1);
    let b = terms.burst.get(tok);
    if (!b) { b = { first: day, days: [] }; terms.burst.set(tok, b); }
    if (day < b.first) b.first = day;
    const idx = b.days.findIndex((x) => x[0] === day);
    if (idx >= 0) b.days[idx][1]++;
    else {
      b.days.push([day, 1]);
      b.days.sort((x, y) => x[0] - y[0]);
      if (b.days.length > 10) b.days.splice(0, b.days.length - 10);
    }
  }
  if (terms.df.size > 300000) {
    for (const [tok, n] of terms.df) {
      if (n === 1 && (terms.burst.get(tok)?.first ?? 0) < day - 60) { terms.df.delete(tok); terms.burst.delete(tok); }
    }
  }
}

export const memoryProjection = new Projection({
  name: 'memory',
  version: 4,
  kinds: ['observation.seen', 'entity.embedded'],
  init: () => ({
    entities: new Map(), relations: new Map(), out: new Map(), in: new Map(), byType: new Map(),
    seen: new Set(), obsCount: 0, terms: { docs: 0, df: new Map(), burst: new Map() },
    minT: Infinity, maxT: 0, extVecs: new Map(), lastEventTs: 0,
  }),
  apply(state, ev) {
    if (ev.kind === 'entity.embedded') {
      const b = ev.body;
      if (b.entityId && Array.isArray(b.vec)) state.extVecs.set(b.entityId, { embedder: b.embedder, vec: Float32Array.from(b.vec) });
      return;
    }
    const b = ev.body;
    const key = ev.dedupKey ?? ev.id;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.obsCount++;
    state.lastEventTs = Math.max(state.lastEventTs, ev.ts);
    const t = Number.isFinite(b.observedAt) ? b.observedAt : ev.ts;
    if (t < state.minT) state.minT = t;
    if (t > state.maxT) state.maxT = t;
    const texts = [];
    for (const spec of b.entities ?? []) {
      if (!spec || !spec.type || spec.key === undefined || spec.key === null) continue;
      const e = ensureEntity(state, entityId(spec.type, String(spec.key)));
      e.n++;
      if (t < e.firstSeen) e.firstSeen = t;
      if (t > e.lastSeen) e.lastSeen = t;
      if (b.sensor) e.sensors.add(b.sensor);
      if (spec.text && t >= e.textAt) { e.text = String(spec.text).slice(0, MAX_TEXT); e.textAt = t; }
      if (spec.attrs && typeof spec.attrs === 'object' && t >= e.attrsAt) { e.attrs = { ...e.attrs, ...spec.attrs }; e.attrsAt = t; }
      if (spec.signals && typeof spec.signals === 'object') {
        for (const [name, v] of Object.entries(spec.signals)) {
          let s = e.signals.get(name);
          if (!s) { s = { n: 0, points: [] }; e.signals.set(name, s); }
          addPoint(s, t, Number(v));
        }
      }
      if (spec.text) texts.push(spec.text);
    }
    for (const r of b.relations ?? []) {
      if (!r || !r.from || !r.rel || !r.to) continue;
      ensureEntity(state, r.from);
      ensureEntity(state, r.to);
      upsertRelation(state, r.from, r.rel, r.to, t);
    }
    const text = b.text || texts.join(' ');
    if (text) updateTerms(state.terms, text, t);
  },
  dehydrate(s) {
    return {
      entities: mapToArr(s.entities, (e) => ({ ...e, signals: mapToArr(e.signals), sensors: setToArr(e.sensors) })),
      relations: mapToArr(s.relations),
      seen: setToArr(s.seen), obsCount: s.obsCount,
      terms: { docs: s.terms.docs, df: mapToArr(s.terms.df), burst: mapToArr(s.terms.burst, (b) => ({ first: b.first, days: b.days })) },
      minT: s.minT === Infinity ? null : s.minT, maxT: s.maxT, lastEventTs: s.lastEventTs,
      extVecs: mapToArr(s.extVecs, (v) => ({ embedder: v.embedder, vec: Array.from(v.vec) })),
    };
  },
  hydrate(j) {
    const state = memoryProjection.init();
    state.obsCount = j.obsCount;
    state.seen = arrToSet(j.seen);
    state.terms = { docs: j.terms.docs, df: arrToMap(j.terms.df), burst: arrToMap(j.terms.burst, (b) => ({ first: b.first, days: b.days.map((x) => [x[0], x[1]]) })) };
    state.minT = j.minT === null ? Infinity : j.minT;
    state.maxT = j.maxT;
    state.lastEventTs = j.lastEventTs ?? 0;
    state.extVecs = arrToMap(j.extVecs, (v) => ({ embedder: v.embedder, vec: Float32Array.from(v.vec) }));
    for (const [id, e] of j.entities) {
      const ent = { ...e, signals: arrToMap(e.signals), sensors: arrToSet(e.sensors) };
      state.entities.set(id, ent);
      let s = state.byType.get(ent.type);
      if (!s) { s = new Set(); state.byType.set(ent.type, s); }
      s.add(id);
    }
    for (const [rk, r] of j.relations) {
      state.relations.set(rk, r);
      link(state.out, r.from, r.rel, r.to);
      link(state.in, r.to, r.rel, r.from);
    }
    return state;
  },
});

// ---------------------------------------------------------------------------
// Query helpers used by the strategy interpreter and value functions.
// ---------------------------------------------------------------------------
export function neighbors(state, id, rel, dir = 'out') {
  const res = new Set();
  if (dir === 'out' || dir === 'both') for (const x of state.out.get(id)?.get(rel) ?? []) res.add(x);
  if (dir === 'in' || dir === 'both') for (const x of state.in.get(id)?.get(rel) ?? []) res.add(x);
  return res;
}
export function degree(state, id, rel = null, dir = 'both') {
  let d = 0;
  const count = (idx) => { const m = idx.get(id); if (!m) return; if (rel) d += m.get(rel)?.size ?? 0; else for (const s of m.values()) d += s.size; };
  if (dir === 'out' || dir === 'both') count(state.out);
  if (dir === 'in' || dir === 'both') count(state.in);
  return d;
}
export function latestSignal(e, name) {
  const p = seriesLatest(e.signals.get(name));
  return p ? p[1] : null;
}
export function relationRecord(state, from, rel, to) { return state.relations.get(`${from}|${rel}|${to}`) ?? null; }

/** IDF from corpus statistics: log((N+1)/(df+0.5)). */
export function idfOf(terms, tok) {
  return Math.log((terms.docs + 1) / ((terms.df.get(tok) ?? 0) + 0.5));
}
/** Mean IDF of an entity's tokens: high = rare vocabulary (surprisal proxy). */
export function surprisal(terms, text) {
  const toks = [...new Set(tokenize(text))];
  if (!toks.length) return 0;
  let s = 0;
  for (const t of toks) s += idfOf(terms, t);
  return s / toks.length;
}
/**
 * Burst score of the most "rising" established token in a text: recent daily
 * rate over historical daily rate (Kleinberg-style, discretised), mapped to
 * [0,1]. Needs corpus history, so it sharpens as memory accumulates.
 */
export function burstScore(terms, text, now, { window = 3, minDf = 5 } = {}) {
  const nowDay = Math.floor(now / DAY_MS);
  let best = 0;
  for (const tok of new Set(tokenize(text))) {
    const df = terms.df.get(tok) ?? 0;
    if (df < minDf) continue;
    const b = terms.burst.get(tok);
    if (!b || nowDay - b.first < window + 1) continue;
    let recent = 0;
    for (const [d, c] of b.days) if (d > nowDay - window) recent += c;
    const old = df - recent;
    const oldDays = Math.max(1, nowDay - b.first - window + 1);
    // +0.3/day smoothing on the historical rate: a token seen once long ago is not a burst
    const ratio = (recent / window) / (old / oldDays + 0.3);
    const score = Math.min(1, Math.log1p(ratio) / Math.log1p(20));
    if (score > best) best = score;
  }
  return best;
}

/** Per-run embedding cache over the memory (hash embedder + corpus IDF). */
export class MemoryVectors {
  constructor(state, embedder = new HashEmbedder()) {
    this.state = state;
    this.embedder = embedder;
    this.cache = new Map();
    this.idf = (tok) => Math.max(0.2, idfOf(state.terms, tok));
  }
  get(id) {
    const ext = this.state.extVecs.get(id);
    if (ext) return ext.vec;
    if (this.cache.has(id)) return this.cache.get(id);
    const e = this.state.entities.get(id);
    const v = e && e.text ? this.embedder.embed(e.text, this.idf) : null;
    this.cache.set(id, v);
    return v;
  }
  embedText(text) { return this.embedder.embed(text, this.idf); }
}

// ---------------------------------------------------------------------------
// Policy state projection (global: all domains): host blocks, poll timestamps,
// robots cache. This is the shared "pheromone" that stops every worker from
// touching a host that any worker was told to leave alone.
// ---------------------------------------------------------------------------
export const policyProjection = new Projection({
  name: 'policy-state',
  version: 2,
  kinds: ['source.polled', 'source.blocked', 'robots.fetched', 'task.claimed'],
  init: () => ({ blocks: new Map(), polls: new Map(), robots: new Map(), claims: new Map() }),
  apply(state, ev) {
    const b = ev.body;
    if (ev.kind === 'task.claimed') {
      const prev = state.claims.get(b.key);
      if (!prev || prev.until < b.until) state.claims.set(b.key, { node: b.node, until: b.until });
    } else if (ev.kind === 'source.blocked') {
      const prev = state.blocks.get(b.host);
      if (!prev || prev.until < b.until) state.blocks.set(b.host, { until: b.until, reason: b.reason, status: b.status ?? null });
    } else if (ev.kind === 'source.polled') {
      let arr = state.polls.get(b.host);
      if (!arr) { arr = []; state.polls.set(b.host, arr); }
      arr.push(ev.ts);
      if (arr.length > 4000) arr.splice(0, arr.length - 4000);
    } else if (ev.kind === 'robots.fetched') {
      const prev = state.robots.get(b.host);
      if (!prev || prev.fetchedAt < b.fetchedAt) state.robots.set(b.host, { text: b.text, fetchedAt: b.fetchedAt, status: b.status });
    }
  },
  dehydrate: (s) => ({ blocks: mapToArr(s.blocks), polls: mapToArr(s.polls), robots: mapToArr(s.robots), claims: mapToArr(s.claims) }),
  hydrate: (j) => ({ blocks: arrToMap(j.blocks), polls: arrToMap(j.polls), robots: arrToMap(j.robots), claims: arrToMap(j.claims) }),
});

export function dailyCountsFrom(policyState, now) {
  const m = new Map();
  for (const [host, arr] of policyState.polls) {
    let n = 0;
    for (let i = arr.length - 1; i >= 0 && arr[i] > now - DAY_MS; i--) n++;
    m.set(host, n);
  }
  return m;
}
