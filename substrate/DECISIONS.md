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

---

# v3 — pushing the ceiling (additive)

Everything below is additive: new event kinds, new projections, new modules, config flags that default to v2 behaviour. Invariants I1–I4 and the four policy gates are untouched; `tests/v3.test.mjs` asserts that default flags emit no v3 events and that v2 folds ignore the v3 kinds. Numbers are in DESIGN.md §9.

## D14 — Measure the plateau before touching mechanisms; instrument the ceiling, not just the score
**Choice.** Extend the harness with three hindsight ceilings per run — the best 20 hidden-truth values among everything that exists (*world*), among what memory holds (*memory*), among what the strategies surfaced (*pool*) — next to what was delivered, plus a hindsight ridge model over the current feature set trained on the truth of every past candidate (*linear*).
**Why.** "Where does it plateau, and why" is a question about gaps: world→memory is polls, memory→pool is search, pool→delivered is scoring. Without the decomposition every addon looks like a coin flip.
**Cost.** Toy-only (needs hidden truth); ~2× harness time. It changed the whole plan: polls were never the bottleneck, scoring was.

## D15 — Learned behavior space as a second archive, never a replacement
**Choice.** Phenotype vectors (~30–40 dims) per evaluation as `strategy.phenotype` events; a vector-quantized archive (`core/vq.mjs`) with on-demand cells, slow centroid drift, widening `tau` at capacity and periodic re-encoding; `descriptor: 'both'` interleaves parents from the learned and the fixed grid.
**Why.** AURORA/VQ-Elites: let the archive's cells follow the phenotypes actually produced instead of a hand-picked 6³ grid. It moved its metric (≈50 learned cells vs ≈27 illuminated fixed cells; +35 % productive strategies; a wider candidate pool) at no cost in hidden-truth value.
**Cost.** ≈ +40 % run time; more parents means the planner's per-cell curiosity is spread thinner. Diversity did not raise value on its own (D18).

## D16 — Frontier challenges: built, measured, shipped off
**Choice.** POET-style challenges (`core/frontier.mjs`): a value bar and a memory region, a minimal criterion, transfers in both directions. Off by default.
**Why.** Neutral in isolation and −8 % under the value model on the toy: transfers never displaced main-archive elites (a strategy tuned to find two great items and eight duds loses on mean novel value), and search was not the bottleneck. Kept because a domain whose value is regional (old entities, a rare type) is exactly where it should pay; the harness will show it.
**Cost.** Code and tests carried for an unproven mechanism; ~1 KB of events per heartbeat when on.

## D17 — Delayed credit: built, measured, shipped off
**Choice.** Provenance projection, credit assignment with neighbour and recency weights, a planner variant that folds `credit.assigned` with its own running scale. Off by default.
**Why.** The premise — poll allocation limits value — is false in the toy (memory ceiling ≈ world ceiling), and the extra observations perturbed a planner that was already fine (−4 %). Untested where the premise might hold (rate-limited real sources).
**Cost.** As D16.

## D18 — The value model: residual, regularized, features not tokens, a two-stage design
**Choice.** Bayesian linear model of the residual *judgment − plug-in score* over generic bucketed entity features, prior variance 0.005, no token features, active only after 10 judgments; search sees the model's posterior (one scale for everyone) and delivery ranks by it; the v2 affine calibration is disabled when the model is on.
**Why.** The first version (prior 0.25, tokens) was under-regularized and cost 20 %; regularization and neighbour-signal features brought calibration error from 0.19 to 0.14. The affine calibration turned out to be net harmful on its own (it compresses scores; disabling it restored the no-judgment baseline). A hindsight ridge over the same features with unlimited labels reaches only ≈5.0 late true value versus 4.4–4.6 for the raw proxy: the feature set is the information floor, so a better model class without better observables cannot move far.
**Cost.** 3–5× run time (feature extraction per candidate); the model's gains are bounded by the features.

## D19 — Judgments are evidence, and they are spent where they change a decision
**Choice.** Expected Improvement over the delivery cutoff with a knowledge-gradient variance (a noisier judgment is worth less) selects which *undelivered* candidates to ask about; a received judgment is combined with the model by precision (`posteriorValue`), never treated as truth; judged, still-novel entities enter the delivery pool by right.
**Why.** Judging the top-k delivered items (v2) informs nothing — they are already delivered. Judging by information gain alone picks curiosities, not decisions. Trusting a noisy judgment as truth invites the winner's curse on marginal items; combining it with the model by precision does not. The response to the budget is monotone with diminishing returns (DESIGN §9.4); ten per heartbeat is what an operator will plausibly do, forty still helps.
**Cost.** Assumes a judgment noise level (`judgmentSd`, default 0.15).

## D20 — "Stopped responding" must be checked against the budget accounting first
**Observation.** The first budget curve showed a dip at 20 and a collapse at 40 judgments per heartbeat, and a plausible story (an exploitation trap: known value out-competing discovery) was written for it. The story was wrong. The value model recomputed its full posterior (O(d³)) for every judgment, heartbeats with many judgments exceeded the toy's 8 s budget × 1.5 hard stop, and evaluations were silently truncated. A rank-one Sherman–Morrison update (same posterior, O(d²)) removed the artifact and the curve became monotone. Two consequences are kept: `vmSearch: 'proxy'` remains the default because it is the principled separation of discovery from confirmation and measured equal to `override`; and every "plateau" claim in DESIGN §9 was re-measured after the fix.

## D21 — The sentinel diagnoses; intervening is opt-in
**Choice.** `sentinel: 'observe'` folds run metrics and reports stagnation (flat value per second, saturated archive, decaying novel value) and the before/after effect of interventions; `sentinel: true` also rotates temperature → frontier → descriptor interventions.
**Why.** Interventions target search diversity, which the ceiling analysis shows is not what limits value on the toy; they were neutral. The diagnosis is what an operator needs.

## D22 — External embeddings: plumbing shipped, quality unmeasured
**Choice.** `entity.embedded` events from any encoder via `loam embed`; the memory's vector space switches wholesale to an external embedder once it covers half the text-bearing entities.
**Why.** Hashed n-grams are the weakest link in soft novelty and phenotype spread; a real encoder is free on Colab. The toy's texts are synthetic tokens, so no quality claim is made here.

## D23 — Random streams are part of the experiment
**Observation.** Identical configurations under different random streams differ by ≈ ±10 % in cumulative hidden-truth value over 30 runs — comparable to the effects under test. Every v3 claim in DESIGN §9 is therefore reported over 5 world seeds × 3 random streams, with the spread.

---

# v4 — attacking the information ceiling (additive)

Everything below is additive: four new event kinds (`hindsight.labeled`, `observable.proposed/adopted/retired`; retrospective environments reuse `challenge.*` with `spec.retro`), new modules, new projections, config flags that default to v3 behaviour. Invariants I1–I4 and the four policy gates are untouched; `tests/v4.test.mjs` asserts that v3 flags emit no v4 events, that v3 folds ignore the v4 kinds, and that a v4 run is reproducible from the log and a seed. Numbers are in DESIGN.md §10. **The outcome is a negative result measured well**: no v4 mechanism moves hidden-truth value on the toy under a paired protocol, so every one of them ships off, with the instruments (label-vs-truth, the ceiling over discovered observables, the logical clock, paired streams) shipping on.

## D24 — Measure the label before trusting it: hidden-truth correlation of self-generated labels is a first-class metric
**Choice.** Every hindsight label the substrate writes is scored in the harness against the toy's hidden truth (rank correlation per batch, and the fraction of the batch's best-20 truth its top-20 captures), next to the plug-in's own proxy at the same moment.
**Why.** A self-supervised label is only worth what it knows about the truth. The first version of the components (raw log-ratio growth, last-point signal growth) reached ρ ≈ 0.28 — *below* the plug-in proxy (0.34): the value model would have learned to predict a signal weaker than the one it already had. Without this metric the failure would have read as "hindsight is neutral" instead of "the label is the bottleneck".
**Cost.** Toy-only, like the ceiling decomposition (D14).

## D25 — Hindsight statistics are count-aware and onset-relative, and a structure older than memory is never "young"
**Choice.** Pair, degree and term components are hindsight bursts (a Poisson surprise of the future count under the past rate, the rate shrunk only for structures younger than seven days) and *young-and-growing* scores (age at the time discounted over the horizon × the eventual size); signal components are window mean-shifts; anything whose birth predates the first observation in memory has unknown age and is never young.
**Why.** Raw log-ratios reward tiny counts (1 → 3) as much as real bursts; a last-point/max-of-window signal statistic is swamped by Poisson noise; a fixed pseudo-history biases every *old* structure toward "bursting" (common tokens scored 0.56); and in a memory that is a few days old, everything looks young. Each fix was measured: the best component's ρ with truth went from 0.24 to 0.37, and the truth-trained ceiling over the components from 0.37 to 0.44.
**Cost.** Two statistics per pair kind (a few more label-model features). The ceiling stays at ρ ≈ 0.4–0.45 because the truth is a *window* after an onset while generic statistics of the future decay inside it — a limit of what hindsight can know, not of the estimator (§10.5).

## D26 — The label model is piecewise-constant, and labels are evidence only after twenty judgment pairs
**Choice.** Bucketed component indicators plus linear terms in a Bayesian ridge; hindsight rows are stored from the first pass but enter the value model only once twenty (components, judgment) pairs exist, at which point the exact posterior is rebuilt with all of them.
**Why.** On the run's own ≈150 judgment pairs a bucketed model reaches ρ = 0.39 with hidden truth where a linear one reaches 0.19 (the relation is a threshold, not a slope). An uncalibrated label (prior 0) is a systematic bias, and precision weighting cannot fix bias — only variance — so the rows wait.
**Cost.** The first ≈ 6–8 heartbeats of hindsight rows are stored, not used; a rebuild of ≈ 3,000 rows costs ≈ 0.2 s at dim 256.

## D27 — Hindsight labels: built, measured, shipped off (with the retrospective curriculum that depends on them)
**Choice.** `hindsight: false`, `curriculum: false` by default; both remain available and tested, in two modes (`hindsightUse: 'evidence' | 'select'`).
**Why.** Paired over 5 seeds × 2 streams (DESIGN §10.3): labels as evidence for the value model cost 4 % of cumulative hidden-truth value (0/10 paired wins), the curriculum costs 6 % (0/10), and labels used only to select observables are neutral (0.99×, 5/10). The labels do know something (ρ ≈ 0.3–0.4; the top-20 by label carries ≈ 65 % of the achievable truth), but v3 already delivered within ≈ 8 % of the truth-trained linear ceiling over its features with ten judgments per heartbeat, so a label with a third of a judgment's precision and a systematic component only adds bias to a model with almost nothing left to learn from these features. The planner agreed — under meta-attention it stopped choosing hindsight passes.
**Cost.** ≈ 1,500 lines of mechanism carried for a result that says no on one world. Kept because the premise — a domain where the operator cannot judge but the future is observable — is common outside the toy, and because the label metric (D24) will say when it applies.

## D28 — Learned observables are discovered from the value model's residual, held out by batch, one adoption per step
**Choice.** A typed entity→scalar DSL (`core/observables.mjs`, ≈ 850 program shapes); candidates proposed from the first heartbeat so evidence accrues before labels arrive; fitness = held-out R² of the bucketed output against the current residual, by batch parity; redundancy check against adopted observables; at most one adoption per step, sixteen adopted at most; the feature space of the value model is rebuilt exactly on every revision.
**Why.** Feature construction by evolutionary search is the rigorous form of "let the substrate discover what to measure" (La Cava's FEAT and evolutionary feature synthesis); scoring on the residual makes every adoption marginal by construction; holding out by batch is what keeps a search over hundreds of candidates from adopting noise. Measured, paired: the truth-trained linear ceiling over base ⊕ discovered observables equals the fixed-feature ceiling (5.20–5.29 vs 5.22–5.33), i.e. with ten judgments per heartbeat the search does not find observables that carry truth the fixed set lacks, and with self-generated labels it finds observables that carry the labels' structure. **Ships off** (0.98× cumulative value, 3/10 paired wins); the search itself is sound (its unit tests recover a planted residual explainer and reject noise) and its instrument — the ceiling over discovered features — is what says when a domain's supervision is rich enough for it.
**Cost.** With judgment rows only (ten per heartbeat) evidence is slow — the first adoption lands around heartbeat 12 and 2–6 observables are adopted by heartbeat 30; each heartbeat costs ≈ +0.1 s.

## D29 — The stacked head: weak labels inform, true labels decide
**Choice.** When hindsight is on, a judgment-only head scores deliveries over base features ⊕ observables ⊕ the hindsight model's prediction (bucketed); the hindsight model supplies residuals for discovery.
**Why.** The standard remedy for weak supervision. It did not rescue hindsight on the toy (D27), which is itself informative: the head learned to ignore the hindsight feature and the remaining loss came from judgments being spent differently.
**Cost.** A second 256-dim model, rebuilt with the first; disabled automatically when hindsight is off.

## D30 — Observables grow the grammar; the proxy moves, the truth does not
**Choice.** Adopted observables become a seed (`topObs`), a filter op (`obsFilter`) and a ranker (`obs`) of the strategy DSL. A genome naming a retired observable degrades to the plain seed / a no-op filter, so every old genome stays valid. Off by default (`obsOps: false`); `v4-grammar` is the named variant.
**Why.** This is open-endedness of the *space*, not only of the population, and it does what it should to the substrate's own metrics: sustained novel value +6–13 %, marginally more illumination and learned cells, and adopted programs that read as the toy's migration structure. On hidden truth it is neutral (0.97–1.00× cumulative, 3/10 and 7/15 paired wins; late 1.01×), and the pool's hidden-truth ceiling does not move (8.09 vs 8.13): the grown grammar finds more of what the proxy values and the same amount of what is valuable. Pushing it — more candidates and steps, a lift-based adoption route, deeper programs, a stall intervention — changes nothing (0.97–0.98×). An unpaired three-seed sweep had shown +7–10 %; it was stream noise (D33).
**Cost.** 1.2× run time on the toy; a grammar diluted by spurious observables is a real risk when adoption is under-supervised, which on this world it always is.

## D31 — Experiments run on a logical wall clock
**Choice.** The harness passes a clock that advances one millisecond per read; event times, learned action costs and time-travel cutoffs become functions of the log alone. Learn actions carry nominal (declared) costs.
**Why.** Under CPU contention the planner's wall-clock cost estimates changed which marginal action fit the budget and two identical runs diverged — the same class of artifact as D20. Reproducibility from the log and a seed is an invariant of the design; the harness must not depend on what else the machine is doing.
**Cost.** `elapsedMs` inside the log is logical; the harness records real wall time separately.

## D32 — Meta-attention is mechanism-level attention with the existing planner, and it is neutral here
**Choice.** Hindsight passes, discovery steps and retrospective evaluations are planner actions with nominal costs, features and a measured learning-progress outcome (nats of information gained by the value model; fitness of adopted observables; retrospective fitness), under a 15 % reserve.
**Why.** It falls out of the design: "which mechanism to invest in" is the same expected-free-energy question as "which action". Measured paired against a fixed schedule with everything on, it is neutral (0.950× vs 0.994× of v3; the planner stops paying for hindsight passes, which is the right call, and it does not matter). With only discovery on, the one learn action always fits its reserve and the question is moot.
**Cost.** Nominal costs are arbitrary units; the reserve is a tunable like D7's.

## D33 — Compare configurations under identical streams, or not at all
**Choice.** The harness pairs every variant with its reference: the same world seed, the same planner random stream (`rngTag`) and the same oracle-noise stream; verdicts report the mean of paired ratios and the number of paired wins; three-seed single-stream comparisons are used for smoke, never for a verdict.
**Why.** The first sweeps seeded the planner and the oracle by variant name, so each variant ran under its own streams; they reported +7–10 % cumulative hidden-truth value for the grammar configuration, and a whole paragraph was written about why. Paired, the same configuration is 0.97–1.00×. On this world a run's cumulative value has a standard deviation of ≈ 6–9 (5–7 %), so an unpaired three-seed difference of 7 % is under two standard errors. v3's D23 had measured the noise; it had not yet enforced the pairing.
**Cost.** Paired runs are one more parameter to remember; the harness now defaults to pairing whenever `rngTag` is given and the CLI documents it. The paired standard error of a ten-run mean ratio is still ≈ 2 %, so effects under ≈ 4 % are not resolvable on the toy at this scale.

# bounty domain — anatomy × pathology × EV × Loam (additive, a plug-in only)

## D34 — The bounty capability is a domain, not a core change
**Choice.** Anatomy, pathology and EV enter behind the existing plug-in interface (`plugins/bounty`); `core/` and `policy/` are untouched, and all 68 prior tests pass unchanged (73 with the 5 new ones).
**Why.** v4's finding was that the ceiling is data + supervision, not algorithm (DESIGN §10). The right response is to supply the missing observables and the teacher, not to add engine. A domain keeps that honest — the same core that watches literature and OSS health now watches bounty scope, and the diff is data + one plug-in.
**Cost.** The plug-in cannot change core behaviour it might want (e.g. a bespoke novelty metric for cells); it must express everything as schema, signals, value and a sink. That constraint is the point.

## D35 — The observe-only boundary is the policy layer, restated in the plug-in, and tested
**Choice.** The only declared endpoint is the public scope feed; the plug-in never contacts a listed target. The end-to-end test asserts that the only host touched across a heartbeat is the feed host. Anatomy ships as invariants and `observableSignals`, techniques as one-line *how-found* + source link — no payloads, no target-specific steps.
**Why.** "Legal" has to be a property of the code, not a promise in a README. The substrate already enforces public-only, robots, and 401/403/429-as-stop (D-policy); the plug-in adds nothing that could reach a target, and a test pins that so a future edit that did would fail CI.
**Cost.** The loop can only reason from what is already public; it can be wrong about a target's real anatomy (inference, never proof). That is the correct trade for staying observe-only.

## D36 — EV is ScoutIq's `evaluateTarget`, unmodified, degrading to null enrichment
**Choice.** Reuse `scripts/ev-core.mjs` `evaluateTarget` directly, with `repoSignals: null` for feed assets; map `max_severity → a nominal reward` only when the program declares it pays, so non-paying programs score EV 0.
**Why.** Reimplementing the EV formula would let the two drift; calling the real one makes the integration genuine and inherits ScoutIq's exclusions and `P(first)` (its own fresh + low-crowd measure). Null enrichment is honest: the feed does not carry repo internals.
**Cost.** Without enrichment `P(findable)` leans on the classifier and `freshCode`/`hardening` are absent, and the nominal reward table is a coarse public inference. Named as the first weakness in the honest report; the fix is per-target enrichment, which is more network and more scope.

## D37 — `mechanismFamilies` is the join; it is coarse on purpose, and fingerprints refine it
**Choice.** Seam ⇄ technique via the ten shared families (recall-first, ≈ 48 techniques/seam); target ⇄ technique via `fingerprints` (a technique's preconditions vs a target's public observable fingerprint) for selectivity.
**Why.** The atlas and the PDF were built to the same ten-pattern ontology, so the family key is a real shared vocabulary, not glue. Coarse recall is the right default for a *discovery* tool: surface the right technique among family-mates and let judgments prune. Fingerprints stop a smart contract from attracting HTTP-desync techniques.
**Cost.** Some listed techniques share only the family, not the exact mechanism — visible false positives. Deliberately left as the first thing operator judgments should tighten (the value model learns family-only matches are weak); the alternative, a hand-curated seam→technique table, would be more precise and far less maintainable, and would not compound.

## D38 — "Tried" is operator-owned, out-of-band; the loop never infers it
**Choice.** A tried *cell* is `target::seam::technique`, recorded by a human in `data/tried.json`; coverage = applicable − tried and the queue never re-surfaces a tried cell. The autonomous loop never writes this file.
**Why.** A "try" is a test — the one thing the boundary forbids the loop from doing or claiming. Keeping tried state human-authored keeps observe-only crisp, makes coverage deterministic and testable, and matches reality: the loop cannot know what was tried unless told.
**Cost.** Coverage only shrinks as the operator records work; there is no automatic progress. The natural extension (parsing `tried` directives out of the judgment reply during `ingest-judgment`) is left as future work so the boundary stays obvious.

## D39 — The alpha queue is a plug-in sink; learned observables ship off until there is volume
**Choice.** The plug-in ships its own `alpha-queue` sink (queue + one full coverage chart) alongside the substrate's generic digest. `valueModel` + `judgmentsPerRun` + `activeJudgments` are on in `loam.config.json`; `discovery`/`obsOps`/`hindsight` are off.
**Why.** The queue needs domain rendering (class, invariant, untried techniques, source links) the generic digest cannot give. The teacher (judgments) works from run one and is the v4 lever, so it is on. The learned-observable search needs ≥120 rows / ≥100 hindsight rows (D28) that a fixture cannot provide, so it ships off but its inputs (the twelve signals) are declared so it switches on cleanly for a long-running deployment.
**Cost.** Out of the box the "eyes" are the declared signals and the graph, not yet evolved observables; a real deployment must accumulate data before that layer earns its runtime (DESIGN §10.3).

# bounty domain — real feed + the investigation-prep loop (additive)

## D40 — The real feed is cached politely; caching is opt-in so unit tests are untouched
**Choice.** The sensor points at the live ~18 MB HackerOne feed. Politeness is layered: a TTL that serves a fresh snapshot with no request; a conditional GET (`If-None-Match`) that downloads only on change; stale-if-error that reuses the last good snapshot on a block/5xx. The cache is opt-in (`options.cacheDir`, under gitignored `.loam`); with no cacheDir the sensor fetches every poll exactly as before.
**Why.** Re-downloading 18 MB every heartbeat is rude and slow, but the cache must not change the deterministic unit tests (which inject their own fetch and assert the feed was contacted). Opt-in gives production politeness and leaves the tests — and the boundary test that the feed host is the only host touched — exactly as they were.
**Cost.** A stale snapshot can be up to `cacheTtlMs` old (default 6 h); acceptable because bounty scope changes slowly and freshness is re-derived from Loam's memory, not the HTTP layer. Node's built-in fetch needs the env proxy/CA in a sandbox (documented in the runbook); in CI/Colab neither is needed.

## D41 — A tried cell's outcome becomes a judgment on the target, not a per-cell label
**Choice.** Marking a cell tried with an outcome (`real-defect`/`disclosed`/`fixed` → high; `impact-not-established`/`unreproducible` → weak; `prevented`/`intended`/`out-of-scope` → low) emits one `judgment.recorded` on the *target*, valued by the outcome, and removes the cell from coverage.
**Why.** The substrate's judgment granularity is the entity (target), and the value model regresses over a target's features — so outcomes teach it which anatomy/EV profiles actually pay. Reusing `judgment.recorded` means no core change and the existing value-model calibration applies unchanged.
**Cost.** A per-cell result is coarsened to a per-target judgment, so one dead-end technique nudges the whole target down (as noisy evidence, D26/D29), not just that cell. Finer per-cell value modelling is future work; the tried set already prevents re-surfacing the specific cell.

## D42 — The prep loop stops at ready_for_human_test; the boundary is a missing state, in code
**Choice.** The investigation state machine is `collected → eligible → investigating → ready_for_human_test` (or `rejected`). There is no state after `ready`, and the "next discriminating check" is a described, read-only, human-run observation — never executed. The active test and everything after is the human's, in scope.
**Why.** Observe-only has to be structural, not a promise: if there is no code path that tests, the loop cannot test. The record's job is to *prepare* — pull the invariant from the seam, lay out competing benign explanations, and name the single check that discriminates — so a human spends their scarce authorized-testing time well.
**Cost.** The loop cannot confirm anything; every output is a hypothesis with competing explanations, not a finding. That is the correct trade for staying legal and observe-only, and it is enforced by a test asserting the terminal state and the descriptive check.

## D43 — Prior-art / dedup is probabilistic and low-visibility by construction
**Choice.** At the eligible gate, `estimatePriorArt` reads only public program signals (response efficiency, resolve activity, managed status, crowd proxy, technique age) and returns a probability with `visibility: 'low'`. `likely-known` (p ≥ 0.7) rejects with recorded evidence; otherwise the lead passes with the estimate attached. "Plausibly-novel" is defined as *no public reason to think it is known*, never *new*.
**Why.** We cannot see private report queues, so any dedup claim is a clue, not proof — and the honest failure mode is over-claiming novelty. Encoding low visibility and the conservative definition of novelty in the data keeps every downstream reader from mistaking a heuristic for a lookup.
**Cost.** Real duplicates on quiet programs can slip through, and picked-over programs with a genuinely novel angle can be rejected. A disclosure-index lookup (Hacktivity/CVE/changelogs) would sharpen it and is noted as the next step, not built.

## D44 — Investigation state lives in a local JSONL journal + atomic claim files, not the core log
**Choice.** Records persist as one-line snapshots in an append-only JSONL journal under `.loam`; recovery replays it (last snapshot per lead wins) and tolerates a torn trailing line; leads are claimed with an atomic exclusive-create claim file that expires. Judgments still go through the core event log (D41); only the prep artifacts are local.
**Why.** The core event log rejects unknown kinds (`events.mjs`), and adding kinds is a core change. A self-contained journal keeps the prep loop additive, and lets the atomic-claim + expiry semantics be owned and tested directly (the interrupt-and-resume test) rather than borrowed. Judgments are the thing that must compound across workers, so those alone ride the shared log.
**Cost.** Investigation state does not sync across workers the way the event log does; for multi-worker prep, records would need promoting into the shared log (additive event kinds) or a shared store. The single-worker resume path — the one the task requires — is implemented and tested.

## D45 — Rank by findability × accessibility; reward only modulates
**Choice.** `value.score` for a target is `pFindable × accessibility × (0.5 + 0.2·lowCrowd + 0.15·freshCode + 0.1·cov + 0.05·fresh) × rewardMod`, where `accessibility` is `{static-source:1.0, live-contract:0.75, static-source-hardened:0.35}[workflow] ?? 0.5` and `rewardMod` is a gentle 0.6–1.0 log-scaled factor. Reward no longer sits inside the driving term. A regression test pins that a static-source target strictly outranks an equal-pFindable live-web one, and that 10× the reward cannot buy the top.
**Why.** The old score buried `pFindable` inside a reward-weighted EV, so hardened live-web giants ($10k, pFindable ≈ 0.2) floated above findable source-available targets. Two Kong source audits (operator-verified) confirmed findability, not reward, is the discriminator — a bug you can actually find on an open surface beats a bigger bounty on a surface you can't. On the fixture the on-chain/source-available target moves from #4 to #1 and the reward-giant live-web drops below it.
**Cost.** Reward still matters (it modulates), but a genuinely high-value hardened target now ranks lower than the pipeline used to place it; that is the intended correction, and the operator's tried-journal judgments (D41) can re-weight it if the field disagrees. Absolute scores compress (≈0.03–0.15) because reward is no longer the multiplier — the ordering is what matters, and the digest sorts strictly by it (D46).

## D46 — Enrichment activates the fresh-code lift; the digest excludes non-paying and sorts strictly
**Choice.** (A) An opt-in, anonymous, read-only, rate-limited GitHub-source enrichment (`enrich.mjs`, a second declared endpoint `api.github.com/repos/`) populates `ev.freshCodeIndex` from the public repo (recent commits, best-effort files-added on the pinned HEAD), so genuinely fresh source-available code rises; a 401/403/429 blocks the host and stops enrichment for the run. (B) The alpha-queue sink sorts strictly by score descending and excludes programs that do not confirm bounties (`offersBounties===false` or `pPayable===0`).
**Why.** Freshness is the strongest public findability signal for source, and it was dormant (`repoSignals: null` → freshCodeIndex 0). Enrichment is opt-in so the boundary test stays exact (default runs never reach `api.github.com`); it is anonymous so no credential enters the loop. The sink change stops a $0 target — which the retune gives a small positive score — from ever appearing above a payable one, and makes the printed queue monotonic.
**Cost.** Enrichment adds up to ~3 public API calls per source asset (bounded by `maxEnrich`), and unauthenticated GitHub is 60/hr — enough for a run, self-limiting via the host block. In a locked-down sandbox whose egress proxy binds `api.github.com` to one repo, enrichment is refused (403) and the loop falls back to unenriched EV — proven to degrade gracefully, but it means the fresh-code lift only fires where the public GitHub API is actually reachable (CI/Colab/laptop). files-added is best-effort (a single compare call, capped).
