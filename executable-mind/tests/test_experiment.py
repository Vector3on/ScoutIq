"""End-to-end tests that lock in the results reported in the research note.

Every deterministic figure in the note is asserted exactly. The random control
is stochastic by design, so it is only required to land in a plausible band and
to lose to active selection at the same budget.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))

import experiment  # noqa: E402
from emind import learner, world  # noqa: E402


class _Shared:
    """Run the (cheap) protocol once and share it across test methods."""

    results = None

    @classmethod
    def get(cls):
        if cls.results is None:
            cls.results = experiment.run_all(verbose=False)
        return cls.results


class Stage1Tests(unittest.TestCase):
    def setUp(self):
        self.r = _Shared.get()

    def test_active_reproduces_seventy_of_seventy_three(self):
        active = self.r["stage_1"]["active"]
        self.assertEqual(active["attempts"], 73)
        self.assertEqual(active["successes"], 70)
        self.assertEqual(active["success_rate_pct"], 95.89)

    def test_exactly_three_failures_all_blind_spots(self):
        witnesses = self.r["stage_1"]["failure_witnesses"]
        self.assertEqual(len(witnesses), 3)
        for w in witnesses:
            # No probe in the pool separates the target from what was learned...
            self.assertEqual(w["distinguishing_probes_in_pool"], 0)
            self.assertTrue(w["observationally_indistinguishable_in_pool"])
            # ...yet the evaluation set does, so the failure is real.
            self.assertGreater(w["distinguishing_eval_inputs"], 0)
            self.assertIsNotNone(w["example_separating_input"])

    def test_blind_spot_is_positive_odd_or_negative_even(self):
        # Each separating example must contain a value missing from the probe
        # vocabulary: a positive odd or a negative even integer.
        for w in self.r["stage_1"]["failure_witnesses"]:
            example = w["example_separating_input"]
            self.assertTrue(
                any((v > 0 and v % 2 == 1) or (v < 0 and v % 2 == 0) for v in example),
                example,
            )

    def test_random_control_lands_in_band_and_loses_to_active(self):
        rand = self.r["stage_1"]["random"]
        self.assertEqual(rand["attempts"], 20 * 73)
        self.assertGreaterEqual(rand["success_rate_pct"], 65.0)
        self.assertLessEqual(rand["success_rate_pct"], 85.0)
        self.assertLess(
            rand["success_rate_pct"], self.r["stage_1"]["active"]["success_rate_pct"]
        )

    def test_first_consistent_baseline_is_weak(self):
        base = self.r["stage_1"]["first_consistent_baseline_not_equal_budget"]
        self.assertLess(base["success_rate_pct"], 10.0)


class ExampleTraceTests(unittest.TestCase):
    def setUp(self):
        self.r = _Shared.get()

    def test_unique_reverse_narrows_73_3_1(self):
        ex = self.r["example_trace_and_persistence"]
        self.assertEqual(ex["target"], "unique |> reverse")
        self.assertEqual(ex["narrowing"][:3], [73, 3, 1])
        self.assertEqual(ex["trace"]["learned_program"], ["unique", "reverse"])

    def test_reloaded_skill_matches_all_eval_inputs_without_search(self):
        ex = self.r["example_trace_and_persistence"]
        self.assertEqual(ex["eval_inputs_checked"], 1296)
        self.assertTrue(ex["reloaded_matches_all_eval_inputs"])
        self.assertEqual(ex["reloaded_program"], ["unique", "reverse"])


class Stage2RepairTests(unittest.TestCase):
    def setUp(self):
        self.r = _Shared.get()

    def test_expanded_vocabulary_solves_every_target(self):
        rep = self.r["stage_2_exploratory_repair"]
        self.assertEqual(rep["probe_pool_size"], 400)
        self.assertEqual(rep["eval_size"], 7776)
        self.assertEqual(rep["active"]["successes"], 73)
        self.assertEqual(rep["active"]["attempts"], 73)
        self.assertEqual(rep["active"]["failures"], [])


class SanityCheckTests(unittest.TestCase):
    def setUp(self):
        self.r = _Shared.get()

    def test_three_invalid_programs_rejected(self):
        checks = self.r["sanity_checks"]["invalid_program_rejection"]
        self.assertEqual(len(checks), 3)
        self.assertTrue(all(not c["ok"] for c in checks))

    def test_sum_oracle_yields_no_candidate(self):
        out = self.r["sanity_checks"]["outside_language_oracle"]
        self.assertTrue(out["no_candidate"])
        self.assertEqual(out["survivors_after_initial_example"], 0)
        self.assertEqual(out["initial_example"]["output"], [0])


class ProtocolInvariantTests(unittest.TestCase):
    def test_probe_pool_and_eval_set_are_disjoint(self):
        pool = set(world.make_list_pool(experiment.PROBE_VALUES, experiment.PROBE_MAX_LENGTH))
        ev = set(world.make_fixed_length_pool(experiment.EVAL_VALUES, experiment.EVAL_LENGTH))
        self.assertTrue(pool.isdisjoint(ev))

    def test_original_probe_vocabulary_has_the_blind_spot(self):
        vals = experiment.PROBE_VALUES
        self.assertFalse(any(v > 0 and v % 2 == 1 for v in vals))  # no positive odd
        self.assertFalse(any(v < 0 and v % 2 == 0 for v in vals))  # no negative even
        rep = experiment.REPAIR_PROBE_VALUES
        self.assertIn(1, rep)
        self.assertIn(-2, rep)

    def test_learner_never_sees_target_identity(self):
        # The learner is handed an opaque callable, never a program.
        pool = world.make_list_pool(experiment.PROBE_VALUES, experiment.PROBE_MAX_LENGTH)
        calls = []

        def spy(xs):
            calls.append(tuple(xs))
            return world.run_program(("sort",), xs)

        res = learner.InductiveLearner(pool).run(spy, "active", 3)
        self.assertEqual(res.learned_program, ("sort",))
        # One free empty example plus at most the budget of chosen queries.
        self.assertLessEqual(len(calls), 1 + 3)
        self.assertEqual(calls[0], ())


if __name__ == "__main__":
    unittest.main()
