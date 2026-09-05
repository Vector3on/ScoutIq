# Loam — design

*A compounding, open-ended intelligence substrate on $0 infrastructure.*

## 0. Thesis (one paragraph)

**Attention is the scarce resource; strategies are the population; memory is the environment.** Loam treats *how to look* as an evolvable object — a typed query genome over a private knowledge graph — and illuminates the space of ways-of-looking with a quality-diversity archive whose fitness is **novel value**: value the private memory has not already delivered. A population cannot converge on the obvious strategy, because the moment a strategy only re-finds what is known its fitness decays to zero while stepping-stone strategies survive in their own behavioral cells. A single Bayesian planner allocates each heartbeat's budget across sensing, evolving and re-testing by minimizing an expected-free-energy objective whose exploit term is the posterior mean of realized novel value and whose explore term is the *exact* information gain of a linear-Gaussian model; both terms are functions of accumulated private state, which is the compounding mechanism. Everything is a pure fold over an append-only, content-addressed, hybrid-logical-clocked event log that is a grow-only set under union, so any number of free workers (a cron runner, a notebook, a laptop) converge to identical state by exchanging events through a shared store — stigmergy with a CRDT ledger as the pheromone field, and a policy layer as the only way anything reaches the outside world. It is not a bandit (bandits do not evolve strategies), not MAP-Elites (which has no attention model or memory), not active inference (which has no population), and not an event-sourced application (which has no intelligence). The bet is that these compose, and that the composite has a measurable property none has alone: **value per unit of attention that rises with run count while output novelty does not decay.** Section 6 states how to falsify it and what the toy world says so far.

## 1. Prior art, and what each piece lacks

| Idea | Source | What it gives | What it lacks alone |
|---|---|---|---|
| Novelty search, open-endedness | Lehman & Stanley 2011; Stanley & Lehman 2015 | Search for behavioral novelty finds stepping stones a fixed objective prunes | No notion of value; no memory of the world; no budget |
| Quality-Diversity, MAP-Elites | Mouret & Clune 2015; Cully & Demiris 2018 (curiosity) | An archive of the best solution of every *kind* (illumination) | Fitness is a fixed function; no attention; no distributed state |
| Active inference / free energy | Friston; Parr, Pezzulo & Friston 2022; Sajid et al. 2021 | Exploit and explore fall out of one objective (risk + ambiguity) | Intractable in general; no population; usually a single agent |
| Bandits, Bayesian optimal design | Thompson 1933; Agrawal & Goyal 2013 (LinTS); Chaloner & Verdinelli 1995 (IG) | Tractable allocation of scarce attention with principled exploration | Actions are fixed arms; nothing evolves; no world model |
| Stigmergy | Grassé 1959; Theraulaz & Bonabeau 1999; Dorigo (ACO) | Coordination through shared environmental state, no controller | Needs a medium that merges without conflict |
| Event sourcing, CRDTs, HLCs, local-first | Fowler; Shapiro et al. 2011; Kulkarni et al. 2014; Kleppmann et al. 2019 | Perfect memory, time travel, conflict-free convergence across machines | No intelligence; nothing decides what to look at |
| Feature hashing, burst detection, MMR | Weinberger et al. 2009; Kleinberg 2002; Carbonell & Goldstein 1998 | Cheap semantics, "rising" signals, diverse output selection | Building blocks only |

Existing systems that watch the world (alerting services, literature recommenders, dependency bots, "AI scientist" pipelines) share three properties Loam rejects: a fixed strategy for *what counts as interesting*, a value function that never learns from what it already delivered, and state that a competitor can re-create by running the same code. Loam's edge is designed to live in (a) the private event log, (b) the archive of strategies that were *discovered to work against that log*, and (c) a value model calibrated by the operator's judgments. All three compound; none can be cloned by copying the code.

## 2. Architecture: one heartbeat

```
   sync-in ──► project state ──► plan ──► act ──► select outputs ──► deliver ──► measure ──► sync-out
 (hub/ledger)  memory · archive   TS+IG   sense    novel ∧ valuable   findings    run.completed   (hub/ledger)
               qd · planner       knapsack  evolve  ∧ diverse (MMR)   + digest    + snapshots
               policy-state                 re-test                    + sinks
```

Every arrow is a function of projected state plus a seeded RNG; every effect is an event. A run is reproducible from the log and the seed (tested).

**Components** (`core/`): `events` (canonical JSON, content-addressed ids, HLC, seeded RNG) · `store` (local SQLite, Turso over HTTP, one schema) · `sync` (star anti-entropy; git-ledger export/import) · `projections` (pure folds, exact snapshots) · `memory` (knowledge graph + signal series + term statistics; policy-state) · `archive` (delivered findings, novelty) · `strategy` (genome DSL, interpreter, variation, behavior descriptors) · `qd` (MAP-Elites archive with curiosity) · `attention` (Bayesian linear model, IG, Thompson sampling, budgeted selection) · `planner` (fold of outcomes into the model) · `worker` (the heartbeat) · `bundle` (paste-ready context, judgment ingestion) · `metrics` / `experiment` (falsification).

**Policy** (`policy/`): data gate, manifest gate, network gate, action gate — §7.

**Plug-ins** (`plugins/`): `toy` (synthetic world with hidden truth), `arxiv-lit` (scientific literature), `oss-health` (open-source ecosystem health). The core imports none of them.

## 3. Formal core

### 3.1 The log

An **event** is `e = (id, node, seq, hlc, kind, ts, domain, dedupKey, body)` with `id = SHA-256(canonical(e \ id))[:32]`. The **log** `L` of a deployment is the union of every worker's events.

Invariants (each has a test in `tests/`):

- **I1 Immutability.** Events are deep-frozen; a store refuses an event whose id does not re-derive from its content (`store.test`).
- **I2 Idempotent union.** `append` is `INSERT OR IGNORE` by id and by `(node, seq)`; a node never reuses a `seq`. Hence `L` is a **G-Set**: merge is set union, commutative, associative, idempotent (`sync.test`).
- **I3 Total order.** `hlc = (wall, logical, node)` is a hybrid logical clock serialized so that string order equals causal order; two events from one node never share an HLC; ties across nodes are broken by node id. Every replica therefore sorts `L` identically (`events.test`).
- **I4 Sanitized bodies.** The only write path is `Ledger.emit`, which runs the data gate before hashing; a stored body can contain no secret value and no person name, by construction (`policy.test`, `plugins-*.test`).

### 3.2 Projections

A **projection** is `P = (init, apply)`, and its state on a log is the fold `S_P(L) = fold(apply, init(), sort_hlc(L))`. Because `sort_hlc` is total and identical on every replica (I3) and `L` converges under union (I2), **every replica converges to identical projection state once it has seen the same events, in any arrival order** (`sync.test` shuffles arrival and partitions across nodes).

Snapshots make this incremental without giving up exactness: a snapshot stores `(state, watermark = max hlc folded, ingestSeq)`. New events (`ingestSeq` greater than the snapshot's) are folded only if all of them sort after the watermark; a late arrival with an earlier clock triggers a replay from scratch. Tested: a snapshot built on the later half of a log, then fed the earlier half, equals a from-scratch fold.

The memory projection is additionally **commutative by construction** — LWW registers keyed by `(observedAt, hlc)` for attributes and text, union for relations, min/max for first/last seen, sorted insertion for signal points, idempotence per observation dedup key — so incremental folds and full replays agree even when timestamps and clocks disagree.

### 3.3 Memory

Entities `x = (type, key, firstSeen, lastSeen, n, text, attrs, signals)` with `signals: name → sorted series of (t, v)` (first point plus the last 63); relations `(from, rel, to, firstSeen, lastSeen, n)` with both adjacency directions; corpus term statistics `df(token)` and per-token daily buckets for burst detection; hashed embeddings computed lazily from text with corpus IDF (`embed.mjs`), so semantic features sharpen as the corpus grows.

Information-theoretic primitives (`memory.mjs`): surprisal of a text = mean IDF of its tokens; **burst** of a token = recent daily rate over historical daily rate (Kleinberg-style, discretised, smoothed), mapped to [0,1]; **bridge** of an entity over a relation = for pairs of its neighbours, either rarity `−log P(pair | degrees)` or **emergence** `recentFraction × log1p(recentCount)`; the latter needs history and is the difference between a habitual combination and a new one.

### 3.4 Novelty

For a candidate entity `x` at time `t`, with `A` the archive of delivered findings:

```
hard(x)   = 1 if x was not delivered within W days, else 0
soft(x)   = 1 − max cos(v(x), v(f)) over the last 200 delivered findings f
novelty(x) = hard(x) · (0.25 + 0.75 · soft(x))
```

Hard novelty is exact (id-level, windowed); soft novelty penalizes semantic redundancy without forbidding it. Findings are delivered only if `hard = 1`, so **no finding is delivered twice within the window** (`plugins-arxiv.test`).

### 3.5 Strategies as genomes

Grammar (`strategy.mjs`):

```
Genome  := seed pipe* rank                       (|pipe| ≤ 4)
seed    := recent(type, days) | all(type) | stale(type, minDays) | top(type, signal, n)
pipe    := expand(rel, dir, keepSeed) | viaNewEdge(rel, dir, days)
         | filterSignal(signal, cmp, q) | filterAge(cmp, days) | filterDegree(rel, dir, cmp, q)
         | bridge(rel, dir, mode ∈ {emerging, rare}, days, q) | newcomer(rel, dir, recentDays, priorDays)
         | accelerating(signal, q) | silent(days) | outlier(q) | rareTerms(q) | rising(q) | limit(n)
rank    := value | surprisal | burst | recency | degree | signal(name) | age | mixed
```

Parameters live on small menus (`MENUS`), so variation is structural and every genome is valid for the plug-in's declared schema by construction. Thresholds are **quantiles within the working set**, so strategies are scale-free across domains. The interpreter is pure: `run(g, memory, now, value) → top-k entities with rationale`, deterministic (tested over 300 random genomes). Entities the archive already considers delivered are excluded before ranking, so the k slots are spent on novel candidates.

**Variation.** Mutation: replace the seed, replace/insert/delete a pipe op, tweak a parameter along its menu, replace the ranker (retry until the id changes). Crossover: one-point on the pipe. Random genomes and four **canonical** schema-derived genomes seed an empty archive.

**Behavior descriptor** (phenotype, not genotype) of a strategy run, each in [0,1]: `age` = median log-age of its outputs (fresh vs historical), `centrality` = median degree percentile of its outputs within their type (hub vs periphery), `spread` = mean pairwise cosine distance of its outputs (focused vs diverse). Grid: 6 × 6 × 6 = 216 cells.

### 3.6 Fitness = novel value

For a strategy's `k` output slots (k = 10):

```
F(g) = (1/k) · Σ_{x ∈ out(g)} value(x) · novelty(x)  −  λ · |g|        (λ = 0.004)
```

`value` is the plug-in's `[0,1]` score (§5), overridden by operator judgments and affinely calibrated once ≥ 5 judgments exist. A strategy that re-finds what has been delivered has `novelty = 0` on those slots and decays; re-evaluating a sitting elite updates its fitness honestly, up or down (`qd.test`).

### 3.7 The archive (MAP-Elites + curiosity)

`strategy.evaluated` events fold into `cells: cell → elite`. Replacement: strictly higher fitness, or equal fitness with a smaller genome. Parent selection is by **curiosity** (Cully & Demiris 2018): +1 to the parent cell when its offspring becomes an elite anywhere, −0.5 otherwise, floored at 0. Coverage = occupied / 216; QD-score = Σ elite fitness. The archive is itself a projection, so every worker sees the same elites.

### 3.8 Attention

**Actions** per heartbeat: `poll(sensor, params)` (proposed by sensors from memory and their own poll history), `evolve(cell)`, `crossover(cellA, cellB)`, `random`, `reevaluate(cell)`, `seeded(genome)` (operator- or canonical-seeded; always run once). Each has hashed features `φ(a) ∈ ℝ^128` (type, sensor, parameter buckets, staleness, last outcome, cell coordinates, curiosity, fitness, genome size) and a cost in seconds (declared by the sensor, then learned as an EMA of actual durations).

**Model.** `y = wᵀφ + ε`, `w ~ N(0, σ₀²I)`, `ε ~ N(0, σₙ²)`, sufficient statistics `Λ = I/σ₀² + Σφφᵀ/σₙ²`, `b = Σφy/σₙ²`, posterior `Σ = Λ⁻¹`, `μ = Σb` (Cholesky; `attention.test` checks the closed form). Outcome `y` is the realized **novel value** of the action normalised by a slowly decaying per-type running maximum: for evolutions the child's fitness; for polls the value of the *new* observations they brought (the live value of each new primary entity). **Non-stationarity**: after every run `Λ ← γΛ + (1−γ)Λ₀`, `b ← γb` (γ = 0.98), so uncertainty regrows toward the prior and stale beliefs get re-tested.

**Objective.** Expected free energy for action `a` decomposes as `G(a) = risk + ambiguity`. With a Gaussian generative model over outcomes and a log-preference proportional to value, risk reduces (up to constants) to `−E[y | a] = −μᵀφ(a)`, and the ambiguity term — expected reduction in posterior entropy of the parameters from observing `y(a)` — is exactly `IG(a) = ½ log(1 + φᵀΣφ/σₙ²)` for a linear-Gaussian model (Chaloner & Verdinelli 1995). So

```
−G(a) ≈ μᵀφ(a) + β · IG(a)         (β = 0.3: nats of information per unit of value)
```

Selection replaces `μ` with one Thompson sample `w̃ ~ N(μ, Σ)` per heartbeat (Agrawal & Goyal 2013) and runs a greedy knapsack on `score(a)/cost(a)` under the run's budget in seconds. This is bounded-rational active inference: the explore term is the exact information gain of the model we actually maintain, not a bonus. (`attention.test`: IG shrinks with evidence, regrows on forgetting, unobserved arms are explored, the better arm wins.)

**Complementarity constraint.** The pipeline's outputs need *both* new observations and evaluations; an additive knapsack objective cannot express that a run with no evaluations delivers nothing. Each group (sense / think) is guaranteed 30 % of the budget before the free allocation. Polls execute before evaluations within a run ("sense before you think"). Documented as a structural constraint, not a heuristic bonus — DECISIONS.md D7.

### 3.9 Output selection

The union of all evaluated strategies' novel findings is deduplicated per entity (best score wins) and diversified by maximal marginal relevance: pick the item maximizing `λ·score − (1−λ)·max sim` to those already picked (λ = 0.7; `sim` = cosine of embeddings, floored at 0.25 for same-strategy siblings). Up to 20 findings per heartbeat are emitted as `finding.emitted` events (the database delivery), written to the digest, and handed to plug-in sinks.

### 3.10 Stigmergy and convergence

Workers never talk to each other; they read and write the log. Pheromones: `source.blocked` (a stop signal any worker received blocks that host for all of them until it evaporates), `task.claimed` (a wall-clock lease on a poll; other workers skip it while it lives), `source.polled` (shared per-host daily counts), `robots.fetched` (a shared cache), `action.outcome` (the shared attention model), `strategy.evaluated` (the shared archive), `finding.emitted` (the shared novelty archive). Topology is a star around a hub (Turso) or a bundle of per-node JSONL segments in git; both are union merges, so any topology converges (§3.1–3.2).

## 4. Why it compounds (four mechanisms, each measurable)

1. **Memory makes value visible.** Migrations, emerging bridges, rising vocabulary and silence are undefined without history; the value function's precision rises with corpus size (toy: top-5 precision 0.12–0.18 with one day of memory → 0.33–0.35 with twelve days).
2. **Calibration.** Judgments recalibrate the value model; the posterior of the attention model tightens (IG ↓) where returns are stable and regrows where they drift.
3. **Archive.** Later strategies are mutations of elites that already worked *on this memory*; stepping stones persist in their own cells.
4. **Source model.** Per-sensor, per-parameter outcome statistics steer polls toward sources that yield novel value, and cost estimates converge to actuals.

A competitor with the same code but without the log has none of these.

## 5. Domain-agnostic by construction

A plug-in is `createPlugin(options) → { id, schema, sensors, value, sinks?, debug? }`.

- `schema`: entity types, relations `(rel, from, to)`, signal names — this is all the genome generator knows.
- `Sensor`: `manifest` (§7), `propose({memory, stats, now, rng, limit}) → [{params, paramsKey, estRequests|estSeconds, features}]`, `poll(params, {fetch, now, pseudonym}) → {observations}`. An **observation** is `{externalId, observedAt, text?, entities:[{type,key,text?,attrs?,signals?}], relations:[{from,rel,to}]}`.
- `ValueFunction`: `score(entity, {memory, now, vectors, helpers}) → [0,1]`, pure, no network.
- `OutputSink`: `emit(findings, ctx)`; the default sink is the findings table in the store plus a Markdown/JSON digest.

The two shipped domains share nothing but this contract: `arxiv-lit` (papers, categories, pseudonymous authors; interests, cross-archive emerging bridges, author bursts into new categories, rising vocabulary) and `oss-health` (packages, repos, pseudonymous maintainers/contributors; usage × maintenance silence × bus factor, advisories, maintainer changes, rising usage), plus the `toy` world. Adding a domain never touches `core/` or `policy/`.

## 6. How it could be wrong

### 6.1 Metrics

Per run (`run.completed`): findings, novel value, value per budget-second, new observations, evaluations, archive cells and coverage, QD-score, mean novelty, strategy entropy of delivered findings, calibration MAE against judgments, mean IG and exploit of chosen actions.

**Compounding** (live, `loam report`): Spearman(run index, value per second) > 0 and last-third mean > 1.1 × first-third mean. **Open-endedness**: coverage grows, ≥ 75 % of runs deliver, late mean novelty ≥ 0.3, late strategy entropy ≥ 1 bit.

### 6.2 The smallest falsifying experiment

`loam experiment` runs the toy world — a deterministic synthetic domain with **hidden ground truth** the substrate never sees: value concentrates in bridges of topic pairs *before* they become hot (habitual pairs are worthless), in authors' first burst in a new topic, and in rising terms before they rise; feed yields drift; there are more feeds than a run can poll. Variants on identical world days:

- **memory** — one persistent store across runs;
- **memoryless** — the store is wiped before every run (same code, same world);
- **single-cell** — one persistent store but an archive with one cell (no quality-diversity).

Outputs are scored by hidden truth, **deduplicated across runs for every variant** (re-reporting yesterday's discovery counts once). The thesis is falsified if late-run true value with memory does not exceed the memoryless ablation, or if novelty/coverage/entropy collapse, or if the single-cell archive matches quality-diversity on illumination.

### 6.3 Results (10 runs, budget 8 s/run, 4 seeds; `tests/worker.test.mjs` asserts the 3-seed version on every CI run)

| seed | late true value memory / memoryless | true hits memory / memoryless | illuminated cells (fixed 6³ grid) QD / single | productive strategies QD / single | QD / single late value | late entropy (bits) | late novelty |
|---|---|---|---|---|---|---|---|
| 7  | **2.09** | 26 / 25 | 16 / 9  | 22 / 18 | 1.19 | 2.84 | 0.82 |
| 11 | **1.73** | 61 / 26 | 17 / 9  | 23 / 19 | 1.41 | 2.87 | 0.80 |
| 23 | 0.96     | 41 / 34 | 12 / 14 | 19 / 19 | 0.82 | 2.51 | 0.82 |
| 31 | **1.59** | 60 / 47 | 24 / 8  | 31 / 16 | 1.15 | 3.49 | 0.82 |
| **aggregate** | **1.35** (2.85 vs 2.12) | 188 / 132 | 17.3 / 10 | 23.8 / 18 | **1.03** (2.85 vs 2.77) | 2.93 | 0.82 |

Reading: persistent state finds about a third more hidden-truth value than the same code without memory, and 42 % more true hits; the advantage is not uniform (seed 23 is a wash — its world offers less history-dependent value in that window). Quality-diversity costs nothing in value on aggregate and illuminates ~70 % more of behavior space with more productive strategies (3 of 4 seeds). Every seed stays open-ended: findings every run, novelty ≈ 0.8, entropy ≈ 3 bits (delivered findings come from ~8 distinct strategies, not one).

### 6.4 Honest caveats

- The toy's value function was designed with the toy's truth in mind; the result shows the *substrate* exploits history when history matters, not that any real domain's value function is good. Real-domain value functions start weak and are meant to be calibrated by judgments.
- The raw run-over-run trend is confounded by the world's own schedule (seed 31 has an early burst); the paired advantage over the memoryless ablation is the honest compounding statistic.
- Ten runs is short. The mechanisms in §4 that need ≥ 30 days of history (habitual-pair recognition, calibration) are only partly exercised.
- The attention model credits polls with the value of what they bring *now*; delayed credit (an author history that enables a finding three runs later) is not attributed. DECISIONS.md D9 lists the planned fix.
- Hash embeddings are crude; semantic spread and soft novelty are correspondingly crude. An external embedder is a drop-in via `entity.embedded` events.

## 7. The policy layer as a formal object

Every side effect passes through one of four gates; each rule below is enforced in code and covered by `tests/policy.test.mjs`.

**Data gate** (`policy/data.mjs`, applied by `Ledger.emit` to every body): secret patterns (GitHub, Anthropic/OpenAI-style, AWS, Slack, Google, Stripe, npm, JWT, private keys, bearer tokens, URL credentials) → `[REDACTED:type]`, with a `policy.redacted` event recording only **type and location**; sensitive keys (`password`, `token`, `authorization`, …) → redacted whatever the value; PII patterns (email, phone, IPv4, SSN, Luhn-valid cards) → redacted; declared person fields → keyed pseudonyms (HMAC-SHA-256 with an operator salt, accent- and case-insensitive), and plug-ins that process person data cannot load without the salt.

**Manifest gate** (`policy/manifest.mjs`): a sensor declares hosts (FQDNs only), path prefixes, methods (GET/HEAD; POST only if declared read-only), minimum interval, daily cap, byte cap, auth mode and token *environment variable name*, data classes, and a terms-of-use URL. Unknown keys refuse the plug-in — `bypassRobots`, `cookies`, `scrape` are refused by the schema itself. Authenticated access requires `terms.officialApi: true`: **authenticated scraping cannot be declared.**

**Network gate** (`policy/network.mjs`): requests only inside a sensing scope for the scoped sensor; only declared endpoints; https only; no credentials in URLs, query strings or caller headers; `robots.txt` fetched (cached as an event for 24 h) and obeyed with longest-match semantics and `Crawl-delay`; per-host minimum interval and single in-flight request; per-run, per-sensor and per-host-per-day caps shared across workers through the log; **401/403/429 are stop signals** — the host is blocked (24 h, or `Retry-After`) for every worker; three 5xx trip a breaker; redirects are not followed; bodies are size-capped and reads time out; tokens come only from the environment, only for a declared auth mode the operator has authorized in config, and only their *location* is ever recorded. A global `fetch` guard routes even a naïve plug-in through the gate.

**Action gate** (`policy/actions.mjs`): the loop can only **propose**. Approval is refused in any autonomous context (CI, cron, Colab, `LOAM_AUTONOMOUS`); execution is a separate human-invoked path that requires an approved proposal *and* an explicit confirmation *and* a non-autonomous context. The worker has no execute path (tested: no `proposal.executed` after runs).

What is enforced versus trusted: everything above is enforced. Two things are trusted and tested instead: that a plug-in's `value.score` is pure (it receives no network handle, and the global fetch guard denies out-of-scope calls), and that a plug-in pseudonymizes the person fields it declares (end-to-end tests assert no fixture names survive into the log).

## 8. Limitations and next steps

- **Delayed credit for polls** (importance-weighted attribution through the entities a finding touched).
- **External embedder** worker (Colab) writing `entity.embedded` events; the hash embedder remains the fallback.
- **Vector clock compaction** and ledger segment rotation for long-lived deployments.
- **Cross-domain memory**: entities that appear in several domains (a paper's authors and a repo's maintainers) are deliberately kept apart today.
- **Learned value functions**: today judgments override and affinely calibrate; a small Bayesian logistic model over the plug-in's feature vector is the obvious next step and fits the same log.

---

# 9. v3 — where the ceiling is, and what moved it

v3 is additive (new event kinds, new projections, new modules; DECISIONS D14–D23). With every flag off the worker emits the v2 event stream, the 45 v2 tests pass unchanged, and v2 folds produce identical state on old logs (`tests/v3.test.mjs`). All numbers below are hidden-truth value on the toy world, deduplicated across runs, 30 heartbeats of 8 s, novelty window ≥ the experiment length, 5 world seeds (7, 11, 23, 31, 41); where noted, 3 independent random streams per configuration (D23). Late = mean of the last 10 runs; cum = 30-run cumulative.

## 9.1 The plateau, quantified (v2)

Over 40 runs the v2 substrate peaks in runs 10–20 and settles 15–30 % lower: true value per run 5.7 → 4.7, 5.4 → 3.9, 5.0 → 3.1 on three seeds; its own novel-value estimate decays monotonically (6.5 → 4.4, 7.3 → 4.0, 6.5 → 3.7) while mean novelty stays 0.74–0.82; fixed-grid coverage saturates at 0.12–0.16 with illumination stalling (26–34 cells). Part of the run-30+ decline was a measurement artifact (the 30-day novelty window re-admits early entities the harness had already counted); with a consistent window the plateau is real but milder (5.7 → 5.1, 5.4 → 4.3, 5.0 → 3.5).

## 9.2 Where the gap is: the ceiling decomposition

For each run the harness computes the best 20 hidden-truth values among everything that exists (*world*), among what memory holds (*memory*), among what the strategies surfaced (*pool*), and what was delivered; plus a hindsight ridge model over the current feature set trained on the truth of every past candidate (*linear*), i.e. what an unlimited judgment budget could reach with this model class.

| late-run, seed 7 (seed 11) | world | memory | pool | delivered | linear (hindsight) |
|---|---|---|---|---|---|
| v2 | 12.4 (13.7) | 12.1 (13.0) | 8.8 (6.4) | 5.0 (3.0) | 4.96 |

Reading: **polls are not the bottleneck** (memory ≈ world); search surfaces 50–75 % of what memory holds; **scoring delivers roughly half of what the pool contains**, and a linear model over these features would reach only ≈ 5.0 with unlimited labels. The floor is the observables, not the label budget or the allocation. This inverted the plan: the diversity mechanisms (1, 2, 6) attack a gap that is second-order; the value mechanisms (3) attack the first-order gap and are themselves bounded.

## 9.3 What each mechanism did (metric it should move → what happened)

| mechanism | metric it should move | isolated result | verdict |
|---|---|---|---|
| **1. Learned behavior space** (`descriptor: 'both'`) | illumination, productive strategies, pool width, at no value cost | ≈ 52 learned cells vs ≈ 27 illuminated fixed cells; productive strategies +35 %; pool 190 vs 95 candidates; late value 0.99× | **ships on** — diversity moved, value did not |
| **2. Frontier (POET)** | transfer elites, sustained novel value | 0 transfer elites in the fixed grid; late value 1.04× alone, **0.92× under the value model** | **ships off** |
| **3. Learned value model + EI judgments** | calibration error, late true value at equal judgment budget | first version −20 % (under-regularized); regularized + neighbour features: calibration 0.19 → 0.14; with 10 judgments/run **+6 % cum, +9–10 % late, +11 % hits** over v2-without-judgments, every stream above every baseline stream; v2's own judgment path (affine) is **−12 %** | **ships on** |
| **4. Delayed credit** | true hits from groundwork | −4 %; premise (poll allocation limits value) false here | **ships off** |
| **5. External embeddings** | soft-novelty discrimination | plumbing + tests; synthetic texts make quality unmeasurable here | shipped, unmeasured |
| **6. Plateau sentinel** | post-intervention slope | diagnosis correct; interventions neutral (they target search) | **observe-only by default** |

## 9.4 The judgment mechanism, pushed until it stopped responding

Judgment budget per heartbeat (v3 shipping configuration, 3 seeds, one random stream, artifact-free — see below): **0 → 121.3** (v2), 5 → 120.7, **10 → 125.0**, **20 → 129.1**, **40 → 131.3** cumulative; late-run true value 4.59 → 4.55 → 4.72 → 4.93 → 5.00; true hits 8.2 → 8.4 → 8.3 → 8.9 → 8.7. The response is monotone and saturating: each doubling of the budget buys ≈ 3–4 points, and at 40 per heartbeat late-run value (5.00) sits at the hindsight-linear ceiling (4.96) — judgments reveal item-level truth that features cannot express, which is exactly the information the model lacks. Judged, still-novel entities entering the delivery pool by right is what converts a judgment into a delivery (at 40/run: 131.3 with seeds vs 124.7 without).

Mechanism, in order of discovery: judging *delivered* items informs nothing (they are already delivered) — spend the budget on undelivered candidates; ranking by information gain picks curiosities — Expected Improvement over the delivery cutoff picks decisions (+5 % vs top-k); a judgment is evidence, not truth — precision-weighted combination with a knowledge-gradient discount; and search should discover while judgments confirm (`vmSearch: 'proxy'`; measured at 10/run over 3 streams × 5 seeds: `proxy` 124.9, `override` 124.8, `posterior` 121.5).

**An artifact, found and removed.** An earlier version of this section reported a dip at 20 and a collapse at 40 judgments per heartbeat and blamed an "exploitation trap". It was a wall-clock artifact: the value model recomputed its full 256×256 posterior (Cholesky + inversion) for every judgment to keep a prequential calibration error, which pushed heartbeats past the 8 s toy budget's hard stop and truncated evaluations. A rank-one Sherman–Morrison update (identical posterior, tested to 1e-9, O(d²) per observation) removed it; the curve above is measured with it. The lesson is recorded in D20: a mechanism that "stops responding" must first be checked against the budget accounting.

## 9.5 Noise

Identical configurations under three random streams: v2 117.0 / 118.0 / 118.8; v3 126.8 / 121.0 / 127.0. Per-seed values vary by ±10 %, five-seed means by ±2 %. Every claim above is at the five-seed-mean level.

## 9.6 Where the ceiling is now

Late-run true value moved from ≈ 4.45 (v2) to ≈ 4.86 (v3 at 10 judgments per heartbeat, 5 seeds × 3 streams) and ≈ 5.0 at 40, against a candidate pool that contains ≈ 8.2 and a hindsight-linear ceiling of ≈ 4.96: **v3 delivers what a linear model over the current observables could deliver with unlimited labels, and a larger judgment budget buys only what the features cannot see.** The plateau that remains is an information plateau, not an allocation, search or labelling plateau: the features the core can compute from memory (structure, timing, vocabulary, neighbour signals) do not separate a pre-rise bridge from a habitual pair with less than ≈ 0.14 mean error, and no amount of attention, diversity or judgment-selection cleverness can beat the observables. The mechanism that plateaued is therefore the **value model**, and it plateaued because its features did — the judgment channel around it is the one lever that still responds, with diminishing returns, because it injects information the features lack. The next ceiling move has to come from better observables — real embeddings of real text (mechanism 5, unmeasured here), richer sensors, or interaction features the operator can name — and from judgments that carry *reasons* the model can generalize (the bundle already asks for them).

## 9.7 Honest caveats

- The toy world was designed with memory-dependent value; the ceiling decomposition is toy-specific. Real domains will place the gaps differently (a rate-limited source can make polls the bottleneck, which is where D17's credit would matter).
- The value model costs 3–5× run time on the toy; on a 240 s real-domain budget this is negligible, on an 8 s toy budget it is not.
- The oracle operator is unbiased noise (σ = 0.15). Real operators are biased; the knowledge-gradient discount assumes the noise level.
- Mechanisms 2, 4 and 6 are shipped off with one world's evidence against them, not a proof that they cannot help elsewhere.

---

# 10. v4 — attacking the information ceiling

v4 is additive (four new event kinds, four new modules, new projections; DECISIONS D24–D32). With every v4 flag off the worker emits the v3 event stream, the 58 prior tests pass unchanged, and v3 folds ignore the v4 kinds (`tests/v4.test.mjs`). All numbers are hidden-truth value on the toy world, deduplicated across runs, 30 heartbeats of 8 s, 10 oracle judgments per heartbeat unless stated, novelty window ≥ the experiment length. Experiments now run under a **logical wall clock** (one millisecond per read), so every configuration is exactly reproducible from the log and a seed whatever the machine is doing (D31). Late = mean of the last 10 runs; cum = 30-run cumulative.

## 10.1 The question v3 left

v3 ended at an information plateau: a linear model over the fixed feature set reaches ≈ 5.0–5.3 late true value with unlimited labels, and v3 at ten judgments per heartbeat delivered ≈ 4.9 — within 8 % of that ceiling. Two things could move it: **better observables** (raise the ceiling) and **more supervision** (reach a higher ceiling). v4 builds both as things the substrate does to itself, and measures each against the other.

## 10.2 The mechanisms

**Hindsight labels** (`core/hindsight.mjs`, `core/timetravel.mjs`). The log is a temporal database: relations carry `firstSeen`, series carry time, term bursts carry days. So the memory of any past heartbeat can be re-folded, and an entity that was fresh then can be labelled by what memory knows now. The components are schema-generic and count-based: for every pair of an entity's neighbours (two topics; an author and a topic) a *young-and-growing* score — the structure was born recently (age at that time, discounted over the horizon; a structure that predates memory has unknown age and is never young) and became substantial by the end of the horizon — and a *hindsight burst* (a Poisson surprise of the future count under the past rate); for every neighbour a degree burst and a signal mean-shift; for the text a term burst; for the entity itself its own degree and signal shifts. A *label model* — a bucketed Bayesian ridge from components to operator judgments, trained on entities that have both within two days — turns components into a calibrated value with a variance, so a hindsight label is evidence of known, lower precision next to a judgment (precision-weighted updates are exact for the linear-Gaussian model). Labels enter the model only once twenty judgment pairs exist. One pass per heartbeat labels ~120 entities of one past day; a v4 value-model projection (`core/valuemodel-v4.mjs`) keeps every labelled row and rebuilds the exact posterior whenever the feature space changes.

**Learned observables** (`core/observables.mjs`). A typed DSL of entity → scalar programs over memory — age, observation count, degree, recent edges, edge ages, signal statistics and percentiles, surprisal and burst, pair statistics over any two relations (co-count, co-age, recent fraction, recent rate), neighbour aggregation to depth two, and arithmetic — with ≈ 850 distinct *shapes* of program. Candidates are proposed (random and mutated from adopted ones), their outputs are recorded on every labelled row, and their fitness is the fraction of the value model's *residual* their bucketed output explains, held out by batch parity. One adoption per step, a redundancy check against adopted observables (Spearman > 0.9 retires the candidate), retirement of the unfit, a cap of sixteen. Adopted observables are bucketed on their adoption quantiles and become features of the value model; the model is rebuilt exactly on every revision.

**The grammar grows** (`core/strategy.mjs`). Adopted observables are offered to the strategy DSL as a filter op (`obsFilter(id, cmp, q)`) and a ranker (`rank: obs`), so the search space of *ways of looking* expands with what the substrate learned to *measure*. A genome that names a retired observable degrades to a no-op filter, so old genomes stay valid.

**Retrospective curriculum** (`core/curriculum.mjs`). An environment is a past heartbeat's memory plus the hindsight labels of the entities that were fresh then; a solver is a genome; its fitness is the labelled value it would have surfaced. Environments spawn from newly labelled days, are retired by a minimal criterion (nobody scores → impossible; the bar is cleared → solved, spawning a child with a higher bar), and transfer both ways: live elites are tried in the past, past elites are tried live through the existing `transfer` path.

**Learning progress and meta-attention** (`core/progress.mjs`, worker). The three learning mechanisms are *actions* — a hindsight pass, a discovery step, a retrospective evaluation — with nominal costs, features, and a measured outcome: the information the value model gained from the pass (nats), the held-out fitness of what discovery adopted, the retrospective fitness. The existing free-energy planner therefore allocates budget across mechanisms by their measured learning progress, under a small reserve (the labels are a complement, D7). A progress projection tracks the value model's learning progress (the slope of its hindsight error), the adoption rate and the rate of *new kinds* of observables (second-order novelty), and declares a frontier stall when all three are flat; `progress: true` raises discovery temperature on a stall so the intervention's effect is measurable.

**The stacked head** (`core/valuemodel-v4.mjs`). Weak labels must inform but never override true ones: a judgment-only head scores deliveries over base features ⊕ observables ⊕ the hindsight model's own prediction (bucketed), once ten judgments exist. The hindsight model still supplies the residuals discovery is scored on, where its thousands of rows give statistical power.

## 10.3 What each mechanism did (3 world seeds, one stream each; metric it should move → what happened)

The isolated variants add one mechanism to the v3 shipping configuration; `v4-all` turns everything on. Cum = 30-run cumulative hidden-truth value; late = mean of the last 10 runs; "pool" and "linear" are the late-run hidden-truth ceilings of §9.2 (top-20 of the candidate pool; a truth-trained ridge over the features), "linear ⊕ obs" the same ridge over base features ⊕ the adopted observables.

| mechanism (variant) | metric it should move | cum | late | hits | sustained novel value | pool | linear | linear ⊕ obs | verdict |
|---|---|---|---|---|---|---|---|---|---|
| v3 shipping (reference) | — | 125.0 | 4.72 | 220 | 3.97 | 8.08 | 5.31 | 5.31 | — |
| **discovery + grammar, judgment-fed** (`v4-obsops-judgments`; the shipping v4) | pool ceiling, late value | **134.0** | **5.06** | **235** | **4.66** | 8.42 | 5.66 | 5.49 | **ships on** (+7 % cum, +7 % late, +17 % sustained novel value) |
| discovery only, judgment-fed (`v4-discovery-judgments`) | linear ⊕ obs ceiling | 126.8 | 4.44 | 219 | 4.13 | 8.09 | 5.06 | 5.01 | ceiling moves, value does not: **ships only with the grammar** |
| hindsight labels (`v4-hindsight`) | label ρ with truth; late value | 121.1 | 4.77 | 213 | 4.42 | 8.25 | 4.91 | — | ρ = 0.23–0.40, top-20 by label = 54–69 % of the best truth; **ships off** (−3 %) |
| hindsight + discovery + grammar (`v4-obsops`) | late value | 126.9 | 4.42 | 221 | 4.16 | 7.98 | 5.15 | 5.22 | labels cancel the grammar's gain; **ships off** |
| retrospective curriculum (`v4-curriculum`) | transfer elites, pool | 127.2 | 4.81 | 222 | 4.19 | 8.05 | 5.36 | — | 0.3 transfer elites; neutral; **ships off** |
| everything on (`v4-all`, stacked head) | late value | 120.2 | 4.65 | 210 | 4.14 | 7.95 | 4.79 | 4.86 | **ships off** as a whole |
| everything on, no stacked head (`v4-nostack`) | late value | 121.8 | 4.74 | 212 | 3.77 | 8.59 | 5.88 | 5.78 | stacking neither helps nor hurts |
| everything on, fixed schedule (`v4-fixed`) | late value at equal cost | 123.6 | 4.81 | 214 | 4.46 | 8.50 | 5.26 | 5.28 | meta-attention neutral-to-mild (+1 % under it) |

**Pushing the mechanism that moved, until it stopped** (same seeds, all judgment-fed with the grammar):

| push | cum | late | adopted | elites using observables | reading |
|---|---|---|---|---|---|
| base (24 candidates, 4 proposals/step, 1 step, depth 2) | **134.0** | **5.06** | 5.3 | 3.3 | — |
| lift route (`obsLift: 1.5`: adopt what ranks labelled value even if it explains no residual) | 124.6 | 4.73 | 3.7 | 2.0 | worse |
| more (48 candidates, 8 proposals, 2 steps) | 123.2 | 4.72 | 5.3 | 3.0 | worse |
| lift + more | 124.9 | 4.90 | 7.3 | 4.0 | worse |
| deeper programs (depth 3) | 126.2 | 4.79 | 4.3 | 3.3 | worse |
| stall intervention (`progress: true`) | 127.5 | 4.96 | 5.0 | 4.0 | neutral |

Reading: the direction responds to its basic configuration and to nothing that adds *more* observables. Every push that adopts more, or adopts by a looser criterion, falls back to v3's level: an observable that is spurious dilutes the grammar with a random filter, and with ten judgments per heartbeat (≈ 300 labelled rows over the whole experiment) the held-out test cannot tell more true observables from more spurious ones. **Adoption quality is the plateau of this direction, and adoption quality is bounded by supervision.**

What the substrate discovered, in its own words (seed 7, shipping configuration): `min pair.coAge(authored_by/in × active_in/out)` — how young the author–topic pair is; `mean pair.coRecent(7d)(authored_by/out × in_topic/out)` — what fraction of the author's papers in this topic are recent; `max pair.coRate(3d)(authored_by/out × in_topic/out)`; `min over authored_by/out of [edges(authored_by,in,≤3d)]` — a burst of recent papers by the author. These are the toy's migration and pre-rise structures, found as programs over the schema, not as hand-written features.

## 10.4 The judgment-budget curve, again

Cumulative hidden-truth value over 30 runs, 3 seeds, one stream (the substrate asks for at most every undelivered candidate, so 40 and 80 per heartbeat are the same request):

| judgments per heartbeat | v3 | discovery, judgment-fed | discovery + grammar, judgment-fed |
|---|---|---|---|
| 10 | 125.0 (late 4.72) | 126.8 (4.44) | **137.4 (5.16)** |
| 20 | 129.1 (4.93) | 136.5 (5.05) | 136.9 (5.20) |
| 40 (= every undelivered candidate) | 131.3 (5.00) | 129.8 (4.65) | 133.9 (4.89) |

Reading: observables in the grammar are worth about thirty judgments per heartbeat — at ten they deliver what v3 needs forty for — and their advantage *narrows* as the budget grows (+10 % → +6 % → +2 %). They substitute for supervision rather than compounding with it: with many judgments the judged items enter the pool by right (D19), and the operator does the searching that the grammar otherwise does. The high-budget asymptote — ≈ 5.0 late, ≈ 132–136 cumulative — is the same for every configuration. That is the joint ceiling of the pool and the scoring, and nothing in v4 moved it.

## 10.5 Label quality, measured against hidden truth (seeds 7 and 11, 24 runs, hindsight only)

| statistic | seed 7 | seed 11 |
|---|---|---|
| best single component (young author×topic pair) ρ with truth | 0.37 | 0.30 |
| plug-in proxy at the time, ρ with truth | 0.33 | 0.28 |
| linear label model on the run's ≈150 judgment pairs, ρ | 0.19 | 0.18 |
| **bucketed label model on the same pairs, ρ** | **0.39** | **0.29** |
| truth-trained ridge over the components, 2,000+ rows (the label ceiling) | 0.44 | 0.40 |
| top-20 by label as a fraction of the batch's best-20 truth | 0.38–0.48 | 0.60 |

Reading: the components carry real information about the future (the migration and the pre-rise bridge are visible as young-and-growing pairs), a piecewise label model recovers most of it from a hundred judgments where a linear one recovers half, and the ceiling of the label given these components is ρ ≈ 0.4–0.45. Two effects bound it: the truth is a *window* after an onset (four days of a migration, five days before a rise) while every generic statistic of the future decays inside that window, and memory only sees the world through the feeds it chose to poll (some migration papers are never ingested). A label at ρ ≈ 0.35 is weaker evidence than a judgment at σ = 0.15 by a factor of roughly three per row, which is what the precision weighting assigns.

## 10.6 Where the ceiling is now

**The ceiling moved from 4.7–4.9 to ≈ 5.1 late true value (125 → 134 cumulative, 3 seeds; the 5-seed × 3-stream table in §10.7 is the claim), and the information ceilings moved with it: the candidate pool's hidden-truth top-20 from 8.1 to 8.4–9.2 and the truth-trained linear ceiling over what the substrate can measure from 5.3 to 5.5–6.2. What plateaued next is observable *adoption*, because its supervision did: the substrate can now propose ways of measuring that carry information the fixed features lacked, but it can only tell a true one from a spurious one with the operator's ten judgments per heartbeat, and its own labels — the memory's future, calibrated — reach ρ ≈ 0.4 with the truth, too weak to substitute (a model that fits them well fits the truth worse).** The next ceiling move therefore has to come from *supervision* that is both cheap and truth-aligned: hindsight labels whose components the operator can name and correct (the label model already learns from judgments; it needs components that track the operator's notion of value, which on the toy is a window after an onset that no generic statistic of the future respects), or judgments that carry reasons the observable search can generalise. Search is no longer the bottleneck — observables in the grammar showed the pool can move — and scoring is no longer feature-bound; both are now bound by how much truth reaches the substrate per heartbeat.

## 10.7 The claim, at the noise level that matters (5 world seeds × 3 random streams, 30 runs, 10 judgments per heartbeat)

PENDING_FINAL_TABLE

## 10.8 Honest caveats

- The hindsight verdict is one world's. The toy's truth is a *window* after an onset (four days of a migration, five days before a rise); every generic statistic of the future decays inside that window, which is why the label ceiling given these components is ρ ≈ 0.45. A domain whose value is "became big later" is where hindsight should pay, and the label metric (D24) is what will say so.
- The discovered observables were selected on ten oracle judgments per heartbeat with σ = 0.15. A biased operator would bias what the substrate learns to measure; the held-out test protects against noise, not against a consistent bias.
- The grammar-growth advantage narrows with the judgment budget; in a deployment where the operator judges forty items per heartbeat it is worth little.
- Every v4 mechanism costs run time on the toy (≈ 1.4× for the shipping configuration, ≈ 4–6× with hindsight on); on a 240 s real-domain budget this is negligible.
- The 40/80-judgment points coincide because the substrate asks for at most every undelivered candidate; the curve's right end is a harness ceiling.
- Three-seed means differ from five-seed × three-stream means by a few percent (§9.5); every per-mechanism verdict above is at the three-seed level and only the shipping configuration is measured at the five-seed × three-stream level.
