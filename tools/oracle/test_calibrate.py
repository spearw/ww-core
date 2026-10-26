import math
import unittest

import calibrate


class Place(unittest.TestCase):
    def test_prefers_half_steps_inside_the_gap(self):
        self.assertEqual(calibrate.place(400, 410, 402), 405)

    def test_falls_back_to_tenths_in_a_narrow_gap(self):
        self.assertEqual(calibrate.place(401, 404, 402), 402)

    def test_clamps_to_the_gap(self):
        self.assertEqual(calibrate.place(400, 410, 900), 410)
        self.assertEqual(calibrate.place(400, 410, 1), 405)

    def test_open_gap_above_everything(self):
        self.assertEqual(calibrate.place(0, math.inf, 850), 850)


class Search(unittest.TestCase):
    def test_recovers_uniformly_scaled_cutoffs(self):
        old = {"a": 120.0, "b": 90.0, "c": 70.0, "d": 50.0, "e": 20.0, "f": 10.0}
        ww_cuts = {"NOW": 850, "NEXT": 600, "SOON": 350}
        target = {i: calibrate.band_for(round(p * 10), ww_cuts) for i, p in old.items()}
        tenths = {i: round(p * 14) for i, p in old.items()}  # every score up 40%
        refs = {"NOW": 85 * 14, "NEXT": 60 * 14, "SOON": 35 * 14}
        out = calibrate.search(target, tenths, refs)
        self.assertEqual(out["agree"], 6)
        self.assertEqual(out["cuts"], {"NOW": 1190, "NEXT": 840, "SOON": 490})

    def test_band_for_is_inclusive(self):
        cuts = {"NOW": 850, "NEXT": 600, "SOON": 350}
        self.assertEqual([calibrate.band_for(t, cuts) for t in (850, 849, 600, 350, 349)],
                         ["NOW", "NEXT", "NEXT", "SOON", "SOMEDAY"])


if __name__ == "__main__":
    unittest.main()
