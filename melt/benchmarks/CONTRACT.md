# Melt reasoning benchmark 2: evaluation contract

Original synthetic problems, inspired by benchmark mechanisms rather than copied tasks.

## Families

1. **State planning:** binary facts, actions with positive and negative preconditions, add/delete effects, nonuniform costs, positive and negative goals. Find a minimum-cost valid plan, prove unreachability by exhausting a finite state space, or explicitly report exhausted search budget. Includes temporary setbacks, destructive shortcuts, cycles, distractors, and renamed/reordered actions. Inspired by [PlanBench](https://arxiv.org/abs/2206.10498) and the importance of changing tool state in [tau2-bench](https://arxiv.org/abs/2506.07982). This is a fully specified symbolic simulator, not a conversational dual-control task.

2. **Visual rule induction:** infer a composition from paired grids and apply it to a new grid. The language contains rotation, reflection, foreground cropping, cyclic recoloring, and context-dependent reflection. Keep all consistent programs; answer only if they agree on the query. Distinguish contradictory/outside-language examples from ambiguity. Inspired by [ARC-AGI-2](https://arcprize.org/blog/arc-agi-2-technical-report). The fixed grammar is far narrower than ARC; no official ARC score is claimed.

3. **Adaptive diagnosis:** choose a complete conditional testing policy that minimizes worst-case cumulative test cost. Account for prior observations and distinguish irreducible ambiguity, contradictions, and exhausted search budgets. Inspired by the explore/infer/act pressure in [ARC-AGI-3](https://arxiv.org/abs/2603.24621). This suite supplies hypothesis predictions; it does not autonomously discover unknown environment mechanics.

## Protocol fixed before candidate evaluation

- Development seed: 1717. Final seed: 880301. Generate final instances only after freezing candidate source digests.
- Same assistant authors specifications, implementations, generators, and oracles. This is not blinded, independent, or contamination-proof evaluation. No official benchmark examples are imported.
- Store public strategy summaries, never hidden reasoning traces. The assistant implements the strategies; the exporter packages them. No learned natural-language compiler is claimed.
- Execute exported artifacts in isolated Python processes with empty environments and the existing offline audit/resource-limited harness.
- Planning correctness requires independently replayable actions, a valid final state, and optimum cost from a finite-state Bellman-Ford reference. A budget stop is not an impossibility proof.
- Visual correctness is conditional on a declared finite grammar. The oracle separately interprets that grammar. Count solved tasks, appropriate abstentions, and wrong answers separately. Outside-grammar coverage remains zero when correctly rejected.
- Diagnosis correctness requires every possible hidden hypothesis to follow its observation branch to the right leaf, and optimum worst-case cost from a bottom-up subset reference.
- Compare exported planners with an action-count BFS baseline; visual induction with first-consistent guessing; diagnosis with immediate partition-quality selection. These are algorithmic ablations, not live LLM baselines. Shared task data does not mean equal compute expenditure.
- Report source/corpus hashes, family counts, baseline scores, statuses, step counts, failure witnesses, and stress-test results. CI must fail on incorrect definitive answers, wrong claims of impossibility, or broken bounded-input handling. Appropriate refusal is reported separately from task completion.
- If final evaluation exposes a bug that is fixed, label it as an exploratory revision and evaluate fresh instances with a newly recorded seed. Do not silently reuse a tuned holdout.

## Limits deliberately included

- A visual transformation absent from the grammar (horizontal tiling).
- Visual examples that underdetermine the query output.
- Unreachable planning goals and deliberately tiny expansion budgets.
- Observationally identical diagnosis hypotheses, inconsistent observations, and tiny search budgets.

The objective is to measure exported decision-making across these finite families, not infer general intelligence from a high aggregate score.
