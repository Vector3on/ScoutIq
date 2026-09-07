# Validation record, 2026-09-07

Executed locally with Node v24.19.0 and Python 3.12.13.

| Gate | Actual result |
|---|---|
| Python evidence/metrics tests | 15 passed |
| GEO Node integration tests | 3 passed |
| Unchanged Loam attention, events, policy and QD tests | 25 passed |
| Melt opportunity capsule parity | 12 cases passed |
| Self-contained Colab notebook code cell | Executed offline; full analysis JSON exactly matched the reference output |
| Upstream source integrity | All 72 imported Loam files plus Melt runtime matched recorded Git blob hashes |
| Real pipeline | 5 successful consumer answers, 3 measured query/engine strata, 3 Loam findings, 1 occupied QD cell in the saved run |
| Gemini API | Not live-tested; requires an external billing-disabled free-tier project |

Commands:

```sh
python -m unittest discover -s geo/tests -p 'test_*.py' -v
node --test geo/tests/*.test.mjs
node --test substrate/tests/attention.test.mjs substrate/tests/events.test.mjs substrate/tests/qd.test.mjs substrate/tests/policy.test.mjs
python -m geo.freeze
node geo/run.mjs --access geo/evidence/access.json --out geo/example
```

The notebook's code cell was run in a fresh temporary directory with ordinary Python, without network access by its code, and its complete `analysis.json` was compared for equality with `geo/example/analysis.json`. This verifies notebook portability; it is not a claim that a hosted Colab session was opened.

The pilot has two ChatGPT runs for each of two prompts and one Gemini run for the broad query. GoatCounter mentions: broad ChatGPT 0/2, narrow ChatGPT 2/2, broad Gemini 0/1. No Perplexity query was sent because the site presented verification. This is a real convenience sample with inadequate statistical power for market-wide or causal claims.

The suite verifies ingestion and real QD execution, not that QD improves marketing outcomes. One populated cell on a tiny graph is an honest cold start, not evidence of an open-ended breakthrough.
