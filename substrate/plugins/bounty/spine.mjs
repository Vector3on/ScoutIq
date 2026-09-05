// plugins/bounty/spine.mjs — the spine that joins anatomy ⇄ pathology ⇄ target.
//
//   anatomy.seam  --mechanismFamilies-->  technique  --fingerprints-->  target
//
// Everything here is a PURE function over two static data files (the defensive
// atlas and the 120-case technique catalog). It contains no network access, no
// payloads, and no target-specific testing instructions: it decides only which
// *published* techniques are conceptually applicable to a target's *inferred*
// anatomy, so the value function can prioritise and the digest can explain.
//
// Two-level join (DESIGN §"the spine"):
//   1. seam ⇄ technique   — static, via the shared mechanismFamilies vocabulary.
//                           Coarse (10 families): every seam sees many techniques.
//   2. target ⇄ technique — dynamic, via fingerprints (a technique's preconditions
//                           matched against a target's public observableSignals).
//                           Selective: only techniques whose stack/protocol fits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(DIR, p), 'utf8'));

/** Build the immutable spine index from the two data files (or injected data). */
export function buildSpine({ anatomy, techniques } = {}) {
  anatomy = anatomy ?? readJson('data/anatomy.json');
  techniques = techniques ?? readJson('data/techniques.json');

  const classById = new Map(anatomy.map((c) => [c.id, c]));
  const techById = new Map(techniques.map((t) => [t.id, t]));

  // family -> [technique] (the coarse vocabulary that everything shares)
  const familyToTech = new Map();
  for (const t of techniques) for (const f of t.mechanismFamilies ?? []) {
    if (!familyToTech.has(f)) familyToTech.set(f, []);
    familyToTech.get(f).push(t);
  }

  // seam -> { seam, class, invariants, techniques[] } via mechanismFamilies
  const seamIndex = new Map();
  for (const c of anatomy) {
    const invBySeam = new Map();
    for (const inv of c.invariants ?? []) for (const sid of inv.seamIds ?? []) {
      if (!invBySeam.has(sid)) invBySeam.set(sid, []);
      invBySeam.get(sid).push(inv);
    }
    for (const s of c.seams ?? []) {
      const set = new Map();
      for (const f of s.mechanismFamilies ?? []) for (const t of familyToTech.get(f) ?? []) set.set(t.id, t);
      seamIndex.set(s.id, {
        seam: s, classId: c.id, systemClass: c.systemClass,
        invariants: invBySeam.get(s.id) ?? [],
        techniques: [...set.values()],
      });
    }
  }

  // class -> seam ids
  const classToSeams = new Map(anatomy.map((c) => [c.id, (c.seams ?? []).map((s) => s.id)]));

  return { anatomy, techniques, classById, techById, familyToTech, seamIndex, classToSeams, families: [...familyToTech.keys()].sort() };
}

/**
 * Does a technique's precondition fingerprint fit a target's observable fingerprint?
 * A technique with no fingerprints is "general" (applies wherever its family exposes a seam).
 */
function fingerprintFits(tech, targetFingerprints) {
  const tf = tech.fingerprints ?? [];
  if (tf.length === 0) return true;                    // general technique
  return tf.some((f) => targetFingerprints.includes(f));
}

/**
 * The doctor's chart for one target: class -> exposed seams (+ the invariant that
 * must hold) -> applicable techniques -> tried/untried. Pure. `tried` is a Set of
 * `${seamId}::${techId}` cells the operator has recorded as already looked at.
 */
export function coverageChart(spine, { classIds, fingerprints = [], key = null }, tried = new Set()) {
  const chart = [];
  let applicable = 0, untried = 0, exposedSeams = 0;
  const distinct = new Set(), distinctUntried = new Set();
  const cellId = (sid, tid) => (key ? `${key}::${sid}::${tid}` : `${sid}::${tid}`);
  for (const classId of classIds) {
    const cls = spine.classById.get(classId);
    if (!cls) continue;
    const seams = [];
    for (const sid of spine.classToSeams.get(classId) ?? []) {
      const entry = spine.seamIndex.get(sid);
      if (!entry) continue;
      const techs = entry.techniques
        .filter((t) => fingerprintFits(t, fingerprints))
        .map((t) => {
          const cell = cellId(sid, t.id);
          const isTried = tried.has(cell);
          distinct.add(t.id);
          if (!isTried) { untried++; distinctUntried.add(t.id); }
          applicable++;
          return { id: t.id, number: t.number, title: t.title, families: t.mechanismFamilies, source: t.source, sourceUrl: t.sourceUrl, tried: isTried, cell };
        });
      if (!techs.length) continue;                     // no fingerprint-fitting technique → seam not "live" for this target
      exposedSeams++;
      seams.push({
        seamId: sid, name: entry.seam.name,
        sideA_assumes: entry.seam.sideA_assumes, sideB_assumes: entry.seam.sideB_assumes,
        mechanismFamilies: entry.seam.mechanismFamilies,
        invariant: (entry.invariants[0]?.statement) ?? null,   // the property that must hold
        invariants: entry.invariants.map((i) => ({ id: i.id, statement: i.statement })),
        techniques: techs,
        untried: techs.filter((t) => !t.tried).length,
      });
    }
    if (!seams.length) continue;
    chart.push({ classId, systemClass: cls.systemClass, seams });
  }
  return {
    classIds, chart, exposedSeams,
    applicableTechniques: applicable, untriedTechniques: untried, triedTechniques: applicable - untried,
    distinctTechniques: distinct.size, distinctUntried: distinctUntried.size,
  };
}

/** Flat set of applicable technique ids for a target (deduped across seams), fingerprint-filtered. */
export function applicableTechniques(spine, { classIds, fingerprints = [] }) {
  const out = new Map();
  for (const classId of classIds) for (const sid of spine.classToSeams.get(classId) ?? []) {
    const entry = spine.seamIndex.get(sid);
    if (!entry) continue;
    for (const t of entry.techniques) if (fingerprintFits(t, fingerprints)) out.set(t.id, t);
  }
  return [...out.values()];
}
