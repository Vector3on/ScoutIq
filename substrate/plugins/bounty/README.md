# Bounty intelligence — the four-layer heartbeat

A Loam domain that assembles four things into one running organism and delivers an
**alpha queue**: a prioritised, never-repeated list of public bug-bounty targets, each
annotated with *where* a bug could live, *what* has actually worked there, *what a lead
is worth*, and *why now*.

```
 anatomy    →  where a bug could live      →  data/anatomy.json      (19 classes, 95 seams)
 pathology  →  what has actually worked     →  data/techniques.json   (120 real case studies)
 EV         →  what a lead is worth         →  ../../../scripts/ev-core.mjs (ScoutIq)
 Loam       →  compounding memory + the      →  the substrate (this repo)
              operator's judgments
```

The v4 lesson this repo proved on its own toy world (DESIGN §10) is that the ceiling is
**data + supervision, not algorithm**. So the work here is not more engine. It is wiring
the atlas + catalog in as real **observables** (the *eyes*) and standing up the
**judgment loop** (the *teacher*). The engine is Loam, unchanged.

## The boundary (non-negotiable, enforced in code)

Public data only. This plugin **observes**, **reasons**, and **prioritises**, and delivers
a **queue**. It **never tests, probes, scans, fetches, or exploits any live target.** No
payloads. The only network endpoint it declares is the public program/scope feed
(`raw.githubusercontent.com/arkadiyt/bounty-targets-data`); the substrate's policy layer
(`policy/`) refuses any undeclared host, obeys `robots.txt`, and treats 401/403/429 as a
stop signal for every worker. The end-to-end test asserts that across a full heartbeat the
**only host contacted is the feed** — never a listed target.

Anatomy is the **invariant that must hold**, never how to break it. A technique record is a
one-line *how it was found*, deduped by mechanism, with a link to the researcher's public
write-up — never a payload or a target-specific test step. The exploitation-analysis plugin
is out of scope here and CVP-gated.

## The spine (the join)

`mechanismFamilies` is the shared vocabulary. There are exactly ten, and they are also the
PDF's "ten recurring patterns" — the atlas and the catalog were built to the same ontology,
so the join is real, not glued on:

```
anatomy.seam  ──mechanismFamilies──▶  technique  ──fingerprints──▶  target
   (95)            (10 families)         (120)      (preconditions)   (public feed)
```

Two levels, because the vocabulary is deliberately coarse:

1. **seam ⇄ technique** — static, via `mechanismFamilies`. Every seam sees many techniques
   (avg ≈ 48); this is the recall-oriented reasoning lens, not exact transfer. "This seam
   fails through the same *class* of mistake this technique exploited elsewhere."
2. **target ⇄ technique** — dynamic, via `fingerprints`: a technique's preconditions
   (`document-media`, `ai-agent-mcp`, `smart-contract-evm`, …) matched against a target's
   public `observableSignals` (its asset type, host shape, program text). This is the
   selective layer: a smart contract does not attract HTTP-desync techniques.

`spine.mjs` builds this index once (pure) and produces the **coverage chart** — the doctor's
chart per target: `class → exposed seams (+ the invariant that must hold) → applicable
techniques → tried/untried`. A *cell* is `target::seam::technique`; the queue never
re-surfaces a tried cell.

## The four layers, in code

| layer | file | what it contributes |
|---|---|---|
| anatomy | `data/anatomy.json` | the atlas verbatim: 19 classes, 95 seams (each with `sideA_assumes`, `sideB_assumes`, `mechanismFamilies`, `referenceDocIds`), 95 invariants, 38 observableSignals |
| pathology | `data/techniques.json` | 120 records parsed from the PDF only, one per case: `title`, `year`, `howFound`, `mechanismFamilies`, `fingerprints`, `source`, `sourceUrl` |
| EV | `index.mjs` → `evaluateTarget()` | the **real** ScoutIq EV: `min(cap,reward) × P(findable) × P(payable) × P(first)`, computed from public feed signals (repo-enrichment degrades to null, honestly) |
| Loam | the substrate | memory (the graph of target ⇄ class ⇄ technique), the value model, and the judgment loop |

### The eyes — observables fed to Loam's learned-observable / behaviour layer

The sensor emits a real graph — `target ─fingerprints_as→ class`, `target ─applicable→
technique`, `target ─in_scope_of→ program` — and rich per-target **signals** (`ev`,
`pFindable`, `exposedSeams`, `applicableTechniques`, `distinctTechniques`, `crowd`,
`classesCount`, …). Those signals *are* the eyes: with `discovery`/`obsOps` enabled
(DESIGN §10), the substrate evolves typed observable programs over exactly these, and graph
strategies traverse the spine. Declaring them is how the atlas + catalog become things Loam
can *learn to look with*.

### The teacher — the judgment loop (the real v4 lever)

Every heartbeat, when `valueModel` is on, the worker asks the operator to rate the top-N
**most uncertain** leads (`judgment.requested`, chosen by expected improvement over the
delivery cutoff). The operator answers; `judgment.recorded` folds into the value model and
recalibrates what gets delivered next. This is the compounding edge: the same code without
the accumulated judgments is a worse ranker. It is front-and-center in the runbook below.

## Value function

`score(target) = clamp( evNorm × coverage × (0.7 + 0.2·fresh + 0.1·lowCrowd) + 0.05·coverage·fresh )`

- `evNorm` — ScoutIq `evScore` (dollars) on a saturating log scale. EV already contains
  `P(first)`, which is ScoutIq's own *fresh + low-crowd* measure, so the queue is EV-first.
- `coverage` — untried applicable cells, saturating (a target that exposes seams whose
  techniques have not been tried on it scores high).
- `fresh` — target novelty from Loam's memory (`firstSeen`), the thing the feed-level EV
  cannot see.
- the small last term is a **watch-list floor**: a fresh, technique-rich, low/zero-EV
  target stays visible instead of vanishing.

## Run it

**Live (the real public feed, read-only, policy-guarded).** The sensor points at
`arkadiyt/bounty-targets-data` (~18 MB HackerOne feed). Caching is polite: a fresh snapshot
makes no request; once stale, a conditional GET (`If-None-Match`) downloads only on change;
on a block it reuses the last good snapshot. `robots.txt` is fetched and obeyed (fail-closed).

```bash
cd substrate
# Node's fetch needs the env proxy + CA in this kind of sandbox; in CI/Colab neither is needed.
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=$CA node bin/loam.mjs run --domain bounty   # observe-only heartbeat → out/bounty/alpha-queue.md
```

**The tried-journal + judgment feedback (the teacher).** When you have looked (in *your*
authorized environment) and know the result, record it. The cell never re-appears, and the
outcome becomes a Loam judgment that calibrates the value model:

```bash
node plugins/bounty/journal.mjs mark "<targetKey>" <seamId> <techId> <outcome> --note "why"
node plugins/bounty/journal.mjs list
# outcomes: real-defect · disclosed · fixed  (positive)  |  impact-not-established · unreproducible (weak)
#           prevented · intended · out-of-scope  (negative)
```

**The investigation-prep loop.** For each top lead, build a bounded-question record and walk
it to a terminal state; it STOPS at `ready_for_human_test`:

```bash
node plugins/bounty/prep.mjs --top 10 --resolve-revisions   # prints states + ONE full record
```

**Offline demo + tests (deterministic, no network):**

```bash
node plugins/bounty/demo.mjs --runs 3 --judge   # fixture heartbeat + stand-in teacher loop
npm test                                          # 80 tests: 68 substrate + 12 bounty
```

## The investigation-prep loop

Between the queue and a human tester sits a bounded, observe-only prep loop
(`investigation.mjs`, driven by `prep.mjs`). A **lead** is (target × seam). Its record answers
a fixed set of questions and no more:

1. **exact repo revision** — the public repo HEAD for source assets (`--resolve-revisions`,
   read-only OSINT), or `n/a` for a deployed service.
2. **scope evidence** — the asset, its eligibility, the program, EV.
3. **observed change** — the public signal that surfaced it (fresh scope, untried coverage).
4. **expected invariant** — **pulled verbatim from the seam**, never invented.
5. **competing explanations** — defect · safeguard · intended · misunderstanding.
6. **next discriminating check** — a single read-only, human-run observation that would tell
   defect from benign. **Described, never executed.**
7. **prior art** — a probabilistic, low-visibility dedup estimate (below).
8. **remaining budget.**

States: `collected → eligible → investigating → ready_for_human_test` (or `rejected`, with a
recorded reason). The output at `ready` is a **supported, testable hypothesis** handed to the
human — with the standing reminder that the active test, and everything after, is theirs, in
their controlled environment, in scope. There is deliberately **no autonomous testing step**.

**Prior-art / dedup** (`priorart.mjs`) runs at the eligible gate. It reads only public program
signals (response efficiency, resolve activity, managed status, crowd, technique age) and
returns a **probability with low visibility — a clue, not proof**. `likely-known` (p ≥ 0.7)
rejects the lead and records the evidence; anything else passes with the estimate attached.
"Plausibly-novel" means *no public reason to think it is known*, never *new*.

**Persistence & recovery** (`prepstore.mjs`): every record snapshot is one line in an
append-only journal (a torn trailing line is ignored, never fatal); every lead is claimed with
an **atomic exclusive-create claim file** that expires, so one worker holds a lead at a time and
a crashed worker's lead becomes stealable after the TTL. Kill the loop anywhere and re-run — it
replays the journal and continues. Proven by an interrupt-and-resume test.

## Honest status — wired vs stubbed

**Wired (runs on the real feed, tested — 80 tests):**
- Atlas verbatim (19/95/95/38); 120 techniques from the PDF with real source links; the
  two-level join; per-target coverage; tried/untried with never-repeat.
- **Real live feed** (`arkadiyt/bounty-targets-data`) with polite TTL + conditional-GET
  caching, robots-obeyed; real HackerOne scope fingerprinted to anatomy classes.
- The **real** ScoutIq `evaluateTarget` EV, degrading honestly to null repo signals.
- The full Loam heartbeat + the **judgment loop**, and now the **tried-journal → judgment**
  feedback (outcome vocabulary → value-model calibration).
- The **investigation-prep loop**: bounded-question records, states stopping at
  `ready_for_human_test`, probabilistic prior-art/dedup, and crash-safe persistence + atomic
  claims with an interrupt-recovery test.

**Stubbed / weak (named so you can push on it):**
- **EV without enrichment.** `evaluateTarget` runs with `repoSignals: null` for feed assets;
  `P(findable)` leans on the classifier and `max_severity → nominal reward` is a conservative
  public inference, not a real payout table.
- **The family join is coarse (recall-first)** — a seam sees ~48 techniques; fingerprints
  refine but do not fully disambiguate. The prep loop's candidate technique is simply the first
  untried one on the seam; ranking techniques within a seam is future work.
- **Prior-art is a heuristic, not a lookup.** It reads public program signals only; it does not
  yet query a disclosure index (HackerOne Hacktivity, CVE, changelogs). Low visibility is stated
  everywhere; treat rejections as prioritisation, not proof of duplication.
- **Revision resolution is HackerOne-shaped and GitHub-only**, unauthenticated (60 req/hr), for
  source assets; other hosts and deep change analysis are not built.
- **`crowd` is a proxy** (`1 − P(first)`); a true low-crowd signal needs feed-diffing over time.
- **Multi-platform normalisation**: HackerOne is fully supported; Bugcrowd/Intigriti/YesWeHack
  are best-effort. **Learned observables** (`discovery`/`obsOps`) ship off until a deployment has
  volume (≥120 rows); their inputs are declared so they switch on with a config flag.

**The first judgments the operator should give to calibrate it:**
1. Rate the top identity/agents/defi leads the queue surfaces — these are where EV and
   anatomy agree, and confirming them anchors the value model's high end.
2. Rate a **coarse-join false positive** low (e.g. an HTTP-desync technique listed under a
   smart-contract seam): the fastest way to teach the model that family-only matches are weak.
3. Rate the **$0 watch-list** item (a points-only program) near zero: confirms the EV-first
   stance and stops coverage-richness alone from promoting non-paying targets.

## Data provenance

`data/anatomy.json` is the supplied defensive atlas, verbatim. `data/techniques.json` is
generated from the 120-case PDF only (the parser and its validation live in the commit
history / scratchpad); each record keeps the researcher's primary-source URL from the PDF's
link annotations. `mechanismFamilies` and `fingerprints` per case are derived by an auditable
keyword classifier over the case text, which is preserved in `howFound`. No other dump was used.

Program-maturity signals (response efficiency, resolve activity, managed status) come from the
same public feed and feed only the probabilistic prior-art estimate.

See DESIGN §11, DECISIONS D34–D44, and RUNBOOK §14.
