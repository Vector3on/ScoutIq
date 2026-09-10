// CONFIRM — step 3 of the hybrid loop (the deterministic tool step).
//
// Each candidate is routed to the confirmers named by its template. A confirmer
// either proves the property (static taint path and/or a working local PoC) or
// it does not. Confirmers that are not installed report "unavailable" — they
// never fabricate a verdict. This static-confirmation step is what kills the
// LLM stage's false positives.
//
// Verdict status: "confirmed" | "unconfirmed" | "unavailable" | "error".
//   confirmed   — the tool proved the property at this site.
//   unconfirmed — the tool ran but did not prove it (or a PoC needs completion).
//   unavailable — the tool (or its prerequisite) is not present/configured.
//   error       — the tool ran but failed unexpectedly.

import { basename, resolve } from "node:path";
import { isLocalInstanceUrl } from "./config.mjs";
import { runCommand as defaultRunCommand, truncate, which as defaultWhich } from "./io.mjs";

const SITE_WINDOW = 25;

function sameFile(a, b) {
  if (!a || !b) return false;
  return basename(a) === basename(b) || a.endsWith(b) || b.endsWith(a);
}

function nearLine(findingLines, candidateLine, window = SITE_WINDOW) {
  const lines = (Array.isArray(findingLines) ? findingLines : [findingLines]).map(Number).filter(Number.isFinite);
  if (!lines.length) return true; // file-level finding with no line — accept at file granularity
  return lines.some((line) => Math.abs(line - candidateLine) <= window);
}

// --- class → tool-rule maps ---------------------------------------------

const SLITHER_DETECTORS = {
  reentrancy: ["reentrancy-eth", "reentrancy-no-eth", "reentrancy-benign", "reentrancy-events", "reentrancy-unlimited-gas"],
  "missing-access-control": ["suicidal", "arbitrary-send-eth", "arbitrary-send-erc20", "arbitrary-send", "unprotected-upgrade"],
  "unprotected-selfdestruct": ["suicidal"],
  "unchecked-low-level-call": ["unchecked-lowlevel", "unchecked-send", "unchecked-transfer"],
  "dangerous-delegatecall": ["controlled-delegatecall", "delegatecall-loop"],
  "tx-origin-auth": ["tx-origin"],
};

const MYTHRIL_SWC = {
  reentrancy: ["107"],
  "missing-access-control": ["105", "106"],
  "unprotected-selfdestruct": ["106"],
  "unchecked-low-level-call": ["104"],
  "dangerous-delegatecall": ["112"],
  "tx-origin-auth": ["115"],
  "signature-replay": ["117", "121"],
};

const SEMGREP_KEYWORDS = {
  "sql-injection": ["sql"],
  "command-injection": ["command", "os-command", "exec", "child-process", "shell"],
  "path-traversal": ["path-traversal", "traversal", "lfi"],
  ssrf: ["ssrf"],
  xss: ["xss", "cross-site"],
  "insecure-deserialization": ["deserial", "pickle", "unserialize", "yaml-load"],
  "template-injection": ["template", "ssti", "jinja"],
  "prototype-pollution": ["prototype"],
  xxe: ["xxe", "xml-external", "xml"],
  "file-inclusion": ["lfi", "rfi", "file-inclusion", "include"],
  "broken-access-control": ["idor", "access-control", "authz", "authorization", "broken-access"],
};

const CODEQL_LANGUAGE = { "js-ts": "javascript", python: "python", go: "go", php: "cpp-unused" };

function keywordHit(haystack, keywords) {
  const text = String(haystack ?? "").toLowerCase();
  return keywords.some((word) => text.includes(word));
}

// --- tool output parsers (defensive) ------------------------------------

function parseSlither(stdout) {
  try {
    const json = JSON.parse(stdout);
    const detectors = json?.results?.detectors ?? [];
    return detectors.map((detector) => ({
      check: detector.check,
      impact: detector.impact,
      confidence: detector.confidence,
      description: truncate(detector.description, 300),
      elements: (detector.elements ?? []).map((element) => ({
        file: element.source_mapping?.filename_relative || element.source_mapping?.filename_short || element.source_mapping?.filename_absolute,
        lines: element.source_mapping?.lines ?? [],
      })),
    }));
  } catch {
    return null;
  }
}

function parseMythril(stdout) {
  try {
    const json = JSON.parse(stdout);
    const issues = [];
    const collect = (list) => {
      for (const issue of list ?? []) {
        const swc = String(issue.swcID ?? issue["swc-id"] ?? "").replace(/\D/g, "");
        const lines = [];
        if (Number.isFinite(Number(issue.lineno))) lines.push(Number(issue.lineno));
        for (const loc of issue.locations ?? []) {
          const n = Number(loc?.sourceMap?.split?.(":")?.[0]);
          if (Number.isFinite(n)) lines.push(n);
        }
        issues.push({ swc, title: issue.title ?? issue.description ?? "mythril issue", severity: issue.severity, file: issue.filename ?? issue.code ?? null, lines });
      }
    };
    if (Array.isArray(json)) for (const entry of json) collect(entry.issues);
    else collect(json.issues);
    return issues;
  } catch {
    return null;
  }
}

function parseSemgrep(stdout) {
  try {
    const json = JSON.parse(stdout);
    return (json.results ?? []).map((result) => ({
      checkId: result.check_id,
      file: result.path,
      line: result.start?.line,
      endLine: result.end?.line,
      message: truncate(result.extra?.message, 240),
      cwe: result.extra?.metadata?.cwe,
      owasp: result.extra?.metadata?.owasp,
      category: result.extra?.metadata?.category,
      hasTaint: Boolean(result.extra?.dataflow_trace),
    }));
  } catch {
    return null;
  }
}

function parseSarif(stdout) {
  try {
    const json = JSON.parse(stdout);
    const findings = [];
    for (const run of json.runs ?? []) {
      for (const result of run.results ?? []) {
        for (const location of result.locations ?? []) {
          const physical = location.physicalLocation;
          findings.push({
            ruleId: result.ruleId,
            file: physical?.artifactLocation?.uri,
            line: physical?.region?.startLine,
            message: truncate(result.message?.text, 240),
            hasTaint: Boolean(result.codeFlows?.length),
          });
        }
      }
    }
    return findings;
  } catch {
    return null;
  }
}

// Memoize a whole-repo scan per run so each tool runs once, not per candidate.
async function memo(cache, key, factory) {
  if (!cache.has(key)) cache.set(key, await factory());
  return cache.get(key);
}

// --- adapters ------------------------------------------------------------

const slither = {
  id: "slither",
  stacks: ["solidity"],
  kind: "static",
  async probe(ctx) {
    const path = await ctx.which("slither", ctx.config.tools?.slither);
    if (!path) return { id: this.id, available: false, reason: "slither not found on PATH" };
    const version = await ctx.runCommand(path, ["--version"], { timeoutMs: 10_000 });
    return { id: this.id, available: true, path, version: version.stdout.trim() || version.stderr.trim() };
  },
  async confirm(candidate, ctx) {
    const probe = ctx.probes.slither;
    if (!probe?.available) return { tool: this.id, status: "unavailable", kind: this.kind, detail: probe?.reason ?? "unavailable" };
    const mapped = SLITHER_DETECTORS[candidate.vulnClass];
    if (!mapped) return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: `no slither detector maps to ${candidate.vulnClass}` };

    const scan = await memo(ctx.cache, "slither", async () => {
      const run = await ctx.runCommand(probe.path, [ctx.targetPath, "--json", "-"], { timeoutMs: ctx.timeoutMs });
      return { parsed: parseSlither(run.stdout), run };
    });
    if (!scan.parsed) return { tool: this.id, status: "error", kind: this.kind, detail: truncate(scan.run.stderr || "slither produced no JSON", 240) };

    for (const detector of scan.parsed) {
      if (!mapped.includes(detector.check)) continue;
      for (const element of detector.elements) {
        if (sameFile(element.file, candidate.file) && nearLine(element.lines, candidate.line)) {
          return {
            tool: this.id,
            status: "confirmed",
            kind: this.kind,
            taintProven: true,
            evidence: { check: detector.check, impact: detector.impact, confidence: detector.confidence, lines: element.lines, file: element.file },
            detail: `slither ${detector.check} (impact ${detector.impact}, confidence ${detector.confidence}) at ${element.file}:${element.lines?.[0] ?? "?"}`,
          };
        }
      }
    }
    return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: `no matching slither detector at ${candidate.file}:${candidate.line}` };
  },
};

const mythril = {
  id: "mythril",
  stacks: ["solidity"],
  kind: "symbolic",
  async probe(ctx) {
    const path = (await ctx.which("myth", ctx.config.tools?.mythril)) || (await ctx.which("mythril", ctx.config.tools?.mythril));
    if (!path) return { id: this.id, available: false, reason: "mythril (myth) not found on PATH" };
    return { id: this.id, available: true, path };
  },
  async confirm(candidate, ctx) {
    const probe = ctx.probes.mythril;
    if (!probe?.available) return { tool: this.id, status: "unavailable", kind: this.kind, detail: probe?.reason ?? "unavailable" };
    const swcs = MYTHRIL_SWC[candidate.vulnClass];
    if (!swcs) return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: `no mythril SWC maps to ${candidate.vulnClass}` };

    const absFile = resolve(ctx.targetPath, candidate.file);
    const scan = await memo(ctx.cache, `mythril:${candidate.file}`, async () => {
      const run = await ctx.runCommand(probe.path, ["analyze", absFile, "-o", "jsonv2", "--execution-timeout", "60"], { timeoutMs: ctx.timeoutMs });
      return { parsed: parseMythril(run.stdout), run };
    });
    if (!scan.parsed) return { tool: this.id, status: "error", kind: this.kind, detail: truncate(scan.run.stderr || "mythril produced no JSON", 240) };

    for (const issue of scan.parsed) {
      if (swcs.includes(issue.swc) && (issue.lines.length === 0 || nearLine(issue.lines, candidate.line))) {
        return {
          tool: this.id,
          status: "confirmed",
          kind: this.kind,
          evidence: { swc: issue.swc, title: issue.title, severity: issue.severity, lines: issue.lines },
          detail: `mythril SWC-${issue.swc}: ${truncate(issue.title, 120)}`,
        };
      }
    }
    return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: `no matching mythril SWC at ${candidate.file}:${candidate.line}` };
  },
};

function makePocRunner(id, kind, { probeBin, envName }) {
  return {
    id,
    stacks: ["solidity"],
    kind,
    async probe(ctx) {
      const path = await ctx.which(probeBin, ctx.config.tools?.[id]);
      if (!path) return { id, available: false, reason: `${probeBin} not found on PATH` };
      return { id, available: true, path };
    },
    async confirm(candidate, ctx) {
      const probe = ctx.probes[id];
      if (!probe?.available) return { tool: id, status: "unavailable", kind, detail: probe?.reason ?? "unavailable" };
      // Auto-exploiting an arbitrary contract needs its ABI/semantics, so a raw
      // scaffold cannot self-confirm. Run only an operator-completed PoC.
      const pocPath = ctx.config.confirm?.[envName];
      if (!pocPath) {
        return { tool: id, status: "unconfirmed", kind, detail: `${probeBin} is installed; complete the generated ${id} PoC (or set confirm.${envName}) and re-run to confirm dynamically.`, needsPoc: true };
      }
      const isForge = probeBin === "forge";
      const run = await ctx.runCommand(probe.path, isForge ? ["test", "--match-path", pocPath] : [pocPath], { cwd: ctx.targetPath, timeoutMs: ctx.timeoutMs });
      // For forge, a PoC written to FAIL on a vulnerable target means exploit success.
      const exploited = isForge ? /\bFAIL/.test(run.stdout) : run.ok;
      if (exploited) {
        return { tool: id, status: "confirmed", kind, evidence: { poc: pocPath }, detail: `${id} PoC reproduced the exploit locally` };
      }
      return { tool: id, status: "unconfirmed", kind, detail: `${id} PoC ran but did not reproduce the exploit` };
    },
  };
}

const foundry = makePocRunner("foundry", "dynamic", { probeBin: "forge", envName: "foundryPocPath" });
const echidna = makePocRunner("echidna", "dynamic", { probeBin: "echidna", envName: "echidnaPocPath" });
const halmos = makePocRunner("halmos", "symbolic", { probeBin: "halmos", envName: "halmosTestPath" });

const semgrep = {
  id: "semgrep",
  stacks: ["js-ts", "python", "php", "go"],
  kind: "static",
  async probe(ctx) {
    const path = await ctx.which("semgrep", ctx.config.tools?.semgrep);
    if (!path) return { id: this.id, available: false, reason: "semgrep not found on PATH" };
    return { id: this.id, available: true, path };
  },
  async confirm(candidate, ctx) {
    const probe = ctx.probes.semgrep;
    if (!probe?.available) return { tool: this.id, status: "unavailable", kind: this.kind, detail: probe?.reason ?? "unavailable" };
    const keywords = SEMGREP_KEYWORDS[candidate.vulnClass] ?? [candidate.vulnClass];

    const scan = await memo(ctx.cache, "semgrep", async () => {
      const rules = ctx.config.tools?.semgrepRules || "auto";
      const run = await ctx.runCommand(probe.path, ["--json", "--quiet", "--config", rules, ctx.targetPath], { timeoutMs: ctx.timeoutMs });
      return { parsed: parseSemgrep(run.stdout), run };
    });
    if (!scan.parsed) return { tool: this.id, status: "error", kind: this.kind, detail: truncate(scan.run.stderr || "semgrep produced no JSON", 240) };

    for (const finding of scan.parsed) {
      const classMatch = keywordHit(finding.checkId, keywords) || keywordHit(finding.message, keywords) || keywordHit(String(finding.cwe ?? ""), keywords);
      if (!classMatch) continue;
      if (sameFile(finding.file, candidate.file) && nearLine([finding.line, finding.endLine], candidate.line)) {
        return {
          tool: this.id,
          status: "confirmed",
          kind: this.kind,
          taintProven: finding.hasTaint,
          evidence: { checkId: finding.checkId, cwe: finding.cwe, owasp: finding.owasp, line: finding.line, taint: finding.hasTaint },
          detail: `semgrep ${finding.checkId}${finding.hasTaint ? " (taint path proven)" : ""} at ${finding.file}:${finding.line}`,
        };
      }
    }
    return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: `no matching semgrep rule at ${candidate.file}:${candidate.line}` };
  },
};

const codeql = {
  id: "codeql",
  stacks: ["js-ts", "python", "go"],
  kind: "static",
  async probe(ctx) {
    const path = await ctx.which("codeql", ctx.config.tools?.codeql);
    if (!path) return { id: this.id, available: false, reason: "codeql not found on PATH" };
    return { id: this.id, available: true, path };
  },
  async confirm(candidate, ctx) {
    const probe = ctx.probes.codeql;
    if (!probe?.available) return { tool: this.id, status: "unavailable", kind: this.kind, detail: probe?.reason ?? "unavailable" };
    const language = CODEQL_LANGUAGE[candidate.stack];
    if (!language || language.endsWith("-unused")) return { tool: this.id, status: "unavailable", kind: this.kind, detail: `codeql has no query pack for ${candidate.stack}` };
    const dbPath = ctx.config.tools?.codeqlDb ? resolve(ctx.root, ctx.config.tools.codeqlDb) : "";
    if (!dbPath) return { tool: this.id, status: "unavailable", kind: this.kind, detail: "set tools.codeqlDb to a built CodeQL database (codeql database create) to run taint queries" };

    const scan = await memo(ctx.cache, `codeql:${language}`, async () => {
      const out = resolve(ctx.artifactDir || ctx.targetPath, `codeql-${language}.sarif`);
      const run = await ctx.runCommand(probe.path, ["database", "analyze", dbPath, `${language}-security-extended.qls`, "--format=sarifv2.1.0", `--output=${out}`, "--rerun"], { timeoutMs: ctx.timeoutMs });
      const sarif = await ctx.readText(out);
      return { parsed: parseSarif(sarif ?? ""), run };
    });
    if (!scan.parsed) return { tool: this.id, status: "error", kind: this.kind, detail: truncate(scan.run.stderr || "no SARIF output", 240) };

    const keywords = SEMGREP_KEYWORDS[candidate.vulnClass] ?? [candidate.vulnClass];
    for (const finding of scan.parsed) {
      if (!keywordHit(finding.ruleId, keywords) && !keywordHit(finding.message, keywords)) continue;
      if (sameFile(finding.file, candidate.file) && nearLine(finding.line, candidate.line)) {
        return {
          tool: this.id,
          status: "confirmed",
          kind: this.kind,
          taintProven: finding.hasTaint,
          evidence: { ruleId: finding.ruleId, line: finding.line, taint: finding.hasTaint },
          detail: `codeql ${finding.ruleId}${finding.hasTaint ? " (data flow proven)" : ""} at ${finding.file}:${finding.line}`,
        };
      }
    }
    return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: `no matching codeql result at ${candidate.file}:${candidate.line}` };
  },
};

const runtimeHarness = {
  id: "runtime-harness",
  stacks: ["js-ts", "python", "php", "go"],
  kind: "dynamic",
  async probe(ctx) {
    const baseUrl = ctx.config.localInstance?.baseUrl ?? "";
    const script = ctx.config.confirm?.runtimeHarnessScript ?? "";
    if (!script) return { id: this.id, available: false, reason: "confirm.runtimeHarnessScript not configured" };
    if (!baseUrl && !ctx.config.localInstance?.containerName) return { id: this.id, available: false, reason: "no localInstance.baseUrl/containerName configured" };
    if (baseUrl && !isLocalInstanceUrl(baseUrl)) return { id: this.id, available: false, reason: "localInstance.baseUrl is not a local address (clean-lane boundary)" };
    return { id: this.id, available: true, script, baseUrl };
  },
  async confirm(candidate, ctx) {
    const probe = ctx.probes["runtime-harness"];
    if (!probe?.available) return { tool: this.id, status: "unavailable", kind: this.kind, detail: probe?.reason ?? "unavailable" };
    // Clean-lane: re-check the base URL at execution time, never skippable.
    if (probe.baseUrl && !isLocalInstanceUrl(probe.baseUrl)) {
      return { tool: this.id, status: "error", kind: this.kind, detail: "refusing to run: localInstance.baseUrl is not a local address" };
    }
    const run = await ctx.runCommand(probe.script, [], {
      cwd: ctx.root,
      timeoutMs: ctx.timeoutMs,
      env: {
        VERIFY_BASE_URL: probe.baseUrl,
        VERIFY_VULN_CLASS: candidate.vulnClass,
        VERIFY_FILE: candidate.file,
        VERIFY_LINE: String(candidate.line),
        VERIFY_TOKEN: ctx.token,
        VERIFY_CONTAINER: ctx.config.localInstance?.containerName ?? "",
      },
    });
    const markerHit = ctx.token && run.stdout.includes(ctx.token);
    if (run.ok && markerHit) {
      return { tool: this.id, status: "confirmed", kind: this.kind, evidence: { marker: ctx.token, exit: run.code }, detail: "runtime harness reproduced the PoC against the local instance (sentinel observed)" };
    }
    if (run.ok) return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: "harness exited 0 but the sentinel was not observed" };
    return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: truncate(run.stderr || `harness exit ${run.code}`, 200) };
  },
};

const fuzzer = {
  id: "fuzzer",
  stacks: ["js-ts", "python", "php", "go"],
  kind: "dynamic",
  async probe(ctx) {
    const argv = ctx.config.confirm?.fuzzHarnessArgv ?? [];
    if (!argv.length) return { id: this.id, available: false, reason: "confirm.fuzzHarnessArgv not configured" };
    const bin = await ctx.which(argv[0], "");
    if (!bin) return { id: this.id, available: false, reason: `fuzz harness binary ${argv[0]} not found` };
    return { id: this.id, available: true, argv };
  },
  async confirm(candidate, ctx) {
    const probe = ctx.probes.fuzzer;
    if (!probe?.available) return { tool: this.id, status: "unavailable", kind: this.kind, detail: probe?.reason ?? "unavailable" };
    const run = await ctx.runCommand(probe.argv[0], probe.argv.slice(1), {
      cwd: ctx.root,
      timeoutMs: ctx.timeoutMs,
      env: { VERIFY_VULN_CLASS: candidate.vulnClass, VERIFY_FILE: candidate.file, VERIFY_LINE: String(candidate.line), VERIFY_TOKEN: ctx.token },
    });
    const markerHit = ctx.token && (run.stdout.includes(ctx.token) || run.stderr.includes(ctx.token));
    if (markerHit || /crash|AddressSanitizer|uncaught/i.test(run.stdout + run.stderr)) {
      return { tool: this.id, status: "confirmed", kind: this.kind, evidence: { exit: run.code }, detail: "fuzz harness produced a crash/sentinel for the candidate payload" };
    }
    return { tool: this.id, status: "unconfirmed", kind: this.kind, detail: "fuzz harness did not produce a crash/sentinel in the budget" };
  },
};

export const ADAPTERS = { slither, mythril, foundry, echidna, halmos, semgrep, codeql, "runtime-harness": runtimeHarness, fuzzer };

export function buildContext({ config, targetPath, root, cache = new Map(), token = "TOKEN", artifactDir, timeoutMs, runCommand = defaultRunCommand, which = defaultWhich, readText } = {}) {
  return {
    config,
    targetPath,
    root,
    cache,
    token,
    artifactDir,
    timeoutMs: timeoutMs ?? config?.confirm?.timeoutMs ?? 240_000,
    runCommand,
    which,
    readText: readText ?? (async () => null),
    probes: {},
  };
}

// Probe every adapter once; returns { [id]: probeResult }.
export async function probeRegistry(ctx, registry = ADAPTERS) {
  const probes = {};
  for (const adapter of Object.values(registry)) {
    probes[adapter.id] = await adapter.probe(ctx);
  }
  ctx.probes = probes;
  return probes;
}

// Route a candidate to its confirmers (named by the template, filtered to the
// candidate's stack and the installed registry).
export function routeConfirmers(candidate, registry = ADAPTERS) {
  return (candidate.confirmers ?? [])
    .map((id) => registry[id])
    .filter((adapter) => adapter && adapter.stacks.includes(candidate.stack));
}

// Run every routed confirmer for a candidate and aggregate the verdict.
export async function confirmCandidate(candidate, ctx, registry = ADAPTERS) {
  const adapters = routeConfirmers(candidate, registry);
  const verdicts = [];
  for (const adapter of adapters) {
    try {
      verdicts.push(await adapter.confirm(candidate, ctx));
    } catch (error) {
      verdicts.push({ tool: adapter.id, status: "error", kind: adapter.kind, detail: truncate(String(error?.message ?? error), 200) });
    }
  }
  const confirmed = verdicts.filter((verdict) => verdict.status === "confirmed");
  const dynamicConfirmed = confirmed.some((verdict) => verdict.kind === "dynamic");
  const taintProven = confirmed.some((verdict) => verdict.taintProven || verdict.kind === "static");
  return {
    confirmingTools: confirmed.map((verdict) => verdict.tool),
    confirmed: confirmed.length > 0,
    dynamicConfirmed,
    taintProven,
    verdicts,
  };
}
