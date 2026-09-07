// core/qd.mjs — the MAP-Elites archive (Mouret & Clune 2015) over strategy
// space, as a projection of `strategy.evaluated` events, with the curiosity
// score of Cully & Demiris (2018) for parent selection.
//
// Fitness is NOVEL VALUE: the mean over k output slots of value × novelty
// against the finding archive, minus a small parsimony pressure. A strategy
// that keeps re-finding what has already been delivered decays; the archive
// keeps the best strategy of every behavioral kind, so stepping stones survive.
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { genomeSize } from './strategy.mjs';

export const PARSIMONY = 0.004;

export const qdProjection = new Projection({
  name: 'qd',
  version: 2,
  kinds: ['strategy.evaluated'],
  init: () => ({ bins: 6, cells: new Map(), curiosity: new Map(), genomes: new Map(), evaluations: 0, elitesReplaced: 0, byKind: new Map(), lastEvalTs: 0 }),
  apply(state, ev) {
    const b = ev.body;
    state.evaluations++;
    state.lastEvalTs = Math.max(state.lastEvalTs, b.ts ?? ev.ts);
    if (b.bins) state.bins = b.bins;
    state.byKind.set(b.kind ?? '?', (state.byKind.get(b.kind ?? '?') ?? 0) + 1);
    let g = state.genomes.get(b.genomeId);
    if (!g) { g = { evals: 0, lastFitness: 0, bestFitness: -Infinity, lastTs: 0, cells: [] }; state.genomes.set(b.genomeId, g); }
    g.evals++;
    g.lastFitness = b.fitness;
    g.lastTs = b.ts ?? ev.ts;
    if (b.fitness > g.bestFitness) g.bestFitness = b.fitness;
    const parentCell = b.parent?.cell ?? null;
    const bumpCuriosity = (delta) => { if (!parentCell) return; state.curiosity.set(parentCell, Math.max(0, (state.curiosity.get(parentCell) ?? 0) + delta)); };
    if (!b.cell || !(b.fitness > 0)) { bumpCuriosity(-0.5); return; }
    const cur = state.cells.get(b.cell);
    if (cur && cur.genomeId === b.genomeId) {
      // Re-evaluation of the sitting elite: its fitness is updated honestly, up or down.
      cur.fitness = b.fitness; cur.ts = b.ts ?? ev.ts; cur.evals++;
      return;
    }
    const better = !cur || b.fitness > cur.fitness + 1e-9 || (Math.abs(b.fitness - cur.fitness) <= 1e-9 && genomeSize(b.genome) < genomeSize(cur.genome));
    if (better) {
      state.cells.set(b.cell, { genomeId: b.genomeId, genome: b.genome, fitness: b.fitness, bd: b.bd, ts: b.ts ?? ev.ts, evals: 1, since: b.ts ?? ev.ts, kind: b.kind ?? null });
      if (!g.cells.includes(b.cell)) g.cells.push(b.cell);
      state.elitesReplaced++;
      bumpCuriosity(1);
    } else {
      bumpCuriosity(-0.5);
    }
  },
  dehydrate: (s) => ({ bins: s.bins, cells: mapToArr(s.cells), curiosity: mapToArr(s.curiosity), genomes: mapToArr(s.genomes), evaluations: s.evaluations, elitesReplaced: s.elitesReplaced, byKind: mapToArr(s.byKind), lastEvalTs: s.lastEvalTs }),
  hydrate: (j) => ({ bins: j.bins, cells: arrToMap(j.cells), curiosity: arrToMap(j.curiosity), genomes: arrToMap(j.genomes), evaluations: j.evaluations, elitesReplaced: j.elitesReplaced, byKind: arrToMap(j.byKind), lastEvalTs: j.lastEvalTs ?? 0 }),
});

export function coverage(qd) { return qd.cells.size / Math.pow(qd.bins, 3); }
export function qdScore(qd) { let s = 0; for (const c of qd.cells.values()) s += Math.max(0, c.fitness); return s; }

/** Fitness from evaluated outputs: mean over k slots of value×novelty − parsimony·size. */
export function fitnessOf(findings, k, genome) {
  let s = 0;
  for (const f of findings) s += f.value * f.novelty;
  return s / k - PARSIMONY * genomeSize(genome);
}
