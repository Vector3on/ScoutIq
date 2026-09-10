// EMIT — step 5 of the hybrid loop.
//
// For each survivor, assemble the reviewer-ready finding: commit permalink,
// vuln class, the confirming tool + its evidence, the local PoC, and the drafted
// Q1 attacker request. Results persist to ScoutIQ's audit memory following the
// data/audited.json convention (version/updatedAt/entries keyed by alias, with
// confirming-tool evidence attached).
//
// Safety: nothing is auto-filed. Findings carry handoff:"human-review" and
// filed:false — the human reviews each confirmed finding, confirms live
// reachability, and files it. By default this writes to a DEDICATED store
// (config.auditStore, default data/verify-loop.json) rather than data/audited.json,
// because entries in data/audited.json drive hard EXCLUSIONS in ev-core.mjs;
// writing confirmed live-candidate findings there would wrongly drop them from
// ranking. Point config.auditStore at data/audited.json only if you intend that.

import { resolve } from "node:path";
import { buildPoc } from "./poc.mjs";
import { buildPermalink } from "./permalink.mjs";
import { readJson, writeJsonAtomic } from "./io.mjs";

function aliasFromContext({ commit, targetPath }) {
  if (commit?.base) {
    const match = commit.base.match(/^https?:\/\/[^/]+\/(.+)$/i);
    if (match) return match[1].toLowerCase().replace(/\/+$/, "");
  }
  const base = String(targetPath ?? "").split(/[\\/]/).filter(Boolean).pop();
  return (base ?? "target").toLowerCase();
}

// Build one emitted finding from a survivor evaluation.
export function buildFinding(evaluation, { commit, baseUrl, token }) {
  const candidate = evaluation.candidate;
  const poc = buildPoc(candidate, { baseUrl, token });
  const permalink = commit?.base && commit?.ref
    ? buildPermalink({ base: commit.base, ref: commit.ref, path: candidate.file, line: candidate.line })
    : null;
  const confirmingVerdicts = evaluation.confirmation.verdicts.filter((verdict) => verdict.status === "confirmed");

  return {
    id: candidate.id,
    vulnClass: candidate.vulnClass,
    severityHint: candidate.severityHint,
    stack: candidate.stack,
    file: candidate.file,
    line: candidate.line,
    snippet: candidate.snippet,
    property: candidate.property,
    scenario: candidate.scenario,
    proposedBy: candidate.proposedBy,
    permalink,
    commit: commit ? { ref: commit.ref, remote: commit.remoteUrl, dirty: commit.dirty } : null,
    confirmingTools: evaluation.confirmation.confirmingTools,
    dynamicPoc: evaluation.confirmation.dynamicConfirmed,
    taintProven: evaluation.confirmation.taintProven,
    evidence: confirmingVerdicts.map((verdict) => ({ tool: verdict.tool, kind: verdict.kind, detail: verdict.detail, evidence: verdict.evidence ?? null })),
    poc: { kind: poc.kind, filename: poc.filename, content: poc.content },
    q1Request: poc.q1,
    gate: evaluation.gate,
    handoff: "human-review",
    filed: false,
  };
}

// Build the audit-memory entry (data/audited.json convention) for a run.
export function buildAuditEntry({ alias, findings, candidateCount, killedCount, now, provider, commit, targetPath }) {
  const verdict = findings.length ? "confirmed-findings" : candidateCount ? "no-confirmed-findings" : "empty";
  return {
    verdict,
    date: now.slice(0, 10),
    notes: findings.length
      ? `verify-loop confirmed ${findings.length} finding(s): ${findings.map((f) => `${f.vulnClass}@${f.file}:${f.line} via ${f.confirmingTools.join("/")}`).join("; ")}. Awaiting human review and live-reachability confirmation.`
      : `verify-loop ran ${candidateCount} hypotheses (provider ${provider}); ${killedCount} killed at the gate; no tool-confirmed finding. Honest empty.`,
    freshCodeIndexAtAudit: null,
    aliases: [alias],
    handoff: "human-review",
    filed: false,
    verifyLoop: {
      schema: 1,
      ranAt: now,
      provider,
      targetPath,
      commit: commit ? { base: commit.base, ref: commit.ref, remote: commit.remoteUrl, dirty: commit.dirty } : null,
      candidateCount,
      confirmedCount: findings.length,
      handoff: "human-review",
      filed: false,
      findings: findings.map((finding) => ({
        vulnClass: finding.vulnClass,
        file: finding.file,
        line: finding.line,
        permalink: finding.permalink,
        confirmingTools: finding.confirmingTools,
        dynamicPoc: finding.dynamicPoc,
        taintProven: finding.taintProven,
        evidence: finding.evidence,
        pocFilename: finding.poc.filename,
        q1Request: finding.q1Request,
      })),
    },
  };
}

// Merge a run's audit entry into the store, preserving the convention and any
// pre-existing entries/aliases.
export async function persistAudit({ root, auditStore, alias, entry, now }) {
  const path = resolve(root, auditStore);
  const store = (await readJson(path, null)) ?? { version: 1, updatedAt: now, entries: {} };
  store.version = store.version ?? 1;
  store.entries = store.entries ?? {};
  const existing = store.entries[alias];
  const mergedAliases = [...new Set([...(existing?.aliases ?? []), ...(entry.aliases ?? []), alias])];
  store.entries[alias] = { ...entry, aliases: mergedAliases };
  store.updatedAt = now;
  await writeJsonAtomic(path, store);
  return { path, alias };
}

export { aliasFromContext };
