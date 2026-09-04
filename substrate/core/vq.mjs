// core/vq.mjs — a learned behavior space: vector-quantized elites (v3).
//
// The archive's cells are codebook vectors in phenotype space, created on
// demand: a phenotype farther than `tau` from every centroid founds a new cell
// (up to `kmax`, after which tau widens), otherwise it competes for the elite
// of its nearest cell. Centroids drift slowly toward their members; every
// `reassignEvery` evaluations the elites are re-encoded and dominated ones
// dropped (AURORA-style re-encoding). Curiosity per cell as in core/qd.mjs.
//
// Pure fold over `strategy.phenotype` events; the v2 grid archive (core/qd.mjs)
// is untouched and keeps folding `strategy.evaluated` as the baseline.
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { genomeSize } from './strategy.mjs';
import { euclid } from './phenotype.mjs';

export const vqCellId = (idx) => `vq:${idx}`;

export function makeVqProjection({ tau = 0.45, kmax = 256, eta = 0.05, reassignEvery = 100, tauGrowth = 1.05, maxElites = 5 } = {}) {
  return new Projection({
    name: 'vq',
    version: 1,
    kinds: ['strategy.phenotype'],
    init: () => ({ dim: null, tau, tau0: tau, kmax, eta, reassignEvery, centroids: [], counts: [], elites: new Map(), curiosity: new Map(), genomes: new Map(), evaluations: 0, created: 0, replaced: 0, denied: 0, dropped: 0, lastEvalTs: 0 }),
    apply(state, ev) {
      const b = ev.body;
      state.evaluations++;
      state.lastEvalTs = Math.max(state.lastEvalTs, b.ts ?? ev.ts);
      let g = state.genomes.get(b.genomeId);
      if (!g) { g = { evals: 0, bestFitness: -Infinity, lastTs: 0, cells: [] }; state.genomes.set(b.genomeId, g); }
      g.evals++; g.lastTs = b.ts ?? ev.ts; if (b.fitness > g.bestFitness) g.bestFitness = b.fitness;
      const parentCell = b.parent?.cell ?? null;
      const bump = (d) => { if (!parentCell || !parentCell.startsWith('vq:')) return; state.curiosity.set(parentCell, Math.max(0, (state.curiosity.get(parentCell) ?? 0) + d)); };
      const p = Array.isArray(b.phenotype) ? b.phenotype : null;
      if (!p || !(b.fitness > 0)) { bump(-0.5); return; }
      if (state.dim === null) state.dim = p.length;
      if (p.length !== state.dim) return; // a phenotype from a different schema version: ignore
      // nearest centroid
      let best = -1, bestD = Infinity;
      for (let i = 0; i < state.centroids.length; i++) { const d = euclid(p, state.centroids[i]); if (d < bestD) { bestD = d; best = i; } }
      const elite = { genomeId: b.genomeId, genome: b.genome, fitness: b.fitness, ts: b.ts ?? ev.ts, phenotype: p, fixedCell: b.fixedCell ?? null, kind: b.kind ?? null, evals: 1 };
      if (best < 0 || bestD > state.tau) {
        if (state.centroids.length < state.kmax) {
          state.centroids.push(p.slice()); state.counts.push(1);
          const idx = state.centroids.length - 1;
          state.elites.set(idx, elite);
          if (!g.cells.includes(idx)) g.cells.push(idx);
          state.created++;
          bump(1);
          return;
        }
        state.denied++;
        state.tau = Math.min(state.tau * tauGrowth, state.tau0 * 4); // widen cells when the codebook is full
      }
      // compete in the nearest cell; move its centroid a little toward the member
      const c = state.centroids[best];
      const rate = Math.max(state.eta, 1 / (state.counts[best] + 1));
      for (let i = 0; i < c.length; i++) c[i] += rate * (p[i] - c[i]);
      state.counts[best]++;
      const cur = state.elites.get(best);
      if (cur && cur.genomeId === b.genomeId) { cur.fitness = b.fitness; cur.ts = elite.ts; cur.evals++; cur.phenotype = p; return; }
      const better = !cur || b.fitness > cur.fitness + 1e-9 || (Math.abs(b.fitness - cur.fitness) <= 1e-9 && genomeSize(b.genome) < genomeSize(cur.genome));
      if (better) { state.elites.set(best, elite); if (!g.cells.includes(best)) g.cells.push(best); state.replaced++; bump(1); }
      else bump(-0.5);
      if (state.evaluations % state.reassignEvery === 0) reassign(state);
    },
    dehydrate: (s) => ({ dim: s.dim, tau: s.tau, tau0: s.tau0, kmax: s.kmax, eta: s.eta, reassignEvery: s.reassignEvery, centroids: s.centroids, counts: s.counts, elites: mapToArr(s.elites), curiosity: mapToArr(s.curiosity), genomes: mapToArr(s.genomes), evaluations: s.evaluations, created: s.created, replaced: s.replaced, denied: s.denied, dropped: s.dropped, lastEvalTs: s.lastEvalTs }),
    hydrate: (j) => ({ ...j, elites: arrToMap(j.elites), curiosity: arrToMap(j.curiosity), genomes: arrToMap(j.genomes) }),
  });
}

/** Re-encode every elite; an elite whose nearest centroid now hosts a fitter elite is dropped. */
function reassign(state) {
  const entries = [...state.elites.entries()].sort((a, b) => a[0] - b[0]);
  const next = new Map();
  for (const [idx, e] of entries) {
    let best = idx, bestD = Infinity;
    for (let i = 0; i < state.centroids.length; i++) { const d = euclid(e.phenotype, state.centroids[i]); if (d < bestD) { bestD = d; best = i; } }
    const cur = next.get(best);
    if (!cur || e.fitness > cur.fitness) next.set(best, e); else state.dropped++;
  }
  state.elites = next;
}

export const vqOccupied = (s) => s.elites.size;
export function vqScore(s) { let t = 0; for (const e of s.elites.values()) t += Math.max(0, e.fitness); return t; }
export function vqElites(s) { return [...s.elites.entries()].map(([idx, e]) => ({ cell: vqCellId(idx), idx, ...e, curiosity: s.curiosity.get(vqCellId(idx)) ?? 0 })); }
