"""The oracle must pass the hand-worked cases and its own rule checks."""

import datetime as dt
import json
import math
import unittest
from pathlib import Path

from app_io import expect_of, parse_case
from check import mismatches
from score import DEFAULT_WEIGHTS, Config, combine_factors, date_flags, score_all, urgency_at

ROOT = Path(__file__).resolve().parents[2]
HAND = json.loads((ROOT / "src" / "engine" / "__fixtures__" / "hand-worked.json").read_text())
AS_OF = dt.date(2026, 9, 11)


class HandWorked(unittest.TestCase):
    def test_every_hand_worked_case(self):
        for suite in HAND["suites"]:
            cfg = Config(members=suite["members"], weights=HAND["weights"],
                         horizon_years=HAND["horizon_years"])
            scored = {r.id: r for r in score_all([parse_case(c["input"]) for c in suite["cases"]],
                                                 cfg, dt.date.fromisoformat(HAND["as_of"]))}
            for case in suite["cases"]:
                with self.subTest(suite=suite["name"], case=case["id"]):
                    self.assertEqual(mismatches(case["expect"], expect_of(scored[case["id"]])), [])


class FactorRules(unittest.TestCase):
    W = DEFAULT_WEIGHTS

    def test_all_four_included_equals_ww_weighted_sum(self):
        f = {"risk": 1.0, "value": 1.0, "finance": 9.0, "enablement": 10.0}
        ww = sum(self.W[k] * f[k] for k in f)
        self.assertAlmostEqual(combine_factors(f, self.W), ww, places=12)

    def test_zero_optional_factors_are_ignored(self):
        f = {"risk": 5.0, "value": 5.0, "finance": 0.0, "enablement": 0.0}
        self.assertAlmostEqual(combine_factors(f, self.W), 5.0, places=12)

    def test_never_below_the_r_v_average(self):
        for fin in (0.0, 1.5, 3.0, 8.5, 10.0):
            for en in (0.0, 7.0, 10.0):
                f = {"risk": 4.8, "value": 1.6667, "finance": fin, "enablement": en}
                self.assertGreaterEqual(combine_factors(f, self.W) + 1e-12,
                                        (0.4 * 4.8 + 0.3 * 1.6667) / 0.7)


class DateRules(unittest.TestCase):
    def project(self, urgency, deadline):
        return parse_case({"id": "p", "cost": 1000, "cost_confidence": "quoted", "effort": 3,
                           "risk": {"probability": 1, "consequence": 1},
                           "value": {"reach": 1, "impact": {"you": 1}},
                           "finance": {"recoup_pct": 0, "annual_savings": 0, "annual_carrying_cost": 0},
                           "urgency": urgency, "identified": "2026-09-11", "deadline": deadline})

    def test_no_date_means_no_urgency_and_no_flags(self):
        for kind in ("hard_deadline", "target_date"):
            p = self.project(kind, None)
            self.assertEqual(urgency_at(p, AS_OF, 0), 1.0)
            self.assertEqual(date_flags(p, AS_OF), (False, False, False))

    def test_hard_deadline_never_gets_less_urgent(self):
        p = self.project("hard_deadline", "2026-11-10")
        us = [urgency_at(p, AS_OF, y) for y in (0, 1, 3, 5)]
        self.assertEqual(us, sorted(us))
        self.assertEqual(us[-1], 2.5)


def _project(pid, urgency="standard", identified="2026-09-11", deadline=None, p=1, c=1, reach=1):
    return parse_case({"id": pid, "cost": 1000, "cost_confidence": "quoted", "effort": 3,
                       "risk": {"probability": p, "consequence": c},
                       "value": {"reach": reach, "impact": {"you": 1}},
                       "finance": {"recoup_pct": 0, "annual_savings": 0,
                                   "annual_carrying_cost": 0},
                       "urgency": urgency, "identified": identified, "deadline": deadline})


class SortOrder(unittest.TestCase):
    def test_band_sorts_before_priority_so_forced_now_stays_above_next_and_soon(self):
        projects = [_project("now", p=5, c=5, reach=10), _project("next", p=4, c=4),
                    _project("soon", p=3, c=3),
                    _project("forced", "hard_deadline", deadline="2026-09-21")]
        pr = {r.id: r.priority for r in score_all(projects, Config(members=["you"]), AS_OF)}
        cfg = Config(members=["you"],
                     bands={"NOW": pr["now"], "NEXT": pr["next"], "SOON": pr["soon"]})
        self.assertLess(pr["forced"], pr["soon"])
        out = score_all(projects, cfg, AS_OF)
        self.assertEqual([(r.id, r.band) for r in out],
                         [("now", "NOW"), ("forced", "NOW"), ("next", "NEXT"),
                          ("soon", "SOON")])


class FutureIdentified(unittest.TestCase):
    def test_future_identified_date_never_lowers_urgency(self):
        p = _project("p", "constant_benefit", identified="2046-09-11")
        self.assertEqual(urgency_at(p, AS_OF, 0), 1.0)
        r = score_all([p], Config(members=["you"]), AS_OF)[0]
        self.assertEqual(r.U, 1.0)
        for v in r.projection.values():
            self.assertTrue(math.isfinite(v))


class SmallCostRule(unittest.TestCase):
    def test_costs_under_50_rank_alike(self):
        base = {"cost_confidence": "quoted", "effort": 3,
                "risk": {"probability": 1, "consequence": 1},
                "value": {"reach": 1, "impact": {"a": 1}},
                "finance": {"recoup_pct": 0, "annual_savings": 0, "annual_carrying_cost": 0},
                "urgency": "standard", "identified": "2026-09-11", "status": "open"}
        ps = [parse_case({**base, "id": i, "cost": c})
              for i, c in (("zero", 0), ("thirty", 30), ("fifty", 50))]
        out = {r.id: r for r in score_all(ps, Config(members=["a"]), dt.date(2026, 9, 11))}
        self.assertEqual(out["zero"].priority, out["thirty"].priority)
        self.assertLess(out["fifty"].priority, out["thirty"].priority)


if __name__ == "__main__":
    unittest.main()
