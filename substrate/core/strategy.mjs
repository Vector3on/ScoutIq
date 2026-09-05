// core/strategy.mjs — strategies as evolvable programs.
//
// A strategy is a tiny typed pipeline over the memory graph: a SEED (which
// entities to start from), up to four PIPE ops (graph, signal, text and
// embedding operators), and a RANKER. It is a genome for genetic programming:
// mutation and crossover are structural, parameters live on small menus, and
// every genome is valid for the plug-in's declared schema by construction.
// The interpreter is pure: same genome + same memory + same `now` → same output.
import { shortHash } from './events.mjs';
import { DAY_MS, neighbors, degree, latestSignal, surprisal, burstScore, seriesLatest } from './memory.mjs';
import { cosine, centroid, spread } from './embed.mjs';

export const MENUS = Object.freeze({
  days: [1, 3, 7, 14, 30, 90, 365],
  q: [0.5, 0.7, 0.8, 0.9, 0.95],
  n: [20, 50, 100, 200],
  priorDays: [3, 7, 14, 30, 90],
  recentDays: [1, 3, 7, 14],
  mode: ['emerging', 'rare'],
});
export const SEED_OPS = ['recent', 'all', 'stale', 'top'];
export const PIPE_OPS = ['expand', 'filterSignal', 'filterAge', 'filterDegree', 'bridge', 'newcomer', 'accelerating', 'silent', 'outlier', 'rareTerms', 'rising', 'viaNewEdge', 'limit'];
// v4: a schema may carry `observables: [{ id, type }]` — discovered ways of measuring (core/observables.mjs) —
// which the grammar offers as a filter op (`obsFilter`) and a ranker (`obs`). Without them the grammar is v2's.
export const OBS_OP = 'obsFilter';
const obsFor = (schema, type) => (schema.observables ?? []).filter((o) => !o.type || o.type === type);
export const RANKERS = ['value', 'surprisal', 'burst', 'recency', 'degree', 'signal', 'age', 'mixed'];
export const MAX_PIPE = 4;
export const MAX_SET = 5000;

export const genomeId = (g) => shortHash(g).slice(0, 16);
export const genomeSize = (g) => 1 + (g.pipe?.length ?? 0);

// ---------------------------------------------------------------------------
// Generation & variation
// ---------------------------------------------------------------------------
function relsFor(schema, type = null) {
  return schema.relations.filter((r) => !type || r.from === type || r.to === type);
}
function signalsFor(schema, type) {
  return schema.signals.filter((s) => !s.type || s.type === type).map((s) => s.name);
}
function pickType(schema, rng) {
  if (schema.primaryType && rng() < 0.6) return schema.primaryType;
  return rng.pick(schema.entityTypes);
}

export function randomSeed(schema, rng) {
  const type = pickType(schema, rng);
  const op = rng.pick(SEED_OPS);
  if (op === 'recent') return { op, type, days: rng.pick(MENUS.days) };
  if (op === 'stale') return { op, type, minDays: rng.pick(MENUS.days.slice(2)), maxDays: 365 };
  if (op === 'top') {
    const sigs = signalsFor(schema, type);
    if (!sigs.length) return { op: 'recent', type, days: rng.pick(MENUS.days) };
    return { op, type, signal: rng.pick(sigs), n: rng.pick(MENUS.n) };
  }
  return { op: 'all', type };
}

export function randomOp(schema, rng, currentType) {
  const obs = obsFor(schema, currentType);
  if (obs.length && rng() < 0.25) return { op: OBS_OP, id: rng.pick(obs).id, cmp: rng() < 0.7 ? 'gt' : 'lt', q: rng.pick(MENUS.q) };
  const op = rng.pick(PIPE_OPS);
  const rels = relsFor(schema, currentType);
  const sigs = signalsFor(schema, currentType);
  switch (op) {
    case 'expand': case 'viaNewEdge': case 'filterDegree': case 'bridge': case 'newcomer': {
      if (!rels.length) return { op: 'limit', n: rng.pick(MENUS.n) };
      const r = rng.pick(rels);
      const dir = r.from === currentType ? 'out' : 'in';
      if (op === 'expand') return { op, rel: r.rel, dir, keepSeed: rng() < 0.3 };
      if (op === 'viaNewEdge') return { op, rel: r.rel, dir, days: rng.pick(MENUS.recentDays) };
      if (op === 'filterDegree') return { op, rel: r.rel, dir, cmp: rng() < 0.6 ? 'gt' : 'lt', q: rng.pick(MENUS.q) };
      if (op === 'bridge') return { op, rel: r.rel, dir, mode: rng.pick(MENUS.mode), days: rng.pick(MENUS.recentDays), q: rng.pick(MENUS.q) };
      return { op, rel: r.rel, dir, recentDays: rng.pick(MENUS.recentDays), priorDays: rng.pick(MENUS.priorDays) };
    }
    case 'filterSignal': case 'accelerating': {
      if (!sigs.length) return { op: 'rareTerms', q: rng.pick(MENUS.q) };
      if (op === 'filterSignal') return { op, signal: rng.pick(sigs), cmp: rng() < 0.6 ? 'gt' : 'lt', q: rng.pick(MENUS.q) };
      return { op, signal: rng.pick(sigs), q: rng.pick(MENUS.q) };
    }
    case 'filterAge': return { op, cmp: rng() < 0.5 ? 'older' : 'younger', days: rng.pick(MENUS.days) };
    case 'silent': return { op, days: rng.pick(MENUS.days.slice(1)) };
    case 'outlier': case 'rareTerms': case 'rising': return { op, q: rng.pick(MENUS.q) };
    case 'limit': return { op, n: rng.pick(MENUS.n) };
    default: return { op: 'limit', n: 100 };
  }
}

export function randomRanker(schema, rng, type) {
  const obs = obsFor(schema, type);
  if (obs.length && rng() < 0.2) return { by: 'obs', id: rng.pick(obs).id };
  const by = rng.pick(RANKERS);
  if (by === 'signal') {
    const sigs = signalsFor(schema, type);
    if (!sigs.length) return { by: 'value' };
    return { by, signal: rng.pick(sigs) };
  }
  return { by };
}

/** Type of the working set after the pipe (expand/viaNewEdge move across a relation). */
export function typeAfter(schema, genome) {
  let type = genome.seed.type;
  for (const op of genome.pipe) {
    if (op.op === 'expand' || op.op === 'viaNewEdge') {
      const r = schema.relations.find((x) => x.rel === op.rel);
      if (r) type = op.dir === 'out' ? r.to : r.from;
      if (op.keepSeed) type = null; // mixed
    }
  }
  return type;
}

export function randomGenome(schema, rng) {
  const seed = randomSeed(schema, rng);
  const pipe = [];
  const len = rng.int(4); // 0..3
  let type = seed.type;
  for (let i = 0; i < len; i++) {
    const op = randomOp(schema, rng, type ?? seed.type);
    pipe.push(op);
    if (op.op === 'expand' || op.op === 'viaNewEdge') {
      const r = schema.relations.find((x) => x.rel === op.rel);
      if (r) type = op.dir === 'out' ? r.to : r.from;
    }
  }
  return normalizeGenome({ seed, pipe, rank: randomRanker(schema, rng, type ?? seed.type) });
}

export function normalizeGenome(g) {
  const seed = { ...g.seed };
  const pipe = (g.pipe ?? []).slice(0, MAX_PIPE).map((op) => ({ ...op }));
  const rank = { ...(g.rank ?? { by: 'value' }) };
  return { seed, pipe, rank };
}

export function mutate(genome, schema, rng) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const g = normalizeGenome(genome);
    const r = rng();
    const type = typeAfter(schema, g) ?? g.seed.type;
    if (r < 0.25) g.seed = randomSeed(schema, rng);
    else if (r < 0.45 && g.pipe.length) g.pipe[rng.int(g.pipe.length)] = randomOp(schema, rng, type);
    else if (r < 0.6 && g.pipe.length < MAX_PIPE) g.pipe.splice(rng.int(g.pipe.length + 1), 0, randomOp(schema, rng, type));
    else if (r < 0.75 && g.pipe.length) g.pipe.splice(rng.int(g.pipe.length), 1);
    else if (r < 0.9) tweak(g, rng);
    else g.rank = randomRanker(schema, rng, type);
    if (genomeId(g) !== genomeId(genome)) return g;
  }
  return randomGenome(schema, rng);
}

function tweak(g, rng) {
  const targets = [g.seed, ...g.pipe, g.rank];
  const t = rng.pick(targets);
  for (const [k, menu] of Object.entries(MENUS)) {
    if (k in t) { t[k] = rng.pick(menu); return; }
  }
  if ('days' in t) t.days = rng.pick(MENUS.days);
  if ('q' in t) t.q = rng.pick(MENUS.q);
  if ('n' in t) t.n = rng.pick(MENUS.n);
  if ('minDays' in t) t.minDays = rng.pick(MENUS.days.slice(2));
  if ('cmp' in t) t.cmp = t.cmp === 'gt' ? 'lt' : t.cmp === 'lt' ? 'gt' : t.cmp === 'older' ? 'younger' : 'older';
}

export function crossover(a, b, rng) {
  const i = rng.int(a.pipe.length + 1);
  const j = rng.int(b.pipe.length + 1);
  return normalizeGenome({ seed: a.seed, pipe: [...a.pipe.slice(0, i), ...b.pipe.slice(j)].slice(0, MAX_PIPE), rank: rng() < 0.5 ? a.rank : b.rank });
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------
const quantile = (values, q) => {
  if (!values.length) return 0;
  const s = values.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

function capSet(mem, ids) {
  if (ids.length <= MAX_SET) return ids;
  return ids.map((id) => [id, mem.entities.get(id)?.lastSeen ?? 0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_SET).map((x) => x[0]);
}

function seedSet(mem, seed, now) {
  const ids = [...(mem.byType.get(seed.type) ?? [])];
  if (seed.op === 'all') return ids;
  if (seed.op === 'recent') { const t0 = now - seed.days * DAY_MS; return ids.filter((id) => mem.entities.get(id).lastSeen >= t0); }
  if (seed.op === 'stale') {
    const hi = now - seed.minDays * DAY_MS, lo = now - (seed.maxDays ?? 365) * DAY_MS;
    return ids.filter((id) => { const e = mem.entities.get(id); return e.lastSeen <= hi && e.lastSeen >= lo; });
  }
  if (seed.op === 'top') {
    return ids.map((id) => [id, latestSignal(mem.entities.get(id), seed.signal)]).filter((x) => x[1] !== null).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, seed.n).map((x) => x[0]);
  }
  return ids;
}

/**
 * Bridge score of an entity over a relation, looking at pairs of its
 * rel-neighbours (e.g. the two categories a paper sits in).
 *   mode 'rare'     : −log P(pair | degrees) — the pair is rarely combined.
 *   mode 'emerging' : recentFraction × log1p(recentCount) — the pair's
 *                     co-linking is new and growing (needs history in memory).
 */
export function bridgeScore(mem, id, rel, dir, { mode = 'emerging', days = 7, now = 0, pairCache = new Map() } = {}) {
  const nbrs = [...neighbors(mem, id, rel, dir)];
  if (nbrs.length < 2) return { score: 0, pair: null };
  const back = dir === 'out' ? 'in' : 'out';
  const t0 = now - days * DAY_MS;
  let best = 0, bestPair = null;
  for (let i = 0; i < nbrs.length && i < 12; i++) {
    for (let j = i + 1; j < nbrs.length && j < 12; j++) {
      const a = nbrs[i] < nbrs[j] ? nbrs[i] : nbrs[j], b = nbrs[i] < nbrs[j] ? nbrs[j] : nbrs[i];
      const key = `${mode}|${days}|${a}|${b}`;
      let c = pairCache.get(key);
      if (c === undefined) {
        const A = neighbors(mem, a, rel, back), B = neighbors(mem, b, rel, back);
        let n = 0, recent = 0;
        const [small, large] = A.size < B.size ? [A, B] : [B, A];
        for (const x of small) if (large.has(x)) {
          n++;
          const ra = back === 'in' ? mem.relations.get(`${x}|${rel}|${a}`) : mem.relations.get(`${a}|${rel}|${x}`);
          const rb = back === 'in' ? mem.relations.get(`${x}|${rel}|${b}`) : mem.relations.get(`${b}|${rel}|${x}`);
          if (Math.max(ra?.firstSeen ?? 0, rb?.firstSeen ?? 0) >= t0) recent++;
        }
        c = { n, recent, da: A.size, db: B.size };
        pairCache.set(key, c);
      }
      let s;
      if (mode === 'rare') s = -Math.log((c.n + 0.5) / (Math.min(c.da, c.db) + 1));
      else s = (c.recent / Math.max(1, c.n)) * Math.log1p(c.recent);
      if (s > best) { best = s; bestPair = [a, b]; }
    }
  }
  return { score: Math.max(0, best), pair: bestPair };
}

function accelScore(series) {
  const pts = series?.points;
  if (!pts || pts.length < 3) return null;
  const n = pts.length;
  const [t0, v0] = pts[0], [t1, v1] = pts[Math.floor((n - 1) / 2)], [t2, v2] = pts[n - 1];
  if (t2 === t0 || t1 === t0 || t2 === t1) return null;
  const s1 = (v1 - v0) / Math.max(1, (t1 - t0) / DAY_MS), s2 = (v2 - v1) / Math.max(1, (t2 - t1) / DAY_MS);
  return (s2 - s1) / (Math.abs(v2) + Math.abs(v0) + 1);
}

/**
 * Run a genome. ctx = { memory, vectors, now, value(id) → [0,1], k }.
 * Returns { items: [{ id, score, rationale: [] }], trace: [sizes], size }.
 */
export function runStrategy(genome, ctx) {
  const { memory: mem, vectors, now } = ctx;
  const k = ctx.k ?? 10;
  const g = normalizeGenome(genome);
  const why = new Map();
  const say = (id, s) => { let a = why.get(id); if (!a) { a = []; why.set(id, a); } if (a.length < 6) a.push(s); };
  let set = capSet(mem, seedSet(mem, g.seed, now));
  const trace = [set.length];
  const pairCache = new Map();
  for (const op of g.pipe) {
    if (!set.length) break;
    switch (op.op) {
      case 'expand': {
        const next = new Set(op.keepSeed ? set : []);
        for (const id of set) for (const n of neighbors(mem, id, op.rel, op.dir)) { next.add(n); say(n, `reached via ${op.rel}`); }
        set = capSet(mem, [...next]);
        break;
      }
      case 'viaNewEdge': {
        const t0 = now - op.days * DAY_MS;
        const next = new Set();
        for (const id of set) {
          for (const n of neighbors(mem, id, op.rel, op.dir)) {
            const r = op.dir === 'out' ? mem.relations.get(`${id}|${op.rel}|${n}`) : mem.relations.get(`${n}|${op.rel}|${id}`);
            if (r && r.firstSeen >= t0) { next.add(n); say(n, `new ${op.rel} link within ${op.days}d`); }
          }
        }
        set = capSet(mem, [...next]);
        break;
      }
      case 'filterSignal': {
        const vals = set.map((id) => [id, latestSignal(mem.entities.get(id), op.signal)]).filter((x) => x[1] !== null);
        const thr = quantile(vals.map((x) => x[1]), op.q);
        set = vals.filter((x) => (op.cmp === 'gt' ? x[1] >= thr : x[1] <= thr)).map((x) => { say(x[0], `${op.signal} ${op.cmp === 'gt' ? '≥' : '≤'} q${op.q} (${fmt(x[1])})`); return x[0]; });
        break;
      }
      case 'filterAge': {
        const t0 = now - op.days * DAY_MS;
        set = set.filter((id) => { const e = mem.entities.get(id); const keep = op.cmp === 'older' ? e.firstSeen <= t0 : e.firstSeen >= t0; if (keep) say(id, `${op.cmp} than ${op.days}d`); return keep; });
        break;
      }
      case 'filterDegree': {
        const vals = set.map((id) => [id, degree(mem, id, op.rel, op.dir)]);
        const thr = quantile(vals.map((x) => x[1]), op.q);
        set = vals.filter((x) => (op.cmp === 'gt' ? x[1] >= thr : x[1] <= thr)).map((x) => { say(x[0], `${op.rel} degree ${x[1]} (${op.cmp} q${op.q})`); return x[0]; });
        break;
      }
      case 'bridge': {
        const mode = op.mode ?? 'emerging', days = op.days ?? 7;
        const vals = set.map((id) => [id, bridgeScore(mem, id, op.rel, op.dir, { mode, days, now, pairCache })]).filter((x) => x[1].score > 0);
        const thr = quantile(vals.map((x) => x[1].score), op.q);
        set = vals.filter((x) => x[1].score >= thr && x[1].score > 0).map((x) => { say(x[0], `bridges ${mode === 'rare' ? 'rarely-combined' : 'newly co-occurring'} ${op.rel} targets ${x[1].pair.map(shortName).join(' ↔ ')} (${mode} ${x[1].score.toFixed(2)})`); return x[0]; });
        break;
      }
      case 'newcomer': {
        const tRecent = now - op.recentDays * DAY_MS, tPrior = now - op.priorDays * DAY_MS;
        set = set.filter((id) => {
          const e = mem.entities.get(id);
          if (e.firstSeen > tPrior) return false;
          for (const n of neighbors(mem, id, op.rel, op.dir)) {
            const r = op.dir === 'out' ? mem.relations.get(`${id}|${op.rel}|${n}`) : mem.relations.get(`${n}|${op.rel}|${id}`);
            if (r && r.firstSeen >= tRecent) { say(id, `established ${Math.round((now - e.firstSeen) / DAY_MS)}d, new ${op.rel} link to ${shortName(n)}`); return true; }
          }
          return false;
        });
        break;
      }
      case 'accelerating': {
        const vals = set.map((id) => [id, accelScore(mem.entities.get(id).signals.get(op.signal))]).filter((x) => x[1] !== null && x[1] > 0);
        const thr = quantile(vals.map((x) => x[1]), op.q);
        set = vals.filter((x) => x[1] >= thr).map((x) => { say(x[0], `${op.signal} accelerating (${x[1].toFixed(3)})`); return x[0]; });
        break;
      }
      case 'silent': {
        const t0 = now - op.days * DAY_MS;
        set = set.filter((id) => { const e = mem.entities.get(id); const keep = e.n >= 2 && e.lastSeen <= t0; if (keep) say(id, `silent for ${Math.round((now - e.lastSeen) / DAY_MS)}d after ${e.n} observations`); return keep; });
        break;
      }
      case 'outlier': {
        const vecs = set.map((id) => [id, vectors.get(id)]).filter((x) => x[1]);
        const c = centroid(vecs.map((x) => x[1]), vectors.dim ?? vectors.embedder.dim);
        if (!c) { set = []; break; }
        const vals = vecs.map(([id, v]) => [id, 1 - cosine(v, c)]);
        const thr = quantile(vals.map((x) => x[1]), op.q);
        set = vals.filter((x) => x[1] >= thr).map((x) => { say(x[0], `semantic outlier (dist ${x[1].toFixed(2)})`); return x[0]; });
        break;
      }
      case 'rareTerms': {
        const vals = set.map((id) => [id, surprisal(mem.terms, mem.entities.get(id).text)]).filter((x) => x[1] > 0);
        const thr = quantile(vals.map((x) => x[1]), op.q);
        set = vals.filter((x) => x[1] >= thr).map((x) => { say(x[0], `rare vocabulary (surprisal ${x[1].toFixed(2)})`); return x[0]; });
        break;
      }
      case 'rising': {
        const vals = set.map((id) => [id, burstScore(mem.terms, mem.entities.get(id).text, now)]).filter((x) => x[1] > 0);
        const thr = quantile(vals.map((x) => x[1]), op.q);
        set = vals.filter((x) => x[1] >= thr).map((x) => { say(x[0], `contains rising terms (burst ${x[1].toFixed(2)})`); return x[0]; });
        break;
      }
      case 'limit': set = set.slice(0, op.n); break;
      case OBS_OP: {
        if (!ctx.obs) break; // an observable this worker cannot evaluate (retired, or no context): the op is a no-op
        const vals = set.map((id) => [id, ctx.obs(op.id, id)]).filter((x) => x[1] !== null && x[1] !== undefined && Number.isFinite(x[1]));
        if (!vals.length) break;
        const thr = quantile(vals.map((x) => x[1]), op.q);
        set = vals.filter((x) => (op.cmp === 'gt' ? x[1] >= thr : x[1] <= thr)).map((x) => { say(x[0], `${ctx.obsName?.(op.id) ?? op.id} ${op.cmp === 'gt' ? '≥' : '≤'} q${op.q} (${fmt(x[1])})`); return x[0]; });
        break;
      }
      default: break;
    }
    trace.push(set.length);
  }
  // rank — only entities the archive does not already consider delivered compete for the k slots
  if (ctx.isNovel) set = set.filter((id) => ctx.isNovel(id));
  if (ctx.accept) set = set.filter((id) => ctx.accept(id)); // v3: optional region filter (frontier challenges)
  const scoreOf = (id) => {
    const e = mem.entities.get(id);
    switch (g.rank.by) {
      case 'value': return ctx.value(id);
      case 'surprisal': return surprisal(mem.terms, e.text);
      case 'burst': return burstScore(mem.terms, e.text, now);
      case 'recency': return -(now - e.lastSeen) / DAY_MS;
      case 'age': return (now - e.firstSeen) / DAY_MS;
      case 'degree': return degree(mem, id);
      case 'signal': return latestSignal(e, g.rank.signal) ?? -Infinity;
      case 'obs': { const v = ctx.obs ? ctx.obs(g.rank.id, id) : null; return v === null || v === undefined ? ctx.value(id) : v; }
      case 'mixed': return 0.5 * ctx.value(id) + 0.3 * Math.min(1, surprisal(mem.terms, e.text) / 8) + 0.2 * Math.min(1, burstScore(mem.terms, e.text, now));
      default: return ctx.value(id);
    }
  };
  const ranked = set.map((id) => [id, scoreOf(id)]).filter((x) => Number.isFinite(x[1])).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k);
  return { items: ranked.map(([id, s]) => ({ id, rankScore: s, rationale: why.get(id) ?? [] })), trace, size: genomeSize(g) };
}

const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toString() : Number(v).toFixed(2));
export const shortName = (id) => { const i = id.indexOf(':'); const key = id.slice(i + 1); return key.length > 28 ? key.slice(0, 26) + '…' : key; };

// ---------------------------------------------------------------------------
// Behavior descriptor (phenotype, not genotype): where in "finding space" the
// strategy's outputs live. Three dims in [0,1]: age, centrality, spread.
// ---------------------------------------------------------------------------
export function describeBehavior(items, ctx, degreeRanks) {
  const { memory: mem, vectors, now } = ctx;
  if (!items.length) return null;
  const ages = [], cents = [], vecs = [];
  for (const it of items) {
    const e = mem.entities.get(it.id);
    if (!e) continue;
    ages.push(Math.max(0, Math.min(1, Math.log1p(Math.max(0, now - e.firstSeen) / DAY_MS) / Math.log1p(365))));
    cents.push(degreeRanks.percentile(e.type, degree(mem, it.id)));
    const v = vectors.get(it.id);
    if (v) vecs.push(v);
  }
  if (!ages.length) return null;
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
  return { age: median(ages), centrality: median(cents), spread: spread(vecs) };
}

export function cellOf(bd, bins) {
  if (!bd) return null;
  const c = (x) => Math.min(bins - 1, Math.max(0, Math.floor(x * bins)));
  return `${c(bd.age)}-${c(bd.centrality)}-${c(bd.spread)}`;
}

/** Precomputed degree percentiles per entity type (for the centrality dim). */
export class DegreeRanks {
  constructor(mem) {
    this.sorted = new Map();
    for (const [type, ids] of mem.byType) {
      const arr = [];
      for (const id of ids) arr.push(degree(mem, id));
      arr.sort((a, b) => a - b);
      this.sorted.set(type, arr);
    }
  }
  percentile(type, d) {
    const arr = this.sorted.get(type);
    if (!arr || !arr.length) return 0.5;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < d) lo = mid + 1; else hi = mid; }
    return arr.length === 1 ? 0.5 : lo / (arr.length - 1);
  }
}

/** Schema-driven starting points for an empty archive (simple, then non-obvious). */
export function canonicalGenomes(schema) {
  const T = schema.primaryType ?? schema.entityTypes[0];
  const out = [
    { seed: { op: 'recent', type: T, days: 3 }, pipe: [], rank: { by: 'value' } },
    { seed: { op: 'recent', type: T, days: 14 }, pipe: [{ op: 'rareTerms', q: 0.7 }], rank: { by: 'mixed' } },
    { seed: { op: 'all', type: T }, pipe: [], rank: { by: 'value' } },
  ];
  const rel = schema.relations.find((r) => r.from === T);
  if (rel) out.push({ seed: { op: 'recent', type: T, days: 7 }, pipe: [{ op: 'bridge', rel: rel.rel, dir: 'out', mode: 'emerging', days: 7, q: 0.5 }], rank: { by: 'value' } });
  return out.map(normalizeGenome);
}

/** v3: apply `strength` independent mutations (temperature interventions). */
export function mutateStrong(genome, schema, rng, strength = 1) {
  let g = genome;
  for (let i = 0; i < Math.max(1, strength); i++) g = mutate(g, schema, rng);
  return g;
}
