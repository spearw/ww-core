import json
import unittest

import generate


class Generate(unittest.TestCase):
    def test_build_is_deterministic_and_complete(self):
        a, b = generate.build(), generate.build()
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        names = [s["name"] for s in a["suites"]]
        self.assertEqual(names, ["ww", "rules", "members", "nobody", "calibration"])
        suites = {s["name"]: s for s in a["suites"]}
        self.assertEqual(len(suites["ww"]["cases"]), 51)
        self.assertEqual(len(suites["calibration"]["cases"]), 30)
        for s in a["suites"]:
            for c in s["cases"]:
                self.assertIn("expect", c, c["id"])

    def test_ww_inputs_are_converted(self):
        ww = {c["id"]: c for c in next(s for s in generate.build()["suites"] if s["name"] == "ww")["cases"]}
        self.assertEqual(ww["urg-fixed-passed"]["input"]["urgency"], "hard_deadline")
        self.assertEqual(ww["gate-safety"]["input"]["non_negotiable"], "safety")
        self.assertNotIn("enables", ww["enable-mirror"]["input"])
        self.assertIn("enable-mirror", ww["dep-child-b"]["input"]["depends_on"])
        self.assertIsNone(ww["conf-unknown"]["input"]["cost_confidence"])
        self.assertEqual(ww["dep-done-child"]["expect"], {"scored": False})

    def test_empty_member_list_scores_zero_value(self):
        nobody = next(s for s in generate.build()["suites"] if s["name"] == "nobody")
        self.assertEqual(nobody["cases"][0]["expect"]["V"], 0.0)


if __name__ == "__main__":
    unittest.main()
