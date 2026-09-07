# ScoutIq synthesis organism

## The result

The new organism is a bounded, offline observer that can change its observation
vocabulary when its current vocabulary leaves competing source-pattern hypotheses
indistinguishable. It retains useful lenses, transfers them to other entrypoints,
reuses content-addressed evidence, and reopens conclusions when their dependency
closure changes. The loop terminates at a static observation and a human-review
proposal. It has no live-target acquisition, probing or action path.

The combination's most interesting behavior is **selective forgetting of conclusions
without forgetting useful ways of observing**. A changed imported file invalidates
the conclusions depending on it; unchanged observations and the useful family/radius
lens survive. Ordinary answer caching cannot do that by itself. Here the invalidation
unit comes from Blindsight's import anatomy, the retained instrument comes from QD,
and the distinction between an answer and a still-unresolved hypothesis comes from
the information-directed learner. This is novel within these combined branches;
there is no claim of research priority over incremental computation or active learning.

Read the executable evidence in
[organism/examples/results/REPORT.md](organism/examples/results/REPORT.md).

## Source preservation and what was studied

`organism/SOURCES.json` pins the initial heads of every branch. This branch starts
at `master` commit `b91077842b6bfd28e544afefd66203a24b1dc3a0`. No merge, rebase,
or change to another branch is part of this implementation. Code was copied by
path into this new branch; existing master files remain unchanged.

| Part | What is incorporated | Important lesson retained |
| --- | --- | --- |
| Loam v2, `claude/compounding-intelligence-substrate-a806b2` | Its event, ledger, memory, attention and QD architecture through the v4 lineage | Strategies and evidence are separate persistent objects |
| Loam v3, `claude/loam-v3-ceiling` | Additive v3 modules and tests retained in v4 | Measure a ceiling and use paired comparisons; more machinery is not evidence of improvement |
| Loam v4, `claude/loam-information-ceiling-ouus70` | `substrate/`, including all four unchanged policy gates | Better proxies did not necessarily improve hidden truth; new observables need honest interpretation |
| Bounty heartbeat branch | Through the Blindsight lineage: atlas, catalog, family spine, plugin and tests | Family joins are broad recall, not proof a technique applies |
| Blindsight branch | Static extractors/import linker plus the original engine and tests | Evidence coordinates and omitted imports matter; heuristic boundaries are not proven boundaries |
| `blindsight-data` | Inspected stored report/coverage and source snapshot; not copied as current truth | Its 128 facts had a null revision; fresh commit-pinned source is preferable for this slice |
| Melt branch | Unchanged runtime/exporter, capsules and tests; a new partition capsule built with them | A portable reviewed procedure is real; recovering hidden model internals is not claimed |
| Executable Mind branch | Source/tests retained; its hypothesis partition principle adapted to static observations | An observation vocabulary can leave distinct hypotheses observationally equivalent |
| ScoutIq master | Existing `scripts/ev-core.mjs` is called directly | Unmeasured hardening stays null; self-observation is not a paying bounty |

The inherited Loam core is not forked or edited. The new supervisor lives under
`organism/` and directly uses its ledger, memory projection, linear model and QD
projection. It does not call the inherited general worker, network acquisition,
model enrichment or proposal executor. Inherited tools remain separately runnable
for compatibility but are not capabilities of this organism.

## One heartbeat

1. Verify an operator-reviewed local manifest and every file's SHA-256/revision.
   Reject binary input, invalid UTF-8, symlinks, traversal and excessive size.
   Redact sensitive patterns before extraction. Nothing in the snapshot executes.
2. Build the bounded lexical/import index using Blindsight. Whole-word boundary
   hints are supplemented by explicit lexical hints because they miss camelCase.
   Every hint remains an inference, not a discovered trust boundary.
3. Join candidate families to the existing 120 technique references and 95 seams
   across 19 classes. Respect optional operator-supplied `triedCells`; never write
   the tried journal. The report emits reference identifiers and invariant examples,
   not technique procedures or exploit instructions.
4. Construct four competing static hypotheses for each candidate: related symbol
   names occur locally, in captured direct imports, in both, or in neither.
   Start with a local-only lens, or an applicable archived expanded lens.
5. The Melt-frozen kernel filters prediction vectors and returns categorical
   partitions. Their Shannon entropy gives exact expected information gain in
   this finite deterministic model with a uniform prior. Select the next affordable
   observation across targets/families using this entropy, Loam's model uncertainty,
   learned observation yield and a bounded EV modulator.
6. If current questions cannot separate survivors, mutate radius zero to radius
   one. Adopt it operationally only if a captured direct import adds a question.
   Missing imports remain unknown. No URL is fetched to fill the gap.
7. Store fresh observations through Loam's sanitizing ledger. Update attention and
   evaluate the lens in Loam QD using realized finite-model information per file.
   Reused evidence receives no new attention/QD training credit.
8. Emit a static conclusion and a human source-review proposal. Never approve,
   execute, test or turn a lexical answer into a runtime-safety verdict.

## The three memories

- **Evidence memory:** content-addressed observation results, source coordinates,
  file digests and searched-file lists. Reused across tasks when the exact question
  and source bytes match. A no answer retains the search scope, not a claim that
  a safeguard does not exist.
- **Instrument memory:** QD keeps family/radius lenses in behavior cells. Descriptors
  encode family, local/direct-import radius and evidence density. Fitness measures
  finite-model information per observed file, with a small complexity penalty.
  The archive chooses a useful expanded lens for later entrypoints in that family.
- **Conclusion memory:** keys depend on target metadata, catalog digest, observer
  version and direct evidence closure. A changed dependency or scope/reward metadata
  reopens the conclusion. An unrelated file change does not. Historical events
  remain immutable; reuse is conditional rather than erasure of history.

The event log, not a transient Python process, is the source of persistent state.
Replay reconstructs QD, observation cache, completed conclusions and attention.
`observation.seen` also feeds Loam's ordinary memory entities and numerical signals.
All writes pass through its data gate. A single-writer lock protects per-node event
sequences. Crash-left locks require operator inspection/removal; the loop does not
guess ownership and force-unlock.

## Attention and what the measurements mean

For a candidate question, the supervisor uses

`score = (hypothesisIG + 0.2*LoamModelIG + 0.2*max(0,predictedGain)) * EVmod / cost`

`EVmod = 1 + 0.1*log(1+max(0,EV))/log(50001)`; cost is at least one for ranking,
while an exact cached observation consumes zero fresh-file budget. Candidates with
zero hypothesis information gain are excluded. LoamModelIG is the unchanged
linear-Gaussian parameter information gain, in nats; hypothesisIG is in bits.
The 0.2 coefficient is a heuristic scale conversion/preference, not a proof of an
optimal unified free-energy objective. Selection is deterministic, not Thompson
sampling, to make paired runs auditable.

This measures uncertainty in a declared source-pattern model. It is not uncertainty
about vulnerability existence, true safeguards, exploitability or expected income.
The Bayesian attention reward is a proxy learned from those finite-model reductions.
The real-source demo is not a benchmark showing active attention beats random at
finding bugs. The small question-partition test verifies the entropy choice; the
original Executable Mind experiment remains separately reproducible.

## Measured real slice

The captured input is seven public files from Loam v4 at
`e4fe28acd375f6eed83f081bac2537291c92caaa`, totaling 47,339 bytes. Four module
entrypoints produce six lexical family candidates. Every command reads local source
only. Both comparison conditions receive a maximum budget of 32 file observations.

| Condition | Distinguished static patterns | Remaining ceilings | Fresh file observations |
| --- | ---: | ---: | ---: |
| Local-only vocabulary | 0 | 6 | 6 |
| Adaptive local + captured imports | 6 | 0 | 14 |
| Exact repeat with memory | 6 reused | 0 | 0 |
| Held-out modules, cold | 3 | 0 | 7 |
| Held-out modules, warm | 3 | 0 | 5 |

The warm held-out run transfers three expanded lenses with no new expansion, and
reuses two questions. The cold run expands three lenses. The fresh-file reduction
mixes instrument transfer with cached evidence: it does not isolate a transfer-only
effect. The source snapshot and staged split were selected during development; this
is a demonstration, not an untouched external evaluation set.

One real example: `policy/manifest.mjs` has no declaration name matching the parser
family heuristic, but its captured import `policy/data.mjs` does. The local-only
observer retains two explanations. Looking at the import distinguishes
`neighbor-name-only`. This says nothing about whether that declaration is called
on the relevant path. Runtime safety correctly stays unknown.

## Safety contract

All inherited policy files are byte-for-byte pinned in `organism/POLICY-PINS.json`.
Their original tests run, including manifests, robots rules, budgets, credential
handling and autonomous action gates. New tests explicitly cover each of 401, 403
and 429. An initial stop response is returned with its status and blocks subsequent
requests; it is not treated as useful data or retried.

The organism's composition is stricter: zero network budget, no registered sensors,
no credentials, a rejecting transport, and an always-autonomous action context even
on a developer laptop. It never calls the execution methods. This is capability
removal in the reviewed call graph, not an OS sandbox against arbitrary new code.
The only child executable is the fixed receipt-checked Melt partition interpreter.
Malicious source remains text; a test verifies it cannot create a marker file.

The catalog remains inherited data. Its links, dates and family assignments have
not been independently revalidated. Some assignments are visibly broad, so the join
is explicitly labeled unverified rather than used as evidence a bug exists.

## Wired versus absent

**Wired:** verified offline snapshots, static extraction, two family detectors,
120/19/95 reference index, optional tried-cell filtering, original EV calculation,
finite hypothesis IG, original Loam attention/ledger/memory/QD, radius mutation,
cross-entrypoint lens reuse, evidence cache, dependency invalidation, proposal-only
output, standalone frozen kernel, tests, deterministic reports, persistent CLI and
a dedicated branch-only Actions workflow.

**Absent, not hidden behind stubs:** live acquisition/feed refresh, automatic
third-party snapshot selection, deeper import traversal, semantic/data-flow proof,
new hypothesis-language invention, automatic new detector generation, model calls,
human-label value training in this loop, extraction of new techniques, paid-bug
validation, distributed concurrent workers, automatic compaction, cross-job CI
state synchronization and default-branch scheduled execution. Colab is a documented
execution option, not a tested deployment here.

There are only two implemented family detectors and four possible family/radius
genomes. This is bounded instrument adaptation and compounding reuse, not an
unbounded novelty engine. A next honest milestone is to add a reviewed static
observer that separates hypotheses this version cannot, and measure whether its
gain transfers under a fixed budget on an independently chosen source corpus.
