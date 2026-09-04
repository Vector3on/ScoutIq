// core/frontier.mjs — frontier expansion, POET-style (v3).
//
// A CHALLENGE is a harder, narrower version of the main search: only outputs
// worth at least `minValue`, drawn from a REGION of memory (a type, an age
// band). Each challenge keeps a few elites; strategies that win a challenge
// are TRANSFERRED into the main archive as candidate stepping stones, and
// main elites are tried inside challenges. A MINIMAL CRITERION keeps the
// frontier honest: a challenge nobody can score on is retired as impossible,
// one that is solved spawns a harder child. (Wang, Lehman, Clune & Stanley
// 2019; Enhanced POET 2020.)
//
// Pure fold over challenge.* events; nothing in v2 folds these.
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { shortHash } from './events.mjs';
import { DAY_MS } from './memory.mjs';
import { genomeSize } from './strategy.mjs';

export const MIN_VALUES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
export const AGE_BANDS = [[null, 1], [1, 7], [7, 30], [30, null], [null, null]]; // days [min, max]

export const challengeId = (spec) => 'c_' + shortHash(spec).slice(0, 10);

export function initialChallenges(schema) {
  const T = schema.primaryType ?? schema.entityTypes[0];
  const other = schema.entityTypes.find((t) => t !== T) ?? T;
  return [
    { minValue: 0.4, region: { type: T, ageMin: 7, ageMax: null } },   // valuable but not fresh
    { minValue: 0.5, region: { type: T, ageMin: null, ageMax: null } }, // simply harder
    { minValue: 0.3, region: { type: other, ageMin: null, ageMax: null } }, // a different kind of entity
  ];
}

/** Produce a harder or shifted challenge. Deterministic given rng. */
export function mutateChallenge(spec, rng, schema, { harder = false } = {}) {
  const s = { minValue: spec.minValue, region: { ...spec.region } };
  const r = rng();
  if (harder || r < 0.5) s.minValue = MIN_VALUES[Math.min(MIN_VALUES.length - 1, MIN_VALUES.indexOf(closest(s.minValue)) + 1)];
  else if (r < 0.8) { const band = rng.pick(AGE_BANDS); s.region.ageMin = band[0]; s.region.ageMax = band[1]; }
  else s.region.type = rng.pick(schema.entityTypes);
  return s;
}
const closest = (v) => MIN_VALUES.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), MIN_VALUES[0]);

/** The region predicate a challenge imposes on candidate entities. */
export function regionAccept(spec, memory, now) {
  const { type, ageMin, ageMax } = spec.region ?? {};
  return (id) => {
    const e = memory.entities.get(id);
    if (!e) return false;
    if (type && e.type !== type) return false;
    const age = (now - e.firstSeen) / DAY_MS;
    if (ageMin !== null && ageMin !== undefined && age < ageMin) return false;
    if (ageMax !== null && ageMax !== undefined && age > ageMax) return false;
    return true;
  };
}

/** Challenge fitness: like the main fitness but only outputs worth ≥ minValue count. */
export function challengeFitness(findings, k, genome, spec) {
  let s = 0;
  for (const f of findings) if (f.value >= spec.minValue) s += f.value * f.novelty;
  return s / k - 0.004 * genomeSize(genome);
}

export function minimalCriterion(ch, { lo = 0.01, hi = 0.3, minEvals = 20, maxEvals = 80 } = {}) {
  if (ch.status !== 'active') return ch.status;
  if (ch.evaluations >= minEvals && ch.best < lo) return 'impossible';
  if (ch.best >= hi) return 'solved';
  if (ch.evaluations >= maxEvals) return 'stale';
  return 'active';
}

export function makeFrontierProjection({ maxElites = 5 } = {}) {
  return new Projection({
    name: 'frontier',
    version: 1,
    kinds: ['challenge.created', 'challenge.evaluated', 'challenge.retired'],
    init: () => ({ challenges: new Map(), created: 0, retired: 0, solved: 0, evaluations: 0, transfers: 0 }),
    apply(state, ev) {
      const b = ev.body;
      if (ev.kind === 'challenge.created') {
        if (state.challenges.has(b.challengeId)) return;
        state.challenges.set(b.challengeId, { id: b.challengeId, spec: b.spec, parent: b.parent ?? null, origin: b.origin ?? null, status: 'active', createdTs: b.ts ?? ev.ts, evaluations: 0, best: 0, bestGenomeId: null, elites: [], lastEvalTs: 0, retiredReason: null });
        state.created++;
      } else if (ev.kind === 'challenge.evaluated') {
        const ch = state.challenges.get(b.challengeId);
        if (!ch) return;
        state.evaluations++;
        if (b.kind === 'transfer-in') state.transfers++;
        ch.evaluations++;
        ch.lastEvalTs = Math.max(ch.lastEvalTs, b.ts ?? ev.ts);
        if (!(b.fitness > 0)) return;
        if (b.fitness > ch.best) { ch.best = b.fitness; ch.bestGenomeId = b.genomeId; }
        const i = ch.elites.findIndex((e) => e.genomeId === b.genomeId);
        if (i >= 0) { ch.elites[i].fitness = b.fitness; ch.elites[i].ts = b.ts ?? ev.ts; }
        else ch.elites.push({ genomeId: b.genomeId, genome: b.genome, fitness: b.fitness, ts: b.ts ?? ev.ts, kind: b.kind ?? null });
        ch.elites.sort((x, y) => y.fitness - x.fitness || (x.genomeId < y.genomeId ? -1 : 1));
        if (ch.elites.length > maxElites) ch.elites.length = maxElites;
      } else if (ev.kind === 'challenge.retired') {
        const ch = state.challenges.get(b.challengeId);
        if (!ch || ch.status !== 'active') return;
        ch.status = b.reason === 'solved' ? 'solved' : 'retired';
        ch.retiredReason = b.reason;
        if (b.reason === 'solved') state.solved++; else state.retired++;
      }
    },
    dehydrate: (s) => ({ challenges: mapToArr(s.challenges), created: s.created, retired: s.retired, solved: s.solved, evaluations: s.evaluations, transfers: s.transfers }),
    hydrate: (j) => ({ ...j, challenges: arrToMap(j.challenges) }),
  });
}

export const activeChallenges = (s) => [...s.challenges.values()].filter((c) => c.status === 'active');
