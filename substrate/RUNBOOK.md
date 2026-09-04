# Runbook

Operating Loam unattended at $0. Commands run from `substrate/`.

## 1. Requirements

- Node.js ≥ 22.13 (`node:sqlite` built in). No `npm install` is needed — the substrate has zero dependencies.
- A GitHub repository with Actions enabled (public repositories get unlimited minutes).
- Optional, recommended for real domains: a free Turso database (private state) and a random salt.

```bash
node bin/loam.mjs doctor     # environment, config, plug-in manifests, hub connectivity
npm test                     # 45 tests incl. the falsification protocol (~7 s)
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

**The judgment loop, v3.** `loam bundle` now opens with *Please judge these first*: the items whose judgment is expected to change what the substrate delivers next (Expected Improvement over the delivery cutoff, discounted for judgment noise). Answer those before anything else; ten per heartbeat is the measured sweet spot on the toy world — more is not better (DESIGN §9.4).

**External embeddings.** `loam embed-export --domain <d> --out texts.jsonl` lists entities with text but no external vector; encode them anywhere (the Colab notebook's cell 7 uses a free open model) and hand back `loam embed vectors.jsonl --embedder <name> --domain <d>`. Once at least half the text-bearing entities have vectors from one embedder, that space is used exclusively (vectors from different embedders are never compared).

**Reading the report.** `loam report` prints the v3 projections when present: learned-archive cells and codebook size, value-model judgments and prequential calibration error, frontier status, and the sentinel's diagnosis plus the before/after effect of every intervention.
