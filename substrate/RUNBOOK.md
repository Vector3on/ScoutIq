# Runbook

Operating Loam unattended at $0. Commands run from `substrate/`.

## 1. Requirements

- Node.js ≥ 22.13 (`node:sqlite` built in). No `npm install` is needed — the substrate has zero dependencies.
- A GitHub repository with Actions enabled (public repositories get unlimited minutes).
- Optional, recommended for real domains: a free Turso database (private state) and a random salt.

```bash
node bin/loam.mjs doctor     # environment, config, plug-in manifests, hub connectivity
npm test                     # 68 tests incl. the falsification protocol (~90 s)
```

## 2. Secrets (GitHub → Settings → Secrets and variables → Actions)

| secret | needed for | notes |
|---|---|---|
| `LOAM_DB_URL` | private hub | `libsql://<db>-<org>.turso.io` from `turso db show <db> --url` |
| `LOAM_DB_TOKEN` | private hub | `turso db tokens create <db>`; a JWT — the substrate never stores it (only `env:LOAM_DB_TOKEN`) |
| `LOAM_PSEUDONYM_SALT` | any plug-in with person data (`arxiv-lit`, `oss-health`) | any random string ≥ 8 chars; **keep it stable** — changing it orphans every pseudonym |
| `GH_PAT` | optional, `oss-health` GitHub sensor | read-only fine-grained PAT for public repos; used only because `loam.config.json` authorizes `github-repos → GH_PAT` |

Without `LOAM_DB_URL` the substrate runs in **git-ledger mode**: events are committed under `substrate/ledger/<domain>/`. That is fine for the toy domain; for real domains in a public repository it makes your private state public (DECISIONS D3).

## 3. Turso hub (one-time)

```bash
turso db create loam
turso db show loam --url          # → LOAM_DB_URL
turso db tokens create loam       # → LOAM_DB_TOKEN
LOAM_DB_URL=... LOAM_DB_TOKEN=... node bin/loam.mjs doctor    # "hub turso:...: 0 events"
```

The schema is created on first contact. Every worker keeps a local replica (`.loam/<domain>.db`) and syncs by cursor; the Actions workflow caches the replica so heartbeats do not replay the whole log.

## 4. Enable domains

Edit `loam.config.json`:

- `toy` — enabled by default; needs nothing.
- `arxiv-lit` — set `enabled: true`, choose `categories` and `interests`. Needs `LOAM_PSEUDONYM_SALT`.
- `oss-health` — set `enabled: true`, list `packages`; set `"github": true` in options to use the GitHub sensor (anonymous, or authorized via `GH_PAT`). Needs `LOAM_PSEUDONYM_SALT`.

Per-domain `budgetSeconds` is the wall-clock budget of one heartbeat. arXiv allows one request per 3 s, so 240 s ≈ 40 polls plus evaluations.

## 5. The heartbeat

`.github/workflows/loam.yml` runs every 6 hours (`37 */6 * * *`) and on manual dispatch (choose a domain and a budget). Each run: `doctor` → `loam run` per enabled domain → commit the ledger (ledger mode) → upload the digest as an artifact (`out/<domain>/latest.md`, 30-day retention).

Set `"publishDigest": true` to also commit `digests/<domain>/latest.md` to the repository (public in a public repo).

Manual heartbeat on your machine (same state if `LOAM_DB_URL` is set):

```bash
LOAM_DB_URL=... LOAM_DB_TOKEN=... LOAM_PSEUDONYM_SALT=... node bin/loam.mjs run --domain arxiv-lit --budget 120
```

## 6. Reading the substrate

```bash
node bin/loam.mjs report --domain arxiv-lit          # per-run series + live compounding/open-endedness verdict
node bin/loam.mjs bundle --domain arxiv-lit --out bundle.md   # paste-ready context for heavy reasoning
```

What to look for in `report`: `denials` > 0 means the policy layer refused something — the reasons are `policy.denied` events (`robots-disallow`, `host-blocked`, `daily-cap`, …); `requests` = 0 with enabled sensors usually means a host is blocked (a 401/403/429 was received; the block expires on its own) or `robots.txt` forbids the path (DECISIONS D11). Check quickly:

```bash
curl -sS https://export.arxiv.org/robots.txt
```

## 7. Heavy reasoning at $0 (your Claude subscription, not the API)

1. `node bin/loam.mjs bundle --domain <d> --out bundle.md`
2. Paste `bundle.md` into a Claude conversation. It asks for ratings, answers and optional strategies in a strict block.
3. Save the reply to `reply.md` and run `node bin/loam.mjs ingest-judgment reply.md --domain <d> --by claude`.
4. The next heartbeat uses the judgments (value overrides, affine recalibration after ≥ 5) and evaluates any seeded strategy once, keeping it if it earns a cell.

A weaker local model can do the same loop; the bundle format is model-agnostic.

## 8. Colab as a heavy worker

Open `colab/loam_worker.ipynb`, add the secrets to Colab's Secrets panel, run the cells. It installs Node 22, clones the repo, runs one heartbeat with a large budget as node `colab`, and syncs through the hub. Workers coordinate through the log: leases (`task.claimed`) stop two workers polling the same query at the same time, and host blocks are shared.

## 9. Proposals (consequential actions)

The loop never acts on outside systems. If a plug-in proposes something (`proposal.created`), review it on your machine — never in CI:

```bash
node bin/loam.mjs proposals list --domain <d>
node bin/loam.mjs proposals approve <id> --domain <d> --by you
```

Execution is a separate, explicit, non-autonomous path (`ActionGate.executeApproved` with `confirm: true`); the shipped plug-ins propose nothing.

## 10. Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `salt-required` at load | plug-in declares person data, no salt | set `LOAM_PSEUDONYM_SALT` |
| `manifest-unknown-key` | a plug-in asks for an undeclared capability | remove it; the schema is the policy |
| `host-blocked until …` | a 401/403/429 or repeated 5xx | wait for expiry; check your caps and the host's terms |
| `robots-unavailable` | robots.txt 5xx/timeout | transient; fails closed, retried next run |
| findings but low value | weak value function / cold start | run the bundle → judgment loop a few times |
| Actions run has 0 requests | ledger mode + toy only, or blocks | expected for toy; see §6 |
| Turso 401 | token expired or wrong DB | recreate token |

## 11. Costs

GitHub Actions: ~1–5 min per heartbeat × 4/day. Turso free tier: hundreds of MB and ~10⁹ row reads/month; a domain generates ~1–3 MB/month of events at 100 observations/day. Colab: free tier sessions. No paid API anywhere in the loop.

## 12. v3 addons (DESIGN.md §9)

Everything below is off unless enabled; the v2 event stream is unchanged when it is off.

| flag (per-domain `options` are plug-in options; these go in the domain's `config` block or `loam.config.json` → `planner`/`qd`/`output`-style top level) | what it does | default |
|---|---|---|
| `descriptor: "both"` | parents come from the learned behavior space (VQ archive over strategy phenotypes) **and** the fixed grid | `"fixed"` (v2) — the toy cron uses `"both"` |
| `valueModel: true` | learned, calibrated value model over generic entity features; judgments are evidence, not overrides; the bundle asks for the judgments with the highest expected improvement | off — the toy cron uses it |
| `judgmentsPerRun` | how many judgments the bundle asks for per heartbeat | 10 |
| `judgmentSd` | assumed noise of an operator judgment (0.15 ≈ "usually right, sometimes off by a lot") | 0.15 |
| `vmSearch` | what strategies see once the model is trained: `proxy` (search discovers, judgments confirm), `override` (a judgment wins rankings), `posterior` (learned model everywhere) | `proxy` (DESIGN §9.4) |
| `affineCalibration: false` | turn off the v2 affine fit on judgments (it compresses scores and hurts selection; DESIGN §9.2) | on in v2; automatically off when `valueModel` is on |
| `sentinel: "observe"` | plateau diagnosis in `loam report` (no interventions); `true` also intervenes | off — the toy cron observes |
| `frontier: true` | POET-style challenges and transfers | off (did not move value; §9) |
| `credit: true` | delayed credit to the polls that enabled a finding | off (hurt in the toy; §9) |

**The judgment loop, v3.** `loam bundle` now opens with *Please judge these first*: the items whose judgment is expected to change what the substrate delivers next (Expected Improvement over the delivery cutoff, discounted for judgment noise). Answer those before anything else; on the toy world every doubling of the judgment budget bought a few percent more hidden-truth value with diminishing returns (DESIGN §9.4), so ten per heartbeat is a reasonable operator budget, not a ceiling.

**External embeddings.** `loam embed-export --domain <d> --out texts.jsonl` lists entities with text but no external vector; encode them anywhere (the Colab notebook's cell 7 uses a free open model) and hand back `loam embed vectors.jsonl --embedder <name> --domain <d>`. Once at least half the text-bearing entities have vectors from one embedder, that space is used exclusively (vectors from different embedders are never compared).

**Reading the report.** `loam report` prints the v3 projections when present: learned-archive cells and codebook size, value-model judgments and prequential calibration error, frontier status, and the sentinel's diagnosis plus the before/after effect of every intervention.

## 13. v4 addons (DESIGN.md §10)

Everything below is off unless enabled; the v3 event stream is unchanged when it is off. No v4 mechanism moved hidden-truth value on the toy under a paired protocol (DESIGN §10.3), so all of them ship off and only the diagnosis (`progress: "observe"`) is on for the toy cron; each remains available, tested, and measured with the numbers that say so (DECISIONS D27–D33).

| flag | what it does | default |
|---|---|---|
| `discovery: true` | evolves *observables* — small typed programs over memory (graph, temporal, signal, pair and text primitives) — and adopts the ones whose bucketed output explains what the value model still gets wrong, held out by batch; adopted observables become features of the value model (`observable.*` events) | off (neutral on hidden truth; §10.3) |
| `obsOps: true` | adopted observables enter the strategy grammar as a seed (`topObs`), a filter op (`obsFilter`) and a ranker (`obs`): the search space grows with what the substrate learned to measure | off (raises the substrate's own novel-value estimate 6–13 %, not hidden truth; §10.3) |
| `obsLift` | a second adoption route: a candidate whose top quintile carries ≥ `obsLift` × the mean label is adopted as a way of looking even if it explains no residual | 0 (off) |
| `obsCandidates` · `obsNewPerStep` · `obsSteps` · `obsDepth` · `obsMaxAdopted` | size of the candidate pool, proposals per step, steps per heartbeat, program depth, adopted cap | 24 · 4 · 1 · 2 · 16 |
| `hindsight: true` | labels the entities that were fresh at a past heartbeat with what memory knows now (young-and-growing pairs, hindsight bursts, signal shifts); a label model calibrated by judgments turns them into evidence for the value model (`hindsight.labeled` events); `hindsightUse: "select"` uses them only to score observable candidates | off (labels reach ρ ≈ 0.3–0.4 with hidden truth on the toy; as evidence they cost 4 % cumulative value, as selectors they are neutral; §10.3–10.4) |
| `hindsightHorizon` · `hindsightFresh` · `hindsightBatch` | days of future per label, freshness window at the time, entities per pass | 7 · 3 · 120 |
| `vmStack: true` | with hindsight on, a judgment-only head scores deliveries over features ⊕ observables ⊕ the hindsight model's prediction | on (only matters with `hindsight`) |
| `curriculum: true` | retrospective environments (a past heartbeat's memory + its hindsight labels) with a minimal criterion and two-way transfer; implies `hindsight` | off (neutral on the toy; §10) |
| `metaAttention` | the learn actions (hindsight pass, discovery step, retrospective evaluation) are planned by the attention model with nominal costs (`learnCosts`) under `reserveLearn`; `false` runs them on a fixed schedule | on (neutral in the shipping configuration) |
| `progress: "observe"` | learning-progress diagnosis in `loam report` and in every `run.completed` (calibration-error slope, adoption rate, new *kinds* of observables, frontier stall); `true` also raises discovery temperature on a stall | off — the toy cron observes |

**Reading the report.** `loam report` prints the v4 projections when present: hindsight rows and label calibration, the adopted observables in words (`max over authored_by/out of [degree(active_in,out)] (fitness 0.013)`), candidates and retired count, kinds of observables adopted, curriculum status, and the progress diagnosis with the before/after effect of every intervention.

**Reproducible, paired experiments.** `loam experiment` runs every variant on a logical wall clock (one millisecond per read), so two runs of the same variant, seed and judgment budget produce identical logs whatever the machine is doing; the real wall time is reported separately. Pass `--config '{"rngTag":"a"}'` to run every variant of an invocation under the same planner and oracle streams — the only way a difference between variants means anything on the toy (DECISIONS D33). Variants: `v4` (v3 plus the progress diagnosis), `v4-grammar`, `v4-all`, isolated `v4-<mechanism>`, `v4-select`, ablated `v4-no-<mechanism>`, `v4-fixed`, and the grammar-growth pushes `v4-obs-lift`, `v4-obs-more`, `v4-obs-deep`, `v4-obs-progress`.

## 14. Bounty intelligence domain (DESIGN §11)

Anatomy (the atlas) × pathology (120 case studies) × EV (ScoutIq) × Loam memory, delivered
as an **alpha queue**. Observe-only: it prioritises public targets and never tests one.
Full design in `plugins/bounty/README.md`.

**Try it offline first (fixture feed, deterministic, no network):**

```bash
cd substrate
node plugins/bounty/demo.mjs --runs 1          # prints the alpha queue + one full coverage chart
node plugins/bounty/demo.mjs --runs 3 --judge  # closes the teacher loop with a stand-in operator
```

**Run it live (public feed, read-only):**

```bash
node bin/loam.mjs doctor                        # confirms: bounty-feed OK, raw.githubusercontent.com, auth none
node bin/loam.mjs run --domain bounty           # observe-only heartbeat; writes out/bounty/alpha-queue.md
```

The heartbeat fetches `arkadiyt/bounty-targets-data`, fingerprints each in-scope asset to
anatomy classes, computes ScoutIq EV, joins the untried applicable techniques, and delivers
the queue to `out/bounty/alpha-queue.md` (+ `alpha-queue.json`, and the top target's full
coverage chart).

### The judgment loop — the teacher (do this; it is the whole point)

The substrate's edge is the operator's accumulated judgment, not the code. Every run it asks
you to rate the leads it is **least sure about**; your ratings recalibrate the value model and
change what it delivers next. The loop is three commands:

```bash
node bin/loam.mjs run    --domain bounty                       # 1. heartbeat → queue + a judgment request
node bin/loam.mjs bundle --domain bounty --out bundle.md       # 2. paste-ready bundle (top leads + "please judge these first")
#    edit bundle.md's reply block:  finding <id> <0..1> <why>   — your reason matters more than the number
node bin/loam.mjs ingest-judgment bundle.md --domain bounty    # 3. fold the ratings back in
node bin/loam.mjs run    --domain bounty                       # 4. re-ranked with what you taught it
```

**The first judgments to give** (they calibrate fastest):
1. Rate the top identity / agents / defi leads — where EV and anatomy agree; this anchors the
   high end.
2. Rate a coarse-join false positive **low** (e.g. an HTTP-desync technique listed under a
   smart-contract seam) — teaches the model that family-only matches are weak.
3. Rate the `$0` points-only watch-list item near **zero** — confirms the EV-first stance.

Record what you actually looked at in `plugins/bounty/data/tried.json` (`target::seam::technique`
cells); the queue will never re-surface a tried cell. The loop never writes that file — a
"try" is a human action, outside the observe-only boundary.

### Config (`loam.config.json`, domain `bounty`)

`valueModel` + `judgmentsPerRun` + `activeJudgments` are **on** (the teacher). The
learned-observable search (`discovery`/`obsOps`, §13) is off until a deployment has
accumulated enough rows (DECISIONS D39); the twelve per-target signals are already declared,
so switching it on is a config change, not a code change. Point `options.feeds` at additional
platform feeds (Bugcrowd/Intigriti/YesWeHack are best-effort; HackerOne is fully supported).
