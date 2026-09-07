# GEO: run the working slice

Start by editing `target.json`: brand names/aliases/domains, competitors, category, engine surfaces, exact buyer prompts and declared intent/fixability priors. The sample target is GoatCounter, whose official site is https://www.goatcounter.com/.

## Reproduce the real pilot

From the repository root, with Node 24 and Python 3.10+:

```sh
node geo/run.mjs --access geo/evidence/access.json --out geo/output
```

Read `geo/output/audit.md`, `opportunity-queue.json`, `next-probes.json`, `strategy-archive.json` and `loam-run.json`. `ledger/` and `loam.sqlite` preserve Loam state; repeating the same input does not create new evidence. Reuse the output directory to retain the archive. Delete nothing to rerun: choose a fresh output directory for an independent experiment.

`geo/example/` contains an actual completed build run for review. Five captured consumer answers: ChatGPT two repeats for each of two prompts, Gemini one broad-category answer. Perplexity was blocked before query submission; `evidence/access.json` records that separately. The pilot is too small for reliable population conclusions.

## Collect fresh answers with no paid API

```sh
python geo/colab/geo_audit.py battery --config geo/target.json
python geo/colab/geo_audit.py collect --config geo/target.json --captures geo/output/new-captures.jsonl --engine chatgpt-consumer --repeats 3 --out geo/output/audit
```

For each printed prompt, start a fresh consumer chat, submit exactly that prompt, paste its answer including visible citation URLs, and enter `END` on its own line. Record a consistent collection-session label. Use `perplexity-consumer` or `gemini-consumer` to collect those surfaces. `BLOCKED` followed by `END` stops that engine. Never paste credentials. Do not count a spinner, refusal or unfinished answer as a successful response; correct the capture status to error before analysis if necessary.

Consumer mode needs your manual session. It does not programmatically run those websites from Colab. Fresh accounts/sessions, dates and modes should have distinct context values; do not relabel them to force pooling. Inspect imported evidence before sending a client report.

## Optional free-tier API battery

Use only a project actually on Google's free tier with billing disabled. Verify that externally first; the flag is a declaration, not a billing-state check. Choose a currently available free-tier model. Set `GEMINI_API_KEY` in the environment or a private Colab secret, never in a tracked file.

```sh
python geo/colab/geo_audit.py collect --config geo/target.json --captures geo/output/api-captures.jsonl --engine gemini-api --model YOUR_FREE_TIER_MODEL --billing-disabled --repeats 1 --out geo/output/api-audit
```

The key is sent only to Google's documented API. No search-grounding tool is requested. API answers are a distinct surface and citation coverage is unknown. Errors stop the battery; there is no retry loop or paid fallback. This adapter was not exercised against a live API in this build.

## Colab

Open `geo/colab/pilot.ipynb` in Colab and Run All to reproduce the included pilot with no downloads, installations or API calls. The notebook embeds the frozen Python procedure, target and measured captures. It is a replay, not a fresh engine measurement. Use the collection command above in an interactive cell for a new audit; it automatically drafts the report after collection.

## Tests and freeze

```sh
python -m unittest discover -s geo/tests -p 'test_*.py' -v
node --test geo/tests/*.test.mjs
python -m geo.freeze
```

The score capsule is validated by the unchanged Melt runtime. `freeze.json` records the standalone hash, capsule hash and validation receipt. Full design, limitations and decisions are in the repository's `DESIGN.md` and `DECISIONS.md`.
