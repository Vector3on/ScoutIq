// core/phenotype.mjs — rich phenotype vectors for strategy runs (v3).
//
// The v2 archive describes a strategy's outputs with three hand-picked numbers
// (age, centrality, spread). That grid saturates. Here a strategy's phenotype is
// a ~30–40 dimensional vector computed from what it found — type mix, age and
// centrality histograms, semantic spread, value/novelty statistics, vocabulary
// statistics, per-relation connectivity, per-signal quantiles, and a fixed
// random projection of the outputs' embedding centroid — so behavior space can
// be learned (core/vq.mjs) instead of hand-picked (AURORA / VQ-Elites idea).
// Deterministic: same outputs + same memory → same vector.
import { makeRng } from './events.mjs';
import { DAY_MS, degree, surprisal, burstScore, seriesLatest } from './memory.mjs';
import { centroid, spread } from './embed.mjs';

const AGE_EDGES = [1, 7, 30];          // days → 4 bins
const CENT_EDGES = [0.25, 0.5, 0.75];  // percentile → 4 bins
export const EMBED_PROJ_DIMS = 8;

const projCache = new Map();
/** Fixed ±1 random projection (seeded) from an embedding dim to EMBED_PROJ_DIMS. */
function projection(dim) {
  if (projCache.has(dim)) return projCache.get(dim);
  const rng = makeRng(`phenotype-projection:${dim}`);
  const m = Array.from({ length: EMBED_PROJ_DIMS }, () => Float32Array.from({ length: dim }, () => (rng() < 0.5 ? -1 : 1)));
  projCache.set(dim, m);
  return m;
}

/** Per (type, signal) sorted latest values, for scale-free signal percentiles. */
export class SignalRanks {
  constructor(mem, signals) {
    this.sorted = new Map();
    for (const s of signals ?? []) {
      const types = s.type ? [s.type] : [...mem.byType.keys()];
      for (const t of types) {
        const arr = [];
        for (const id of mem.byType.get(t) ?? []) { const p = seriesLatest(mem.entities.get(id).signals.get(s.name)); if (p) arr.push(p[1]); }
        arr.sort((a, b) => a - b);
        this.sorted.set(`${t}|${s.name}`, arr);
      }
    }
  }
  percentile(type, name, v) {
    const arr = this.sorted.get(`${type}|${name}`);
    if (!arr || arr.length < 2) return 0.5;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    return Math.min(1, lo / (arr.length - 1));
  }
}

const hist = (values, edges) => {
  const h = new Array(edges.length + 1).fill(0);
  for (const v of values) { let i = 0; while (i < edges.length && v >= edges[i]) i++; h[i]++; }
  return values.length ? h.map((x) => x / values.length) : h;
};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/**
 * Phenotype of a strategy run.
 * items: [{ id }] (the top-k outputs); findings: [{ entityId, value, novelty }] aligned by entity id.
 */
export function phenotypeOf(items, { memory: mem, vectors, now, schema, degreeRanks, signalRanks, findings = [] }) {
  if (!items.length) return null;
  const labels = [];
  const vec = [];
  const push = (label, v) => { labels.push(label); vec.push(Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0); };
  const ents = items.map((it) => mem.entities.get(it.id)).filter(Boolean);
  if (!ents.length) return null;
  const n = ents.length;
  // type mix
  for (const t of schema.entityTypes) push(`type:${t}`, ents.filter((e) => e.type === t).length / n);
  // age + centrality histograms
  const ages = ents.map((e) => Math.max(0, now - e.firstSeen) / DAY_MS);
  for (const [i, v] of hist(ages, AGE_EDGES).entries()) push(`age:${i}`, v);
  const cents = ents.map((e) => degreeRanks.percentile(e.type, degree(mem, e.id)));
  for (const [i, v] of hist(cents, CENT_EDGES).entries()) push(`cent:${i}`, v);
  // semantic spread + value/novelty statistics
  const vecs = ents.map((e) => vectors.get(e.id)).filter(Boolean);
  push('spread', spread(vecs));
  const byId = new Map(findings.map((f) => [f.entityId, f]));
  const vals = ents.map((e) => byId.get(e.id)?.value ?? 0), novs = ents.map((e) => byId.get(e.id)?.novelty ?? 0);
  push('value:mean', 0.5 * mean(vals)); push('value:max', 0.5 * Math.max(0, ...vals));
  push('novelty:mean', 0.5 * mean(novs));
  // vocabulary statistics
  push('surprisal', 0.5 * Math.min(1, mean(ents.map((e) => surprisal(mem.terms, e.text))) / 8));
  push('burst', 0.5 * mean(ents.map((e) => burstScore(mem.terms, e.text, now))));
  // per-relation connectivity (log-scaled)
  for (const r of schema.relations) push(`rel:${r.rel}`, 0.7 * mean(ents.map((e) => Math.min(1, Math.log1p(degree(mem, e.id, r.rel, 'both')) / Math.log(50)))));
  // per-signal percentiles
  for (const s of schema.signals) {
    const ps = ents.filter((e) => e.signals.has(s.name)).map((e) => signalRanks.percentile(e.type, s.name, seriesLatest(e.signals.get(s.name))[1]));
    push(`sig:${s.name}`, ps.length ? 0.7 * mean(ps) : 0);
  }
  // embedding centroid, randomly projected
  const c = vecs.length ? centroid(vecs, vecs[0].length) : null;
  const P = c ? projection(c.length) : null;
  for (let i = 0; i < EMBED_PROJ_DIMS; i++) {
    let s = 0;
    if (c) for (let j = 0; j < c.length; j++) s += P[i][j] * c[j];
    push(`emb:${i}`, c ? 0.35 * Math.max(-1, Math.min(1, s / Math.sqrt(c.length) * 4)) : 0);
  }
  return { vec: vec.map((x) => Number(x.toFixed(4))), labels, dim: vec.length };
}

export function euclid(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
