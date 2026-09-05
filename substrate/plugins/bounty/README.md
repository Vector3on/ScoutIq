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

**Offline demo (fixture feed, no network, deterministic):**

```bash
cd substrate
node plugins/bounty/demo.mjs --runs 1            # prints the alpha queue + one full coverage chart
node plugins/bounty/demo.mjs --runs 3 --judge    # closes the teacher loop with a stand-in operator
```

**Tests (the 68 substrate tests stay green; 5 new ones prove this domain):**

```bash
npm test
```

**Live (public feed, read-only, policy-guarded):**

```bash
node bin/loam.mjs run --domain bounty            # fetches arkadiyt/bounty-targets-data, observe-only
node bin/loam.mjs bundle --domain bounty --out bundle.md   # the operator's judgment bundle
node bin/loam.mjs ingest-judgment reply.md --domain bounty # fold ratings back in
```

## Honest status — wired vs stubbed

**Wired (runs, tested):**
- Atlas loaded verbatim (19/95/95/38); 120 techniques parsed from the PDF with real source
  links; the two-level join; per-target coverage charts; tried/untried with never-repeat.
- Public fingerprinting from the feed schema (asset type + host shape + program text).
- The **real** ScoutIq `evaluateTarget` EV, degrading honestly to null repo signals.
- The full Loam heartbeat: graph, value model, novelty/diversity delivery, and the
  **judgment loop** (request → bundle → ingest → recalibrate), demonstrated end-to-end.
- The alpha-queue digest (queue + one full coverage chart), and the boundary test.

**Stubbed / weak (named so you can push on it):**
- **EV without enrichment.** `evaluateTarget` runs with `repoSignals: null` for feed assets,
  so `P(findable)` leans on the classifier and `freshCode`/`hardening` are absent.
  `max_severity → nominal reward` is a conservative public inference, not a real payout table.
- **The family join is coarse (recall-first).** Ten families over 120 techniques means a seam
  sees ~48 techniques; fingerprints refine but do not fully disambiguate. Some listed
  techniques share only the *family*, not the exact mechanism. This is by design (a lens),
  but it is the first thing operator judgments should tighten.
- **`crowd` is a proxy** (`1 − P(first)`); a true low-crowd signal needs feed-diffing over
  time (which Loam's memory gives, but the fixture is a single snapshot).
- **Multi-platform normalisation.** HackerOne is fully supported; Bugcrowd/Intigriti/
  YesWeHack are best-effort.
- **Learned observables** (`discovery`/`obsOps`) ship off: they need volume (≥120 rows,
  ≥100 hindsight rows) a fixture cannot provide. The signals are declared so they switch on
  cleanly for a long-running deployment.

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

See DESIGN §11, DECISIONS D34–D39, and RUNBOOK §14.
