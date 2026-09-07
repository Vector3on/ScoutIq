# Melt reasoning benchmark 2: what survived export

Three more complex public strategies became independently executable: search through changing state, retain competing visual explanations, and plan a conditional sequence of diagnostic questions. The implementations run without a model client or repository checkout.

## Final evaluation

The evaluation contract and development seed were established before final generation. Candidate source, runtime, and evaluator digests are recorded in [freeze.json](freeze.json). Final seed: 880301. Random cases per family: 60, plus deliberately constructed boundary cases. The [complete machine-readable findings](../findings/reasoning-benchmark.json) retain each case's status, correctness, cost, steps, and baseline result.

| Exported capability | Completed tasks | Other correct outcomes | Total checks |
|---|---:|---|---:|
| State planning | 40 optimal plans | 27 unreachable goals; 3 exhausted expansion budgets | 70 |
| Visual rule induction | 51 unambiguous predictions | 24 ambiguous cases; 15 outside-language cases | 90 |
| Adaptive diagnosis | 56 optimal policies | 8 unidentifiable cases; 1 contradictory observation set; 4 exhausted subset budgets | 69 |
| Total | 147 | 82 other outcomes, including 27 reachability proofs | 229 |

All 229 checks passed their declared behavioral contracts. That is not 229 solved tasks. No incorrect definitive answer was observed in this finite suite. None of the detached runs attempted a network or subprocess operation. The original 915-case export experiment remains a separate regression gate.

## What makes these different from the first four capsules

The first experiment mostly executed fixed transformations. These three exports make decisions over new inputs: the planner explores alternative state trajectories; the visual solver constructs and filters program hypotheses; the diagnostician constructs an observation-dependent policy. None stores the benchmark's answers in its source.

The worlds are nevertheless fully specified or represented by a finite known language. The assistant wrote the source and evaluators. This is a procedural export experiment, not proof that general internal reasoning was extracted or that a new model learned these strategies.

## State planning: preserve future options

Actions have positive and negative preconditions, can both create and delete facts, and have unequal costs. A useful test requires preparing a resource, consuming it for authorization, preparing it again, and then delivering. The four-action route costs 4; a one-action shortcut costs 25. Minimizing action count gives the wrong cost objective.

The exported uniform-cost planner matched the optimum or unreachable status on all 67 non-budget cases. An action-count BFS baseline matched on 62/67. In five cases the exported strategy strictly reduced cost, with 70 total cost units saved. The three intentionally tiny-budget cases correctly reported search exhaustion.

One boundary problem required a 1,023-action plan, verified by replay and an independent finite-state reference. It is a binary-counter world with supplied transition rules, not an open-world task requiring 1,023 novel insights. The longest run used 62,632 metered steps, below the unchanged 200,000-step runtime cap.

## Visual induction: uncertainty survives the conversion

Each ordinary task has three training pairs, a composition of three operations, and a larger query grid. The five operations are rotation, reflection, foreground cropping, cyclic recoloring, and reflection only when the current grid is wider than tall. Cropping and rotation can change the context for the conditional operation.

There are 156 candidate programs through depth three. The export retains every consistent program and predicts only when all agree on the query. It completed 51/60 ordinary composition-and-size-transfer tasks. Nine ordinary tasks remained ambiguous. Fifteen deliberately underdetermined tasks also remained ambiguous.

A first-consistent-program baseline happened to match 55/90 hidden outputs, versus 51 definite predictions from the conservative export. The four extra correct guesses came from ambiguous cases. This baseline number is not a like-for-like improvement score: it trades evidential support for extra guesses. The export's ambiguity witnesses are independently checked to fit all training pairs and disagree on the query.

All 15 horizontal-tiling tasks were unsupported because the transformation is absent from the language. Coverage on that outside-language family was **0/15**. This is a real limitation of the exported solver, even though acknowledging it passes the uncertainty contract. More search over the same grammar cannot add tiling.

## Adaptive diagnosis: plan beyond the next question

The input supplies hypothesis predictions and test costs. The export minimizes the worst-case total cost of a complete conditional decision tree, accounting for any observations already made. The evaluator checks every possible hidden hypothesis through the exported tree and compares the result with a bottom-up subset optimum.

All 56 identifiable cases received optimal policies. The immediate-partition baseline matched the optimum on only 16/56. Lookahead improved 40 cases and saved 184 total worst-case cost units across those cases. These units are arbitrary benchmark costs, not dollars or measured inference savings. Baseline and solver share inputs, but do not spend equal compute.

The example in [diagnosis.json](examples/diagnosis.json) costs 12 with the greedy strategy and 6 with optimal lookahead. As observations arrive, the same exported procedure can reduce its hypothesis set and return a smaller remaining policy. The eight unidentifiable cases expose hypotheses whose predictions cannot be separated by any supplied test. The system does not invent new tests.

## Development failure retained as a regression

The first visual implementation correctly detected ambiguity but displayed the first three consistent programs as its witnesses. On all-zero training examples and a single colored query, those three programs made the same prediction; the actual disagreement occurred later in the candidate list. I revised the export to track the first program for each distinct prediction. The final evaluator and a dedicated regression test now check the witnesses themselves.

This correction happened during development, before the recorded final freeze. The final source was not tuned after final-case evaluation. The [development result](../findings/reasoning-development.json) is retained separately.

## How to reproduce

```bash
python3 -m unittest discover -s melt/tests -v
python3 melt/cli.py benchmark --seed 880301 --count 60 --out melt/out/reasoning-benchmark.json
```

There are 15 current runtime/reasoning tests. The GitHub workflow runs those, the earlier experiment, the new benchmark, and the selected target before exporting all seven standalone files. The checked-in results describe this recorded run; reruns use the current code and explicitly report its hashes.

## What I learned about melting reasoning

1. Search, uncertainty retention, and conditional lookahead can be expressed as portable procedures that continue making decisions on new inputs after the model disconnects.
2. Removing the mechanism changes behavior: action-count search loses cost optimality, immediate partitioning loses future test-cost information, and first-consistent guessing loses justification.
3. The representation boundary remains decisive. The visual export cannot infer an operation outside its language; diagnosis cannot distinguish hypotheses that all available observations treat identically.
4. An executable explanation also needs verifiable evidence. Correctly saying "ambiguous" was insufficient when its displayed witnesses did not demonstrate the ambiguity.

## Practical and scientific limits

These are original synthetic benchmark families inspired by [PlanBench](https://arxiv.org/abs/2206.10498), [ARC-AGI-2](https://arcprize.org/blog/arc-agi-2-technical-report), [ARC-AGI-3](https://arxiv.org/abs/2603.24621), and stateful tool-agent evaluation in [tau2-bench](https://arxiv.org/abs/2506.07982). No official questions were copied or official benchmark scores measured.

The same assistant authored specifications, source, generators, and oracles. Algorithms differ where practical, but that is not independent or blinded evaluation. Hash freezing prevents silently changing the recorded candidate; it cannot remove the author's knowledge of the task family. No live-model accuracy or equal-compute comparison was performed. The network guard is a Python audit hook, not kernel network isolation. The translator from public strategy to source is still the assistant, not a learned autonomous compiler.

The next research question is whether a model-assisted converter can discover useful representations on unfamiliar tasks under a fixed budget, outperforming ordinary code generation. This experiment supplies stronger executable decision procedures and tests, but has not answered that question.
