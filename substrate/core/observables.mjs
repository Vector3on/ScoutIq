// core/observables.mjs — learned observables: a typed DSL of entity → scalar
// programs over memory, and the search that discovers which of them explain
// what the value model still gets wrong (v4; DESIGN.md §10).
//
// v3 found the value model FEATURE-BOUND: a linear model over the fixed
// feature set reaches ≈5 late true value with unlimited labels. The features
// were hand-picked once; here the substrate proposes its own "ways of
// measuring" — compositions of graph, temporal, signal, pair and text
// primitives — and adopts the ones whose bucketed output explains the
// residual of the current model on labelled rows, held out by batch, with a
// redundancy check against what is already adopted. Adopted observables are
// folded from the log (observable.adopted events) so every worker scores with
// the same feature space, and they are offered to the strategy grammar as
// filter ops and rankers (core/strategy.mjs), so the search space grows with
// what the substrate learned to measure.
//
// Everything here is pure and deterministic given (program, memory, now).
import { shortHash } from './events.mjs';
import { DAY_MS, neighbors, degree, surprisal, burstScore, seriesLatest, relationRecord } from './memory.mjs';

export const AGGS = ['min', 'max', 'mean'];
export const PAIR_STATS = ['coCount', 'coAge', 'coRecent', 'coRate'];
export const SIG_STATS = ['latest', 'delta', 'slope', 'first'];
export const OPS = ['add', 'sub', 'mul', 'div', 'max', 'min'];
export const DAYS = [1, 3, 7, 14, 30];
export const MAX_NODES = 6;
export const MAX_NBR = 8;   // neighbours considered per relation (deterministic: insertion order)
export const BINS = 5;

export const observableId = (prog) => 'o_' + shortHash(prog).slice(0, 12);

// ---------------------------------------------------------------------------
// Grammar helpers
// ---------------------------------------------------------------------------
function relsFrom(schema, type) { return schema.relations.filter((r) => r.from === type || r.to === type); }
function dirOf(r, type) { return r.from === type ? 'out' : 'in'; }
function nbrType(r, dir) { return dir === 'out' ? r.to : r.from; }
function signalsFor(schema, type) { return schema.signals.filter((s) => !s.type || s.type === type).map((s) => s.name); }

/** Number of nodes in a program (size pressure). */
export function programSize(p) {
  if (!p || typeof p !== 'object') return 0;
  let n = 1;
  if (p.inner) n += programSize(p.inner);
  if (p.a) n += programSize(p.a);
  if (p.b) n += programSize(p.b);
  return n;
}

/** The "shape" of a program: its primitives without parameters (a kind of observable). */
export function programShape(p) {
  if (!p) return '';
  const parts = [p.f];
  if (p.stat) parts.push(p.stat);
  if (p.agg) parts.push(p.agg);
  if (p.op) parts.push(p.op);
  const head = parts.join(':');
  if (p.inner) return `${head}(${programShape(p.inner)})`;
  if (p.a) return `${head}(${programShape(p.a)},${programShape(p.b)})`;
  return head;
}

export function describeProgram(p) {
  if (!p) return '?';
  switch (p.f) {
    case 'age': return 'age';
    case 'seen': return 'observations';
    case 'deg': return `degree(${p.rel},${p.dir})`;
    case 'recentDeg': return `edges(${p.rel},${p.dir},≤${p.days}d)`;
    case 'edgeAge': return `${p.agg} edge-age(${p.rel},${p.dir})`;
    case 'sig': return `${p.signal}.${p.stat}${p.days ? `(${p.days}d)` : ''}`;
    case 'sigPct': return `${p.signal}.pct`;
    case 'surprisal': return 'surprisal';
    case 'burst': return 'burst';
    case 'pair': return `${p.agg} pair.${p.stat}${p.days ? `(${p.days}d)` : ''}(${p.rel1}/${p.dir1} × ${p.rel2}/${p.dir2})`;
    case 'nbr': return `${p.agg} over ${p.rel}/${p.dir} of [${describeProgram(p.inner)}]`;
    case 'op': return `${p.op}(${describeProgram(p.a)}, ${describeProgram(p.b)})`;
    default: return p.f;
  }
}

/** A random leaf primitive for entities of `type`. */
export function randomLeaf(schema, type, rng) {
  const rels = relsFrom(schema, type), sigs = signalsFor(schema, type);
  const menu = ['age', 'seen', 'surprisal', 'burst'];
  if (rels.length) menu.push('deg', 'recentDeg', 'edgeAge', 'pair', 'pair');
  if (sigs.length) menu.push('sig', 'sigPct');
  const f = rng.pick(menu);
  switch (f) {
    case 'deg': { const r = rng.pick(rels); return { f, rel: r.rel, dir: dirOf(r, type) }; }
    case 'recentDeg': { const r = rng.pick(rels); return { f, rel: r.rel, dir: dirOf(r, type), days: rng.pick(DAYS) }; }
    case 'edgeAge': { const r = rng.pick(rels); return { f, rel: r.rel, dir: dirOf(r, type), agg: rng.pick(AGGS) }; }
    case 'sig': { const stat = rng.pick(SIG_STATS); return { f, signal: rng.pick(sigs), stat, ...(stat === 'delta' || stat === 'slope' ? { days: rng.pick(DAYS) } : {}) }; }
    case 'sigPct': return { f, signal: rng.pick(sigs) };
    case 'pair': {
      const r1 = rng.pick(rels), r2 = rng.pick(rels);
      const stat = rng.pick(PAIR_STATS);
      return { f, rel1: r1.rel, dir1: dirOf(r1, type), rel2: r2.rel, dir2: dirOf(r2, type), stat, agg: rng.pick(AGGS), ...(stat === 'coRecent' || stat === 'coRate' ? { days: rng.pick(DAYS) } : {}) };
    }
    default: return { f };
  }
}

/** A random program for entities of `type`, at most `depth` levels of composition. */
export function randomProgram(schema, type, rng, depth = 2) {
  const r = rng();
  const rels = relsFrom(schema, type);
  if (depth > 0 && r < 0.35 && rels.length) {
    const rel = rng.pick(rels), dir = dirOf(rel, type);
    return { f: 'nbr', rel: rel.rel, dir, agg: rng.pick(AGGS), inner: randomProgram(schema, nbrType(rel, dir), rng, depth - 1) };
  }
  if (depth > 0 && r < 0.5) {
    return { f: 'op', op: rng.pick(OPS), a: randomProgram(schema, type, rng, depth - 1), b: randomLeaf(schema, type, rng) };
  }
  return randomLeaf(schema, type, rng);
}

/** Structural mutation: replace a subtree, tweak a parameter, or wrap the program. */
export function mutateProgram(prog, schema, type, rng) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const g = JSON.parse(JSON.stringify(prog));
    const r = rng();
    let out;
    if (r < 0.3) out = replaceRandomSubtree(g, schema, type, rng);
    else if (r < 0.6) { tweakParam(g, rng); out = g; }
    else if (r < 0.8 && programSize(g) < MAX_NODES - 1) {
      const rels = relsFrom(schema, type);
      if (rels.length && rng() < 0.5) { const rel = rng.pick(rels), dir = dirOf(rel, type); const inner = randomProgram(schema, nbrType(rel, dir), rng, 1); out = { f: 'nbr', rel: rel.rel, dir, agg: rng.pick(AGGS), inner }; }
      else out = { f: 'op', op: rng.pick(OPS), a: g, b: randomLeaf(schema, type, rng) };
    } else out = g.inner ?? g.a ?? randomLeaf(schema, type, rng); // unwrap
    if (programSize(out) <= MAX_NODES && observableId(out) !== observableId(prog)) return out;
  }
  return randomProgram(schema, type, rng, 2);
}

function replaceRandomSubtree(g, schema, type, rng) {
  if (g.f === 'op' && rng() < 0.5) { if (rng() < 0.5) g.a = randomProgram(schema, type, rng, 1); else g.b = randomProgram(schema, type, rng, 1); return g; }
  if (g.f === 'nbr' && rng() < 0.6) { const r = schema.relations.find((x) => x.rel === g.rel); g.inner = randomProgram(schema, r ? nbrType(r, g.dir) : type, rng, 1); return g; }
  return randomProgram(schema, type, rng, 2);
}

function tweakParam(g, rng) {
  const nodes = [];
  const walk = (n) => { nodes.push(n); if (n.inner) walk(n.inner); if (n.a) walk(n.a); if (n.b) walk(n.b); };
  walk(g);
  const n = rng.pick(nodes);
  if ('days' in n) n.days = rng.pick(DAYS);
  else if ('agg' in n) n.agg = rng.pick(AGGS);
  else if ('op' in n) n.op = rng.pick(OPS);
  else if ('stat' in n && n.f === 'pair') n.stat = rng.pick(PAIR_STATS);
  else if ('stat' in n && n.f === 'sig') n.stat = rng.pick(SIG_STATS);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
const log1p = Math.log1p;
const aggregate = (vals, agg) => {
  const v = vals.filter((x) => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  if (agg === 'min') return Math.min(...v);
  if (agg === 'max') return Math.max(...v);
  return v.reduce((s, x) => s + x, 0) / v.length;
};

/**
 * An evaluation context over one memory state at one time. Caches per
 * (program, entity) and per neighbour pair; build one per heartbeat (or per
 * time-travel fold) and discard.
 */
export function makeObsContext({ memory, now, schema, degreeRanks = null, signalRanks = null }) {
  const memo = new Map();
  const pairCache = new Map();
  const nbrs = (id, rel, dir) => { const s = neighbors(memory, id, rel, dir); return s.size > MAX_NBR ? [...s].slice(0, MAX_NBR) : [...s]; };
  const edgeRecord = (id, rel, dir, n) => (dir === 'out' ? relationRecord(memory, id, rel, n) : relationRecord(memory, n, rel, id));

  function evalNode(p, id) {
    const e = memory.entities.get(id);
    if (!e) return null;
    switch (p.f) {
      case 'age': return log1p(Math.max(0, now - e.firstSeen) / DAY_MS);
      case 'seen': return log1p(e.n);
      case 'deg': return log1p(degree(memory, id, p.rel, p.dir));
      case 'recentDeg': { const t0 = now - p.days * DAY_MS; let c = 0; for (const n of neighbors(memory, id, p.rel, p.dir)) { const r = edgeRecord(id, p.rel, p.dir, n); if (r && r.firstSeen >= t0) c++; } return log1p(c); }
      case 'edgeAge': { const ages = []; for (const n of nbrs(id, p.rel, p.dir)) { const r = edgeRecord(id, p.rel, p.dir, n); if (r) ages.push(log1p(Math.max(0, now - r.firstSeen) / DAY_MS)); } return aggregate(ages, p.agg); }
      case 'sig': {
        const s = e.signals.get(p.signal);
        if (!s || !s.points.length) return null;
        const pts = s.points, last = pts[pts.length - 1];
        if (p.stat === 'latest') return last[1];
        if (p.stat === 'first') return pts[0][1];
        const t0 = now - (p.days ?? 7) * DAY_MS;
        let ref = null;
        for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] <= t0) { ref = pts[i]; break; }
        if (!ref) ref = pts[0];
        if (p.stat === 'delta') return (last[1] - ref[1]) / (Math.abs(ref[1]) + 1);
        const dt = Math.max(1, (last[0] - ref[0]) / DAY_MS);
        return (last[1] - ref[1]) / dt / (Math.abs(ref[1]) + 1);
      }
      case 'sigPct': { const pt = seriesLatest(e.signals.get(p.signal)); if (!pt) return null; return signalRanks ? signalRanks.percentile(e.type, p.signal, pt[1]) : pt[1]; }
      case 'surprisal': return e.text ? surprisal(memory.terms, e.text) : null;
      case 'burst': return e.text ? burstScore(memory.terms, e.text, now) : null;
      case 'pair': {
        const A = nbrs(id, p.rel1, p.dir1), B = nbrs(id, p.rel2, p.dir2);
        const vals = [];
        let count = 0;
        for (const a of A) for (const b of B) {
          if (a === b) continue;
          if (count++ >= 28) break;
          vals.push(pairStat(a, p.rel1, p.dir1, b, p.rel2, p.dir2, p.stat, p.days ?? 7));
        }
        return aggregate(vals, p.agg);
      }
      case 'nbr': { const vals = []; for (const n of nbrs(id, p.rel, p.dir)) vals.push(evalProgram(p.inner, n)); return aggregate(vals, p.agg); }
      case 'op': {
        const a = evalProgram(p.a, id), b = evalProgram(p.b, id);
        if (a === null || b === null) return null;
        switch (p.op) {
          case 'add': return a + b;
          case 'sub': return a - b;
          case 'mul': return a * b;
          case 'div': return a / (Math.abs(b) + 1);
          case 'max': return Math.max(a, b);
          default: return Math.min(a, b);
        }
      }
      default: return null;
    }
  }

  /** Statistic of the pair (a via rel1/dir1, b via rel2/dir2) over the entities linked to both. */
  function pairStat(a, rel1, dir1, b, rel2, dir2, stat, days) {
    const key = `${a}|${rel1}|${dir1}|${b}|${rel2}|${dir2}|${stat}|${days}`;
    let c = pairCache.get(key);
    if (c === undefined) {
      const back1 = dir1 === 'out' ? 'in' : 'out', back2 = dir2 === 'out' ? 'in' : 'out';
      const A = neighbors(memory, a, rel1, back1), B = neighbors(memory, b, rel2, back2);
      const [small, large] = A.size < B.size ? [A, B] : [B, A];
      let n = 0, recent = 0, first = Infinity;
      const t0 = now - days * DAY_MS;
      for (const x of small) {
        if (!large.has(x)) continue;
        n++;
        const ra = back1 === 'in' ? relationRecord(memory, x, rel1, a) : relationRecord(memory, a, rel1, x);
        const rb = back2 === 'in' ? relationRecord(memory, x, rel2, b) : relationRecord(memory, b, rel2, x);
        const t = Math.max(ra?.firstSeen ?? 0, rb?.firstSeen ?? 0);
        if (t >= t0) recent++;
        if (t < first) first = t;
      }
      c = { n, recent, first };
      pairCache.set(key, c);
    }
    if (stat === 'coCount') return log1p(c.n);
    if (stat === 'coAge') return c.n ? log1p(Math.max(0, now - c.first) / DAY_MS) : null;
    if (stat === 'coRecent') return c.n ? c.recent / c.n : null;
    return log1p(c.recent);
  }

  const ids = new WeakMap(); // program object → id (never written onto the program: bodies are hashed)
  const idOf = (p) => { let v = ids.get(p); if (!v) { v = observableId(p); ids.set(p, v); } return v; };
  function evalProgram(p, id) {
    const key = `${idOf(p)}|${id}`;
    if (memo.has(key)) return memo.get(key);
    let v;
    try { v = evalNode(p, id); } catch { v = null; }
    if (v !== null && !Number.isFinite(v)) v = null;
    memo.set(key, v);
    return v;
  }
  return { eval: evalProgram, memory, now, schema, degreeRanks, signalRanks };
}

/** Evaluate every program in `programs` ([{id, program}]) for an entity → { id: value|null }. */
export function evalAll(ctx, programs, entityId) {
  const out = {};
  for (const o of programs) out[o.id] = ctx.eval(o.program, entityId);
  return out;
}

// ---------------------------------------------------------------------------
// Bucketing (scale-free: quantiles of the population the observable was adopted on)
// ---------------------------------------------------------------------------
export function quantileEdges(values, bins = BINS) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < bins) return null;
  const edges = [];
  for (let i = 1; i < bins; i++) edges.push(v[Math.min(v.length - 1, Math.floor((i / bins) * v.length))]);
  return edges;
}
export function bucketOf(value, edges) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'na';
  let i = 0;
  while (i < edges.length && value >= edges[i]) i++;
  return `b${i}`;
}

// ---------------------------------------------------------------------------
// Fitness: how much of the residual a candidate explains, held out by batch.
//   rows: [{ obs: { id: value }, r: residual, batch }]
//   Two folds by batch parity: bin edges and bin means fitted on one parity,
//   sum of squared errors scored on the other. R²_cv = 1 − SSE_bins / SSE_mean.
// ---------------------------------------------------------------------------
export function candidateFitness(id, rows, { bins = BINS, minRows = 120 } = {}) {
  const have = rows.filter((row) => row.obs && row.obs[id] !== undefined && Number.isFinite(row.r));
  const batches = new Set(have.map((row) => row.batch));
  if (have.length < minRows || batches.size < 2) return { fitness: null, n: have.length, batches: batches.size };
  let sseBins = 0, sseMean = 0, scored = 0;
  for (const parity of [0, 1]) {
    const train = have.filter((row) => Math.abs(row.batch % 2) !== parity), test = have.filter((row) => Math.abs(row.batch % 2) === parity);
    if (train.length < 20 || test.length < 20) continue;
    const edges = quantileEdges(train.map((row) => row.obs[id]), bins) ?? [];
    const sum = new Map(), cnt = new Map();
    let total = 0;
    for (const row of train) { const b = bucketOf(row.obs[id], edges); sum.set(b, (sum.get(b) ?? 0) + row.r); cnt.set(b, (cnt.get(b) ?? 0) + 1); total += row.r; }
    const mean = total / train.length;
    for (const row of test) {
      const b = bucketOf(row.obs[id], edges);
      const n = cnt.get(b) ?? 0;
      // shrink bin means toward the global mean (5 pseudo-observations) to tame small bins
      const m = n ? (sum.get(b) + 5 * mean) / (n + 5) : mean;
      sseBins += (row.r - m) ** 2;
      sseMean += (row.r - mean) ** 2;
      scored++;
    }
  }
  if (!scored || sseMean <= 1e-12) return { fitness: null, n: have.length, batches: batches.size };
  return { fitness: 1 - sseBins / sseMean, n: have.length, batches: batches.size };
}

/** Spearman correlation between two observables over rows that carry both. */
export function obsCorrelation(idA, idB, rows) {
  const xs = [], ys = [];
  for (const row of rows) { const a = row.obs?.[idA], b = row.obs?.[idB]; if (a !== undefined && b !== undefined && a !== null && b !== null) { xs.push(a); ys.push(b); } }
  if (xs.length < 30) return 0;
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length, m = (n - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - m) * (ry[i] - m); sxx += (rx[i] - m) ** 2; syy += (ry[i] - m) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
