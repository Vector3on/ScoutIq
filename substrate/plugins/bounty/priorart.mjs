// plugins/bounty/priorart.mjs — probabilistic prior-art / dedup at the eligible gate.
//
// We cannot see private report queues. We can only read PUBLIC feed signals about
// how picked-over a program is, and how old/known a technique is. So this returns
// a PROBABILITY with LOW visibility — a clue, not proof. A high estimate rejects a
// lead (records why); anything else lets it through with the estimate attached.
//
// This is deliberately conservative about claiming novelty: low visibility means a
// "plausibly-novel" verdict is "we found no public reason to think it's known",
// never "this is new". A real deployment would also query a disclosure index
// (HackerOne Hacktivity, CVE, project changelogs) — that hook is noted, not built.
import { clamp, round } from '../../../scripts/ev-core.mjs';

export const LIKELY_KNOWN = 0.7;

/**
 * @param {object} p  { progEfficiency, progResolveDays, progManaged, crowd } — public program signals
 * @param {object} technique  { year, mechanismFamilies }
 * @param {number} nowYear
 * @returns { probability, visibility:'low', verdict, evidence[], caveat }
 */
export function estimatePriorArt({ program = {}, technique = {}, nowYear = new Date().getUTCFullYear() }) {
  const evidence = [];
  let p = 0.2; // base rate: any in-scope asset on a public program has had some eyes
  const eff = program.progEfficiency;
  if (Number.isFinite(eff)) { p += clamp(eff / 100) * 0.25; evidence.push(`program response efficiency ${eff}% — a mature, well-worked program`); }
  const rd = program.progResolveDays;
  if (Number.isFinite(rd) && rd > 0) { p += 0.1; evidence.push(`program actively resolves reports (avg ${Math.round(rd)}d) — an engaged researcher crowd`); }
  if (program.progManaged) { p += 0.1; evidence.push('managed program (professional triage + steady crowd)'); }
  const crowd = program.crowd;
  if (Number.isFinite(crowd)) { p += crowd * 0.15; evidence.push(`crowd proxy ${round(crowd, 2)} (1 = most crowded)`); }
  const age = Number.isFinite(technique.year) ? nowYear - technique.year : 0;
  if (age >= 2) { p += Math.min(0.15, age * 0.03); evidence.push(`technique is ~${age}y old — widely known, so more likely already applied here`); }
  p = round(clamp(p), 2);
  const verdict = p >= LIKELY_KNOWN ? 'likely-known' : p >= 0.45 ? 'uncertain' : 'plausibly-novel';
  return {
    probability: p, visibility: 'low', verdict, evidence,
    caveat: 'public-signal heuristic; LOW visibility; a clue, not proof of prior disclosure. Novelty here means "no public reason to think it is known", not "new".',
  };
}
