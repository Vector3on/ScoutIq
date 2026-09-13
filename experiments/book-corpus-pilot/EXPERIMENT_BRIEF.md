# Experiment brief: autonomous, authorized book acquisition and searchable, source-backed context

| Field | Value |
|---|---|
| Stage | Design only. No code written, no book downloaded, no test executed. |
| Design date | 2026-09-13 |
| Planning jurisdiction | India (Copyright Act, 1957; term rules in s.22 to s.24). Recorded because public-domain status varies by jurisdiction. |
| Intended use of the reusable corpus | Internal indexing and bounded excerpt retrieval for a research agent, with permissions that cover **commercial** use. |
| Out of scope for this pilot | Public redistribution of books, sharing excerpts publicly, model training, purchases, account creation, contacting rightsholders, and bypassing paywalls, DRM, CAPTCHAs or access controls. |
| Companion documents | `SOURCE_AND_PERMISSION_EVIDENCE.md`, `IMPLEMENTATION_SPEC.md`, `CODING_HANDOFF.md` |

## 1. Goal

Build and test the smallest autonomous system that takes a book website or a reading wishlist, obtains eligible books only through authorized routes, and turns them into a searchable collection where every returned passage points back to a specific book, edition, source URL and location.

The research agent that will consume this collection is not part of the experiment. The experiment only has to show that the collection can be produced lawfully, automatically and reproducibly, and that retrieval over it returns correctly located evidence.

## 2. Motivation and what this pilot can and cannot establish

A research agent with good search or reasoning still needs reliable subject material. This pilot supplies a small collection and measures whether it yields usable, attributable evidence.

A future commercial product motivates the permission policy (commercial-use licences by default). The pilot cannot establish product viability, revenue or "reasoning superiority". Success claims are limited to the acceptance criteria in section 10.

## 3. Starting inputs and how each is handled

| Input | Handling in this design |
|---|---|
| User-selected website `https://oceanofpdf.com/` | Registered as source profile `oceanofpdf` with `approval: unapproved`. The system never crawls it, never fetches ebook files from it, and never sends it requests during the pilot. A wishlist entry that is an OceanofPDF URL is treated as a **clue only**: the title/author slug is parsed offline and re-resolved against approved sources. If no authorized edition exists, the entry is reported `unavailable`. Background evidence and the current source-profile reasoning are in `SOURCE_AND_PERMISSION_EVIDENCE.md` section 1.4. |
| No wishlist or topic supplied | The pilot runs on a clearly labelled **three-book demonstration set** from one eligible publisher (Open Book Publishers via the Thoth metadata API). The demonstration set is not a substitute for the user's unspecified wishlist and must be reported as a demonstration. |
| Legal, autonomous acquisition required | Two separate decisions per item, each `eligible`, `not_eligible` or `needs_review` with evidence URL, scope and rule: (a) acquisition through a specific route, (b) inclusion in the intended-use corpus. Availability of a download link is never treated as permission. |
| CPU-only machine, about 8 GB RAM, no GPU, no paid API | Deterministic Python command-line pipeline. No LLM is required on the ordinary path. SQLite + FTS5 for retrieval. pypdf for PDF text. Sequential extraction with resource limits. |
| Possible future commercial product | Default corpus policy accepts only clearly applicable CC BY (any version), CC0, jurisdiction-verified public domain, or express written permission covering commercial internal indexing. Noncommercial licences are excluded from this corpus. A separate private noncommercial mode is specified but not run in the pilot. |

## 4. Scope

In scope:

- A title-to-authorized-edition resolver that accepts titles, authors, ISBNs or book URLs.
- One catalogue adapter for the first positive demonstration: Open Book Publishers (OBP) enumerated through the Thoth GraphQL API, with files fetched only from OBP's own hosts as listed in Thoth `fullTextUrl` records.
- Two negative or exclusion adapters: the selected site (unapproved) and an author-hosted noncommercial example (Peter Watts's *Blindsight*, CC BY-NC-SA), used as resolution and exclusion checks.
- Permission filter, bounded downloader, integrity and deduplication, extraction with locations, FTS5 retrieval, reporting.
- Offline fixtures for adverse cases and a live three-book pilot, expandable to at most ten books.

Out of scope:

- Supporting every book website; HTML crawling of any site; OCR; model training; public redistribution; any paid service.

## 5. Assumptions (explicit)

1. Open Book Publishers records its books' licences in Thoth as a licence URL per work (`Work.license`), and OBP's own hosts serve the full-text files listed in Thoth `Location.fullTextUrl`. Interface verified from Thoth source code; live data not yet observed (see evidence file). If the live data differ, the adapter reports and stops rather than guessing.
2. A CC BY 4.0 licence on a whole work permits downloading, internal indexing and bounded excerpt display for commercial purposes, subject to attribution and to any third-party exclusions stated in the work. The pilot records exclusions and does not extract or index images.
3. The intended-use policy is deliberately conservative. Excluding CC BY-SA, CC BY-ND and NC licences from automatic inclusion is an experiment policy, not a claim that those licences are unusable.
4. The machine can run Python 3.10 or newer with a SQLite build that includes FTS5. This must be verified at implementation time; the design sandbox had Python 3.11.15 and SQLite 3.45.1 with FTS5 enabled.
5. OBP's robots.txt permits fetching book files with a self-identifying user agent. Not verifiable from the design sandbox (host blocked). The implementation must fetch and obey robots.txt before any file transfer and must stop with a report if it is disallowed. Robots directives and copyright permission are separate checks.

## 6. Pilot inputs

### 6.1 Demonstration set (labelled; not the user's wishlist)

Three Open Book Publishers titles. Licence evidence in this sandbox is secondary (search-engine snippets of the OBP pages); each item stays `needs_review` until the stage-2 preflight captures primary evidence from Thoth and from the licence statement embedded in the downloaded file. Details and evidence URLs are in `SOURCE_AND_PERMISSION_EVIDENCE.md` section 2.

| # | Title | Creators | Year | DOI | Expected licence | Expected file route |
|---|---|---|---|---|---|---|
| D1 | Ethics for A-Level | Mark Dimmock, Andrew Fisher | 2017 | 10.11647/OBP.0125 | CC BY 4.0 | PDF from `books.openbookpublishers.com` |
| D2 | Literature Against Criticism: University English and Contemporary Fiction in Conflict | Martin Paul Eve | 2016 | 10.11647/OBP.0102 | CC BY 4.0 | PDF from `books.openbookpublishers.com` |
| D3 | The Essence of Mathematics Through Elementary Problems | Alexandre Borovik, Tony Gardiner | 2019 | 10.11647/OBP.0168 | CC BY 4.0 | PDF from `books.openbookpublishers.com` |

D3 is mathematics-heavy and is included partly to exercise the garbled-text flags. If its beginning, middle and end prose samples fail the readability check, that is a visible extraction result, not an acquisition failure.

### 6.2 Exclusion and resolution checks (no download expected)

| Check | Input | Expected outcome |
|---|---|---|
| X1 | A wishlist entry whose URL is on `oceanofpdf.com` | `resolution_status = unapproved_source`; slug parsed offline; re-resolution against approved sources; no request to the domain; reported with reason. |
| X2 | `https://www.rifters.com/real/Blindsight.htm` (author-hosted, CC BY-NC-SA 2.5 per secondary evidence) | Resolved as an author-hosted edition; `use_decision = not_eligible` for the commercial corpus (rule NC); no full-book transfer under commercial settings. |

### 6.3 Reference list

The independently checked reference list for the live pilot is D1 to D3 plus X1 and X2, frozen before acquisition with the DOIs and URLs above. The list is recorded in `SOURCE_AND_PERMISSION_EVIDENCE.md` with the evidence class of each field.

## 7. Resource budgets (limits, not promised completion times)

| Budget | Value |
|---|---|
| Books in smoke run | 3 |
| Books after expansion | at most 10 |
| Catalogue candidates considered | at most 50 |
| Catalogue requests per run | at most 60 |
| Resolver queries per run | at most 60 |
| Total transferred book data including retries and partial files | 250 MB |
| Per-file limit | 100 MB (proposed) |
| Download workers | 1 |
| Run budget | 1 hour wall clock, resumable across runs |
| Request interval where automation is permitted and no stricter limit applies | 2 seconds; `Retry-After` always honoured; at most one retry per 429/503 within the time budget |
| Redirect hops | at most 3, every hop validated against the profile's host allowlist before it is followed |
| Extraction | sequential; per-book time limit 10 minutes; per-page content-stream limit 20 MB; child process address-space limit 2 GB on POSIX |

## 8. Permission policy summary

Use scopes are recorded separately for every item: `download`, `internal_index`, `excerpt_display_internal`, `redistribute_full`, `share_excerpts_public`, `train_models`. The pilot authorizes only the first three and records the last three as `false` for every item.

Rules for the commercial internal-index corpus (full table in `IMPLEMENTATION_SPEC.md` section 5):

- Licence evidence must be captured from the publisher's designated machine-readable metadata (Thoth `Work.license`) and, after download, checked against the licence statement in the file. Agreement on CC BY (any version) or CC0 → `eligible`. Any disagreement → `needs_review`.
- NC licences → `not_eligible` for this corpus. ND or SA → `needs_review` (not automatic). Missing or unknown licence → `needs_review`. Public domain requires a recorded basis under Indian term rules for that edition. Express permission requires a stored document.
- An unapproved source route makes acquisition `not_eligible` through that route regardless of licence.
- `needs_review` and `not_eligible` items are skipped and reported together. They never block eligible items and never generate per-book confirmation prompts.
- Software applies explicit rules to retained evidence. No model's confidence is treated as legal authority.

## 9. Measurable hypotheses

| ID | Hypothesis | Metric | Pass threshold |
|---|---|---|---|
| H1 | Permission gating is complete | Files in `books/` without an `eligible` use decision backed by stored evidence | 0 |
| H2 | Eligible reference items are acquired within budget | Acquired ÷ independently verified eligible and accessible reference items | ≥ 90 %; with three items this means 3 of 3 |
| H3 | Reruns are idempotent and interruptions are safe | Bytes downloaded on rerun for completed unchanged files; partial files ever marked complete | 0 and 0 |
| H4 | Extracted text is readable and correctly located | Beginning, middle and end samples per book judged readable and pointing to the right page or anchor | all samples for all books; failures remain visible |
| H5 | Retrieval supplies located evidence | Top-5 hit rate over 20 held-out questions; abstention behaviour on unsupported questions | reported per question with coverage; no fixed threshold is claimed before the development-set tuning |

## 10. Acceptance criteria

1. Every acquired file has permission and provenance evidence appropriate to its intended use. No ineligible or unresolved fixture triggers a full-book download (asserted by the fixture server's request log).
2. At least 90 % of independently verified eligible, accessible reference items within the declared budget are acquired. Report numerator, denominator, failures and budget exclusions separately.
3. A rerun downloads nothing for completed unchanged files. An interruption never marks a partial file complete.
4. Beginning, middle and end samples from each extracted book remain readable and point back to the correct location. Failed extraction stays visible in the manifest and report.
5. Twenty held-out questions, including questions the collection cannot answer, are evaluated for whether top-five retrieval supplies a relevant, correctly located passage. Relevance and low-evidence behaviour are defined before evaluation and tuned on a separate development set. Individual outcomes and coverage are reported.

## 11. Evaluation protocol (what each result class means)

| Class | Definition | Where recorded |
|---|---|---|
| Fixture | Offline, deterministic, served by a local fixture server; adverse cases | `tests/`, CI output |
| Manually verified record | A human confirmed a field against a primary page and recorded URL, date and quote | evidence file, `evidence/` folder in the workspace |
| Planned live test | Specified before running; not yet executed | this brief, `IMPLEMENTATION_SPEC.md` section 14 |
| Observed result | Produced by an actual run, with `run_report.md` and manifest hashes | stage 2 only |

Nothing in this design package is an observed result.

Optional later comparison (not required, must not block the core experiment and must not require buying API credits): the same locally available model answers the held-out questions with no context, with relevant retrieved context, and with unrelated context of matched length; matched settings and answer budgets; answers and citations scored against references; human relay work logged.

## 12. Risks and the smallest genuinely unresolved blockers

| Item | Status | Resolution path |
|---|---|---|
| Primary verification of OBP item licences, robots.txt and file hosts | Blocked in the design sandbox (egress policy). Secondary evidence is consistent for all three titles. | Stage-2 preflight captures Thoth responses and the embedded licence statements before any full-book transfer; automatic upgrade to `eligible` when they agree. |
| Thoth publisher identifier for OBP | Not observed | Runtime lookup with `publishers(filter: "Open Book Publishers")`; pinned in run state with evidence. |
| Thoth rate limits and terms page text | Terms page not fetchable; no rate limiting found in the server source | Conservative 2-second interval; stop on 429 after honouring `Retry-After` once. |
| EPUB availability from OBP at no cost | Conflicting secondary statements | Adapter prefers EPUB only when Thoth lists a free `fullTextUrl` on an allowlisted host; otherwise PDF. |
| Held-out question sets | Cannot be authored before extraction | Authored by a human in stage 2 from the extracted text, frozen with a hash before tuning ends. |

## 13. Stage plan

1. Stage 1 (this package): design, evidence register, specification, coding handoff.
2. Stage 2: implement the minimum project, pass offline fixtures, run the stage-2 preflight, run the three-book pilot, produce `run_report.md`.
3. Stage 3 (only if stage 2 meets criteria 1 to 4): expand to at most ten books within the same budgets, run the twenty-question evaluation, optionally run the model comparison.
