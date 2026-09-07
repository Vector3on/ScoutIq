# GEO intelligence engine

This branch turns Loam into an evidence-first AI visibility audit tool. The first customer deliverable is a reproducible category audit: where a brand appears, where it does not, which sources answers link, and which uncertainty is worth resolving next. It does not promise rankings or invent a successful marketing intervention.

## Working slice

Run from the repository root with Node 24 and Python 3.10+:

```sh
node geo/run.mjs --access geo/evidence/access.json --out geo/output
```

No npm or pip dependencies, API key, paid service, or model call is needed to reproduce the included audit. Edit `geo/target.json` for another brand, then collect actual answers. `geo/example/audit.md` is the auto-generated real-brand pilot; it is not a fixture presented as a customer measurement.

## Reuse, not a core fork

The new branch starts from master `b91077842b6bfd28e544afefd66203a24b1dc3a0`. The complete `substrate/` directory is imported unchanged from Loam v4 `e4fe28acd375f6eed83f081bac2537291c92caaa`; only a new `substrate/plugins/geo/` directory is added. `geo/upstream-lock.json` records every imported Git blob SHA. Tests verify byte identity. The original branches receive no writes, rebases or merges.

- Loam v2 supplies the domain contract, immutable ledger, quality-diversity strategy grammar and attention allocator.
- v3's learned behavior archive and observation-only sentinel run in the slice. Its documentation warns that extra diversity does not establish higher real-world value; we preserve that distinction.
- v4's hindsight/discovery code remains available, but is off for this tiny pilot. Automatically treating future citations as sales labels would be invalid supervision.
- Blindsight's extraction design supplies evidence-linked facts with explicit observed/inferred/unknown status. Its code parsers are not suitable for answer surfaces, so GEO uses a new bounded-domain extractor, not a claimed reuse of its parsers.
- Melt's unchanged `runtime.py` validates an actual opportunity-score capsule. The full audit procedure is frozen as a standalone standard-library Python program; IO is outside Melt's restricted interpreter.

## Data flow

Consumer answer or optional free-tier API response → immutable raw capture with SHA-256 → validation and structured facts → metrics by query/engine/model/context → Loam query/source/brand graph → QD search and attention → opportunity queue, next probes, audit.

The plugin exports the existing `createPlugin(options, env)` shape and is loaded through Loam's `loadPlugin`. Its sensor proposes validated local answer strata and polls them into ordinary `observation.seen` events. It never imports a domain into the core. `runOnce` genuinely executes the existing planner, strategy evaluation, archive and ledger code.

Entities: brand, category, buyer-intent query stratum, engine, source and intervention hypothesis. Relations: mentions, cites, measured_on, in_category, targets, about. Query signals: opportunity, visibility, samples, intent prior, source count, competitor voice. All signals are derived from raw captures or explicitly named priors.

The Python file is the single metrics implementation. The plugin invokes it with argument arrays, not shell interpolation. The same source is frozen for Colab, preventing JavaScript/Python metric drift.

## Measurement contract

Each capture stores exact prompt, query ID, engine surface, visible model label or unknown, timestamp, collection context, raw answer, format, status, citation-coverage status and SHA-256. Pilot snapshots preserve the complete visible browser state. Their raw-answer slices are mechanically extracted, not reconstructed from memory. Browser clock timestamps are retained verbatim; clock synchronization was not independently established.

Visibility = answers with at least one alias match / successful answers. Repetition inside an answer counts once. Text matching is case-insensitive with word boundaries. URL-only occurrences and DOM citation chips/dialogs do not count as prose mentions. Alias matching is conservative, not semantic brand disambiguation.

Share of voice = a brand's binary answer appearances / all tracked-brand answer appearances in that stratum. It is not the share of every possible brand. Vendor-domain citation rate is separate from mention rate; source links can occur without brand mentions. Third-party links are mapped without pretending to verify the claims they support. Tracking parameters and fragments are removed for source aggregation; raw URLs remain in the captures.

Unknown citation coverage yields null, not zero. Visible-only captures give a lower bound, not an exhaustive citation count. Source recurrence is not authority. Independent authority is unassessed. Sentiment accepts exact-quote, named-reviewer annotations; it does not guess polarity from a mention or silently assign neutral to missing reviews.

Failed/blocked/unavailable responses never enter the success denominator. No samples gives null visibility and null opportunity. Illustrative records are excluded; a conflicting duplicate ID, altered hash, fabricated citation URL or modified prompt under the same query ID fails validation. Same-ID replay is idempotent. Hashes prove integrity, not that an untrusted operator genuinely collected an answer. Same text under separate true run IDs can be a legitimate repeat.

95% Wilson intervals are displayed with the IID caveat. Same-session repeats are not independent users. Query/engine/model/context strata are not pooled, nor are Gemini API and Gemini consumer answers. This pilot is a convenience sample, selected after the first answer, not a representative market survey.

## Opportunity and attention

For n answers and k target mentions, the absence posterior mean under Beta(1,1) is `(n-k+1)/(n+2)`. Opportunity is `100 × intent_prior × fixability_prior × absence_posterior_mean`. Priors are configurable, with a required fixability rationale. The score ranks investigation hypotheses. It is not measured ROI, conversion probability or causal lift. With zero evidence it is unknown.

`geo/attention.mjs` directly imports Loam's `LinearModel`, learns from observed binary absence and uses its exact parameter-information gain. Query, engine and competitor features let it prioritize which uncertainty a new unbranded answer resolves. The Gaussian model is an approximation to binary observations; its IG is not a visibility confidence interval. One answer observes all tracked brands, so the queue deduplicates query/engine requests and never injects the focus competitor into the prompt. Access-blocked engines are quarantined when an access ledger is supplied.

Fixed-battery trend collection and adaptive exploration must be kept separate. The queue recommends a one-in-five fixed-battery reserve; the current assisted collector does not automatically enforce that schedule. Do not compute market-wide trends from adaptively selected prompts.

## Novelty worth investigating

The engine automatically compares buyer framings within matching collection strata. In the included pilot, GoatCounter appears in 0/2 broad SaaS answers and 2/2 low-traffic self-hosting answers. The descriptive 100-point contrast has wide overlapping uncertainty intervals. It suggests a category-positioning question, not a proven fix or a general ranking.

The source graph also distinguishes known competitor-owned comparison pages from unclassified external publishers. A brand may be absent from an answer while competitors' comparison pages help define its category. A candidate experiment is to publish a truthful use-case bridge or correct an eligible third-party comparison, then repeat pre-registered prompts across days with an unchanged comparison query. Nothing here posts content or sends outreach.

Loam's QD archive evolves graph-query strategies for discovering these opportunities. Archive occupancy demonstrates working search, not discovered marketing efficacy. The marketing hypotheses are currently evidence-derived templates; there is no learned intervention-success archive yet. Verified before/after experiments and analyst judgments are the next data needed for that, not more autonomous code.

## Cost and acquisition boundary

Consumer mode is assisted: the operator runs the battery in accessible ChatGPT, Perplexity or Gemini sessions and pastes verbatim answers and links. The pilot was actually collected through the anonymous ChatGPT and Gemini UIs. Perplexity displayed a bot-verification page; no prompt was submitted and no visibility measurement was made there.

The optional documented Gemini `generateContent` collector requires an API key for a free-tier, billing-disabled project, a model name chosen from current availability, and an explicit `--billing-disabled` declaration. This script cannot verify the project's billing state. It does not enable billing, use search grounding, fall back to a paid model, or retry a block. Default operation makes no paid requests. No Gemini API request was made during this build. API results are always `gemini-api`, never labelled consumer visibility.

Reference documentation checked 2026-09-07: [generateContent](https://ai.google.dev/api/generate-content), [pricing](https://ai.google.dev/gemini-api/docs/pricing), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits). Free quotas and model availability are external constraints, not a guaranteed unattended service. Colab sessions also expire. Offline processing can run unattended; consumer collection cannot honestly be promised unattended at $0.

## Validation and scope

Tests cover evidence integrity, fake citation rejection, fixture exclusion, failure denominators, boundary matching, citations vs mentions, sentiment evidence, strata isolation, interval edges, no-network API gating, upstream byte identity, plugin loading, actual Loam ingestion/QD, replay and attention. Frozen-score parity is checked in Melt; the frozen script and self-contained notebook reproduce the pilot offline.

No paying customer, verified ranking improvement, revenue lift, population visibility estimate, autonomous consumer collector or independent authority classifier is claimed.
