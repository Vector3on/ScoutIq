# ScoutIQ source-audit toolkit

An executable version of the **100-point systematic bug-bounty methodology**. ScoutIQ's radar tells you *which* authorized target is worth your time; this toolkit helps you *work* one, in the white-box (SRC) lane, without ever leaving the disciplined path ScoutIQ already stands for.

**It never sends a request to a live target.** The scanner reads local source and emits *seeds*. The scope guard is a fail-closed gate for the live lane, which **you** run yourself, against scope you have personally verified, under safe harbor. A discovery feed, this repo, and these files are **not** authorization — the official program policy always is.

## What's here

| File | Role |
|---|---|
| `audit/methodology.json` | All 100 methodology items, machine-readable (section, lane, priority, CWE, and the **Q1** attacker-request prompt). |
| `audit/detectors.json` | Static SRC-lane detectors (~40 signatures across ~23 items), each with an honest confidence and a **KILL-unless** condition. |
| `scripts/audit-core.mjs` | The engine: regex + function detectors, entropy gating, secret redaction, dedup, honest priority×confidence ranking. Pure and unit-tested. |
| `scripts/audit.mjs` | CLI: scan a checked-out repo, print a table / JSON / Markdown worksheet, or show coverage. |
| `scripts/audit-report.mjs` | Renders seeds as a **7-Question Gate** worksheet — KILL by default. |
| `scripts/scope-guard.mjs` | Fail-closed "scope is law" gate for the live lane. Always blocks loopback / RFC1918 / link-local / cloud-metadata addresses (SSRF safety). |
| `config/engagement.json` | The only authorization the live lane trusts. You fill it in and mark it `verifiedByUser` after checking the official policy. |

## Seeds are not findings

Every scanner hit is a **seed** — a candidate. The methodology's core rule (item 95) is the whole point:

> A finding is not a finding until you can write the attacker's exact copy-paste request (Q1). If you can't, **KILL it**.

Confidence reflects the false-positive rate, **not** severity. A `high`-confidence secret match is still killed if the secret turns out to be a rotated placeholder. Most seeds die at Q1 — that is the method working, not failing (item 100: most reviews find nothing).

## Usage

```bash
# 1. What does the methodology automate vs. hand to the human?
npm run audit:coverage

# 2. Scan a repository you have legitimately checked out (SRC lane).
npm run audit -- --path /path/to/target-checkout

# 3. Write a 7-Question-Gate worksheet you can work through.
npm run audit -- --path /path/to/target-checkout --report worksheet.md

# 4. Focus: only medium+ confidence, only one methodology section.
npm run audit -- --path . --min-confidence medium --section C

# 5. Machine-readable for chaining.
npm run audit -- --path . --format json
```

### The live lane is yours — the guard keeps it in scope

Fill `config/engagement.json` from the **official** Abode/Intigriti policy, then and only then set `verifiedByUser: true`. Until you do, the guard denies everything:

```bash
npm run scope -- https://some-host.example.com
# [DENY ] ... engagement is not verifiedByUser — confirm scope on the official policy first (fail-closed)
```

Once verified, it allows in-scope hosts and still hard-blocks internal targets:

```bash
npm run scope -- https://in-scope.example.com   # [ALLOW]
npm run scope -- http://169.254.169.254         # [DENY ] private/metadata always blocked
```

Exit code is `0` only if **every** target is allowed, so you can gate a live script on it:

```bash
node scripts/scope-guard.mjs "$TARGET" && curl ... "$TARGET"   # curl runs only if in-scope
```

The guard **never grants** anything on its own — it only narrows what you may touch. It cannot approve a target the official policy doesn't.

## Coverage & honesty

23 of the 100 items have an automated SRC seed (secrets, JWT, IDOR, mass assignment, SSRF sinks, SQLi, deserialization, path traversal, XXE, postMessage, CORS, weak RNG, timing compares, TLS-off, and more). The other 77 — recon, live business logic, races, MFA, stored XSS, cross-tenant writes — need a human on an authorized target. The toolkit documents each of those with its Q1 prompt and hands it to you: **seed-and-stop** (item 96).

## Tests

```bash
npm run test:audit
```

The suite proves detection on seeded-vuln fixtures **and** proves false-positive discipline on clean fixtures (parameterized SQL, placeholder secrets, safe compares, returned 401s), plus full fail-closed scope-guard coverage.

## Responsible use

Only test public programs you are personally eligible for, within the exact current policy. Use your own accounts and data. Do not test third parties, exceed permitted traffic, or treat a discovery feed as authorization. This toolkit is built to make that discipline the path of least resistance.
