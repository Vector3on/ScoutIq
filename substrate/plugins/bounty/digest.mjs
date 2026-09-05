// plugins/bounty/digest.mjs — the "alpha queue" delivery.
//
// The queue is the product: top fresh, in-scope, low-crowd targets, each with its
// inferred anatomy class, the exposed seams + the invariant that must hold, the
// untried applicable techniques, and why. It is a chart to reason from, not an
// instruction to act: no payloads, no target-specific test steps.
import fs from 'node:fs';
import path from 'node:path';
import { coverageChart } from './spine.mjs';
import { latestSignal } from '../../core/memory.mjs';

const DAY = 86400000;
const sig = (e, n) => latestSignal(e, n);

function coverageForEntity(spine, tried, entity) {
  const a = entity.attrs ?? {};
  const key = entity.id.replace(/^target:/, '');
  return coverageChart(spine, { classIds: a.classIds ?? [], fingerprints: a.fingerprints ?? [], key }, tried);
}

/** The one-line-per-lead queue with the top seams + untried techniques inlined. */
export function renderAlphaQueue(targets, { spine, tried, now, topSeams = 3, techPerSeam = 3 }) {
  const L = [];
  L.push(`# Alpha queue — ${targets.length} lead${targets.length === 1 ? '' : 's'} — ${new Date(now).toISOString().slice(0, 16)}Z`, '');
  L.push('_Observe-only. Public data. This queue **prioritises**; it never tests, probes, or contacts a target._', '');
  targets.forEach(({ finding: f, entity: e }, i) => {
    const cc = coverageForEntity(spine, tried, e);
    const ev = sig(e, 'ev') ?? 0, reward = sig(e, 'rewardCeiling') ?? 0;
    const freshDays = Math.round((now - e.firstSeen) / DAY);
    const a = e.attrs ?? {};
    L.push(`## ${i + 1}. ${a.assetValue ?? f.entityId}  ·  \`${a.platform ?? '?'}/${a.programHandle ?? '?'}\``);
    L.push(`- **score ${f.score}** · EV $${ev} (pFindable ${sig(e, 'pFindable')} × pPayable ${sig(e, 'pPayable')} × pFirst ${sig(e, 'pFirst')} × $${reward}${a.offersBounties ? '' : ', program does not confirm bounties'})`);
    L.push(`- coverage: **${cc.untriedTechniques} untried** of ${cc.applicableTechniques} applicable cells · ${cc.distinctUntried} distinct techniques · ${cc.exposedSeams} exposed seams`);
    L.push(`- anatomy (inferred, not proof): ${(a.classIds ?? []).map((c) => `\`${c}\``).join(', ')} · asset ${a.assetType}${a.workflow ? ` · ScoutIq ${a.workflow}` : ''}`);
    const whyBits = [a.evReason].filter(Boolean);
    if (freshDays <= 45) whyBits.push(`fresh (first seen ${freshDays}d ago)`);
    if ((sig(e, 'crowd') ?? 1) <= 0.6) whyBits.push('low recorded crowd');
    if (a.excludeReason) whyBits.push(`EV-excluded: ${a.excludeReason}`);
    L.push(`- why: ${whyBits.join('; ') || '—'}`);
    const seams = cc.chart.flatMap((c) => c.seams.map((s) => ({ ...s, classId: c.classId }))).sort((x, y) => y.untried - x.untried).slice(0, topSeams);
    for (const s of seams) {
      L.push(`  - \`${s.classId}.${s.seamId.split('.').pop()}\` **${s.name}** — invariant: _${s.invariant ?? 'n/a'}_`);
      const untried = s.techniques.filter((t) => !t.tried).slice(0, techPerSeam);
      for (const t of untried) L.push(`      · [${t.id}] ${t.title} _(${t.families.join(', ')})_ — ${t.sourceUrl}`);
      const more = s.untried - untried.length;
      if (more > 0) L.push(`      · … +${more} more untried`);
    }
    L.push('');
  });
  return L.join('\n');
}

/** One target's full doctor's chart: class → seam (+ invariant) → every applicable technique, tried/untried. */
export function renderCoverageChart(entity, { spine, tried, now }) {
  const cc = coverageForEntity(spine, tried, entity);
  const a = entity.attrs ?? {};
  const L = [];
  L.push(`# Coverage chart — ${a.assetValue ?? entity.id}`, '');
  L.push(`\`${a.platform}/${a.programHandle}\` · asset ${a.assetType} · EV $${sig(entity, 'ev') ?? 0} · ${cc.untriedTechniques}/${cc.applicableTechniques} untried cells · ${cc.exposedSeams} exposed seams across ${cc.classIds.length} class(es)`, '');
  L.push('_Anatomy is inferred from public signals (never proof). A seam names an invariant that must hold; a technique is a published way that invariant has failed elsewhere. Nothing here is a test instruction._', '');
  for (const c of cc.chart) {
    L.push(`## \`${c.classId}\` — ${c.systemClass}`);
    for (const s of c.seams) {
      L.push(`### ${s.seamId} · ${s.name}  (untried ${s.untried}/${s.techniques.length})`);
      L.push(`- invariant that must hold: **${s.invariant ?? 'n/a'}**`);
      L.push(`- families: ${s.mechanismFamilies.join(', ')}`);
      const shown = s.techniques.slice(0, 8);
      for (const t of shown) L.push(`  - [${t.tried ? 'x' : ' '}] [${t.id}] ${t.title} _(${t.families.join(', ')})_ — ${t.sourceUrl}`);
      if (s.techniques.length > shown.length) L.push(`  - … +${s.techniques.length - shown.length} more (${s.techniques.filter((t) => !t.tried).length - shown.filter((t) => !t.tried).length} untried)`);
    }
    L.push('');
  }
  return L.join('\n');
}

/** Loam sink: renders the alpha queue + the top target's full chart to outDir. */
export function alphaQueueSink({ spine, tried }) {
  return {
    id: 'alpha-queue',
    async emit(findings, { domain, memory, now, outDir, runId }) {
      const targets = findings
        .filter((f) => f.entityType === 'target')
        .map((f) => ({ finding: f, entity: memory.entities.get(f.entityId) }))
        .filter((x) => x.entity)
        // exclude programs that do not confirm bounties (a $0 lead never outranks a payable one)
        .filter(({ entity: e }) => e.attrs?.offersBounties !== false && (sig(e, 'pPayable') ?? 0) > 0)
        // strictly by score descending — the queue is monotonic in priority
        .sort((a, b) => (b.finding.score ?? 0) - (a.finding.score ?? 0) || (a.entity.id < b.entity.id ? -1 : 1));
      if (!targets.length) return;
      const queue = renderAlphaQueue(targets, { spine, tried, now });
      const chart = renderCoverageChart(targets[0].entity, { spine, tried, now });
      const dir = outDir ?? path.join(process.cwd(), 'out', domain ?? 'bounty');
      fs.mkdirSync(dir, { recursive: true });
      const md = `${queue}\n\n---\n\n${chart}\n`;
      fs.writeFileSync(path.join(dir, 'alpha-queue.md'), md);
      if (runId) fs.writeFileSync(path.join(dir, `alpha-queue-${runId}.md`), md);
      fs.writeFileSync(path.join(dir, 'alpha-queue.json'), JSON.stringify({
        runId, domain, now,
        queue: targets.map(({ finding: f, entity: e }) => {
          const cc = coverageForEntity(spine, tried, e);
          return { entityId: f.entityId, asset: e.attrs?.assetValue, score: f.score, ev: sig(e, 'ev'), untried: cc.untriedTechniques, applicable: cc.applicableTechniques, exposedSeams: cc.exposedSeams, classIds: e.attrs?.classIds };
        }),
      }, null, 2));
    },
  };
}
