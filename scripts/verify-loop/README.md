# verify-loop

A hybrid **LLM + program-analysis verification harness** for ScoutIQ. It
operationalizes the GPTScan architecture — **the LLM proposes, deterministic
tools confirm** — to turn source-evident hypotheses into *tool-verified*
findings with local proofs-of-concept.

It is a **local source-analysis tool**. It operates only on target code cloned
to local disk and on local instances the operator builds on their own machine.
It **never sends a request to a live third-party target**. The human reviews
every confirmed finding, confirms live reachability outside this tool, and files
it. Nothing is autonomous against production, and nothing is auto-filed.

## The loop

```
INGEST → HYPOTHESIZE → CONFIRM → GATE → EMIT
```

1. **INGEST** — locate the in-scope target on local disk (clone a public/in-scope
   repo locally if only a git URL is given) and detect its stack(s):
   Solidity / JS-TS / Python / PHP / Go.
2. **HYPOTHESIZE** (the semantic/LLM step) — for each candidate location, match
   against a `{scenario, property}` template library seeded from the 100-area
   methodology, and emit **ranked candidates with exact file/line + the property
   to check**. This is deliberately high-recall. LLM-alone is high false-positive,
   so we **do not stop here**.
3. **CONFIRM** (the deterministic tool step) — route each candidate to the right
   confirmer and try to prove the property:
   - **Solidity**: Slither and Mythril confirm autonomously; Foundry/Echidna/Halmos
     run an operator-completed PoC for a dynamic/symbolic proof.
   - **JS/TS/Python/PHP/Go**: Semgrep and CodeQL taint queries prove
     source→sink reachability; a **local runtime harness** (against a local
     instance/container you built) executes the candidate payload and observes the
     effect; language fuzzers drive the payload step.
4. **GATE** — a candidate survives **only** if a tool confirmed it: a taint path
   proven **and/or** a working local PoC produced. Everything else is killed. This
   is the static-confirmation step that removes the bulk of the false positives.
5. **EMIT** — for each survivor: commit permalink, vuln class, the confirming
   tool + its evidence, the local PoC (Foundry test / Echidna property / the
   request run against the **local** instance), and the drafted **Q1 attacker
   request**. Handed to the human to confirm live reachability and file.

**An honest empty is a valid result.** If no tool confirms anything, the loop
emits zero findings and says so.

## Usage

```bash
# list the vuln classes in the template library
node scripts/verify-loop.mjs --list-classes

# run the full loop on a locally-cloned target
node scripts/verify-loop.mjs --target /path/to/target --stack auto

# limit to specific classes, require a working dynamic PoC, and persist results
node scripts/verify-loop.mjs --target /path/to/target \
  --classes reentrancy,sql-injection --require-dynamic --emit

# machine-readable
node scripts/verify-loop.mjs --target /path/to/target --format json
```

npm scripts: `npm run verify -- --target <path>`, `npm run verify:classes`,
`npm run test:verify`.

## Configuration (`config/verify-loop.json`)

Config-driven: target repo path, stack, vuln classes, tool paths, and the local
instance connection. CLI flags override the file. Key fields:

| Field | Meaning |
|---|---|
| `target.repoPath` / `target.gitUrl` | local target path, or an in-scope repo to clone **locally** |
| `target.permalinkBase` / `target.ref` | permalink base + commit (else derived from git) |
| `stack` | `auto` or one of `solidity`, `js-ts`, `python`, `php`, `go` |
| `vulnClasses` | limit to these classes (empty = all applicable) |
| `hypothesizer.provider` | `deterministic` (default, offline), `anthropic`, or `command` |
| `tools.*` | explicit binary paths / Semgrep rules / CodeQL DB (else resolved from PATH) |
| `confirm.requireDynamicPoc` | survivors must have a working dynamic PoC, not only a taint proof |
| `confirm.runtimeHarnessScript` | operator script that drives the local instance for the runtime confirmer |
| `localInstance.baseUrl` | **LOCAL** instance URL (loopback/private only) |
| `auditStore` | audit-memory file (default `data/verify-loop.json`) |

### The hypothesis providers

- **deterministic** (default): an offline signal matcher over the template
  library. No network, no key. Higher false-positive rate by design — the
  confirm step and gate are what make the output trustworthy.
- **anthropic**: Claude Messages API over raw `fetch` (consistent with the rest
  of the pipeline's zero-dependency, fetch-based networking). Needs
  `ANTHROPIC_API_KEY`; model defaults to `claude-opus-5`. The model reads
  locally-cloned source — it is the analysis engine, not a target, so it respects
  the clean lane. Falls back to the deterministic matcher on any error.
- **command**: an operator-supplied program (e.g. `claude -p`) that receives the
  template catalog + source on stdin and returns candidate JSON on stdout.

All three are *grounded*: every candidate is validated against real files/lines
before it reaches the confirm step.

## Tools (install + pin)

Confirmer versions are pinned in [`tools.pinned.json`](./tools.pinned.json).
Install them with:

```bash
scripts/verify-loop/install-tools.sh            # all groups
scripts/verify-loop/install-tools.sh contracts  # Solidity toolchain only
```

The loop **degrades gracefully**: a confirmer that is not installed reports
`unavailable` and the candidate is killed at the gate — it is never counted as a
pass. The report header lists which confirmers were available on each run.

## Audit memory

Results persist to `config.auditStore` (default **`data/verify-loop.json`**)
using ScoutIQ's `data/audited.json` convention (`version` / `updatedAt` /
`entries` keyed by alias, with `aliases`), and each entry attaches the
confirming-tool evidence under `verifyLoop` (findings, permalink, PoC filename,
Q1 request). Entries carry `handoff: "human-review"` and `filed: false`.

The default is a **dedicated store**, not `data/audited.json`, on purpose:
entries in `data/audited.json` drive hard **exclusions** in `scripts/ev-core.mjs`
(an audited target is dropped from ranking unless fresh code jumps), so writing a
confirmed *live-candidate* finding there would wrongly remove it from the radar.
Point `auditStore` at `data/audited.json` only if that exclusion is what you
intend.

## Clean-lane boundary (enforced)

- The only network host the tool will touch for a *target* is a local instance,
  and `localInstance.baseUrl` must resolve to loopback / a private LAN range /
  `localhost` / `*.local` / the docker host alias. A public host is a **hard
  config error** — the loop refuses to run, and the runtime harness re-checks at
  execution time. Live reachability against a real target is confirmed by the
  human, outside this tool.
- Q1 attacker requests are **drafted** for the human; web payloads are aimed only
  at the local instance. The tool never fires them at a live third-party target.
- No remote-host scanning, no autonomous exploitation, no auto-filing.
