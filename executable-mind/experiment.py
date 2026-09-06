#!/usr/bin/env python3
"""A small experiment in active program induction.

This is the executable companion to ``Executable_Mind_Research.md``. It is a
Python-standard-library-only program: no network calls, no model credentials,
no live LLM agent. A deterministic search procedure performs the runtime
induction; the experimental protocol was authored by a human.

What it measures
----------------
The learner must recover a hidden integer-list transformation using a fixed
budget of oracle queries. It never sees the target's identity -- only the
outputs of the queries it chooses. We compare two ways of choosing those
queries at an *equal* oracle budget:

* ``random``  -- pick probes uniformly at random (the control), and
* ``active``  -- pick the probe on which the surviving hypotheses disagree the
  most (maximum output entropy under a uniform prior).

Exact task success requires the learned program to match the target on every
input of a held-out evaluation set that is disjoint from the probe pool.

It then diagnoses *why* active selection fails where it does (a blind spot in
the probe vocabulary), and shows that widening the vocabulary repairs it.

Run::

    python3 experiment.py --output results.json
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from typing import Callable, Dict, List, Sequence

from emind import execution, learner, memory, world

# --- Protocol constants -------------------------------------------------------

QUERY_BUDGET = 3
RANDOM_SEEDS = 20

# Stage 1: the original probe vocabulary. Note it contains no positive odd
# number and no negative even number -- the blind spot discovered below.
PROBE_VALUES = (-3, -1, 0, 2, 4)
PROBE_MAX_LENGTH = 3

# Held-out evaluation: a different vocabulary and a longer length, so it is
# disjoint from the probe pool by construction.
EVAL_VALUES = (-2, -1, 0, 1, 2, 3)
EVAL_LENGTH = 4

# Stage 2 (exploratory repair): add a negative even and a positive odd.
REPAIR_PROBE_VALUES = (-3, -2, -1, 0, 1, 2, 4)
REPAIR_EVAL_LENGTH = 5

EXAMPLE_TARGET = ("unique", "reverse")


def _pct(num: int, den: int) -> float:
    return round(100.0 * num / den, 2) if den else 0.0


# --- Episodes -----------------------------------------------------------------


def run_condition(
    targets: Sequence[world.Program],
    probe_pool: Sequence[world.IntList],
    eval_inputs: Sequence[world.IntList],
    strategy: str,
    budget: int,
    rng: random.Random | None = None,
) -> Dict:
    """Run one strategy against every target; return successes and per-target detail."""
    ind = learner.InductiveLearner(probe_pool)
    successes = 0
    failures: List[Dict] = []
    per_target: List[Dict] = []
    for target in targets:
        oracle = learner.oracle_from_program(target)
        res = ind.run(oracle, strategy=strategy, budget=budget, rng=rng)
        ok = res.learned_program is not None and learner.behaviorally_equal(
            res.learned_program, oracle, eval_inputs
        )
        successes += int(ok)
        entry = {
            "target": list(target),
            "target_label": world.program_repr(target),
            "learned": (
                list(res.learned_program)
                if res.learned_program is not None
                else None
            ),
            "learned_label": (
                world.program_repr(res.learned_program)
                if res.learned_program is not None
                else None
            ),
            "survivors_final": res.survivors_final,
            "queries_used": res.queries_used,
            "success": ok,
        }
        per_target.append(entry)
        if not ok:
            failures.append(entry)
    return {
        "successes": successes,
        "attempts": len(targets),
        "success_rate_pct": _pct(successes, len(targets)),
        "failures": failures,
        "per_target": per_target,
    }


def run_random_condition(
    targets: Sequence[world.Program],
    probe_pool: Sequence[world.IntList],
    eval_inputs: Sequence[world.IntList],
    budget: int,
    seeds: int,
) -> Dict:
    """The random control, averaged over several seeds at the same budget."""
    total_success = 0
    total_attempts = 0
    per_seed: List[Dict] = []
    for seed in range(seeds):
        rng = random.Random(seed)
        cond = run_condition(targets, probe_pool, eval_inputs, "random", budget, rng)
        total_success += cond["successes"]
        total_attempts += cond["attempts"]
        per_seed.append(
            {
                "seed": seed,
                "successes": cond["successes"],
                "attempts": cond["attempts"],
                "success_rate_pct": cond["success_rate_pct"],
            }
        )
    return {
        "successes": total_success,
        "attempts": total_attempts,
        "success_rate_pct": _pct(total_success, total_attempts),
        "seeds": seeds,
        "per_seed": per_seed,
    }


def run_first_consistent_baseline(
    targets: Sequence[world.Program],
    probe_pool: Sequence[world.IntList],
    eval_inputs: Sequence[world.IntList],
) -> Dict:
    """Deliberately weak: no additional queries, just the first consistent program.

    Because the only observation is the uninformative ``[] -> []``, this is
    *not* an equal-budget competitor and is reported separately.
    """
    return run_condition(targets, probe_pool, eval_inputs, "active", budget=0)


# --- Diagnostics --------------------------------------------------------------


def witness_failures(
    failures: Sequence[Dict],
    probe_pool: Sequence[world.IntList],
    eval_inputs: Sequence[world.IntList],
) -> List[Dict]:
    """For each failure, show it is a blind spot rather than a search error.

    A failure is a *blind spot* if the chosen program and the target agree on
    every probe in the pool (so no experiment could have separated them) yet
    disagree somewhere on the evaluation set.
    """
    witnesses = []
    for f in failures:
        if f["learned"] is None:
            continue
        target, learned = tuple(f["target"]), tuple(f["learned"])
        probe_diffs = sum(
            1
            for x in probe_pool
            if world.run_program(target, x) != world.run_program(learned, x)
        )
        eval_diffs = [
            x
            for x in eval_inputs
            if world.run_program(target, x) != world.run_program(learned, x)
        ]
        example = list(eval_diffs[0]) if eval_diffs else None
        witnesses.append(
            {
                "target_label": f["target_label"],
                "learned_label": f["learned_label"],
                "distinguishing_probes_in_pool": probe_diffs,
                "distinguishing_eval_inputs": len(eval_diffs),
                "observationally_indistinguishable_in_pool": probe_diffs == 0,
                "example_separating_input": example,
                "target_output_on_example": (
                    world.run_program(target, example) if example else None
                ),
                "learned_output_on_example": (
                    world.run_program(learned, example) if example else None
                ),
            }
        )
    return witnesses


def example_trace_and_persistence(
    probe_pool: Sequence[world.IntList], eval_inputs: Sequence[world.IntList]
) -> Dict:
    """Trace one active episode end to end, then persist and reload the skill."""
    oracle = learner.oracle_from_program(EXAMPLE_TARGET)
    res = learner.InductiveLearner(probe_pool).run(oracle, "active", QUERY_BUDGET)

    # Persist the discovered capability with its evidence.
    store = memory.SkillStore()
    skill = memory.SkillRecord(
        name=world.program_repr(res.learned_program),
        program=list(res.learned_program),
        provenance=(
            f"induced by active selection in {res.queries_used} oracle queries "
            f"from probe pool of {len(probe_pool)}"
        ),
        tests=[
            {"inputs": s.as_dict()["probe"], "output": s.as_dict()["output"]}
            for s in res.steps
        ],
        cost_queries=res.queries_used,
    )
    store.add(skill)

    # Round-trip through JSON and confirm the skill still works with no search.
    reloaded = memory.SkillStore.from_json(store.to_json()).get(skill.name)
    reuse_ok = learner.behaviorally_equal(reloaded.program, oracle, eval_inputs)

    return {
        "target": world.program_repr(EXAMPLE_TARGET),
        "trace": res.as_dict(),
        "narrowing": [len(world.enumerate_programs())]
        + [s.survivors_after for s in res.steps],
        "skill_record": skill.as_dict(),
        "reloaded_program": list(reloaded.program),
        "reloaded_matches_all_eval_inputs": reuse_ok,
        "eval_inputs_checked": len(eval_inputs),
    }


def outside_language_check(probe_pool: Sequence[world.IntList]) -> Dict:
    """Confirm the learner reports 'no candidate' for an inexpressible oracle."""
    res = learner.InductiveLearner(probe_pool).run(
        world.sum_reduction_oracle, "active", QUERY_BUDGET
    )
    return {
        "oracle": "sum_reduction ([sum(xs)])",
        "initial_example": res.initial_example,
        "survivors_after_initial_example": res.survivors_final,
        "no_candidate": res.no_candidate,
        "queries_used": res.queries_used,
        "note": (
            "The empty-list output [0] conflicts with every candidate, which "
            "returns []. This is a deliberately easy outside-language case."
        ),
    }


# --- Main ---------------------------------------------------------------------


def run_all(verbose: bool = True) -> Dict:
    log: Callable[[str], None] = (lambda s: print(s, flush=True)) if verbose else (lambda s: None)
    t0 = time.perf_counter()

    targets = world.enumerate_programs()
    probe_pool = world.make_list_pool(PROBE_VALUES, PROBE_MAX_LENGTH)
    eval_inputs = world.make_fixed_length_pool(EVAL_VALUES, EVAL_LENGTH)

    protocol = {
        "primitives": {p: world.PRIMITIVE_DOC[p] for p in world.PRIMITIVE_ORDER},
        "candidate_programs": len(targets),
        "max_program_length": world.MAX_PROGRAM_LENGTH,
        "targets": "all candidate programs, including behaviorally equivalent ones",
        "initial_example": "[] -> oracle([]) (uninformative for in-language targets)",
        "query_budget": QUERY_BUDGET,
        "probe_pool": {
            "values": list(PROBE_VALUES),
            "lengths": f"0..{PROBE_MAX_LENGTH}",
            "size": len(probe_pool),
        },
        "evaluation": {
            "values": list(EVAL_VALUES),
            "length": EVAL_LENGTH,
            "size": len(eval_inputs),
            "disjoint_from_probe_pool": True,
        },
        "success_criterion": "learned program matches target on every evaluation input",
        "random_seeds": RANDOM_SEEDS,
    }
    log("== Protocol ==")
    log(f"candidates={protocol['candidate_programs']}  probe_pool={len(probe_pool)}  "
        f"eval={len(eval_inputs)}  budget={QUERY_BUDGET}")

    # Stage 1 ---------------------------------------------------------------
    log("\n== Stage 1: original probe vocabulary ==")
    baseline = run_first_consistent_baseline(targets, probe_pool, eval_inputs)
    log(f"first-consistent baseline (0 queries, not equal-budget): "
        f"{baseline['successes']}/{baseline['attempts']} = {baseline['success_rate_pct']}%")

    rand = run_random_condition(targets, probe_pool, eval_inputs, QUERY_BUDGET, RANDOM_SEEDS)
    log(f"random experiments, {RANDOM_SEEDS} seeds x {len(targets)} targets: "
        f"{rand['successes']}/{rand['attempts']} = {rand['success_rate_pct']}%")

    active = run_condition(targets, probe_pool, eval_inputs, "active", QUERY_BUDGET)
    log(f"active experiments, {len(targets)} targets: "
        f"{active['successes']}/{active['attempts']} = {active['success_rate_pct']}%")

    witnesses = witness_failures(active["failures"], probe_pool, eval_inputs)
    log("\n== Stage 1 failure witnesses ==")
    for w in witnesses:
        log(f"target={w['target_label']!r:34} learned={w['learned_label']!r:34} "
            f"probes that separate them={w['distinguishing_probes_in_pool']}  "
            f"eval inputs that separate them={w['distinguishing_eval_inputs']}")

    # Example trace + persistence -----------------------------------------
    log(f"\n== Example trace: {world.program_repr(EXAMPLE_TARGET)} ==")
    example = example_trace_and_persistence(probe_pool, eval_inputs)
    log(f"narrowing: {' -> '.join(str(n) for n in example['narrowing'])}")
    log(f"reloaded skill matches all {example['eval_inputs_checked']} eval inputs: "
        f"{example['reloaded_matches_all_eval_inputs']}")

    # Stage 2: exploratory repair -----------------------------------------
    log("\n== Stage 2: exploratory repair (expanded probe vocabulary) ==")
    repair_pool = world.make_list_pool(REPAIR_PROBE_VALUES, PROBE_MAX_LENGTH)
    repair_eval = world.make_fixed_length_pool(EVAL_VALUES, REPAIR_EVAL_LENGTH)
    repair = run_condition(targets, repair_pool, repair_eval, "active", QUERY_BUDGET)
    log(f"probe_pool={len(repair_pool)}  eval={len(repair_eval)}  "
        f"active: {repair['successes']}/{repair['attempts']} = {repair['success_rate_pct']}%")

    # Sanity checks ---------------------------------------------------------
    log("\n== Sanity checks ==")
    runner = execution.Runner()
    rejections = execution.demo_invalid_programs(runner)
    log(f"invalid interpreter programs rejected: {rejections.rejected}/{len(rejections.checked)}")
    for c in rejections.checked:
        log(f"  {c['program']!r}: {c['error']}")
    outside = outside_language_check(probe_pool)
    log(f"sum-reduction oracle -> no candidate: {outside['no_candidate']} "
        f"(survivors after initial example: {outside['survivors_after_initial_example']})")

    elapsed = round(time.perf_counter() - t0, 2)
    log(f"\nelapsed: {elapsed}s")

    return {
        "title": "Active program induction in a tiny list-transformation world",
        "protocol": protocol,
        "stage_1": {
            "first_consistent_baseline_not_equal_budget": {
                k: baseline[k] for k in ("successes", "attempts", "success_rate_pct")
            },
            "random": {k: rand[k] for k in ("successes", "attempts", "success_rate_pct", "seeds", "per_seed")},
            "active": {
                k: active[k] for k in ("successes", "attempts", "success_rate_pct", "failures")
            },
            "failure_witnesses": witnesses,
        },
        "example_trace_and_persistence": example,
        "stage_2_exploratory_repair": {
            "probe_values": list(REPAIR_PROBE_VALUES),
            "probe_pool_size": len(repair_pool),
            "eval_length": REPAIR_EVAL_LENGTH,
            "eval_size": len(repair_eval),
            "active": {
                k: repair[k] for k in ("successes", "attempts", "success_rate_pct", "failures")
            },
            "note": (
                "Informed by the stage-1 failures; an exploratory follow-up, not "
                "an independent replication or an autonomous vocabulary change."
            ),
        },
        "sanity_checks": {
            "invalid_program_rejection": rejections.checked,
            "outside_language_oracle": outside,
        },
        "limitations": [
            "Finite-domain agreement on the evaluation set, not a universal proof.",
            "Equal oracle budgets, but active selection spends more local simulation compute.",
            "Descriptive results for this constructed task family; not a benchmark claim about LLMs.",
            "The proposer is a deterministic enumerator, not a model.",
            "No vision, weight updates, autonomous curriculum, or self-rewriting.",
            "Restricting an interpreter vocabulary is not a general sandbox for arbitrary code.",
            "The stage-2 vocabulary change was chosen by a human after inspecting failures.",
        ],
        "elapsed_seconds": elapsed,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--output", help="write full results as JSON to this path")
    parser.add_argument("--quiet", action="store_true", help="suppress progress output")
    args = parser.parse_args(argv)

    results = run_all(verbose=not args.quiet)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(results, fh, indent=2)
        if not args.quiet:
            print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
