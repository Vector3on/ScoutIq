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
import {
  buildGithubMetadataQuery,
  detectRepositorySignals,
  enrichRepositoryCache,
  parseRepositoryTarget,
  repositoryCoverageGate,
  resolveGithubAuth,
  selectScanBlobs,
} from "../scripts/repo-enrichment.mjs";
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

test("unresolved repository hardening is null and adds no un-hardened bonus", () => {
  const unresolved = { status: "pending", fullName: "example/unresolved" };
  assert.equal(calculateHardeningIndex(unresolved), null);
  const result = evaluateTarget(
    program(),
    target({ type: "source-code", value: "https://github.com/example/unresolved" }),
    { now, repoSignals: unresolved, settings: { unknownProgramFloor: "MEDIUM" } },
  );
  assert.equal(result.hardeningIndex, null);
  assert.equal(result.pFindable, 0.056);
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

test("Electroneum replay fixture trips DEV_KNOWN and its dormant fork gate", () => {
  const tree = [
    { path: "core/types/priority_sig_binding_test.go", type: "blob", sha: "a", size: 3_000 },
    { path: "params/config.go", type: "blob", sha: "b", size: 8_000 },
  ];
  const scanPlan = selectScanBlobs(tree);
  assert.deepEqual(scanPlan.selected.map((item) => item.path).sort(), tree.map((item) => item.path).sort());
  const detected = detectRepositorySignals(tree, [
    {
      path: "core/types/priority_sig_binding_test.go",
      text: "// an attacker can replay a priority signature. This documents the vulnerability.",
    },
    {
      path: "params/config.go",
      text: "FutureForkBlock: big.NewInt(math.MaxInt64) // signature replay protection fork",
    },
  ]);
  assert.equal(detected.devKnown, true);
  assert.equal(detected.securityFixGated, true);
  assert.ok(detected.trapTags.includes("DEV_KNOWN"));
  assert.ok(detected.trapHits.some((hit) => hit.path === "core/types/priority_sig_binding_test.go"));
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
  assert.equal(parseRepositoryTarget("https://github.com/vercel/eve/tree/main").key, "vercel/eve");
  assert.equal(
    parseRepositoryTarget("https://github.com/immutable/ts-immutable-sdk/tree/main/packages/passport/#readme").key,
    "immutable/ts-immutable-sdk",
  );
  assert.equal(parseRepositoryTarget("https://gitlab.com/group/subgroup/project/-/tree/main").key, "gitlab.com/group/subgroup/project");
  assert.equal(parseRepositoryTarget("https://github.com/uphold/*"), null);
  assert.equal(parseRepositoryTarget("https://github.com/brave/*,%20https:"), null);
});

test("GitHub metadata query batches exactly 100 repositories", () => {
  const refs = Array.from({ length: 100 }, (_, index) => ({ owner: `owner${index}`, name: `repo${index}` }));
  const query = buildGithubMetadataQuery(refs, now).query;
  assert.equal((query.match(/repository\(owner:/g) ?? []).length, 100);
  assert.throws(() => buildGithubMetadataQuery([...refs, { owner: "overflow", name: "repo" }], now), /exceeds 100/);
});

test("repository enrichment backfills every source target in bounded 250-repo runs", async () => {
  const targets = Array.from({ length: 301 }, (_, index) => target({
    key: `repo:${index}`,
    type: "source-code",
    value: `https://github.com/example/repo-${index}`,
  }));
  const result = await enrichRepositoryCache([program({ targets })], { version: 3, repositories: {} }, {
    now,
    githubToken: "",
    logger: { error() {} },
  });
  assert.equal(result.stats.discovered, 301);
  assert.equal(result.stats.attempted, 250);
  assert.equal(result.stats.deferred, 51);
  assert.equal(result.stats.pending, 301);
  assert.equal(Object.keys(result.cache.repositories).length, 301);
  assert.equal(result.cache.repositories["example/repo-0"].stars, undefined);
});

test("a failed refresh never overwrites a good cached repository", async () => {
  const input = program({ targets: [target({ key: "repo", type: "source-code", value: "https://github.com/example/good" })] });
  const cached = {
    version: 3,
    generatedAt: "2026-09-01T00:00:00.000Z",
    repositories: {
      "github:example/good": { status: "ok", fullName: "example/good", fetchedAt: "2026-09-01T00:00:00.000Z", stars: 123, commits90d: 9 },
    },
  };
  const result = await enrichRepositoryCache([input], cached, {
    now,
    forceRefresh: true,
    githubToken: "",
    logger: { error() {} },
  });
  assert.equal(result.cache.repositories["example/good"].status, "ok");
  assert.equal(result.cache.repositories["example/good"].stars, 123);
  assert.match(result.cache.repositories["example/good"].lastError, /GH_PAT/);
});

test("GitHub PAT is sent as Bearer auth and startup rate limit is logged", async () => {
  const input = program({ targets: [target({ key: "repo", type: "source-code", value: "https://github.com/example/good" })] });
  const cached = {
    version: 4,
    generatedAt: now,
    repositories: {
      "example/good": { status: "ok", fullName: "example/good", fetchedAt: now, stars: 123, commits90d: 9 },
    },
  };
  const calls = [];
  const logs = [];
  const result = await enrichRepositoryCache([input], cached, {
    now,
    githubToken: "secret-test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization });
      return new Response(JSON.stringify({ resources: { core: { remaining: 4_999, limit: 5_000 }, graphql: { remaining: 4_998, limit: 5_000 } } }), { status: 200 });
    },
    logger: { info(message) { logs.push(message); }, error() {} },
  });
  assert.deepEqual(calls, [{ url: "https://api.github.com/rate_limit", authorization: "Bearer secret-test-token" }]);
  assert.equal(result.stats.startingRateLimit.coreRemaining, 4_999);
  assert.match(logs[0], /core remaining=4999\/5000/);
  assert.doesNotMatch(logs[0], /secret-test-token/);
});

test("an unset GH_PAT falls back to the authenticated Actions token", () => {
  assert.deepEqual(resolveGithubAuth({}, {
    GH_PAT: "",
    SCOUTIQ_GITHUB_TOKEN: "",
    GITHUB_TOKEN: "actions-token",
  }), { source: "GITHUB_TOKEN", token: "actions-token" });
});

test("coverage gate fails loudly at five repos and scales to the real denominator", () => {
  const targets = Array.from({ length: 190 }, (_, index) => ({
    repoSignals: { status: index < 5 ? "ok" : "pending" },
    hardeningIndex: index < 5 ? 20 : null,
  }));
  const partial = repositoryCoverageGate(targets, { configuredFloor: 400, ratio: 0.8 });
  assert.deepEqual(partial, {
    discoveredTargets: 190,
    numericHardeningTargets: 5,
    requiredHardeningTargets: 152,
    ratio: 5 / 190,
    ready: false,
  });
  targets.slice(5, 152).forEach((item) => { item.hardeningIndex = 20; });
  assert.equal(repositoryCoverageGate(targets, { configuredFloor: 400, ratio: 0.8 }).ready, true);
  const thousand = Array.from({ length: 1_000 }, () => ({ repoSignals: {}, hardeningIndex: null }));
  assert.equal(repositoryCoverageGate(thousand, { configuredFloor: 400, ratio: 0.8 }).requiredHardeningTargets, 400);
});

test("headline rewards above $50k have identical EV influence", () => {
  const context = { now, settings: { unknownProgramFloor: "MEDIUM", rewardCap: 50_000 } };
  const high = evaluateTarget(program({ maxReward: 3_000_000 }), target(), context);
  const capped = evaluateTarget(program({ maxReward: 50_000 }), target(), context);
  assert.equal(high.effectiveReward, 50_000);
  assert.equal(high.rewardCapped, true);
  assert.equal(high.evScore, capped.evScore);
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
