"""The verbatim WW copy must reproduce WW's own 51-case fixture."""

import datetime as dt
import json
import unittest
from pathlib import Path

from ww_score import score_all
from ww_types import EngineConfig, ProjectInput

ROOT = Path(__file__).resolve().parents[2]
SUITE = json.loads((ROOT / "reference" / "ww-engine" / "conformance.json").read_text())
TOL = {"R": 0.01, "V": 0.01, "split": 0.01, "fpr": 0.01, "F": 0.01, "E": 0.01, "U": 0.005,
       "C": 0.005, "cod": 0.01, "cod_adj": 0.01, "size": 0.005, "priority": 0.06}
ATTR = {"split": "disagreement"}


def to_input(c: dict) -> ProjectInput:
    date = lambda s: dt.date.fromisoformat(s) if s else None  # noqa: E731
    return ProjectInput(
        id=c["id"], cost=float(c["cost"]), effort=float(c["effort"]),
        probability=float(c["risk"]["probability"]), consequence=float(c["risk"]["consequence"]),
        reach=float(c["value"]["reach"]),
        impacts={k: float(v) for k, v in c["value"]["impact"].items()},
        cost_confidence=c.get("cost_confidence", "estimate"),
        recoup_pct=float(c["finance"]["recoup_pct"]),
        annual_savings=float(c["finance"]["annual_savings"]),
        annual_carrying_cost=float(c["finance"]["annual_carrying_cost"]),
        urgency=c.get("urgency", "standard"), identified=date(c.get("identified")),
        deadline=date(c.get("deadline")), gate=c.get("gate"),
        depends_on=list(c.get("depends_on") or []), enables=list(c.get("enables") or []),
        status=c.get("status", "open"),
    )


class WwCopy(unittest.TestCase):
    def test_reproduces_all_51_cases(self):
        cfg = EngineConfig.from_tuning(weights=SUITE["weights"],
                                       horizon_years=SUITE["horizon_years"], tuning={})
        scored = {r.id: r for r in score_all([to_input(c["input"]) for c in SUITE["cases"]],
                                             cfg, dt.date.fromisoformat(SUITE["as_of"]))}
        self.assertEqual(len(SUITE["cases"]), 51)
        for case in SUITE["cases"]:
            with self.subTest(case=case["id"]):
                want, rec = case["expect"], scored.get(case["id"])
                if want.get("scored") is False:
                    self.assertIsNone(rec)
                    continue
                for key, tol in TOL.items():
                    self.assertLessEqual(abs(getattr(rec, ATTR.get(key, key)) - want[key]), tol + 1e-9, key)
                self.assertEqual((rec.track, rec.band, rec.blocked, sorted(rec.blocks)),
                                 (want["track"], want["band"], want["blocked"], want["blocks"]))


if __name__ == "__main__":
    unittest.main()
