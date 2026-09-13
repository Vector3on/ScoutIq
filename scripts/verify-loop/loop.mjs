// The hybrid verify-loop orchestrator: INGEST → HYPOTHESIZE → CONFIRM → GATE → EMIT.
//
// LLM-style semantic proposal, then deterministic tool confirmation, then a hard
// gate that keeps only tool-confirmed survivors, then reviewer-ready emission.
// Dependencies (clock, randomness, network, subprocess) are injectable so the
// whole loop is unit-testable offline.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateConfig } from "./config.mjs";
import { loadTemplates, allVulnClasses } from "./templates.mjs";
import { ingest } from "./ingest.mjs";
import { hypothesize } from "./hypothesize.mjs";
import { buildContext, probeRegistry, confirmCandidate, ADAPTERS } from "./confirm.mjs";
import { gateCandidates } from "./gate.mjs";
import { resolveCommitContext } from "./permalink.mjs";
import { buildFinding, buildAuditEntry, persistAudit, aliasFromContext } from "./emit.mjs";
import { runCommand as defaultRunCommand, which as defaultWhich, readTextSafe, writeJsonAtomic } from "./io.mjs";

function makeToken(rand = randomBytes) {
  return rand(4).toString("hex").toUpperCase();
}

export async function runVerifyLoop(config, {
  root = process.cwd(),
  env = process.env,
  now = new Date().toISOString(),
  token,
  emit = false,
  fetchImpl,
  runCommand = defaultRunCommand,
  which = defaultWhich,
  registry = ADAPTERS,
  rand = randomBytes,
} = {}) {
  const runToken = token ?? makeToken(rand);
  const warnings = [];

  // --- validate (clean-lane boundary enforced here) ---
  const validation = validateConfig(config);
  warnings.push(...validation.warnings);
  if (!validation.ok) {
    const error = new Error(`invalid verify-loop config:\n - ${validation.errors.join("\n - ")}`);
    error.validation = validation;
    throw error;
  }

  // --- templates ---
  const library = await loadTemplates({ root, templatesPath: config.templatesPath });
  if (library.rejected.length) warnings.push(`${library.rejected.length} template(s) rejected during load`);

  // --- 1. INGEST ---
  const ingested = await ingest(config, { root });

  // --- 2. HYPOTHESIZE ---
  const hypotheses = await hypothesize(config, {
    sources: ingested.sources,
    library,
    activeStacks: ingested.activeStacks,
    env,
    fetchImpl,
    runCommandImpl: runCommand,
  });
  warnings.push(...hypotheses.warnings);

  // --- 3. CONFIRM ---
  const runDir = resolve(root, ".verify-loop", "runs", now.replace(/[:.]/g, "-"));
  const artifactDir = resolve(runDir, "artifacts");
  const ctx = buildContext({
    config,
    targetPath: ingested.targetPath,
    root,
    token: runToken,
    artifactDir,
    runCommand,
    which,
    readText: (path) => readTextSafe(path),
  });
  const probes = await probeRegistry(ctx, registry);

  const evaluations = [];
  for (const candidate of hypotheses.candidates) {
    const confirmation = await confirmCandidate(candidate, ctx, registry);
    evaluations.push({ candidate, confirmation });
  }

  // --- 4. GATE ---
  const { survivors, killed } = gateCandidates(evaluations, { requireDynamicPoc: config.confirm?.requireDynamicPoc });

  // --- 5. EMIT ---
  const commit = await resolveCommitContext(ingested.targetPath, { permalinkBase: config.target?.permalinkBase, ref: config.target?.ref });
  if (commit.dirty) warnings.push("target working tree is dirty; permalinks pin HEAD but local edits are not reflected at that commit.");
  const baseUrl = config.localInstance?.baseUrl ?? "";
  const findings = survivors.map((evaluation) => buildFinding(evaluation, { commit, baseUrl, token: runToken }));

  const report = {
    schema: 1,
    tool: "verify-loop",
    ranAt: now,
    runToken,
    target: { path: ingested.targetPath, cloned: ingested.cloned, fileCount: ingested.fileCount, commit },
    detection: ingested.detection,
    activeStacks: ingested.activeStacks,
    templates: { source: library.source, methodology: library.methodology, count: library.templates.length, classes: allVulnClasses(library) },
    hypothesizer: { provider: hypotheses.provider, fellBack: hypotheses.fellBack, candidateCount: hypotheses.candidates.length },
    tools: Object.fromEntries(Object.entries(probes).map(([id, probe]) => [id, { available: probe.available, reason: probe.reason ?? null, version: probe.version ?? null }])),
    hypotheses: hypotheses.candidates.map((candidate) => ({
      id: candidate.id,
      vulnClass: candidate.vulnClass,
      stack: candidate.stack,
      file: candidate.file,
      line: candidate.line,
      score: candidate.score,
      severityHint: candidate.severityHint,
      proposedBy: candidate.proposedBy,
      snippet: candidate.snippet,
      rationale: candidate.rationale,
    })),
    verdicts: evaluations.map((evaluation) => ({
      id: evaluation.candidate.id,
      vulnClass: evaluation.candidate.vulnClass,
      file: evaluation.candidate.file,
      line: evaluation.candidate.line,
      confirmed: evaluation.confirmation.confirmed,
      confirmingTools: evaluation.confirmation.confirmingTools,
      results: evaluation.confirmation.verdicts.map((verdict) => ({ tool: verdict.tool, status: verdict.status, kind: verdict.kind, detail: verdict.detail })),
    })),
    findings,
    killedCount: killed.length,
    warnings,
  };

  let emitted = null;
  if (emit) {
    emitted = await writeRunArtifacts({ root, runDir, artifactDir, report, findings, config, commit, now, provider: hypotheses.provider, candidateCount: hypotheses.candidates.length, killedCount: killed.length });
    report.emitted = emitted;
  }

  return report;
}

async function writeRunArtifacts({ root, runDir, artifactDir, report, findings, config, commit, now, provider, candidateCount, killedCount }) {
  await mkdir(artifactDir, { recursive: true });
  for (const finding of findings) {
    await writeFile(resolve(artifactDir, finding.poc.filename), `${finding.poc.content}\n`).catch(() => {});
  }
  await writeJsonAtomic(resolve(runDir, "report.json"), report);

  const alias = aliasFromContext({ commit, targetPath: report.target.path });
  const entry = buildAuditEntry({ alias, findings, candidateCount, killedCount, now, provider, commit, targetPath: report.target.path });
  const persisted = await persistAudit({ root, auditStore: config.auditStore, alias, entry, now });

  return { runDir, reportPath: resolve(runDir, "report.json"), auditStore: persisted.path, alias, pocFiles: findings.map((finding) => finding.poc.filename) };
}
