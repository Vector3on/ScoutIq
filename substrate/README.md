# Loam

**A compounding, open-ended intelligence substrate that runs unattended on free infrastructure.**

Loam continuously ingests information from pluggable public sources, decides for itself what to look at next, evolves *ways of looking* instead of settling on the obvious one, and delivers prioritized, never-repeated findings to a database. Everything it learns lives in an append-only private event log that any number of free workers (GitHub Actions cron, a Colab notebook, your laptop) extend and converge on. The core knows nothing about any domain: the same substrate monitors scientific literature and open-source ecosystem health, and the two shipped plug-ins share nothing but an interface.

- **Design & math:** [DESIGN.md](DESIGN.md) — thesis, prior art, formal core, attention objective, falsification protocol and results.
- **Choices & trade-offs:** [DECISIONS.md](DECISIONS.md).
- **Operating it:** [RUNBOOK.md](RUNBOOK.md).

## What makes it different

| | typical watcher / alert pipeline | Loam |
|---|---|---|
| what counts as interesting | fixed rules or a prompt | an evolvable strategy population, kept diverse by a quality-diversity archive |
| what to look at next | poll everything, or a schedule | a Bayesian planner minimizing expected free energy (exploit + exact information gain) under a time budget |
| memory | a cache | a content-addressed event log; every projection is a pure fold; replicas converge without coordination |
| "novel" | not repeated today | not delivered within a window *and* semantically distant from what was delivered |
| learning from you | none | paste-ready context bundle → judgments → recalibrated value model and seeded strategies |
| cost | servers, API keys | $0: Actions cron, Turso free tier (or the git ledger), Colab; no model in the hot path |

The edge lives in the accumulated private state and in strategies discovered to work *against that state*. A competitor with the same code but without the log has neither.

## How it is general

A domain is a plug-in behind three interfaces:

```js
export function createPlugin(options) {
  return {
    id: 'my-domain',
    schema: { entityTypes: [...], relations: [{ rel, from, to }], signals: [{ name, type }], primaryType: '...' },
    sensors: [{ id, manifest, propose({ memory, stats, now, rng, limit }), poll(params, { fetch, now, pseudonym }) }],
    value:   { score(entity, { memory, now, vectors, helpers }) /* → [0,1], pure */ },
    sinks:   [{ id, emit(findings, ctx) }],   // optional; the store + digest are the default sink
  };
}
```

`core/` and `policy/` never import a domain. Shipped domains:

- `plugins/toy` — a synthetic world with **hidden ground truth**, used to falsify the substrate's claims in CI.
- `plugins/arxiv-lit` — scientific-literature monitoring over the public arXiv API (interests, cross-archive emerging bridges, authors bursting into new fields, rising vocabulary; author names are never stored).
- `plugins/oss-health` — open-source ecosystem health over npm, npm downloads, deps.dev and optionally the GitHub API (usage × maintenance silence × bus factor, advisories, maintainer changes, rising usage; maintainers are keyed pseudonyms).

## How it is legitimate

The policy layer is code, not comments, and is tested (`tests/policy.test.mjs`):

- Public or explicitly authorized data only, through declared endpoints of declared hosts. `robots.txt` is fetched, cached in the log and obeyed; per-host minimum intervals and daily caps are shared across workers; **401/403/429 are stop signals** that block the host for every worker.
- The autonomous loop observes and reasons; it cannot act on outside systems. Consequential actions become *proposals* that only a human can approve, outside CI, with explicit confirmation.
- Secrets are never stored (type and location only); PII patterns are redacted; person names become keyed pseudonyms, and plug-ins that touch person data cannot load without a salt.
- Manifests are strict schemas: undeclared capabilities (`bypassRobots`, `cookies`, authenticated scraping) are refused at load.

## Quick start

```bash
cd substrate
node bin/loam.mjs doctor
npm test                                   # 68 tests, ~90 s, including the falsification protocol
node bin/loam.mjs run --domain toy         # one heartbeat (git-ledger mode, no secrets)
node bin/loam.mjs report --domain toy
node bin/loam.mjs experiment               # memory vs memoryless vs single-cell on hidden truth
node bin/loam.mjs bundle --domain toy --out bundle.md   # paste into Claude; feed the reply back with ingest-judgment
```

Requires Node ≥ 22.13. No dependencies.

## Does it actually compound?

`loam experiment` runs the toy world under three variants on identical days and scores outputs against hidden truth, deduplicated across runs. Over 4 seeds × 10 runs: persistent state delivers **1.35×** the late-run true value of the same code with memory wiped every run (188 vs 132 true hits), quality-diversity costs nothing in value (1.03×) while illuminating ~70 % more of behavior space, and every seed stays open-ended (findings every run, novelty ≈ 0.8, ~3 bits of strategy entropy). DESIGN.md §6 has the table, the criteria that would falsify the thesis, and the caveats.

## v3: where the ceiling is, and what moved it

v3 asked one question — *where does the substrate plateau, and why* — and answered it with instruments before mechanisms. On the toy world the plateau is not in polling (memory holds almost everything valuable) and only partly in search (strategies surface 50–75 % of what memory holds); it is in **scoring**: the value model delivers about half of what its own candidate pool contains, and a hindsight model over the same features with unlimited labels barely does better. That fixed the priorities.

Six additive mechanisms were built, each behind a flag, each with tests and its own falsification metric wired into `loam experiment`: a learned behavior space (vector-quantized elites over strategy phenotypes), POET-style frontier challenges, a Bayesian value model with Expected-Improvement judgment selection, delayed credit for polls, an external-embedding path, and a plateau sentinel. The ones that moved their metric without costing hidden-truth value ship on by default for the toy cron; the ones that did not are shipped off with the numbers that say so. DESIGN.md §9 has the ceiling decomposition, the judgment-budget curve (monotone with diminishing returns, once a measurement artifact was found and removed), the noise study, and the honest verdict per mechanism.

## v4: attacking the information ceiling — a negative result, measured well

v3 left the ceiling as an *information* limit: a linear model over the fixed feature set could not do much better with unlimited labels. v4 built both sides of that limit as things the substrate does to itself. It **discovers observables** — small typed programs over its own memory (graph, temporal, signal, pair and text primitives, ≈ 850 kinds) — and adopts the ones that explain what its value model still gets wrong, held out by batch; those observables can **grow the strategy grammar** (a seed, a filter, a ranker), so the space of ways of looking expands with what it learned to measure. It **labels its own past with its own future** (an entity that was fresh at a past heartbeat is a precursor if the structures it belonged to were young then and grew afterwards), with a label model calibrated by judgments and a label-vs-truth metric that says how much those labels know; it trains solvers on **retrospective environments** with a minimal criterion; and it lets the existing free-energy planner allocate budget across these mechanisms by their measured learning progress, with a projection that tracks second-order novelty (new *kinds* of observables) and declares a frontier stall.

What the numbers say (DESIGN.md §10): under a paired protocol (identical world, planner and oracle streams; 5 seeds × 2–3 streams) **none of it moves hidden-truth value**. The grammar configuration is 0.97–1.00× v3 while raising the substrate's *own* novel-value estimate by 6–13 % — the grown grammar finds more of what the proxy values and the same amount of what is valuable; hindsight labels reach ρ ≈ 0.3–0.4 with the truth and cost 4 % as evidence; the curriculum costs 6 %; meta-attention is neutral; and the truth-trained ceiling over everything the substrate can now measure equals the ceiling over the fixed features. An unpaired three-seed sweep had shown +7–10 %; it was stream noise, and the harness now pairs every comparison. So every v4 mechanism ships off, with the instruments on, and the plateau has a sharper name: on this world the remaining truth is invisible to any linear function of what memory can measure, and the mechanisms that could change what it measures are bound by truth-aligned supervision per heartbeat — ten operator judgments cannot select among 850 kinds of observables, and the substrate's own labels are not aligned enough to substitute.

## Layout

```
bin/loam.mjs          CLI: run · experiment · report · bundle · ingest-judgment · proposals · sync · doctor
core/                 events · store · sync · projections · memory · archive · embed · strategy · qd · attention · planner · worker · bundle · metrics · experiment
                      v3: phenotype · vq · frontier · features · valuemodel · credit · sentinel · embedio
                      v4: observables · hindsight · timetravel · valuemodel-v4 · curriculum · progress
policy/               data gate · manifest gate · network gate · action gate
plugins/              toy · arxiv-lit · oss-health
tests/                68 tests (core loop, CRDT convergence, policy layer, plug-ins, falsification, v3 and v4 addons)
colab/                heavy-worker notebook
loam.config.json      domains, store mode, policy caps, planner/QD parameters
../.github/workflows/loam.yml   the heartbeat
```
