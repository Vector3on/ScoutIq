import assert from "node:assert/strict";
import test from "node:test";

import {
  mergePrograms,
  normalizeSource,
  reconcilePrograms,
  scoreProgram,
} from "../scripts/radar-core.mjs";

const source = {
  id: "yeswehack",
  label: "YesWeHack",
  platform: "YesWeHack",
  adapter: "yeswehack",
  homepage: "https://yeswehack.com/programs",
  programUrlTemplate: "https://yeswehack.com/programs/{id}",
  priority: 10,
  paidOnly: true,
};

test("normalizes a paid program and its inspectable targets", () => {
  const programs = normalizeSource(source, [{
    id: "small-open-source-program",
    name: "Small Open Source Program",
    public: true,
    disabled: false,
    min_bounty: 500,
    max_bounty: 15_000,
    targets: {
      in_scope: [
        { type: "source_code", target: "https://github.com/example/core" },
        { type: "api", target: "api.example.test" },
      ],
    },
  }]);

  assert.equal(programs.length, 1);
  assert.equal(programs[0].paid, true);
  assert.equal(programs[0].maxReward, 15_000);
  assert.equal(programs[0].sourceCode, true);
  assert.deepEqual(programs[0].tags, ["api", "source-code"]);
  assert.equal(programs[0].url, "https://yeswehack.com/programs/small-open-source-program");
});

test("detects an added target without treating the baseline as news", () => {
  const normalized = normalizeSource(source, [{
    id: "program",
    name: "Program",
    public: true,
    max_bounty: 5_000,
    targets: { in_scope: [{ type: "api", target: "api.example.test" }] },
  }]);
  const merged = mergePrograms(normalized);
  const baseline = reconcilePrograms(merged, [], "2026-09-02T00:00:00.000Z", { baseline: true });
  assert.equal(baseline.events.length, 0);
  assert.equal(baseline.programs[0].change.type, "baseline");

  const expanded = normalizeSource(source, [{
    id: "program",
    name: "Program",
    public: true,
    max_bounty: 5_000,
    targets: { in_scope: [
      { type: "api", target: "api.example.test" },
      { type: "source_code", target: "https://github.com/example/new-core" },
    ] },
  }]);
  const next = reconcilePrograms(mergePrograms(expanded), baseline.programs, "2026-09-02T01:00:00.000Z");
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].change.type, "new_target");
  assert.equal(next.events[0].change.addedTargets, 1);
});

test("keeps a missing program for one successful poll before removal", () => {
  const prior = [{
    id: "program:careful",
    name: "Careful",
    platform: "Self-hosted",
    url: "https://example.test/policy",
    status: "open",
    paid: true,
    currency: "USD",
    minReward: null,
    maxReward: 1_000,
    safeHarbor: null,
    disclosureAllowed: null,
    sourceIds: ["manual"],
    sourceCode: false,
    repositoryCount: 0,
    targetCount: 1,
    tags: ["web"],
    languages: [],
    targets: [{ key: "one", type: "web", value: "example.test", eligible: true }],
    localTestingHint: false,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    lastChangedAt: "2026-09-01T00:00:00.000Z",
    change: { type: "baseline", label: "Baseline import", at: "2026-09-01T00:00:00.000Z" },
    missingCount: 0,
    score: 1,
    scoreBreakdown: { freshness: 1, reward: 0, inspectability: 0, authorization: 0, friction: 0 },
    reasons: [],
    attentionPressure: "unknown",
  }];
  const firstMiss = reconcilePrograms([], prior, "2026-09-02T00:00:00.000Z");
  assert.equal(firstMiss.programs.length, 1);
  assert.equal(firstMiss.programs[0].status, "stale");
  const secondMiss = reconcilePrograms([], firstMiss.programs, "2026-09-02T01:00:00.000Z");
  assert.equal(secondMiss.programs.length, 0);
});

test("scores inspectable source code above an otherwise similar web scope", () => {
  const base = {
    change: { type: "new_target", at: "2026-09-02T00:00:00.000Z" },
    maxReward: 10_000,
    minReward: 1_000,
    paid: true,
    status: "open",
    safeHarbor: null,
    disclosureAllowed: null,
    repositoryCount: 0,
    targetCount: 2,
    languages: [],
    localTestingHint: false,
  };
  const web = scoreProgram({ ...base, sourceCode: false, tags: ["web"] }, "2026-09-02T00:00:00.000Z");
  const code = scoreProgram({ ...base, sourceCode: true, repositoryCount: 1, tags: ["source-code"], languages: ["rust"] }, "2026-09-02T00:00:00.000Z");
  assert.ok(code.score > web.score);
  assert.equal(code.attentionPressure, "lower");
});
