# Observe-only synthesis: measured run

Real input: seven commit-pinned public ScoutIq source files, four entrypoints. No target code was executed. No target endpoint was contacted. These are lexical-pattern observations, not vulnerability findings.

| Condition | Distinguished patterns | Unresolved patterns | File observations | Reused queries | New lens expansions | Transferred lenses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0 | 6 | 6 | 0 | 0 | 0 |
| adaptive | 6 | 0 | 14 | 2 | 6 | 0 |
| replay | 6 | 0 | 0 | 0 | 0 | 0 |
| train | 3 | 0 | 9 | 0 | 3 | 0 |
| warm | 3 | 0 | 5 | 2 | 0 | 3 |
| cold | 3 | 0 | 7 | 0 | 3 | 0 |

## What actually happened

The local-only lens could not distinguish hypotheses differing only in imported declarations. The bounded mutation added captured direct imports. The surviving source-pattern hypotheses narrowed from four to two to one. On held-out entrypoints, archived expanded lenses were reused without repeating their discovery. Exact repeated input required no new observations or duplicate proposals.

This is an engineered finite observation vocabulary. It establishes compositional behavior on this snapshot, not open-ended intelligence or a measured bug-bounty advantage. Baseline and adaptive receive the same maximum budget; adaptive spends more of it on a richer vocabulary. Warm versus cold also differs in cached evidence, so its cost difference is not attributable to lens transfer alone.

## One concrete observation

Entry: `source/substrate/policy/manifest.mjs`. Family hint: semantic/parser differential. Result: **neighbor-name-only**.

- local-symbol: **no**; 4 to 2 surviving static hypotheses.
- neighbor-symbol: **yes**; 2 to 1 surviving static hypotheses.
  - Evidence: `source/substrate/policy/data.mjs:125`, revision `e4fe28acd375f6eed83f081bac2537291c92caaa`, content SHA-256 `5e44fb152f91a8b8c3f8060064e0282860d7e5cd03a9a7e0a56e17a8d1c7e0de`.

A matching declaration in an imported module is not proof the entrypoint calls it, nor proof that it enforces an invariant. Runtime safety stays **unknown**. All demo entries are research-only; their ScoutIq EV is zero, with unmeasured hardening left null.

## Coverage and limits

All 120 inherited technique records and 19 anatomy classes / 95 seams are indexed. Two family detectors and radii zero/one are executable. Family joins are recall hints, not verified applicability. The report does not emit the catalog’s technique procedures. It never marks a technique as tested. Source URLs and catalog family assignments were inherited, not independently audited.

The state files are SQLite event logs. The demo uses temporary databases to make its results reproducible; the normal CLI preserves state across invocations.
