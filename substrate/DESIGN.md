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
