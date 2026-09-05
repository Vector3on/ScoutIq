// core/curriculum.mjs — retrospective environments: environment ↔ solver
// coevolution on the memory's own past (v4; DESIGN.md §10).
//
// v3's frontier (core/frontier.mjs) made challenges harder INSIDE the live
// world and measured them with the same proxy value function, which is why
// its transfers never displaced main-archive elites. Here an ENVIRONMENT is a
// past heartbeat: the memory as it was then (core/timetravel.mjs) and, as its
// ground truth, the hindsight labels of the entities that were fresh then
// (core/hindsight.mjs). A solver (a strategy genome) is scored by how much
// hindsight-labelled value it would have surfaced — a near-truth signal the
// live fitness never has. Environments get progressively richer for free
// (later days carry more history) and harder by a minimal criterion (a solved
// environment spawns a child with a higher value bar; an unsolvable one is
// retired). Solvers transfer both ways: live elites are tried in the past,
// past elites are tried live (the existing `transfer` path).
//
// Events reuse challenge.{created,evaluated,retired} with `spec.retro`, folded
// by their own projection instance (core/frontier.mjs, retro: true).
import { makeFrontierProjection, MIN_VALUES, challengeId, challengeFitness } from './frontier.mjs';

export const makeCurriculumProjection = (opts = {}) => makeFrontierProjection({ ...opts, name: 'curriculum', retro: true });

export function retroSpec({ asOfDay, cutoffTs, now, minValue = 0.3 }) {
  return { retro: { asOfDay, cutoffTs, now }, minValue };
}
export const retroId = (spec) => challengeId(spec);

/** A harder child of a solved environment: same day, next value bar. */
export function harderRetro(spec) {
  const i = MIN_VALUES.findIndex((v) => v >= spec.minValue - 1e-9);
  const next = MIN_VALUES[Math.min(MIN_VALUES.length - 1, Math.max(0, i) + 1)];
  return { retro: { ...spec.retro }, minValue: next };
}

/**
 * Minimal criterion for retrospective environments. Looser than the live
 * frontier's: a hindsight label is dense, so a few evaluations tell.
 */
export function retroCriterion(ch, { lo = 0.01, hi = 0.25, minEvals = 8, maxEvals = 40 } = {}) {
  if (ch.status !== 'active') return ch.status;
  if (ch.evaluations >= minEvals && ch.best < lo) return 'impossible';
  if (ch.best >= hi) return 'solved';
  if (ch.evaluations >= maxEvals) return 'stale';
  return 'active';
}

/** Hindsight labels of one past day from the value model's rows: entityId → { value, novel }. */
export function labelsForDay(vmState, asOfDay) {
  const out = new Map();
  for (const row of vmState.rows) if (row.kind === 'hindsight' && row.batch === asOfDay) out.set(row.id, { value: row.y, novel: row.nv === 0 ? 0 : 1 });
  return out;
}

/** Fitness of a solver's outputs in an environment: hindsight value × novelty-then over k slots, above the bar. */
export const retroFitness = (findings, k, genome, spec) => challengeFitness(findings, k, genome, spec);

export const activeRetro = (s) => [...s.challenges.values()].filter((c) => c.status === 'active');
