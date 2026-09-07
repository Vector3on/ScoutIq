import { extract } from '../substrate/blindsight/extract.mjs';
import { shortHash } from '../substrate/core/events.mjs';
import { buildSpine } from '../substrate/plugins/bounty/spine.mjs';
import { requireObservation } from './policy.mjs';
import { neighborhood } from './snapshot.mjs';

// Families are inherited join keys. Rules detect names, never enforcement.
export const FAMILIES = Object.freeze({
  'trust-binding failure': /policy|gate|saniti|valid|author|authenti|permission|tenant|session/i,
  'semantic/parser differential': /parse|serial|decode|encode|canonical|normaliz/i,
});
export const OBSERVER_VERSION = 'static-names-v1';
export const HYPOTHESES = Object.freeze([
  { id: 'neither-name-observed', local: 'no', neighbor: 'no' },
  { id: 'local-name-only', local: 'yes', neighbor: 'no' },
  { id: 'neighbor-name-only', local: 'no', neighbor: 'yes' },
  { id: 'both-names-observed', local: 'yes', neighbor: 'yes' },
]);

export function candidateSeams(target, index, spine = buildSpine()) {
  const anchors = index.facts.filter(f => f.entity === `file:${target.entry}` && f.predicate === 'boundaryCandidate');
  // Blindsight's whole-word boundary hints miss camelCase names. The adapter
  // adds explicit lexical cues without claiming a resolved symbol or boundary.
  const lines = index.lexical.get(target.entry) ?? [];
  return Object.entries(FAMILIES).filter(([, re]) => anchors.some(f => re.test(f.value.excerpt)) || lines.some(r => re.test(r.text)))
    .map(([family]) => {
      // Recall join, explicitly not a target-specific finding or technique execution.
      const seams = [...spine.seamIndex.values()].filter(s => s.seam.mechanismFamilies.includes(family));
      const techniques = [...(spine.familyToTech.get(family) ?? [])];
      const tried = new Set(target.triedCells ?? []);
      const untriedCells = seams.flatMap(s => techniques.map(t => `${s.seam.id}::${t.id}`)).filter(c => !tried.has(c));
      return { family, anchors: [...anchors.flatMap(f => f.evidence), ...lines.filter(r => FAMILIES[family].test(r.text)).map(r => r.evidence)], seamIds: seams.map(s => s.seam.id),
        referenceIds: techniques.map(t => t.id), untriedCells,
        status: 'lexical-family-candidate', applicability: 'unverified',
        observation: 'Whether related names are declared locally or in captured direct imports.' };
    });
}

export function lens(family, radius = 0) {
  if (!(family in FAMILIES) || ![0, 1].includes(radius)) throw new Error('Invalid lens genome');
  const genome = { seed: { op: 'source', family }, pipe: radius ? [{ op: 'captured-direct-imports' }] : [], rank: 'information' };
  return { id: shortHash([OBSERVER_VERSION, genome]), family, radius, genome };
}
export function mutate(parent) { return parent.radius === 0 ? lens(parent.family, 1) : null; }

export function questions(target, snapshot, index, way) {
  const result = [{ kind: 'local-symbol', paths: [target.entry], field: 'local' }];
  const neighbors = neighborhood(target.entry, snapshot.files, index.links);
  if (way.radius && neighbors.length) result.push({ kind: 'neighbor-symbol', paths: neighbors, field: 'neighbor' });
  return result.map(q => ({ ...q, family: way.family, cost: q.paths.length,
    key: shortHash([OBSERVER_VERSION, way.family, q.kind, q.paths.map(p => [p, snapshot.files.get(p).sha256])]) }));
}

export function observe(question, snapshot) {
  requireObservation(question.kind);
  if (!(question.family in FAMILIES) || !question.paths.length || question.paths.length > 128) throw new Error('Invalid observation');
  const evidence = [];
  for (const p of question.paths) {
    const a = snapshot.files.get(p);
    if (!a) throw new Error('Observation outside captured snapshot');
    for (const f of extract('symbols', a)) {
      if (FAMILIES[question.family].test(f.value.name)) evidence.push(...f.evidence.map(e => ({ ...e, path: p, revision: a.revision, sha256: a.sha256 })));
    }
  }
  return { answer: evidence.length ? 'yes' : 'no', evidence,
    searched: question.paths.map(p => ({ path: p, sha256: snapshot.files.get(p).sha256 })),
    meaning: 'Lexical declaration heuristic only. A no answer is not absence of a safeguard.' };
}

export function entropy(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  return n ? Math.max(0, -counts.filter(c => c > 0).reduce((s, c) => s + c / n * Math.log2(c / n), 0)) : 0;
}

export function descriptor(way, evidenceCount) {
  const bd = [Object.keys(FAMILIES).indexOf(way.family), way.radius, Math.min(1, evidenceCount / 10)];
  return { bd, cell: bd.map(v => Math.min(5, Math.floor(v * 6))).join(':') };
}
