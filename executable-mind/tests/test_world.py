"""Unit tests for the world, runner, hypotheses, and memory components."""

import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))

from emind import execution, hypotheses, learner, memory, world  # noqa: E402


class WorldTests(unittest.TestCase):
    def test_primitive_semantics(self):
        self.assertEqual(world.run_program(["add_one"], [1, -1]), [2, 0])
        self.assertEqual(world.run_program(["double"], [1, -2]), [2, -4])
        self.assertEqual(world.run_program(["keep_positive"], [-1, 0, 1]), [1])
        self.assertEqual(world.run_program(["keep_even"], [-2, -1, 0, 1]), [-2, 0])
        self.assertEqual(world.run_program(["reverse"], [1, 2, 3]), [3, 2, 1])
        self.assertEqual(world.run_program(["sort"], [3, 1, 2]), [1, 2, 3])
        self.assertEqual(world.run_program(["unique"], [2, 1, 2, 3, 1]), [2, 1, 3])
        self.assertEqual(world.run_program(["take_two"], [5, 6, 7]), [5, 6])

    def test_identity_and_composition_order(self):
        self.assertEqual(world.run_program([], [3, 1]), [3, 1])
        # Programs apply left to right: unique first, then reverse.
        self.assertEqual(
            world.run_program(["unique", "reverse"], [1, 2, 1, 3]), [3, 2, 1]
        )
        self.assertEqual(
            world.run_program(["reverse", "unique"], [1, 2, 1, 3]), [3, 1, 2]
        )

    def test_language_and_pool_sizes_match_the_note(self):
        self.assertEqual(len(world.enumerate_programs()), 73)
        self.assertEqual(len(world.make_list_pool([-3, -1, 0, 2, 4], 3)), 156)
        self.assertEqual(
            len(world.make_fixed_length_pool([-2, -1, 0, 1, 2, 3], 4)), 1296
        )
        self.assertEqual(
            len(world.make_list_pool([-3, -2, -1, 0, 1, 2, 4], 3)), 400
        )
        self.assertEqual(
            len(world.make_fixed_length_pool([-2, -1, 0, 1, 2, 3], 5)), 7776
        )

    def test_enumeration_is_canonical_and_unique(self):
        programs = world.enumerate_programs()
        self.assertEqual(programs[0], ())
        self.assertEqual(programs[1], ("add_one",))
        self.assertEqual(len(set(programs)), len(programs))

    def test_every_program_maps_empty_to_empty(self):
        for prog in world.enumerate_programs():
            self.assertEqual(world.run_program(prog, []), [])

    def test_sum_oracle_is_outside_language(self):
        self.assertEqual(world.sum_reduction_oracle([]), [0])
        self.assertEqual(world.sum_reduction_oracle([1, 2, 3]), [6])


class RunnerTests(unittest.TestCase):
    def test_valid_program_executes(self):
        r = execution.Runner().execute(["sort", "reverse"], (1, 3, 2))
        self.assertTrue(r.ok)
        self.assertEqual(r.output, (3, 2, 1))

    def test_rejects_three_distinct_invalid_programs(self):
        runner = execution.Runner()
        report = execution.demo_invalid_programs(runner)
        self.assertEqual(report.rejected, 3)
        self.assertEqual(len(report.checked), 3)
        errors = [c["error"] for c in report.checked]
        self.assertIn("unknown primitive", errors[0])
        self.assertIn("must be a string", errors[1])
        self.assertIn("exceeds budget", errors[2])
        self.assertEqual(runner.rejections, 3)
        self.assertEqual(runner.executions, 0)

    def test_rejects_non_sequence(self):
        self.assertIsNotNone(execution.Runner().validate("reverse"))


class HypothesisTests(unittest.TestCase):
    def test_empty_example_is_uninformative(self):
        archive = hypotheses.HypothesisArchive()
        self.assertEqual(archive.restrict((), ()), 73)

    def test_restrict_keeps_only_consistent_programs(self):
        archive = hypotheses.HypothesisArchive()
        archive.restrict((3, 1, 2), (1, 2, 3))  # looks like sort
        for prog in archive.candidates:
            self.assertEqual(world.run_program(prog, [3, 1, 2]), [1, 2, 3])
        self.assertIn(("sort",), archive.candidates)
        self.assertNotIn(("reverse",), archive.candidates)

    def test_active_probe_maximizes_entropy(self):
        archive = hypotheses.HypothesisArchive()
        pool = world.make_list_pool([-3, -1, 0, 2, 4], 3)
        choice = archive.select_active_probe(pool)
        best = max(archive.entropy(p) for p in pool)
        self.assertAlmostEqual(choice.entropy, best)
        self.assertGreater(choice.entropy, 0.0)
        # The empty list separates nothing, so it can never be the choice.
        self.assertNotEqual(choice.probe, ())

    def test_stuck_detection(self):
        # keep_positive vs keep_positive|>keep_even only differ on positive odds.
        archive = hypotheses.HypothesisArchive(
            [("keep_positive",), ("keep_positive", "keep_even")]
        )
        blind_pool = world.make_list_pool([-3, -1, 0, 2, 4], 3)
        self.assertTrue(archive.is_stuck(blind_pool))
        wide_pool = world.make_list_pool([-3, -2, -1, 0, 1, 2, 4], 3)
        self.assertFalse(archive.is_stuck(wide_pool))

    def test_pick_is_first_in_canonical_order(self):
        archive = hypotheses.HypothesisArchive()
        self.assertEqual(archive.pick(), ())
        self.assertIsNone(hypotheses.HypothesisArchive([]).pick())


class MemoryTests(unittest.TestCase):
    def test_skill_round_trip_preserves_program(self):
        store = memory.SkillStore()
        store.add(
            memory.SkillRecord(
                name="unique |> reverse",
                program=["unique", "reverse"],
                provenance="test",
                cost_queries=2,
            )
        )
        reloaded = memory.SkillStore.from_json(store.to_json())
        skill = reloaded.get("unique |> reverse")
        self.assertEqual(skill.program, ["unique", "reverse"])
        self.assertEqual(skill.cost_queries, 2)
        self.assertEqual(skill.apply([1, 2, 1, 3]), [3, 2, 1])

    def test_counterexample_narrows_and_bumps_version(self):
        store = memory.SkillStore()
        store.add(memory.SkillRecord(name="s", program=["sort"]))
        store.record_counterexample("s", [1], [2])
        self.assertEqual(store.get("s").version, 2)
        self.assertEqual(len(store.get("s").counterexamples), 1)


class LearnerTests(unittest.TestCase):
    def test_random_strategy_requires_rng(self):
        ind = learner.InductiveLearner(world.make_list_pool([0, 1], 1))
        with self.assertRaises(ValueError):
            ind.run(learner.oracle_from_program(("sort",)), "random", 1)

    def test_random_strategy_is_seed_deterministic(self):
        pool = world.make_list_pool([-3, -1, 0, 2, 4], 3)
        ind = learner.InductiveLearner(pool)
        oracle = learner.oracle_from_program(("sort", "unique"))
        a = ind.run(oracle, "random", 3, random.Random(7))
        b = ind.run(oracle, "random", 3, random.Random(7))
        self.assertEqual(a.as_dict(), b.as_dict())


if __name__ == "__main__":
    unittest.main()
