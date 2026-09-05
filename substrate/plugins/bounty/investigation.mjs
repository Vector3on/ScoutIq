// plugins/bounty/investigation.mjs — the investigation-prep loop.
//
// For a lead (target × seam) it fills a BOUNDED-QUESTION record and walks a small
// state machine that STOPS at ready_for_human_test:
//
//   collected → eligible → investigating → ready_for_human_test        (or → rejected)
//
// The record answers a fixed set of questions and no more: exact repo revision,
// scope evidence, observed change, the expected invariant PULLED FROM THE SEAM
// (never invented), the competing explanations (defect / safeguard / intended /
// misunderstanding), the single next discriminating check, and the remaining
// budget. The output is a supported, TESTABLE claim — a hypothesis — or an
// evidence-backed rejection.
//
// It never tests. The discriminating check is DESCRIBED, not executed. The active
// test, and everything after ready_for_human_test, is the human's, in their own
// authorized environment, in scope. There is deliberately no autonomous test step.
import { coverageChart } from './spine.mjs';
import { estimatePriorArt } from './priorart.mjs';
import { latestSignal } from '../../core/memory.mjs';

const sig = (e, n) => latestSignal(e, n);
export const leadId = (targetKey, seamId) => `${targetKey}::${seamId}`;

function coverageForEntity(spine, tried, entity) {
  const a = entity.attrs ?? {};
  const key = entity.id.replace(/^target:/, '');
  return coverageChart(spine, { classIds: a.classIds ?? [], fingerprints: a.fingerprints ?? [], key }, tried);
}

/** Build a fresh 'collected' record for the best (or a chosen) seam of a target entity. */
export function collectLead(entity, { spine, tried = new Set(), seamId = null, budget = 4, now = Date.now() }) {
  const a = entity.attrs ?? {};
  const cc = coverageForEntity(spine, tried, entity);
  const seams = cc.chart.flatMap((c) => c.seams.map((s) => ({ ...s, classId: c.classId })));
  const chosen = (seamId ? seams.find((s) => s.seamId === seamId) : null) ?? seams.sort((x, y) => y.untried - x.untried)[0];
  if (!chosen) return null;
  const candidate = chosen.techniques.find((t) => !t.tried) ?? chosen.techniques[0];
  const targetKey = entity.id.replace(/^target:/, '');
  const freshDays = Math.round((now - entity.firstSeen) / 86400000);
  return {
    leadId: leadId(targetKey, chosen.seamId),
    targetKey, seamId: chosen.seamId, classId: chosen.classId,
    state: 'collected', createdAt: now, updatedAt: now,
    budget: { total: budget, remaining: budget },
    questions: {
      repoRevision: null,                              // filled at 'investigating'
      scopeEvidence: {
        asset: a.assetValue, assetType: a.assetType, eligible: sig(entity, 'eligible') === 1,
        program: a.programHandle, platform: a.platform, url: a.programUrl,
        offersBounties: !!a.offersBounties, feed: a.feedId ?? null,
        ev: sig(entity, 'ev'), evReason: a.evReason ?? null,
      },
      observedChange: {
        signal: freshDays <= 45 ? 'fresh-scope' : 'standing-scope',
        detail: `asset present in the public ${a.platform} scope feed; EV $${sig(entity, 'ev') ?? 0}; ${chosen.untried} untried cells at this seam; first seen ${freshDays}d ago${(sig(entity, 'crowd') ?? 1) <= 0.6 ? '; low recorded crowd' : ''}`,
      },
      expectedInvariant: chosen.invariant,             // PULLED FROM THE SEAM
      seam: { id: chosen.seamId, name: chosen.name, sideA_assumes: chosen.sideA_assumes, sideB_assumes: chosen.sideB_assumes, families: chosen.mechanismFamilies },
      candidateTechnique: candidate ? { id: candidate.id, title: candidate.title, families: candidate.families, sourceUrl: candidate.sourceUrl } : null,
      competingExplanations: null,                     // filled at 'investigating'
      priorArt: null,                                  // filled at 'eligible'
      nextDiscriminatingCheck: null,                   // filled at 'investigating'
    },
    outcome: null,
    _untried: chosen.untried,
    _attrs: { progEfficiency: a.progEfficiency, progResolveDays: a.progResolveDays, progManaged: a.progManaged, crowd: sig(entity, 'crowd') },
  };
}

function competingExplanations(seam, technique) {
  const t = technique ? `"${technique.title}"` : 'a published mechanism in this family';
  return [
    { kind: 'defect', statement: `The invariant fails as in ${t}: ${seam.sideA_assumes} — but ${seam.sideB_assumes} The two sides can disagree, crossing the boundary.`, favoredBy: 'the technique fingerprint fits the asset; the seam is exposed' },
    { kind: 'safeguard', statement: 'A control enforces the invariant before impact — a WAF, a framework default, a gateway policy, input validation, or a canonicalization step — so the deviation is caught.', favoredBy: 'mature program; hardened stack' },
    { kind: 'intended', statement: 'The behaviour is intended and documented (a feature, flag, or configuration); no trust boundary is actually crossed.', favoredBy: 'the asset advertises the behaviour' },
    { kind: 'misunderstanding', statement: 'The anatomy inference is wrong — it is inference from public signals, not proof; the seam may not exist as modelled on this asset.', favoredBy: 'thin public signal; unusual stack' },
  ];
}

const CHECK_BY_FAMILY = {
  'trust-binding failure': 'In your authorized session, observe which identifier the boundary binds on (e.g. immutable subject vs mutable claim; token audience vs issuer; tenant vs resource). A mismatch is the defect signature; a correct, consistent binding is a safeguard.',
  'semantic/parser differential': 'Compare, read-only, how two components on the path interpret the same input (proxy vs origin, gateway vs backend, sanitizer vs renderer). A divergence that changes meaning is the defect; identical interpretation is a safeguard.',
  'stateful/race/desync': 'Observe whether a state transition (retry, cache lifetime, rollback, reconnect) can be reached that crosses the invariant. A reachable window is the defect; an enforced ordering/idempotency is a safeguard.',
  'boundary-width/precision': 'Check whether a width, precision, length, or unit conversion at the boundary can lose or reinterpret a value used for accounting or validation. A lossy conversion is the defect signature.',
  'confused-deputy': 'Observe whether an intermediary (agent, proxy, callback, runner) will act on attacker-influenced input with its own authority. Acting with elevated authority on unvalidated input is the defect.',
  'secondary-channel/provenance': 'Check whether a secondary channel (log, callback, build artifact, email, telemetry) is trusted as authoritative for the invariant. Trusting it is the defect; independent verification is a safeguard.',
  'historical supply-chain': 'Check the dependency/update provenance for a stale, mutable, or orphaned control path (a domain, namespace, tag, or migration). A dangling path is the defect signature.',
  'cost/DoS asymmetry': 'Check whether a small input maps to disproportionate work at the boundary (decompression, quadratic parsing, unbounded retries). Asymmetry is the defect; a cost bound is a safeguard.',
  'hardware abstraction leak': 'Check whether a lower-layer/hardware abstraction leaks state across the boundary. A leak that survives the boundary is the defect.',
  'structured protocol fuzzing': 'Model the protocol/state machine for a sequence the two parties would interpret differently. A disagreement the boundary does not reconcile is the defect.',
};
function discriminatingCheck(seam) {
  const fam = (seam.families ?? [])[0];
  return CHECK_BY_FAMILY[fam] ?? 'In your authorized environment, make the single read-only observation that would show whether the invariant actually fails here (defect) versus is enforced (safeguard) or intended.';
}

function readyClaim(rec) {
  const q = rec.questions;
  const t = q.candidateTechnique;
  return [
    `HYPOTHESIS — test in YOUR authorized environment, in scope (this is not a confirmed finding):`,
    `• Target: ${q.scopeEvidence.asset}  (${rec.classId}.${rec.seamId} "${q.seam.name}")`,
    `• Invariant that must hold (from the seam): ${q.expectedInvariant}`,
    `• Public signal: ${q.observedChange.detail}`,
    t ? `• A published way this invariant has failed elsewhere: ${t.title} — ${t.sourceUrl}` : `• Family: ${q.seam.families.join(', ')}`,
    `• Competing benign explanations to rule out first: safeguard, intended, or misunderstanding (see record).`,
    `• The single discriminating check (read-only / human-run): ${q.nextDiscriminatingCheck}`,
    `• Prior art: ${q.priorArt.verdict} (p≈${q.priorArt.probability}, ${q.priorArt.visibility} visibility — ${q.priorArt.caveat})`,
    `The active test, and everything after, is yours — in your controlled environment, within the program's scope. The loop stops here.`,
  ].join('\n');
}

/** One state transition. Pure except for an optional async revision resolver. */
export async function advance(rec, { revisionResolver = null, nowYear = new Date().getUTCFullYear() } = {}) {
  const q = rec.questions;
  rec.updatedAt = Date.now();
  if (rec.state === 'collected') {
    // eligibility gates
    if (!q.scopeEvidence.offersBounties || (q.scopeEvidence.ev ?? 0) <= 0) return reject(rec, 'program does not confirm bounties (EV 0)');
    if (!q.scopeEvidence.eligible) return reject(rec, 'asset is not marked bounty-eligible in the public scope');
    if ((rec._untried ?? 0) <= 0) return reject(rec, 'no untried applicable techniques at this seam');
    // prior-art / dedup (PROBABILISTIC, low visibility)
    q.priorArt = estimatePriorArt({ program: rec._attrs, technique: { year: yearOf(q.candidateTechnique), mechanismFamilies: q.seam.families }, nowYear });
    if (q.priorArt.verdict === 'likely-known') return reject(rec, `prior-art likely-known (p≈${q.priorArt.probability})`, q.priorArt.evidence);
    rec.state = 'eligible';
    return rec;
  }
  if (rec.state === 'eligible') {
    // repo revision (source assets only; observe-only public metadata)
    q.repoRevision = await resolveRevision(q.scopeEvidence, revisionResolver);
    q.competingExplanations = competingExplanations(q.seam, q.candidateTechnique);
    q.nextDiscriminatingCheck = discriminatingCheck(q.seam);
    rec.budget.remaining = Math.max(0, rec.budget.remaining - 1);
    rec.state = 'investigating';
    return rec;
  }
  if (rec.state === 'investigating') {
    if (rec.budget.remaining <= 0) return reject(rec, 'investigation budget exhausted before a testable claim was supported');
    const ok = q.expectedInvariant && q.candidateTechnique && q.competingExplanations && q.nextDiscriminatingCheck;
    if (!ok) return reject(rec, 'record incomplete: could not support a testable claim');
    rec.state = 'ready_for_human_test';
    rec.outcome = { kind: 'ready', claim: readyClaim(rec), handoff: 'human-controlled-test-in-scope' };
    return rec;
  }
  return rec; // terminal
}

/** Walk to a terminal state (ready_for_human_test or rejected). STOPS at ready. */
export async function advanceToTerminal(rec, ctx = {}) {
  let guard = 0;
  while (rec.state !== 'ready_for_human_test' && rec.state !== 'rejected' && guard++ < 10) await advance(rec, ctx);
  return rec;
}

function reject(rec, reason, evidence = null) {
  rec.state = 'rejected';
  rec.outcome = { kind: 'rejected', reason, evidence };
  return rec;
}

/** Render one investigation record as a readable bounded-question sheet. */
export function renderInvestigation(rec) {
  const q = rec.questions;
  const L = [];
  L.push(`# Investigation record — ${rec.leadId}`);
  L.push(`state: **${rec.state}**  ·  budget ${rec.budget.remaining}/${rec.budget.total}  ·  ${rec.classId}.${rec.seamId}`, '');
  L.push('## Bounded questions', '');
  L.push(`1. exact repo revision: ${q.repoRevision ? `${q.repoRevision.source} — ${q.repoRevision.revision}${q.repoRevision.repo ? ` (${q.repoRevision.repo})` : ''}${q.repoRevision.note ? ` — ${q.repoRevision.note}` : ''}` : '(not yet collected)'}`);
  L.push(`2. scope evidence: ${q.scopeEvidence.asset} · ${q.scopeEvidence.assetType} · program \`${q.scopeEvidence.program}\` · eligible=${q.scopeEvidence.eligible} · bounties=${q.scopeEvidence.offersBounties} · EV $${q.scopeEvidence.ev}`);
  L.push(`3. observed change: [${q.observedChange.signal}] ${q.observedChange.detail}`);
  L.push(`4. expected invariant (from seam ${q.seam.id} "${q.seam.name}"): ${q.expectedInvariant}`);
  L.push(`5. competing explanations:`);
  for (const c of q.competingExplanations ?? []) L.push(`   - **${c.kind}**: ${c.statement}${c.favoredBy ? `  _(favored by: ${c.favoredBy})_` : ''}`);
  if (!q.competingExplanations) L.push('   (not yet collected)');
  L.push(`6. next discriminating check (DESCRIBED, human-run, read-only): ${q.nextDiscriminatingCheck ?? '(not yet collected)'}`);
  L.push(`7. prior art: ${q.priorArt ? `${q.priorArt.verdict} · p≈${q.priorArt.probability} · ${q.priorArt.visibility} visibility` : '(not yet checked)'}`);
  if (q.priorArt?.evidence?.length) for (const e of q.priorArt.evidence) L.push(`     · ${e}`);
  if (q.priorArt) L.push(`     · caveat: ${q.priorArt.caveat}`);
  L.push(`8. remaining budget: ${rec.budget.remaining}/${rec.budget.total}`);
  L.push('');
  if (rec.outcome?.kind === 'ready') { L.push('## Outcome — READY FOR HUMAN TEST (the loop stops here)', '', rec.outcome.claim); }
  else if (rec.outcome?.kind === 'rejected') { L.push('## Outcome — REJECTED', '', `reason: ${rec.outcome.reason}`); if (rec.outcome.evidence) for (const e of rec.outcome.evidence) L.push(`- ${e}`); }
  return L.join('\n');
}
const yearOf = (t) => (t && Number.isFinite(t.year) ? t.year : undefined);

async function resolveRevision(scope, resolver) {
  if (scope.assetType === 'SOURCE_CODE') {
    if (resolver) { try { const r = await resolver(scope.asset); if (r) return r; } catch { /* observe-only, best-effort */ } }
    return { source: 'github', asset: scope.asset, revision: 'unresolved', note: 'public source not fetched (enable a revision resolver to pin the exact commit)' };
  }
  return { source: 'none', revision: 'n/a', note: 'no public source repository for this asset type; the "revision" is the deployed service state, observed at test time by the human' };
}
