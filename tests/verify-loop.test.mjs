import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  detectStack,
  stackOfFile,
} from "../scripts/verify-loop/ingest.mjs";
import {
  loadTemplates,
  templatesFor,
  allVulnClasses,
  validateTemplate,
} from "../scripts/verify-loop/templates.mjs";
import {
  deterministicMatch,
  hypothesize,
  candidateId,
} from "../scripts/verify-loop/hypothesize.mjs";
import {
  isLocalInstanceUrl,
  validateConfig,
  loadConfig,
  mergeConfig,
} from "../scripts/verify-loop/config.mjs";
import {
  normalizeRemote,
  buildPermalink,
} from "../scripts/verify-loop/permalink.mjs";
import {
  buildContext,
  probeRegistry,
  routeConfirmers,
  confirmCandidate,
} from "../scripts/verify-loop/confirm.mjs";
import { applyGate, gateCandidates } from "../scripts/verify-loop/gate.mjs";
import { buildPoc, payloadFor, buildHttpRequest } from "../scripts/verify-loop/poc.mjs";
import { buildAuditEntry, persistAudit, aliasFromContext } from "../scripts/verify-loop/emit.mjs";
import { runVerifyLoop } from "../scripts/verify-loop/loop.mjs";
import { parseArgs, overridesFrom } from "../scripts/verify-loop.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const NOW = "2026-09-10T00:00:00.000Z";

const VULNERABLE_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
    }
}
`;

const VULNERABLE_JS = `const express = require("express");
const { exec } = require("child_process");
const app = express();
app.get("/ping", (req, res) => {
  exec("ping -c 1 " + req.query.host, (e, out) => res.send(out));
});
app.get("/user/:id", (req, res) => {
  db.findById(req.params.id).then((u) => res.send(u));
});
`;

async function makeFixtureRepo() {
  const dir = await mkdtemp(join(tmpdir(), "verify-loop-fixture-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "foundry.toml"), "[profile.default]\nsrc = 'src'\n");
  await writeFile(join(dir, "src", "Vault.sol"), VULNERABLE_SOL);
  await writeFile(join(dir, "server.js"), VULNERABLE_JS);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  return dir;
}

// ---------------------------------------------------------------- ingest

test("stackOfFile and detectStack classify by extension and markers", () => {
  assert.equal(stackOfFile("src/Vault.sol"), "solidity");
  assert.equal(stackOfFile("server.js"), "js-ts");
  assert.equal(stackOfFile("api.py"), "python");
  assert.equal(stackOfFile("README.md"), null);

  const detection = detectStack([
    { path: "src/Vault.sol" },
    { path: "foundry.toml" },
    { path: "server.js" },
    { path: "package.json" },
  ]);
  assert.ok(detection.stacks.some((entry) => entry.stack === "solidity"));
  assert.ok(detection.stacks.some((entry) => entry.stack === "js-ts"));
  assert.ok(["solidity", "js-ts"].includes(detection.primary));
});

test("detectStack honors a forced stack", () => {
  const detection = detectStack([{ path: "server.js" }], { forced: "python" });
  assert.equal(detection.primary, "python");
  assert.equal(detection.forced, true);
});

// ------------------------------------------------------------- templates

test("the seeded template library loads and covers all five stacks", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  assert.equal(library.rejected.length, 0);
  assert.ok(library.templates.length >= 30);
  for (const stack of ["solidity", "js-ts", "python", "php", "go"]) {
    assert.ok(templatesFor(library, stack).length > 0, `expected templates for ${stack}`);
  }
  assert.ok(allVulnClasses(library).includes("reentrancy"));
  assert.ok(allVulnClasses(library).includes("sql-injection"));
});

test("templatesFor filters by vuln class", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  const only = templatesFor(library, "solidity", ["reentrancy"]);
  assert.ok(only.length >= 1);
  assert.ok(only.every((template) => template.vulnClass === "reentrancy"));
});

test("validateTemplate reports missing fields", () => {
  assert.deepEqual(validateTemplate({ id: "x", vulnClass: "y", stacks: ["go"], scenario: "s", property: "p", confirmers: ["semgrep"] }), []);
  assert.ok(validateTemplate({ id: "x" }).length > 0);
});

test("a missing templates file falls back to the built-in library", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/does-not-exist.json" });
  assert.equal(library.source, "built-in fallback");
  assert.ok(library.templates.length >= 2);
});

// ----------------------------------------------------------- hypothesize

test("deterministic matcher flags the reentrancy sink in vulnerable Solidity", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  const sources = [{ path: "src/Vault.sol", stack: "solidity", text: VULNERABLE_SOL }];
  const candidates = deterministicMatch({ sources, library, activeStacks: ["solidity"], maxCandidates: 40 });
  const reentrancy = candidates.find((candidate) => candidate.vulnClass === "reentrancy");
  assert.ok(reentrancy, "expected a reentrancy candidate");
  assert.equal(reentrancy.file, "src/Vault.sol");
  assert.ok(reentrancy.line > 0);
  assert.equal(reentrancy.id, candidateId(reentrancy));
  // withdraw() with no owner check should also surface access control.
  assert.ok(candidates.some((candidate) => candidate.vulnClass === "missing-access-control"));
});

test("deterministic matcher flags command injection in vulnerable JS", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  const sources = [{ path: "server.js", stack: "js-ts", text: VULNERABLE_JS }];
  const candidates = deterministicMatch({ sources, library, activeStacks: ["js-ts"], maxCandidates: 40 });
  assert.ok(candidates.some((candidate) => candidate.vulnClass === "command-injection"));
  assert.ok(candidates.some((candidate) => candidate.vulnClass === "broken-access-control"));
});

test("negate signals suppress an already-mitigated match", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  const guarded = VULNERABLE_SOL.replace("function withdraw() external {", "function withdraw() external nonReentrant {");
  const sources = [{ path: "src/Vault.sol", stack: "solidity", text: guarded }];
  const candidates = deterministicMatch({ sources, library, activeStacks: ["solidity"], maxCandidates: 40 });
  assert.ok(!candidates.some((candidate) => candidate.vulnClass === "reentrancy"), "nonReentrant should suppress the reentrancy candidate");
});

test("hypothesize anthropic provider falls back to deterministic without a key", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  const sources = [{ path: "src/Vault.sol", stack: "solidity", text: VULNERABLE_SOL }];
  const config = { vulnClasses: [], hypothesizer: { provider: "anthropic", maxCandidates: 40, anthropic: { apiKeyEnv: "DEF_NOT_SET_KEY" } } };
  const result = await hypothesize(config, { sources, library, activeStacks: ["solidity"], env: {} });
  assert.equal(result.fellBack, true);
  assert.equal(result.provider, "anthropic-fallback");
  assert.ok(result.candidates.length > 0);
  assert.ok(result.warnings.join(" ").includes("fell back"));
});

test("hypothesize anthropic provider parses a Messages response and grounds candidates", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  const sources = [{ path: "src/Vault.sol", stack: "solidity", text: VULNERABLE_SOL }];
  const config = { vulnClasses: [], hypothesizer: { provider: "anthropic", maxCandidates: 40, anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-opus-5" } } };
  let capturedUrl;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    assert.equal(init.headers["x-api-key"], "test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "claude-opus-5");
    return {
      ok: true,
      async json() {
        return {
          stop_reason: "end_turn",
          content: [{ type: "text", text: '```json\n[{"file":"src/Vault.sol","line":8,"vulnClass":"reentrancy","templateId":"sol-reentrancy","confidence":0.95,"rationale":"call before state write"}]\n```' }],
        };
      },
    };
  };
  const result = await hypothesize(config, { sources, library, activeStacks: ["solidity"], env: { ANTHROPIC_API_KEY: "test-key" }, fetchImpl: fakeFetch });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.fellBack, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].vulnClass, "reentrancy");
  assert.ok(capturedUrl.endsWith("/v1/messages"));
});

test("hypothesize command provider grounds LLM-style JSON candidates", async () => {
  const library = await loadTemplates({ root: ROOT, templatesPath: "config/verify-templates.json" });
  const sources = [{ path: "src/Vault.sol", stack: "solidity", text: VULNERABLE_SOL }];
  const config = { vulnClasses: [], hypothesizer: { provider: "command", maxCandidates: 40, command: { argv: ["fake-llm"] } } };
  const fakeRun = async () => ({ ok: true, stdout: JSON.stringify([{ file: "src/Vault.sol", line: 8, vulnClass: "reentrancy", templateId: "sol-reentrancy", confidence: 0.9, rationale: "external call before state update" }]), stderr: "" });
  const result = await hypothesize(config, { sources, library, activeStacks: ["solidity"], env: {}, runCommandImpl: fakeRun });
  assert.equal(result.provider, "command");
  assert.equal(result.fellBack, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].vulnClass, "reentrancy");
  assert.equal(result.candidates[0].proposedBy, "command");
});

// --------------------------------------------------- clean-lane boundary

test("isLocalInstanceUrl accepts loopback/private and rejects public hosts", () => {
  for (const ok of ["http://127.0.0.1:8080", "http://localhost:3000", "https://10.1.2.3", "http://192.168.0.5/app", "http://172.16.9.9", "http://host.docker.internal:8000", "http://api.localhost"]) {
    assert.equal(isLocalInstanceUrl(ok), true, `${ok} should be local`);
  }
  for (const bad of ["http://example.com", "https://1.2.3.4", "http://169.254.169.254.nip.io", "https://metadata.google.internal", "ftp://127.0.0.1", "not a url"]) {
    assert.equal(isLocalInstanceUrl(bad), false, `${bad} should be rejected`);
  }
});

test("validateConfig rejects a non-local instance URL (hard clean-lane stop)", async () => {
  const config = await loadConfig({ root: ROOT, configPath: "config/verify-loop.json", overrides: { localInstance: { baseUrl: "http://example.com" } } });
  const result = validateConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.join(" ").includes("not a local address"));

  const okConfig = await loadConfig({ root: ROOT, configPath: "config/verify-loop.json", overrides: { localInstance: { baseUrl: "http://127.0.0.1:8080" } } });
  assert.equal(validateConfig(okConfig).ok, true);
});

test("validateConfig rejects unknown stack and provider", () => {
  assert.equal(validateConfig({ stack: "rust", hypothesizer: { provider: "deterministic" } }).ok, false);
  assert.equal(validateConfig({ stack: "auto", hypothesizer: { provider: "telepathy" } }).ok, false);
  assert.equal(validateConfig({ stack: "auto", hypothesizer: { provider: "command", command: { argv: [] } } }).ok, false);
});

test("mergeConfig deep-merges objects and replaces arrays", () => {
  const merged = mergeConfig({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

// -------------------------------------------------------------- permalink

test("normalizeRemote handles ssh, scp, and https remotes", () => {
  assert.equal(normalizeRemote("git@github.com:acme/vault.git"), "https://github.com/acme/vault");
  assert.equal(normalizeRemote("https://github.com/acme/vault.git"), "https://github.com/acme/vault");
  assert.equal(normalizeRemote("ssh://git@gitlab.com/acme/vault"), "https://gitlab.com/acme/vault");
  assert.equal(normalizeRemote(""), null);
});

test("buildPermalink pins a line on a commit", () => {
  assert.equal(
    buildPermalink({ base: "https://github.com/acme/vault", ref: "abc123", path: "src/Vault.sol", line: 8 }),
    "https://github.com/acme/vault/blob/abc123/src/Vault.sol#L8",
  );
  assert.equal(buildPermalink({ base: "", ref: "x", path: "y" }), null);
});

// ---------------------------------------------------------------- confirm

function fakeSlitherJson() {
  return JSON.stringify({
    results: {
      detectors: [
        {
          check: "reentrancy-eth",
          impact: "High",
          confidence: "Medium",
          description: "Reentrancy in Vault.withdraw()",
          elements: [{ source_mapping: { filename_relative: "src/Vault.sol", lines: [7, 8, 9, 10] } }],
        },
      ],
    },
  });
}

function reentrancyCandidate() {
  return {
    id: "cand1",
    templateId: "sol-reentrancy",
    vulnClass: "reentrancy",
    stack: "solidity",
    file: "src/Vault.sol",
    line: 8,
    confirmers: ["slither", "foundry", "echidna"],
    poc: "foundry",
    severityHint: "HIGH",
    property: "state before external call",
    q1Template: "re-enter before the call returns",
  };
}

test("routeConfirmers keeps only stack-applicable confirmers", () => {
  const routed = routeConfirmers(reentrancyCandidate());
  const ids = routed.map((adapter) => adapter.id);
  assert.deepEqual(ids, ["slither", "foundry", "echidna"]);
  // a web confirmer on a solidity candidate is dropped
  assert.deepEqual(routeConfirmers({ stack: "solidity", confirmers: ["semgrep"] }).map((a) => a.id), []);
});

test("slither adapter confirms a mapped detector at the candidate site", async () => {
  const fakeWhich = async (binary) => (binary === "slither" ? "/usr/bin/slither" : null);
  const fakeRun = async (bin, args) => {
    if (args.includes("--version")) return { ok: true, stdout: "0.10.4", stderr: "" };
    if (args.includes("--json")) return { ok: true, stdout: fakeSlitherJson(), stderr: "" };
    return { ok: false, stdout: "", stderr: "unexpected" };
  };
  const ctx = buildContext({ config: { confirm: { timeoutMs: 1000 } }, targetPath: "/tmp/target", root: "/tmp", which: fakeWhich, runCommand: fakeRun });
  await probeRegistry(ctx);
  const result = await confirmCandidate(reentrancyCandidate(), ctx);
  assert.equal(result.confirmed, true);
  assert.ok(result.confirmingTools.includes("slither"));
  assert.equal(result.taintProven, true);
  const slitherVerdict = result.verdicts.find((v) => v.tool === "slither");
  assert.equal(slitherVerdict.status, "confirmed");
  assert.equal(slitherVerdict.evidence.check, "reentrancy-eth");
  // foundry/echidna are installed-absent here → unavailable, not confirmed.
  assert.equal(result.verdicts.find((v) => v.tool === "foundry").status, "unavailable");
});

test("foundry adapter confirms a completed PoC that FAILs on a vulnerable target (dynamic)", async () => {
  const fakeWhich = async (binary) => (binary === "forge" ? "/usr/bin/forge" : null);
  const fakeRun = async (bin, args) => {
    if (Array.isArray(args) && args.includes("test")) return { ok: false, stdout: "Running 1 test...\n[FAIL: reentrancy drained] test_reentrancy()\n", stderr: "" };
    return { ok: false, stdout: "", stderr: "" };
  };
  const ctx = buildContext({
    config: { confirm: { timeoutMs: 1000, foundryPocPath: "test/verify/Poc.t.sol" } },
    targetPath: "/tmp/target",
    root: "/tmp",
    which: fakeWhich,
    runCommand: fakeRun,
  });
  await probeRegistry(ctx);
  const candidate = { ...reentrancyCandidate(), confirmers: ["foundry"] };
  const result = await confirmCandidate(candidate, ctx);
  assert.equal(result.confirmed, true);
  assert.equal(result.dynamicConfirmed, true);
  const verdict = result.verdicts.find((v) => v.tool === "foundry");
  assert.equal(verdict.status, "confirmed");
  assert.equal(verdict.kind, "dynamic");
});

test("with no confirmers installed every candidate is unconfirmed", async () => {
  const noTools = async () => null;
  const ctx = buildContext({ config: { confirm: { timeoutMs: 1000 } }, targetPath: "/tmp/target", root: "/tmp", which: noTools, runCommand: async () => ({ ok: false, stdout: "", stderr: "" }) });
  await probeRegistry(ctx);
  const result = await confirmCandidate(reentrancyCandidate(), ctx);
  assert.equal(result.confirmed, false);
  assert.ok(result.verdicts.every((verdict) => verdict.status === "unavailable"));
});

// ------------------------------------------------------------------- gate

test("applyGate keeps confirmed candidates and kills the rest", () => {
  assert.equal(applyGate({ confirmed: true, confirmingTools: ["slither"], dynamicConfirmed: false, taintProven: true, verdicts: [] }).survives, true);
  assert.equal(applyGate({ confirmed: false, confirmingTools: [], dynamicConfirmed: false, taintProven: false, verdicts: [{ status: "unconfirmed" }] }).survives, false);
});

test("requireDynamicPoc kills static-only confirmations", () => {
  const staticOnly = { confirmed: true, confirmingTools: ["slither"], dynamicConfirmed: false, taintProven: true, verdicts: [] };
  assert.equal(applyGate(staticOnly, { requireDynamicPoc: true }).survives, false);
  const dynamic = { confirmed: true, confirmingTools: ["runtime-harness"], dynamicConfirmed: true, taintProven: false, verdicts: [] };
  assert.equal(applyGate(dynamic, { requireDynamicPoc: true }).survives, true);
});

test("gateCandidates partitions survivors and killed", () => {
  const evaluations = [
    { candidate: { id: "a" }, confirmation: { confirmed: true, confirmingTools: ["slither"], dynamicConfirmed: false, taintProven: true, verdicts: [] } },
    { candidate: { id: "b" }, confirmation: { confirmed: false, confirmingTools: [], dynamicConfirmed: false, taintProven: false, verdicts: [{ status: "unavailable" }] } },
  ];
  const { survivors, killed } = gateCandidates(evaluations);
  assert.equal(survivors.length, 1);
  assert.equal(killed.length, 1);
  assert.equal(survivors[0].candidate.id, "a");
  assert.ok(survivors[0].gate.survives);
});

// -------------------------------------------------------------------- poc

test("payloadFor and buildHttpRequest produce LOCAL-only drafts with the token", () => {
  const payload = payloadFor("command-injection", "ABCD");
  assert.equal(payload.marker, "VERIFY-ABCD");
  const request = buildHttpRequest({ vulnClass: "command-injection", file: "server.js", line: 5 }, { baseUrl: "http://127.0.0.1:3000", token: "ABCD" });
  assert.ok(request.includes("LOCAL-ONLY"));
  assert.ok(request.includes("http://127.0.0.1:3000"));
  assert.ok(request.includes("VERIFY-ABCD"));
});

test("buildPoc selects foundry scaffold for a contract candidate", () => {
  const poc = buildPoc(reentrancyCandidate(), { baseUrl: "", token: "T" });
  assert.equal(poc.kind, "foundry");
  assert.ok(poc.filename.endsWith(".t.sol"));
  assert.ok(poc.content.includes("forge-std/Test.sol"));
  assert.ok(poc.q1.includes("Q1"));
});

// ------------------------------------------------------------------- emit

test("buildAuditEntry follows the audited.json convention and attaches evidence", () => {
  const findings = [{
    vulnClass: "reentrancy", file: "src/Vault.sol", line: 8, permalink: "https://github.com/acme/vault/blob/abc/src/Vault.sol#L8",
    confirmingTools: ["slither"], dynamicPoc: false, taintProven: true, evidence: [{ tool: "slither", detail: "reentrancy-eth" }],
    poc: { filename: "cand1.t.sol" }, q1Request: "Q1 ...",
  }];
  const entry = buildAuditEntry({ alias: "acme/vault", findings, candidateCount: 3, killedCount: 2, now: NOW, provider: "deterministic", commit: { base: "https://github.com/acme/vault", ref: "abc" }, targetPath: "/t" });
  assert.equal(entry.verdict, "confirmed-findings");
  assert.deepEqual(entry.aliases, ["acme/vault"]);
  assert.equal(entry.filed, false);
  assert.equal(entry.verifyLoop.confirmedCount, 1);
  assert.equal(entry.verifyLoop.findings[0].confirmingTools[0], "slither");
  assert.ok(Object.prototype.hasOwnProperty.call(entry, "freshCodeIndexAtAudit"));

  const empty = buildAuditEntry({ alias: "acme/vault", findings: [], candidateCount: 5, killedCount: 5, now: NOW, provider: "deterministic", commit: null, targetPath: "/t" });
  assert.equal(empty.verdict, "no-confirmed-findings");
});

test("persistAudit writes a convention-compatible store and preserves existing entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verify-loop-audit-"));
  const storeName = "verify-loop.json";
  const entry1 = buildAuditEntry({ alias: "acme/one", findings: [], candidateCount: 1, killedCount: 1, now: NOW, provider: "deterministic", commit: null, targetPath: "/t" });
  await persistAudit({ root: dir, auditStore: storeName, alias: "acme/one", entry: entry1, now: NOW });
  const entry2 = buildAuditEntry({ alias: "acme/two", findings: [], candidateCount: 1, killedCount: 1, now: NOW, provider: "deterministic", commit: null, targetPath: "/t" });
  await persistAudit({ root: dir, auditStore: storeName, alias: "acme/two", entry: entry2, now: NOW });

  const store = JSON.parse(await readFile(resolve(dir, storeName), "utf8"));
  assert.equal(store.version, 1);
  assert.ok(store.entries["acme/one"]);
  assert.ok(store.entries["acme/two"]);
  assert.ok(Array.isArray(store.entries["acme/one"].aliases));
});

test("aliasFromContext derives owner/repo from the permalink base", () => {
  assert.equal(aliasFromContext({ commit: { base: "https://github.com/acme/vault" } }), "acme/vault");
  assert.equal(aliasFromContext({ targetPath: "/home/user/Cool-Repo" }), "cool-repo");
});

// --------------------------------------------------------- end-to-end loop

test("end-to-end: no confirmers installed → honest empty result", async () => {
  const dir = await makeFixtureRepo();
  const config = await loadConfig({
    root: ROOT,
    configPath: "config/verify-loop.json",
    overrides: { target: { repoPath: dir, permalinkBase: "https://github.com/acme/vault", ref: "deadbeef" }, stack: "solidity" },
  });
  const report = await runVerifyLoop(config, {
    root: dir,
    now: NOW,
    token: "TESTTOKEN",
    which: async () => null, // nothing installed
    runCommand: async () => ({ ok: false, stdout: "", stderr: "not installed" }),
  });
  assert.ok(report.hypotheses.length > 0, "matcher should propose candidates");
  assert.equal(report.findings.length, 0, "no tool available → nothing survives the gate");
  assert.ok(report.killedCount > 0);
  assert.ok(Object.values(report.tools).every((probe) => probe.available === false));
});

test("end-to-end: fake slither confirms → a finding with permalink, PoC, and Q1 is emitted", async () => {
  const dir = await makeFixtureRepo();
  const fakeWhich = async (binary) => (binary === "slither" ? "/usr/bin/slither" : null);
  const fakeRun = async (bin, args) => {
    if (Array.isArray(args) && args.includes("--version")) return { ok: true, stdout: "0.10.4", stderr: "" };
    if (Array.isArray(args) && args.includes("--json")) return { ok: true, stdout: fakeSlitherJson(), stderr: "" };
    return { ok: false, stdout: "", stderr: "" };
  };
  const config = await loadConfig({
    root: ROOT,
    configPath: "config/verify-loop.json",
    overrides: {
      target: { repoPath: dir, permalinkBase: "https://github.com/acme/vault", ref: "deadbeef" },
      stack: "solidity",
      vulnClasses: ["reentrancy"],
      auditStore: "audit-out.json",
    },
  });
  const report = await runVerifyLoop(config, {
    root: dir,
    now: NOW,
    token: "TESTTOKEN",
    emit: true,
    which: fakeWhich,
    runCommand: fakeRun,
  });

  const finding = report.findings.find((f) => f.vulnClass === "reentrancy");
  assert.ok(finding, "expected a confirmed reentrancy finding");
  assert.ok(finding.confirmingTools.includes("slither"));
  assert.equal(finding.permalink, "https://github.com/acme/vault/blob/deadbeef/src/Vault.sol#L8");
  assert.equal(finding.filed, false);
  assert.equal(finding.handoff, "human-review");
  assert.ok(finding.poc.content.includes("forge-std/Test.sol"));
  assert.ok(finding.q1Request.includes("Q1"));
  assert.ok(finding.evidence.some((ev) => ev.tool === "slither" && ev.detail.includes("reentrancy-eth")));

  // emitted to the audit store following the convention
  assert.ok(report.emitted);
  const store = JSON.parse(await readFile(resolve(dir, "audit-out.json"), "utf8"));
  const alias = report.emitted.alias;
  assert.equal(store.entries[alias].verdict, "confirmed-findings");
  assert.equal(store.entries[alias].verifyLoop.confirmedCount, 1);
});

test("runVerifyLoop throws on a non-local instance URL before doing any work", async () => {
  const dir = await makeFixtureRepo();
  const config = await loadConfig({
    root: ROOT,
    configPath: "config/verify-loop.json",
    overrides: { target: { repoPath: dir }, localInstance: { baseUrl: "http://evil.example.com" } },
  });
  await assert.rejects(() => runVerifyLoop(config, { root: dir, now: NOW, which: async () => null }), /not a local address/);
});

// -------------------------------------------------------------------- CLI

test("CLI parseArgs and overridesFrom build a config overlay", () => {
  const flags = parseArgs(["--target", "/x", "--stack", "go", "--classes", "ssrf,sql-injection", "--provider", "anthropic", "--emit"]);
  assert.equal(flags.target, "/x");
  assert.equal(flags.emit, true);
  const overrides = overridesFrom(flags);
  assert.equal(overrides.target.repoPath, "/x");
  assert.equal(overrides.stack, "go");
  assert.deepEqual(overrides.vulnClasses, ["ssrf", "sql-injection"]);
  assert.equal(overrides.hypothesizer.provider, "anthropic");
});
