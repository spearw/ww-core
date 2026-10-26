"""Compare an expected-values dict with an actual one, using WW's tolerances."""

TOL = {"R": 0.01, "V": 0.01, "split": 0.01, "fpr": 0.01, "F": 0.01, "E": 0.01, "U": 0.005,
       "C": 0.005, "cod": 0.01, "cod_adj": 0.01, "size": 0.005, "priority": 0.06}
PROJECTION_TOL = 0.06


def mismatches(want: dict, got: dict) -> list[str]:
    out = []
    for key, w in want.items():
        g = got.get(key)
        if key in TOL:
            if g is None or abs(g - w) > TOL[key] + 1e-9:
                out.append(f"{key}: got {g}, want {w}")
        elif key == "projection":
            for n, wv in w.items():
                if abs(g[n] - wv) > PROJECTION_TOL + 1e-9:
                    out.append(f"projection.{n}: got {g[n]}, want {wv}")
        elif g != w:
            out.append(f"{key}: got {g!r}, want {w!r}")
    return out
