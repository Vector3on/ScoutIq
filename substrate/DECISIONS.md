# Decisions

Each entry: the choice, why, and what it costs. Numbers refer to DESIGN.md sections.

## D1 — The log is the only source of truth; everything else is a fold
**Choice.** Append-only, content-addressed events; every projection (memory, archive, QD archive, planner, policy state) is a pure fold; snapshots are an optimization that is exact or discarded.
**Why.** Perfect memory and time travel for free; replicas converge without coordination (G-Set + total HLC order); every decision is reproducible from the log and a seed, which is what makes the falsification protocol possible at all.
**Cost.** Full replays are O(|log|). Mitigated by exact snapshots; a very long-lived deployment will need segment compaction (D12).

## D2 — Two storage backends, one schema, zero dependencies
**Choice.** `node:sqlite` locally, Turso/libSQL over its HTTP pipeline API for the hub, same DDL. No npm dependencies anywhere in the substrate.
**Why.** $0 and no supply-chain surface. Turso's free tier is generous, and the HTTP API is a few dozen lines. Node ≥ 22.13 ships SQLite.
**Cost.** `node:sqlite` still prints an experimental warning (silenced in the CLI). The Turso client is hand-written and only integration-tested against a real hub by the operator (RUNBOOK §3); its unit behaviour is covered through the shared schema and the local store.

## D3 — A git ledger as the zero-secret fallback
**Choice.** With no `LOAM_DB_URL`, workers export their own events as per-node JSONL segments under `substrate/ledger/<domain>/` and the cron commits them.
**Why.** Works out of the box with no accounts; per-node files never conflict in git; union merge is the same CRDT semantics as the hub.
**Cost.** In a public repository the log is public, so the *edge* (private state) is not private. Use the ledger for the toy domain and for private repositories; use Turso for anything whose findings are the moat. The ledger also grows without bound (segments rotate at 4 MB; compaction is D12).

## D4 — Strategies are genomes in a tiny typed DSL, not free-form code or prompts
**Choice.** Seed → ≤ 4 pipe ops → ranker, parameters on menus, quantile thresholds, schema-derived validity.
**Why.** Evolution needs a search space where most mutants are valid and cheap to evaluate; a closed DSL makes fitness, behavior descriptors and rationale strings well-defined and *deterministic*; no model in the hot path. Non-obvious strategies (emerging bridges, migrations, silence, new edges) are one op away from obvious ones, which is what stepping stones need.
**Cost.** Expressiveness is bounded by the op set. New generic ops must be added to the core (they are domain-agnostic by construction; domain knowledge enters only through schema, signals and relations).

## D5 — Fitness is novel value, and novelty is measured against what was delivered
**Choice.** `F = mean(value × novelty) − λ|g|`, hard novelty by delivered-within-window, soft novelty by embedding distance.
**Why.** This is the open-endedness pressure: a strategy that keeps re-finding the known decays to zero fitness; strategies that surface *new* value stay elite. It also makes "never deliver the same finding twice" a property, not a filter bolted on at the end.
**Cost.** A genuinely important entity is not re-reported within the window even if its context changes dramatically. Judgments (`entity <id> 0.9`) and a shorter `windowDays` are the escape hatches.

## D6 — MAP-Elites with phenotype descriptors (age, centrality, spread), 6³ cells, curiosity-based parent selection
**Choice.** Descriptors are computed from a strategy's outputs, not its genome.
**Why.** We want diversity of *kinds of findings* (fresh vs historical, hub vs periphery, focused vs diverse), not diversity of syntax. Curiosity (Cully & Demiris) is a bandit over cells and costs nothing.
**Cost.** 216 cells is arbitrary; coverage numbers are only comparable at a fixed grid, which is why the experiment re-bins on a fixed 6³ grid when comparing to the single-cell ablation.

## D7 — Attention: linear-Gaussian Thompson sampling + exact information gain + a complementarity reserve
**Choice.** Hashed features (128 dims), Bayesian linear regression with forgetting, one posterior sample per run, `score = w̃ᵀφ + β·IG`, greedy knapsack by score/cost, and a guaranteed 30 % of budget each for sensing and thinking.
**Why.** This is the tractable reduction of expected free energy for the model we can actually maintain (DESIGN §3.8); both terms are exact for that model. Thompson sampling handles the combinatorial selection with a single sample. The reserve is not a bonus: the pipeline's output is a *conjunction* of sensing and thinking, which an additive objective cannot express; without it, cold-start runs spent their whole budget on polls and delivered nothing (observed before D7 was added).
**Cost.** Double exploration (TS already explores; IG adds directed exploration); β is a tunable with a default, not a derived constant. Features are hashed, so rare feature collisions exist (128 dims, ~10 active per action).

## D8 — Outcomes are normalised per action type by a decaying running maximum
**Choice.** `y = raw / scale(type)`, `scale ← max(0.995·scale, raw)`.
**Why.** Poll outcomes (sum of values of new observations) and evolution outcomes (fitness) live on different scales; without normalisation one type starves the other. Normalising "relative to the best of its kind" keeps both in [0,1].
**Cost.** The split between sensing and thinking is then governed by relative-not-absolute returns plus the reserve. The principled alternative is D9.

## D9 — Polls are credited with the value of what they bring *now* (planned: delayed credit)
**Choice.** A poll's raw outcome is the live value of each new primary entity it observed.
**Why.** Simple, domain-agnostic, and it makes the feed bandit follow *valuable* sources rather than merely productive ones.
**Cost.** No credit for observations that enable findings in later runs (an author's history that makes a migration detectable three runs later). Planned: when a finding is delivered, attribute its score to the (sensor, params) that touched its entity, back through the log.

## D10 — Person data is never stored; identity is a keyed pseudonym
**Choice.** Plug-ins that touch names declare the `person` data class and cannot load without `LOAM_PSEUDONYM_SALT`; names become `HMAC(salt, normalized name)`; the data gate additionally redacts emails, phones, IPs, cards, SSNs.
**Why.** The prompt's constraint, and good hygiene: co-authorship, migration and bus-factor analytics need *identity*, not names. Accent- and case-insensitive normalisation gives cheap entity resolution.
**Cost.** Findings say "author p_3f… entered cs.CR after 12 papers in q-bio"; the operator resolves the paper id if they want the name. Losing the salt orphans all pseudonyms (RUNBOOK §2).

## D11 — Robots.txt is obeyed even for official APIs
**Choice.** A `Disallow` on a declared API path is a denial, logged as `policy.denied`, even if the API's own terms permit programmatic access.
**Why.** "A block is a stop signal" is the operator's rule; when two signals conflict the conservative one wins, and the log shows exactly why nothing was fetched.
**Cost.** If a host's robots.txt disallows its documented API path, that sensor is useless until the operator reviews (RUNBOOK §6). This is deliberate.

## D12 — Deferred: compaction, external embeddings, learned value, cross-domain memory
Listed in DESIGN §8. Each fits the log without changing invariants I1–I4: compaction is a projection snapshot plus a tombstone-free cut of old segments; embeddings are `entity.embedded` events; learned value is a projection of `judgment.recorded` over plug-in feature vectors; cross-domain memory is a domain-less projection.

## D13 — Where it might fail in practice (honest notes)
- **Cold start on a real domain**: the first runs poll broadly and evolve random genomes; expect noisy findings for the first ~10 heartbeats. Judgments accelerate this markedly (bundle → reply → ingest).
- **Value functions are the weakest link**: a bad `value.score` produces confident nonsense; the substrate will faithfully find *novel* nonsense. The calibration path exists precisely because no fixed value function is right for long.
- **Budget accounting is wall-clock**: a slow host (arXiv at 3 s/request) makes polls expensive; the planner learns actual costs but the first run over-plans.
- **Public-ledger mode leaks state**: see D3.
- **Snapshots on a hub are per node**: a fresh Actions runner without the cache replays the whole log from the hub; at ~10⁵ events this is seconds, at 10⁷ it is not (D12).
