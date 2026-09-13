# Executable Mind

A small, real, runnable realization of the design in
[`docs/Executable_Mind_Research.md`](docs/Executable_Mind_Research.md): a system
that turns a hypothesis into an executable program, chooses experiments that
discriminate between competing hypotheses, observes the world's answer, revises
its beliefs, and preserves what it learns as a reusable, evidence-backed skill.

Everything here is **standard-library Python, fully deterministic, and
externally checkable**. There is no model call, no network, no credentials, and
no self-rewriting. The "proposer" is a deterministic enumerator. This is the
honest starting point the research note asks for — not a claim that a general
self-improving agent has been built.

## Reproduce

```bash
cd executable-mind
python3 experiment.py --output results.json   # ~4s, prints the full protocol
python3 -m unittest discover -s tests -t .    # 31 tests, ~4s
```

`experiment.py` needs only Python 3.8+ and the `emind/` package beside it.

## What it does

The learner must recover a hidden integer-list transformation from a fixed
budget of oracle queries. It never sees the target's identity — only the
outputs of the queries it chooses itself. Two ways of choosing queries are
compared at an **equal oracle budget** of 3:

- **random** — pick a probe uniformly at random (the control);
- **active** — pick the probe on which the surviving hypotheses disagree most
  (maximum output entropy under a uniform prior over survivors).

The world has 8 primitives (`add_one`, `double`, `keep_positive`, `keep_even`,
`reverse`, `sort`, `unique`, `take_two`). The search language is every 0-, 1-
and 2-operation program: **73** candidates, which are also the 73 targets
(including behaviourally equivalent ones). Probes come from the 156 lists of
length 0–3 over `{-3,-1,0,2,4}`; success is judged on all 1,296 four-element
lists over `{-2,-1,0,1,2,3}`, disjoint from the probe pool. *Exact task
success* means matching the target on **every** evaluation input.

## Results

Reported by `python3 experiment.py` and asserted in `tests/test_experiment.py`.

| Condition | This build | Research note |
|---|---:|---:|
| First-consistent baseline (0 queries, not equal-budget) | 2 / 73 = 2.74% | "deliberately weak" |
| Random experiments, 20 seeds × 73 targets | 1,076 / 1,460 = **73.7%** | 1,084 / 1,460 = 74.25% |
| Active experiments, 73 targets | **70 / 73 = 95.89%** | 70 / 73 = 95.89% |
| Active, after repair (400 probes, 7,776 eval inputs) | **73 / 73 = 100%** | 73 / 73 |

Every *deterministic* figure in the note is reproduced exactly. The random
control is stochastic by construction; the eight-episode gap out of 1,460 is
the difference in random draw sequences, not in method, and the tests only
require it to land in a plausible band and lose to active selection.

**The `unique |> reverse` trace** narrows the candidate set **73 → 3 → 1**,
exactly as the note reports. The discovered skill is serialized to JSON,
reloaded, and matches all 1,296 evaluation inputs with no further search —
persistence, not (yet) a measured transfer advantage.

### The failure, and why it is a blind spot rather than a bug

All three active failures are **observationally indistinguishable** from the
program the learner chose across the *entire* probe pool — zero probes separate
them — yet 1,000+ evaluation inputs do:

| Target | Learned instead | Separating probes in pool | Separating eval inputs |
|---|---|---:|---:|
| `keep_positive \|> keep_even` | `keep_positive` | 0 | 1,040 |
| `keep_even \|> add_one` | `add_one \|> keep_positive` | 0 | 1,215 |
| `keep_even \|> keep_positive` | `keep_positive` | 0 | 1,040 |

The probe vocabulary `{-3,-1,0,2,4}` contains **no positive odd number and no
negative even number**, so filters that only differ on those values look
identical. No amount of extra reasoning over the same probes can break the tie
— this is the architecture's section-6 situation, and `HypothesisArchive.is_stuck`
detects it. Adding `-2` and `1` to the vocabulary (400 probes) fixes it: active
selection then matches all 73 targets on 7,776 five-element inputs. As the note
is careful to say, that vocabulary change was chosen by a human after inspecting
the failures; it is an exploratory follow-up, not an autonomous repair.

### Sanity checks

- The runner **rejects three malformed programs** for three distinct reasons
  (unknown primitive, non-string operation, length over budget).
- A **sum-reduction oracle** — outside the language — yields *no candidate*:
  its empty-list output `[0]` conflicts with every candidate's `[]`. This is a
  deliberately easy case and does not establish general unknown-task detection.

## Architecture → code

The research note's eight design points map onto the `emind/` package:

| Note § | Idea | Where |
|---|---|---|
| 1 | Observations keep raw evidence separate from interpretation | `learner.QueryStep` records the probe, its raw output, and the survivor counts |
| 2 | A response proposes a change to persistent state, with its assumptions | `proposals.Proposal` |
| 3 | Keep competing programs; choose the experiment they disagree on | `hypotheses.HypothesisArchive.select_active_probe` |
| 4 | Execution turns proposals into observations, behind interface & budget checks | `execution.Runner` |
| 5 | Skills are stored with contract, provenance, tests, counterexamples, cost, version | `memory.SkillRecord`, `memory.SkillStore` |
| 6 | When experiments cannot distinguish hypotheses, change the instruments | `HypothesisArchive.is_stuck` + the stage-2 vocabulary repair in `experiment.py` |
| 7 | Evolve at multiple timescales; keep the evaluator outside the thing evaluated | The oracle and eval set live in `experiment.py`, never inside the learner |
| 8 | Give exploration a direction and a stopping rule | `InductiveLearner.run` stops on budget, empty archive, or stuck |

The runner is *owned by the supervisor*: the learner may propose programs but
only the runner decides what is admissible and what it produces. That is the
concrete lesson the note draws from the Darwin Gödel Machine appendix, where a
candidate "improved" a metric by editing the logging rather than the behaviour.

## What is real and what is not

**Real:** a working propose/experiment/observe/revise loop; active experiment
selection that measurably beats random at equal budget; a diagnosed and
repaired blind spot; validated execution; evidence-carrying persistent skills;
ignorance reporting for out-of-language tasks; a test suite that pins every
deterministic number in the note.

**Not built (and not claimed):** an LLM proposer, vision, weight updates, an
autonomous curriculum, self-rewriting, cross-task transfer measurement, or a
general sandbox — restricting an interpreter's vocabulary is only safe because
that vocabulary is fixed and pure.

## The next falsifiable milestone

Replace `world.enumerate_programs` with a real model-driven proposer on a
small, verifiable domain, keep `execution.Runner` and the evaluation set outside
it, and compare at equal model + execution budgets: (1) direct generation with
ordinary correction, (2) competing hypotheses + chosen experiments, (3) the same
loop with persistent skills, (4) the same loop allowed to propose new
representations and experiment generators. Measure correctness, queries, tokens,
time, skill reuse, transfer, *and regressions*. If a mechanism does not help,
remove it — more modules do not establish more intelligence.

## Layout

```
executable-mind/
├── experiment.py          # the full protocol; `--output results.json`
├── results.json           # the run reported above
├── emind/
│   ├── world.py           # primitives, programs, probe/eval pools, sum oracle
│   ├── proposals.py       # proposal schema
│   ├── hypotheses.py      # candidate archive, entropy-max experiment choice, stuck detection
│   ├── execution.py       # validating runner + invalid-program demo
│   ├── memory.py          # skill records/store with JSON round-trip
│   └── learner.py         # the induction loop
├── tests/
│   ├── test_world.py      # unit tests per component
│   └── test_experiment.py # end-to-end: pins the numbers in the note
└── docs/
    └── Executable_Mind_Research.md   # the design note this realizes
```
