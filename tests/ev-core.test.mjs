import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateFreshCodeIndex,
  calculateHardeningIndex,
  calculateKnownIssueRisk,
  evaluateProgram,
  evaluateTarget,
} from "../scripts/ev-core.mjs";
import { extractPolicySignals } from "../scripts/policy-enrichment.mjs";
import { detectRepositorySignals, parseRepositoryTarget } from "../scripts/repo-enrichment.mjs";
import { shortlist } from "../scripts/query.mjs";

const now = "2026-09-03T00:00:00.000Z";

function program(overrides = {}) {
  return {
    id: "program:example",
    name: "Example",
    platform: "Public",
    url: "https://example.test/policy",
    status: "open",
    paid: true,
    currency: "USD",
    minReward: 500,
    maxReward: 20_000,
    safeHarbor: "full",
    tags: [],
    languages: [],
    launchedAt: "2025-01-01T00:00:00.000Z",
    resolvedReports: 4,
    change: { type: "baseline", at: now, label: "Baseline" },
    targets: [],
    ...overrides,
  };
}

function target(overrides = {}) {
  return { key: "target:one", type: "web", value: "https://app.example.test", eligible: true, ...overrides };
}

test("implements the hardening and fresh-code formulas", () => {
  const repo = {
    status: "ok",
    fullName: "example/wallet-core",
    stars: 9_000,
    ageY: 6,
    contributorsCount: 101,
    advisories: { resolved: 3 },
    secTooling: true,
    commits90d: 70,
    filesAdded90d: 9,
    maxMergedPrAdditions90d: 801,
  };
  assert.equal(calculateHardeningIndex(repo, "crypto signing"), 100);
  assert.equal(calculateFreshCodeIndex(repo, { recentScope: true }), 100);
});

test("managed-language parser DoS is hard-excluded below a medium floor", () => {
  const result = evaluateTarget(
    program({ languages: ["go"] }),
    target({ type: "source-code", value: "https://github.com/example/protobuf-parser" }),
    {
      now,
      repoSignals: { status: "ok", fullName: "example/protobuf-parser", languages: { go: 100 }, ageY: 1 },
      settings: { unknownProgramFloor: "MEDIUM" },
    },
  );
  assert.equal(result.payableSeverityCeiling, "LOW");
  assert.ok(result.traps.includes("DOS_CEILING"));
  assert.match(result.excludeReason, /below the MEDIUM program floor/);
  assert.equal(result.evScore, 0);
});

test("live auth routes to ATO with a critical ceiling and nonzero EV", () => {
  const result = evaluateTarget(
    program({ name: "OIDC Account Link", launchedAt: "2026-08-20T00:00:00.000Z", resolvedReports: 0 }),
    target({ type: "web", value: "https://login.example.test/account-link" }),
    { now, settings: { unknownProgramFloor: "MEDIUM" } },
  );
  assert.equal(result.workflow, "live-web");
  assert.equal(result.findableClass, "account-takeover");
  assert.equal(result.payableSeverityCeiling, "CRITICAL");
  assert.equal(result.pFirst, 1);
  assert.ok(result.evScore > 0);
});

test("developer-known and gated security behavior reaches the hard risk cutoff", () => {
  const detected = detectRepositorySignals(
    [{ path: "tests/security_replay_test.go", type: "blob" }],
    [{ path: "tests/security_replay_test.go", text: "// known issue: security replay fix\nif false { enableFix() }" }],
  );
  assert.equal(detected.devKnown, true);
  assert.equal(detected.securityFixGated, true);
  assert.equal(calculateKnownIssueRisk(detected), 70);
});

test("audited targets stay excluded until fresh code jumps by more than 40", () => {
  const audited = { entries: { example: { verdict: "hardened", date: "2026-09-01", freshCodeIndexAtAudit: 0, aliases: ["example/core"] } } };
  const base = { status: "ok", fullName: "example/core", languages: { typescript: 100 }, ageY: 1, commits90d: 20, filesAdded90d: 1 };
  const closed = evaluateTarget(program(), target({ type: "source-code", value: "https://github.com/example/core" }), {
    now,
    audited,
    repoSignals: base,
    settings: { unknownProgramFloor: "MEDIUM" },
  });
  assert.match(closed.excludeReason, /audited hardened target/);

  const reopened = evaluateTarget(program(), target({ type: "source-code", value: "https://github.com/example/core" }), {
    now,
    audited,
    repoSignals: { ...base, commits90d: 40, filesAdded90d: 8 },
    settings: { unknownProgramFloor: "MEDIUM" },
  });
  assert.equal(reopened.freshCodeIndex > 40, true);
  assert.equal(reopened.excludeReason, null);
});

test("explicitly dormant deployed contracts are excluded", () => {
  const result = evaluateTarget(
    program({ name: "Solidity Vault", tags: ["smart-contract"], languages: ["solidity"] }),
    target({ type: "smart-contract", value: "0x0000000000000000000000000000000000000001" }),
    {
      now,
      liveState: { deployed: true, verified: true, tx30d: 0, tvl: 10 },
      settings: { unknownProgramFloor: "MEDIUM" },
    },
  );
  assert.ok(result.traps.includes("DORMANT"));
  assert.match(result.excludeReason, /zero recent use or value/);
});

test("program selects a payable live target instead of its excluded parser repo", () => {
  const input = program({
    name: "Login Platform",
    tags: ["web", "source-code"],
    languages: ["go"],
    targets: [
      target({ key: "repo", type: "source-code", value: "https://github.com/example/protobuf-parser" }),
      target({ key: "login", type: "web", value: "https://login.example.test/oauth" }),
    ],
  });
  const result = evaluateProgram(input, {
    now,
    targetContexts: new Map([["repo", { repoSignals: { status: "ok", fullName: "example/protobuf-parser", languages: { go: 1 }, ageY: 2 } }]]),
    settings: { unknownProgramFloor: "MEDIUM" },
  });
  assert.equal(result.bestTargetKey, "login");
  assert.equal(result.workflow, "live-web");
  assert.equal(result.excludeReason, null);
});

test("policy parser derives the user's payable severity floor and restrictions", () => {
  const signals = extractPolicySignals(
    "Low $100. Medium $1,500. High $8,000. Critical $25,000. KYC is required. Researchers in India are not eligible. 12 resolved reports.",
    { minimumPayableReward: 1_000 },
  );
  assert.equal(signals.programFloorSeverity, "MEDIUM");
  assert.equal(signals.kycRequired, true);
  assert.deepEqual(signals.excludedCountries, ["IN"]);
  assert.equal(signals.resolvedReports, 12);
});

test("parses GitHub and nested GitLab repository targets", () => {
  assert.equal(parseRepositoryTarget("https://github.com/vercel/eve/tree/main").key, "github:vercel/eve");
  assert.equal(parseRepositoryTarget("https://gitlab.com/group/subgroup/project/-/tree/main").key, "gitlab:group/subgroup/project");
});

test("default, live, and fresh-source shortlists route honestly", () => {
  const rows = [
    { name: "Live", workflow: "live-web", evScore: 100, excludeReason: null },
    { name: "Fresh", workflow: "static-source", freshCodeIndex: 70, evScore: 90, excludeReason: null },
    { name: "Hardened", workflow: "static-source-hardened", freshCodeIndex: 10, evScore: 80, excludeReason: null },
    { name: "Excluded", workflow: "live-api", evScore: 0, excludeReason: "known" },
  ];
  assert.deepEqual(shortlist(rows).map((row) => row.name), ["Live", "Fresh"]);
  assert.deepEqual(shortlist(rows, { lane: "live" }).map((row) => row.name), ["Live"]);
  assert.deepEqual(shortlist(rows, { lane: "fresh-source" }).map((row) => row.name), ["Fresh"]);
});
