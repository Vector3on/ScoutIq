# ScoutIQ v2

ScoutIQ ranks public bug bounty targets by estimated payable value, not by how interesting a repository looks.

```text
EV = min(max reward, $50k) × P(findable by us) × P(payable) × P(first)
```

The collector runs on GitHub Actions, writes static JSON, and serves a public dashboard. It uses no LLM and no paid backend. The official program policy always controls authorization.

ScoutIQ is public open-source software under the MIT License. All pipeline logic, scoring rules, trap evidence, tests, workflows, and generated public datasets are auditable in this repository. Credentials are never committed.

## Loam: the compounding intelligence substrate

`substrate/` contains **Loam**, a domain-agnostic, open-ended intelligence-and-automation substrate that runs unattended on free infrastructure: an event-sourced private memory, a quality-diversity archive of evolvable *ways of looking*, an active-inference attention planner, and an enforced policy layer (public data only, robots/ToS/rate limits, observe-only, no secrets or PII stored). Two example domains ship with it (arXiv literature monitoring and open-source ecosystem health) plus a synthetic toy world used to falsify its claims in CI. See [`substrate/README.md`](substrate/README.md), [`substrate/DESIGN.md`](substrate/DESIGN.md) and [`substrate/RUNBOOK.md`](substrate/RUNBOOK.md). Its heartbeat is `.github/workflows/loam.yml`.

## What changed in v2

- Routes each target to `live-web`, `live-api`, `live-contract`, `ai-agent`, `static-source`, or `static-source-hardened`.
- Enriches GitHub and GitLab targets with repository age, activity, new files, merged PR size, contributors, releases, languages, tree signals, security tooling, and advisories.
- Scrapes official policy pages incrementally to infer the lowest severity that can clear the configured payable reward.
- Detects developer-known issues, disabled security fixes, low-only parser DoS, and dormant deployed contracts.
- Permanently remembers completed audits in `data/audited.json`, unless fresh code rises by more than 40 points from the audit baseline.
- Hard-excludes traps before ranking. Excluded records retain `excludeReason` in JSON for auditability but never appear in the normal dashboard or CLI shortlist.
- Defaults to the top 25 positive-EV candidates and provides dedicated live and fresh-source lanes.

## Pipeline

```mermaid
flowchart TD
  A[Public bounty feeds] --> B[Normalize and diff]
  B --> C[Repo, policy, and chain caches]
  C --> D[Target class and workflow]
  D --> E[Hard exclusions]
  E --> F[EV ranking]
  F --> G[Static JSON and public dashboard]
```

Six discovery feeds currently cover HackerOne, Bugcrowd, Intigriti, YesWeHack, Federacy, and community-listed public programs. Feed data is discovery evidence, not permission.

## Scoring

### HardeningIndex

High means avoid:

```text
min(30, stars / 300)
+20 security tooling
+15 repo older than 4 years
+15 more than 100 contributors
+10 at least 3 resolved advisories
+10 mature-core keyword
```

### FreshCodeIndex

High means investigate:

```text
min(35, commits_90d / 2)
+min(25, files_added_90d × 3)
+20 merged PR over 800 additions
+20 target or repository added to the program within 45 days
```

### KnownIssueRisk

```text
+40 developer-known pattern
+30 open or recent advisory matching the path
+30 security fix gated behind a disabled flag or dormant fork
```

### Probabilities

```text
P_findable = clamp(
  0.15
  + 0.45 × FreshCodeIndex / 100
  + 0.30 × (100 - HardeningIndex) / 100  [measured repositories only]
  + 0.10 × proficiency_fit
)

P_payable = (ceiling >= program floor)
  × (1 - KnownIssueRisk / 100)
  × eligibility

P_first = clamp(
  0.2
  + 0.5 × (program age < 90 days)
  + 0.3 × crowd term
)
```

Mature crypto and hardened static-source classes receive explicit findability multipliers after the base formula. This encodes the observed failure rate of blind core-library review.

## Hard exclusions

A target is removed before ranking when any of these is true:

- Its plausible severity ceiling is below the program's payable floor.
- `HardeningIndex > 70` and `FreshCodeIndex < 25`.
- `KnownIssueRisk >= 60`.
- It is in `data/audited.json` and fresh code has not jumped by more than 40 points.
- It is closed, unpaid, target-ineligible, invite-only, KYC-required, explicitly unavailable to Indian researchers, or explicitly lacks required safe harbor.
- It is a deployed contract with an explicit `tx30d == 0` or `tvl == 0` signal.

Unknown is not silently converted to evidence. An unresolved repository has `hardeningIndex: null`, its hardening term is omitted from `P(findable)`, and its repository metrics remain `null`, never zero. Unparsed policy floors use the configurable conservative default and are labeled `conservative-default`. Chain dormancy only fires on configured explorer/RPC evidence.

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm ci
npm test
```

Run the next incremental batch of up to 250 stale or unresolved repositories:

```bash
npm run collect
```

Force a weekly refresh batch:

```bash
npm run collect:weekly
```

Query the default top 25:

```bash
npm run shortlist
```

Query only live services and contracts:

```bash
npm run shortlist -- --lane live
```

Query only source targets with `FreshCodeIndex > 50`:

```bash
npm run shortlist -- --lane fresh-source
```

Machine-readable output:

```bash
npm run shortlist -- --lane live --format json
```

## Configuration

`config/preferences.json` sets the desired minimum reward and initial reviewed list.

`config/program-overrides.json` stores verified policy facts that cannot be parsed reliably:

```json
{
  "defaults": {
    "researcherCountry": "IN",
    "minimumPayableReward": 1000,
    "unknownProgramFloor": "MEDIUM",
    "unknownResolvedReports": 25
  },
  "programs": {
    "program:example": {
      "programFloorSeverity": "HIGH",
      "excludedCountries": ["IN"],
      "safeHarborRequired": true,
      "noSafeHarbor": true
    }
  }
}
```

`config/live-targets.json` enables evidence-based EVM checks. Do not commit API keys; refer to Actions secret names:

```json
{
  "version": 1,
  "targets": [
    {
      "match": "Example Vault",
      "adapter": "evm",
      "chainId": 1,
      "address": "0x0000000000000000000000000000000000000000",
      "rpcUrlEnv": "EXAMPLE_RPC_URL",
      "explorerApiUrl": "https://api.etherscan.io/v2/api",
      "explorerApiKeyEnv": "ETHERSCAN_API_KEY"
    }
  ]
}
```

`data/audited.json` is persistent memory. Add the program or repository alias, verdict, date, note, and its FreshCodeIndex at audit time.

## GitHub Actions

`.github/workflows/radar.yml` runs at minute 17 each hour to discover changes and at 02:41 UTC each Sunday to force a refresh pass. Each run processes at most 250 missing or seven-day-stale repositories, so cache coverage accumulates instead of restarting. GitHub metadata is fetched in GraphQL batches of 100 repositories.

Add an Actions secret named `GH_PAT` containing a read-only fine-grained PAT for public repositories. Every GitHub REST and GraphQL request prefers it and sends `Authorization: Bearer`. The run starts by logging the authenticated REST and GraphQL rate-limit balance without exposing the token. The workflow falls back to the authenticated per-run `github.token`; if neither token exists, enrichment refuses to send anonymous requests. Add `GITLAB_TOKEN` only if public GitLab rate limits become a problem. Never commit either token.

Repository failures are emitted as `[repo-enrichment]` log lines and stored as explicit pending records with `lastError`; a failed refresh never overwrites a good cache entry and never writes zero-valued evidence. The public dataset is withheld unless at least 80% of discovered repository targets have numeric hardening evidence, capped at a 400-target absolute requirement. Cache progress is still committed on a failed coverage run, while the prior `programs.json` remains untouched.

The public dashboard loads the latest open JSON snapshot from `Vector3on/ScoutIq` on GitHub, then falls back to its bundled snapshot if GitHub Raw is unavailable. Data-only Actions commits therefore appear without a separate frontend deployment.

DEV_KNOWN detection scans prioritized test and source blobs for suspicious test filenames, known-vulnerability comments, and disabled security/fork gates. DOS_CEILING and DORMANT are computed as hard exclusion traps during EV evaluation. Regression fixtures cover Electroneum's public `priority_sig_binding_test.go` and `FutureForkBlock: math.MaxInt64`, plus a managed TON/RLP parser ceiling.

Scheduled runs do not install frontend dependencies. Source-change and manual runs execute the complete build and test suite. This keeps private-repository Actions usage low while still validating code changes.

## Output schema

`public/data/programs.json` retains the v1 fields and adds:

```text
hardeningIndex, freshCodeIndex, knownIssueRisk,
payableSeverityCeiling, programFloorSeverity, workflow,
pFindable, pPayable, pFirst, effectiveReward, rewardCap, evScore, traps,
repoSignals, liveState, excludeReason, honestReason
```

The same decision fields are attached to each public target. Full enrichment evidence remains in `data/repo_cache.json`; public JSON carries only the lean evidence needed to explain a rank.

## Files

```text
scripts/collect.mjs             orchestration and fail-soft snapshots
scripts/radar-core.mjs          feed normalization, dedupe, and change history
scripts/repo-enrichment.mjs     GitHub GraphQL/REST and GitLab enrichment
scripts/policy-enrichment.mjs   policy scraper and severity floor parser
scripts/live-enrichment.mjs     configured explorer/RPC live-state checks
scripts/ev-core.mjs             class map, indices, traps, hard filters, EV
scripts/query.mjs               default, live, and fresh-source CLI lanes
data/audited.json               persistent completed-audit memory
```

## Responsible use

Only test public programs you are personally eligible for, within the exact current policy. Use your own accounts and data. Do not test third parties, exceed permitted traffic, or treat a discovery feed as authorization.
