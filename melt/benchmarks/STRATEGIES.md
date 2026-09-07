# Public strategies being exported

These summaries specify desired mechanisms. They are not private chain-of-thought transcripts. The assistant translates them into source; this project does not yet learn that translation automatically.

## Reason about action consequences

An action that gets closer to the goal can destroy a prerequisite or cost more than a longer route. Represent the complete relevant state, not just a count of satisfied goals. Search alternatives in increasing accumulated cost. Remember the least cost found for each state so loops do not waste the search. A returned plan must include enough state information for independent replay. Only exhausted reachability search supports an impossibility claim; an exhausted compute budget supports uncertainty.

Export: `state_planner.py`. The implementation uses uniform-cost search with add/delete effects, exact state identity, replayable paths, and explicit budget outcomes. The comparative baseline minimizes action count, losing the cost distinction. Test data includes a 1,023-action plan, though the action rules are fully specified and solving it is not evidence of open-world reasoning.

## Preserve uncertainty while discovering rules

Several programs can fit a few examples. The relevant question is whether they agree on the new input. Search a declared compositional language, retain the consistent alternatives, and make a prediction only when their outputs agree. Otherwise expose two programs that fit every example but disagree on the query. If no candidate explains the examples, report the language/evidence mismatch rather than choosing the nearest guess.

Export: `visual_rule.py`. Context-dependent reflection interacts with cropping and rotation because the aspect ratio can change mid-program. The language has 156 programs through depth three. This is finite program induction, far narrower than ARC-AGI. It cannot invent a missing transformation such as tiling.

Development correction: the first implementation displayed the first three consistent programs as ambiguity witnesses. On zero-only training and a single colored query, those programs agreed despite other candidates disagreeing. The revision tracks the first program for each distinct prediction and displays an actual disagreement. `test_visual_witnesses_really_disagree` preserves this failure condition.

## Plan questions, including their future consequences

A question that immediately separates many hypotheses may be expensive or leave a costly residual problem. Evaluate the complete conditional policy: the test's own cost plus the most expensive continuation across its possible observations. Reuse solutions to repeated hypothesis subsets. After an observation, eliminate incompatible hypotheses and recompute the remaining policy. Keep contradiction, irreducible indistinguishability, and compute exhaustion separate.

Export: `diagnose.py`. The implementation constructs a minimax-cost decision tree over at most eight hypotheses and eight tests. The independent evaluator uses bottom-up subset optimization and follows every hidden hypothesis through the resulting tree. In one development case, greedy immediate partitioning costs 12 while optimal lookahead costs 6.

## What is actually complex here

The outputs contain runtime search and conditional decisions, not just answers to stored examples. Plans can undo earlier effects; rules can interact; later questions depend on earlier answers. These are deliberately limited, explicit worlds in which such behavior can be verified. Success shows that these chosen strategies survive procedural export. It does not show that the assistant's complete internal reasoning has been extracted, that new strategy invention is autonomous, or that benchmark-wide intelligence has been reproduced.
