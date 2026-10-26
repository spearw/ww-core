"""Independent quiz maths (HANDOFF §5.5): properties and golden-file freshness."""

import itertools
import json
import math
import random
import unittest

import quiz
import quiz_golden

B, W, M1, M2 = "risk", "enablement", "value", "finance"
PAIRS = [(B, M1), (B, M2), (B, W), (M1, W), (M2, W)]


def duels(answers):
    return [(a, b, ans) for (a, b), ans in zip(PAIRS, answers, strict=True)]


class Estimate(unittest.TestCase):
    def test_all_toss_ups_keep_order_between_prior_and_equal(self):
        e = quiz.estimate(B, W, duels(["tossUp"] * 5))
        w, p = e["weights"], e["prior"]
        self.assertGreater(w[B], w[M1])
        self.assertAlmostEqual(w[M1], w[M2], places=12)
        self.assertGreater(w[M1], w[W])
        for c in quiz.CRITERIA:
            lo, hi = sorted([p[c], 0.25])
            self.assertTrue(lo < w[c] < hi, c)

    def test_every_answer_pattern_sums_to_one_within_bounds(self):
        for combo in itertools.product(quiz.ANSWERS, repeat=5):
            w = quiz.estimate(B, W, duels(combo))["weights"]
            self.assertAlmostEqual(sum(w.values()), 1.0, places=12)
            for v in w.values():
                self.assertTrue(quiz.FLOOR - 1e-12 <= v <= quiz.CAP + 1e-12)

    def test_definitely_for_best_makes_it_top(self):
        w = quiz.estimate(B, W, duels(["definitelyA"] * 5))["weights"]
        self.assertEqual(max(w, key=w.get), B)

    def test_symmetric_answers_give_symmetric_weights(self):
        w = quiz.estimate(B, W, duels(["leanA", "leanA", "definitelyA", "leanA", "leanA"]))["weights"]
        self.assertAlmostEqual(w[M1], w[M2], places=12)

    def test_recheck_fires_on_an_intransitive_set_only(self):
        consistent = quiz.estimate(B, W, duels(["definitelyA"] * 5))
        cycle = quiz.estimate(B, W, duels(["definitelyA", "tossUp", "definitelyB", "definitelyA", "tossUp"]))
        self.assertFalse(consistent["needsRecheck"])
        self.assertTrue(cycle["needsRecheck"])
        self.assertEqual(cycle["worstIndex"], 2)


class Tiers(unittest.TestCase):
    def test_target_shifts_by_the_tier_gap(self):
        self.assertEqual(quiz.duel_target("tossUp"), 0.0)
        self.assertAlmostEqual(quiz.duel_target("tossUp", 1, 2), math.log(2), places=12)
        self.assertAlmostEqual(quiz.duel_target("leanA", 2, 1), 0.0, places=12)

    def test_medium_against_high_toss_up_reads_as_lean(self):
        tiered = [(a, b, "tossUp", 1, 2) for a, b in PAIRS]
        got = quiz.estimate(B, W, tiered)["weights"]
        want = quiz.estimate(B, W, duels(["leanA"] * 5))["weights"]
        for c in quiz.CRITERIA:
            self.assertAlmostEqual(got[c], want[c], places=12)

    def test_equal_tiers_change_nothing(self):
        answers = ["leanA", "tossUp", "definitelyB", "leanA", "definitelyA"]
        tiered = [(a, b, ans, 2, 2) for (a, b, ans) in duels(answers)]
        got = quiz.estimate(B, W, tiered)
        want = quiz.estimate(B, W, duels(answers))
        for c in quiz.CRITERIA:
            self.assertAlmostEqual(got["weights"][c], want["weights"][c], places=12)

    def test_residuals_use_the_shifted_target(self):
        e = quiz.estimate(B, M1, [(B, M1, "leanB", 2, 0)])
        v = e["v"]
        self.assertAlmostEqual(
            e["residuals"][0], v[B] - v[M1] - quiz.duel_target("leanB", 2, 0), places=12)


LADDER = [math.log(4), math.log(2), 0.0, -math.log(2), -math.log(4)]
LATENT_ANSWERS = ["definitelyA", "leanA", "tossUp", "leanB", "definitelyB"]


def simulate(true_step, people=4000, seed=1):
    """People answer with a true tier step; the app assumes 2. Returns (top-beats-bottom, mean error)."""
    rng = random.Random(seed)
    hits, err = 0, 0.0
    for _ in range(people):
        raw = [rng.gammavariate(2, 1) for _ in quiz.CRITERIA]
        total = sum(raw)
        w = dict(zip(quiz.CRITERIA, quiz.scale_clamp([x / total for x in raw], 1.0), strict=True))
        seen = {c: math.log(w[c]) + rng.gauss(0, 0.4) for c in quiz.CRITERIA}
        order = sorted(quiz.CRITERIA, key=lambda c: -seen[c])
        best, m1, m2, worst = order
        rank = {best: 0, m1: 1, m2: 1, worst: 2}
        pairs = [(best, m1), (best, m2), (best, worst), (m1, worst), (m2, worst)]
        rng.shuffle(pairs)
        mixed = set(rng.sample(range(5), 3))
        duels_in = []
        for k, (x, y) in enumerate(pairs):
            if k in mixed:
                lo = rng.choice([0, 1])
                tx, ty = (lo + 1, lo) if rank[x] > rank[y] else (lo, lo + 1)
            else:
                tx = ty = rng.choice([0, 1, 2])
            a, b = (x, y) if rng.random() < 0.5 else (y, x)
            ta, tb = (tx, ty) if a == x else (ty, tx)
            latent = (math.log(w[a] / w[b]) + (ta - tb) * math.log(true_step)
                      + rng.gauss(0, 0.4))
            ans = LATENT_ANSWERS[min(range(5), key=lambda i: abs(LADDER[i] - latent))]
            duels_in.append((a, b, ans, ta, tb))
        est = quiz.estimate(best, worst, duels_in)["weights"]
        # Ties at the floor or cap make this pick arbitrary but deterministic (first in order).
        top = max(quiz.CRITERIA, key=lambda c: w[c])
        bottom = min(quiz.CRITERIA, key=lambda c: w[c])
        hits += est[top] > est[bottom]
        err += sum(abs(est[c] - w[c]) for c in quiz.CRITERIA) / 4
    return hits / people, err / people


class Simulation(unittest.TestCase):
    def test_tiers_keep_the_estimate_close_even_when_the_true_step_differs(self):
        for true_step in (1.5, 2.0, 3.0):
            with self.subTest(true_step=true_step):
                ordered, error = simulate(true_step)
                self.assertGreaterEqual(ordered, 0.97)
                self.assertLessEqual(error, 0.055)


class ScaleClamp(unittest.TestCase):
    def test_floor_and_cap_hold_and_total_is_kept(self):
        out = quiz.scale_clamp([0.97, 0.01, 0.01, 0.01], 1.0)
        self.assertEqual(out[0], 0.5)
        for v in out[1:]:
            self.assertAlmostEqual(v, 1 / 6, places=12)

    def test_rejects_impossible_totals(self):
        with self.assertRaises(ValueError):
            quiz.scale_clamp([0.5, 0.5], 1.5)


class Adjust(unittest.TestCase):
    def test_snaps_to_five_percent_and_keeps_sum(self):
        base = quiz.estimate(B, W, duels(["leanA"] * 5))["weights"]
        out = quiz.adjust(base, "finance", 0.33)
        self.assertAlmostEqual(out["finance"], 0.35, places=12)
        self.assertAlmostEqual(sum(out.values()), 1.0, places=12)

    def test_target_is_clamped(self):
        base = dict(quiz.DEFAULT_WEIGHTS)
        self.assertEqual(quiz.adjust(base, "finance", 0.9)["finance"], 0.5)
        self.assertEqual(quiz.adjust(base, "finance", -1)["finance"], 0.05)


class Archetype(unittest.TestCase):
    def test_names_flavour_and_balancer(self):
        self.assertEqual(quiz.archetype({"risk": 0.5, "value": 0.2, "finance": 0.2, "enablement": 0.1}, False), ("firefighter", None))
        self.assertEqual(quiz.archetype({"risk": 0.4, "value": 0.33, "finance": 0.17, "enablement": 0.1}, False), ("firefighter", "enjoyer"))
        self.assertEqual(quiz.archetype({"risk": 0.28, "value": 0.25, "finance": 0.25, "enablement": 0.22}, False), ("balancer", None))
        self.assertEqual(quiz.archetype(dict(quiz.DEFAULT_WEIGHTS), True), ("balancer", None))


class Golden(unittest.TestCase):
    def test_committed_golden_file_is_fresh(self):
        built = json.dumps(quiz_golden.build(), indent=1, sort_keys=True) + "\n"
        self.assertEqual(built, quiz_golden.OUT.read_text())


if __name__ == "__main__":
    unittest.main()
