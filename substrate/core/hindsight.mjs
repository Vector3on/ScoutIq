// core/hindsight.mjs — the memory labels its own past with its own future (v4).
//
// v3 showed the remaining ceiling on the toy is an information limit, and
// that the one lever still responding was the operator's judgments — ten per
// heartbeat, each revealing item-level truth. This module makes labels cheap:
// an entity observed at time t is a PRECURSOR if the structures it belonged
// to grew afterwards — the pair of neighbours it bridged became a busy pair,
// the neighbour it linked became more active, its rare vocabulary became
// common, its own signals rose. Every component is schema-generic and is
// computed from the current memory's timestamps alone (relations carry
// firstSeen, series carry time, term bursts carry days), so no snapshot of
// the past is needed: the memory projection is already a temporal database.
//
// The components are not the label. A tiny label model — a Bayesian linear
// regression from components to operator judgments, trained on entities that
// have both — turns them into a calibrated value with a variance, so a
// hindsight label is evidence of known (lower) precision next to a judgment.
// The value model (core/valuemodel.mjs, v4 projection) folds thousands of
// such labels per run where it previously saw ten judgments.
import { DAY_MS, neighbors, relationRecord, seriesLatest } from './memory.mjs';
import { tokenize } from './embed.mjs';
import { LinearModel, featurize } from './attention.mjs';

const squash = (g) => 1 - Math.exp(-Math.max(0, g));   // growth (log-ratio) → [0,1)
const log1p = Math.log1p;
const MAX_NBR = 8;

/**
 * Growth components of entity `id` between `asOf` and `asOf + horizon`, read
 * from `memory` (the memory NOW, which must extend past asOf + horizon).
 * Returns { name: value ∈ [0,1] }. Names are schema-derived so the label
 * model can weight them.
 */
export function hindsightComponents(id, { memory, asOf, horizon, schema }) {
  const e = memory.entities.get(id);
  if (!e) return null;
  const end = asOf + horizon * DAY_MS;
  const comps = {};
  const rels = schema.relations.filter((r) => r.from === e.type || r.to === e.type);
  const edgeRec = (x, rel, dir, n) => (dir === 'out' ? relationRecord(memory, x, rel, n) : relationRecord(memory, n, rel, x));
  // neighbours as of asOf (edges that existed then), per relation
  const nbrAt = new Map();
  for (const r of rels) {
    const dir = r.from === e.type ? 'out' : 'in';
    const list = [];
    for (const n of neighbors(memory, id, r.rel, dir)) { const rec = edgeRec(id, r.rel, dir, n); if (rec && rec.firstSeen <= asOf) list.push(n); if (list.length >= MAX_NBR) break; }
    nbrAt.set(r.rel, { dir, list, nType: dir === 'out' ? r.to : r.from });
  }
  // 1. pair growth: entities of my type linked to both neighbours, before vs after
  for (let i = 0; i < rels.length; i++) for (let j = i; j < rels.length; j++) {
    const A = nbrAt.get(rels[i].rel), B = nbrAt.get(rels[j].rel);
    let best = 0, any = false;
    for (const a of A.list) for (const b of B.list) {
      if (a === b) continue;
      if (i === j && a > b) continue;
      const { before, after } = coCounts(memory, a, rels[i].rel, A.dir, b, rels[j].rel, B.dir, asOf, end);
      any = true;
      const g = log1p(after) - log1p(before);
      if (g > best) best = g;
    }
    if (any) comps[`pair:${rels[i].rel}×${rels[j].rel}`] = squash(best);
  }
  // 2. neighbour signal growth and 3. neighbour degree growth
  for (const r of rels) {
    const { dir, list, nType } = nbrAt.get(r.rel);
    if (!list.length) continue;
    for (const s of schema.signals) {
      if (s.type && s.type !== nType) continue;
      let best = null;
      for (const n of list) {
        const ne = memory.entities.get(n);
        const ser = ne?.signals.get(s.name);
        if (!ser) continue;
        const g = signalGrowth(ser.points, asOf, end);
        if (g !== null && (best === null || g > best)) best = g;
      }
      if (best !== null) comps[`sig:${r.rel}:${s.name}`] = squash(best);
    }
    let bestDeg = null;
    for (const n of list) {
      const { before, after } = degreeCounts(memory, n, r.rel, dir === 'out' ? 'in' : 'out', asOf, end);
      const g = log1p(after) - log1p(before);
      if (bestDeg === null || g > bestDeg) bestDeg = g;
    }
    if (bestDeg !== null) comps[`deg:${r.rel}`] = squash(bestDeg);
  }
  // 4. vocabulary: a token that was rare and became common (Kleinberg-style, in hindsight)
  if (e.text) {
    const asOfDay = Math.floor(asOf / DAY_MS), endDay = Math.floor(end / DAY_MS);
    let best = 0;
    for (const tok of new Set(tokenize(e.text))) {
      const b = memory.terms.burst.get(tok), df = memory.terms.df.get(tok) ?? 0;
      if (!b || df < 3) continue;
      let after = 0, tail = 0;
      for (const [d, c] of b.days) { if (d > asOfDay && d <= endDay) after += c; if (d > endDay) tail += c; }
      const priorDays = Math.max(1, asOfDay - b.first + 1);
      const priorRate = Math.max(0, df - after - tail) / priorDays;
      const ratio = (after / Math.max(1, endDay - asOfDay)) / (priorRate + 0.3);
      const g = Math.log1p(ratio) - Math.log1p(1);
      if (g > best) best = g;
    }
    comps.term = squash(best);
  }
  // 5. self growth: own degree and own signals
  {
    let before = 0, after = 0;
    for (const r of rels) {
      const dir = r.from === e.type ? 'out' : 'in';
      for (const n of neighbors(memory, id, r.rel, dir)) { const rec = edgeRec(id, r.rel, dir, n); if (!rec) continue; if (rec.firstSeen <= asOf) before++; if (rec.firstSeen <= end) after++; }
    }
    comps['self:deg'] = squash(log1p(after) - log1p(before));
    for (const s of schema.signals) {
      if (s.type && s.type !== e.type) continue;
      const ser = e.signals.get(s.name);
      if (!ser) continue;
      const g = signalGrowth(ser.points, asOf, end);
      if (g !== null) comps[`self:sig:${s.name}`] = squash(g);
    }
  }
  return comps;
}

function coCounts(memory, a, relA, dirA, b, relB, dirB, asOf, end) {
  const backA = dirA === 'out' ? 'in' : 'out', backB = dirB === 'out' ? 'in' : 'out';
  const A = neighbors(memory, a, relA, backA), B = neighbors(memory, b, relB, backB);
  const [small, large] = A.size < B.size ? [A, B] : [B, A];
  let before = 0, after = 0;
  for (const x of small) {
    if (!large.has(x)) continue;
    const ra = backA === 'in' ? relationRecord(memory, x, relA, a) : relationRecord(memory, a, relA, x);
    const rb = backB === 'in' ? relationRecord(memory, x, relB, b) : relationRecord(memory, b, relB, x);
    const t = Math.max(ra?.firstSeen ?? 0, rb?.firstSeen ?? 0);
    if (t <= asOf) before++;
    if (t <= end) after++;
  }
  return { before, after };
}

function degreeCounts(memory, n, rel, dir, asOf, end) {
  let before = 0, after = 0;
  for (const x of neighbors(memory, n, rel, dir)) {
    const rec = dir === 'out' ? relationRecord(memory, n, rel, x) : relationRecord(memory, x, rel, n);
    if (!rec) continue;
    if (rec.firstSeen <= asOf) before++;
    if (rec.firstSeen <= end) after++;
  }
  return { before, after };
}

/** log-ratio growth of a series: the max in (asOf, end] over the last value ≤ asOf. */
function signalGrowth(points, asOf, end) {
  let at = null, max = null;
  for (const [t, v] of points) {
    if (t <= asOf) at = v;
    else if (t <= end && (max === null || v > max)) max = v;
  }
  if (at === null || max === null) return null;
  return (max - at) / (Math.abs(at) + 1);
}

// ---------------------------------------------------------------------------
// The label model: components → value, calibrated by judgments.
//   label = prior(c) + wᵀφ(c),  prior(c) = 0.5 · max(c)
// Before any judgment pairs exist the prior alone is the label; every pair
// (components, judgment) tightens w. Predictive variance + residual variance
// give the label's precision as evidence for the value model.
// ---------------------------------------------------------------------------
export const LABEL_DIM = 64;
export const labelPrior = (comps) => 0.5 * Math.max(0, ...Object.values(comps ?? {}));
export const labelPhi = (comps) => featurize({ ...(comps ?? {}), max: Math.max(0, ...Object.values(comps ?? {})) }, LABEL_DIM);

export function makeLabelModel({ priorVar = 0.05, noiseVar = 0.04 } = {}) {
  return new LinearModel({ dim: LABEL_DIM, priorVar, noiseVar, forgetting: 1 });
}

/** Label with precision for a components vector. `residualVar` is the running |label − judgment|² on judged pairs. */
export function labelOf(model, comps, { residualVar = 0.09 } = {}) {
  const phi = labelPhi(comps);
  const mu = labelPrior(comps) + model.mean(phi);
  const variance = model.variance(phi) + residualVar;
  return { value: Math.max(0, Math.min(1, mu)), variance };
}

/** Rank correlation (for reports and the harness). */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - m) * (ry[i] - m); sxx += (rx[i] - m) ** 2; syy += (ry[i] - m) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
