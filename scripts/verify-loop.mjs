// verify-loop CLI — the hybrid LLM + program-analysis verification lane.
//
//   node scripts/verify-loop.mjs --target <path> [options]
//
// Runs INGEST → HYPOTHESIZE → CONFIRM → GATE → EMIT on a locally-cloned target.
// Prints the ranked hypotheses, the per-candidate tool-confirmation verdict, and
// for each confirmed survivor the permalink, confirming tool, local PoC, and the
// drafted Q1 attacker request. Pass --emit to persist to the audit store.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./verify-loop/config.mjs";
import { loadTemplates, allVulnClasses } from "./verify-loop/templates.mjs";
import { runVerifyLoop } from "./verify-loop/loop.mjs";

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--emit") flags.emit = true;
    else if (token === "--list-classes") flags.listClasses = true;
    else if (token === "--help" || token === "-h") flags.help = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else flags._.push(token);
  }
  return flags;
}

function overridesFrom(flags) {
  const overrides = {};
  const target = {};
  if (flags.target) target.repoPath = String(flags.target);
  if (flags["git-url"]) target.gitUrl = String(flags["git-url"]);
  if (flags.ref) target.ref = String(flags.ref);
  if (flags["permalink-base"]) target.permalinkBase = String(flags["permalink-base"]);
  if (Object.keys(target).length) overrides.target = target;
  if (flags.stack) overrides.stack = String(flags.stack);
  if (flags.classes) overrides.vulnClasses = String(flags.classes).split(",").map((value) => value.trim()).filter(Boolean);
  if (flags.templates) overrides.templatesPath = String(flags.templates);
  if (flags["audit-store"]) overrides.auditStore = String(flags["audit-store"]);
  const hypothesizer = {};
  if (flags.provider) hypothesizer.provider = String(flags.provider);
  if (flags.max) hypothesizer.maxCandidates = Math.max(1, Number(flags.max) || 40);
  if (Object.keys(hypothesizer).length) overrides.hypothesizer = hypothesizer;
  if (flags["base-url"]) overrides.localInstance = { baseUrl: String(flags["base-url"]) };
  if (flags["require-dynamic"]) overrides.confirm = { requireDynamicPoc: true };
  return overrides;
}

const HELP = `verify-loop — hybrid LLM + program-analysis verification harness

Usage:
  node scripts/verify-loop.mjs --target <path> [options]

Options:
  --target <path>         local path to the in-scope target repo (or set target.repoPath in config)
  --git-url <url>         clone an in-scope repo locally, then analyze it (local clone only)
  --ref <commit>          commit/branch for permalinks (default: resolved HEAD)
  --permalink-base <url>  browse base for permalinks (default: derived from git remote)
  --stack <stack>         auto | solidity | js-ts | python | php | go   (default: auto)
  --classes <a,b,c>       limit to these vuln classes (default: all applicable)
  --provider <p>          hypothesizer: deterministic | anthropic | command  (default: deterministic)
  --base-url <url>        LOCAL instance URL for the runtime harness (loopback/private only)
  --require-dynamic       survivors must have a working dynamic PoC, not just a taint proof
  --config <path>         config file (default: config/verify-loop.json)
  --templates <path>      template library (default: from config)
  --audit-store <path>    audit memory file (default: config.auditStore)
  --max <n>               max candidate hypotheses (default: 40)
  --format <fmt>          table | json | ndjson   (default: table)
  --emit                  persist findings + PoCs + report to the audit store
  --list-classes          print the vuln classes in the template library and exit
  -h, --help              show this help

Clean lane: analyzes local code and local instances only; never contacts a live
third-party target. The human confirms live reachability and files each finding.`;

function printTable(report) {
  const out = [];
  out.push(`verify-loop @ ${report.ranAt}  (run ${report.runToken})`);
  out.push(`target: ${report.target.path}`);
  if (report.target.commit?.base && report.target.commit?.ref) {
    out.push(`commit: ${report.target.commit.base} @ ${String(report.target.commit.ref).slice(0, 12)}${report.target.commit.dirty ? " (dirty)" : ""}`);
  }
  out.push(`stacks: ${report.activeStacks.join(", ") || "none detected"}  |  files: ${report.target.fileCount}`);
  out.push(`hypothesizer: ${report.hypothesizer.provider}${report.hypothesizer.fellBack ? " (fell back)" : ""}  |  candidates: ${report.hypothesizer.candidateCount}`);
  const available = Object.entries(report.tools).filter(([, probe]) => probe.available).map(([id]) => id);
  const missing = Object.entries(report.tools).filter(([, probe]) => !probe.available).map(([id]) => id);
  out.push(`confirmers available: ${available.join(", ") || "none"}`);
  out.push(`confirmers missing:   ${missing.join(", ") || "none"}`);
  console.log(out.join("\n"));

  if (report.hypotheses.length) {
    console.log("\nRanked hypotheses (LLM/matcher PROPOSED — not yet confirmed):");
    console.table(report.hypotheses.slice(0, 25).map((h, index) => ({
      "#": index + 1,
      class: h.vulnClass,
      where: `${h.file}:${h.line}`,
      score: h.score,
      sev: h.severityHint,
      by: h.proposedBy,
    })));
  }

  if (report.findings.length) {
    console.log(`\n✔ CONFIRMED findings (${report.findings.length}) — tool-verified, awaiting human review:`);
    for (const finding of report.findings) {
      console.log(`\n  [${finding.vulnClass}] ${finding.file}:${finding.line}  (${finding.severityHint})`);
      if (finding.permalink) console.log(`    permalink: ${finding.permalink}`);
      console.log(`    confirmed by: ${finding.confirmingTools.join(", ")}${finding.dynamicPoc ? " (dynamic PoC)" : finding.taintProven ? " (taint/static proof)" : ""}`);
      for (const ev of finding.evidence) console.log(`      - ${ev.tool}: ${ev.detail}`);
      console.log(`    PoC: ${finding.poc.filename} (${finding.poc.kind})`);
      console.log(`    Q1 (drafted for human): ${finding.q1Request.split("\n")[0]}`);
    }
  } else {
    console.log("\n✔ CONFIRMED findings: none. Honest empty — no tool proved a candidate.");
  }

  if (report.killedCount) console.log(`\nKilled at the gate (unconfirmed): ${report.killedCount}`);
  if (report.warnings.length) console.log(`\nwarnings:\n - ${report.warnings.join("\n - ")}`);
  if (report.emitted) console.log(`\nemitted:\n - report: ${report.emitted.reportPath}\n - audit store: ${report.emitted.auditStore} (alias: ${report.emitted.alias})\n - PoCs: ${report.emitted.pocFiles.join(", ") || "none"}`);
  console.log("\nHandoff: a human reviews each confirmed finding, confirms LIVE reachability (outside this tool), and files it.");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }
  const root = resolve(import.meta.dirname, "..");
  const configPath = flags.config ? String(flags.config) : "config/verify-loop.json";

  if (flags.listClasses) {
    const overrides = overridesFrom(flags);
    const config = await loadConfig({ root, configPath, overrides });
    const library = await loadTemplates({ root, templatesPath: config.templatesPath });
    console.log(`template library: ${library.source} (methodology: ${library.methodology}, ${library.templates.length} templates)`);
    console.log(`vuln classes:\n - ${allVulnClasses(library).join("\n - ")}`);
    return;
  }

  const overrides = overridesFrom(flags);
  const config = await loadConfig({ root, configPath, overrides });
  const report = await runVerifyLoop(config, { root, emit: Boolean(flags.emit) });

  const format = flags.format ?? "table";
  if (format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === "ndjson") process.stdout.write(`${report.findings.map((finding) => JSON.stringify(finding)).join("\n")}\n`);
  else printTable(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`verify-loop failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { parseArgs, overridesFrom };
