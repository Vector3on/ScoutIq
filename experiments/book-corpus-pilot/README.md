# Book corpus pilot: design package (stage 1)

Standalone design for an autonomous, authorized book-acquisition and searchable-context experiment. Produced 2026-09-13; design only, nothing built, downloaded or tested.

| File | Purpose |
|---|---|
| `EXPERIMENT_BRIEF.md` | goal, scope, assumptions, pilot inputs, budgets, hypotheses, acceptance criteria |
| `SOURCE_AND_PERMISSION_EVIDENCE.md` | inspected sources with dates and evidence classes, observed interfaces, proposed titles, permission decisions, attribution, unresolved evidence |
| `IMPLEMENTATION_SPEC.md` | configuration, component interfaces, manifest schema, queue states, extraction and retrieval design, fixtures, failure handling, build order |
| `CODING_HANDOFF.md` | self-contained prompt for the coding agent that will implement and pilot the project |
| `evidence/fts5_probe.py`, `evidence/fts5_probe_output.txt` | empirical FTS5 verification run in the design sandbox (SQLite 3.45.1) |

This package is independent of the rest of this repository.
