"""Oracle for the onboarding quiz maths (HANDOFF §5.5). Never shipped.

Mirrors src/quiz/weights.ts operation for operation; quiz_golden.py turns it into
src/quiz/__fixtures__/weights-golden.json, which the TypeScript must match within 1e-9.
"""

from __future__ import annotations

import math

CRITERIA = ("risk", "value", "finance", "enablement")
ANSWERS = ("definitelyA", "leanA", "tossUp", "leanB", "definitelyB")
RATIO = {"definitelyA": 4.0, "leanA": 2.0, "tossUp": 1.0, "leanB": 0.5, "definitelyB": 0.25}
TIER_STEP = 2.0
LAMBDA = 0.75
FLOOR = 0.05
CAP = 0.50
RECHECK_THRESHOLD = math.log(4)
FLAVOUR_MARGIN = 0.08
BALANCER_SPREAD = 0.10
DEFAULT_WEIGHTS = {"risk": 0.40, "value": 0.30, "finance": 0.20, "enablement": 0.10}
ARCHETYPE_OF = {"risk": "firefighter", "value": "enjoyer", "finance": "investor",
                "enablement": "builder"}


def prior_from_cards(best: str, worst: str) -> dict[str, float]:
    if best == worst:
        raise ValueError("best and worst must differ")
    return {c: 0.44 if c == best else 0.11 if c == worst else 0.225 for c in CRITERIA}


def solve_linear(A: list[list[float]], b: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting."""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = col
        for r in range(col + 1, n):
            if abs(M[r][col]) > abs(M[piv][col]):
                piv = r
        M[col], M[piv] = M[piv], M[col]
        for r in range(col + 1, n):
            f = M[r][col] / M[col][col]
            for k in range(col, n + 1):
                M[r][k] = M[r][k] - f * M[col][k]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        s = M[i][n]
        for k in range(i + 1, n):
            s = s - M[i][k] * x[k]
        x[i] = s / M[i][i]
    return x


def scale_clamp(values: list[float], total: float, lo: float = FLOOR, hi: float = CAP) -> list[float]:
    """Find t with sum(clamp(t*v, lo, hi)) == total; return the clamped values."""
    n = len(values)
    if any(not v > 0 for v in values):
        raise ValueError("scale_clamp: values must be > 0")
    if total < n * lo - 1e-9 or total > n * hi + 1e-9:
        raise ValueError(f"scale_clamp: total {total} out of range")
    bps = sorted(set([lo / v for v in values] + [hi / v for v in values]))
    edges = [0.0] + bps + [math.inf]
    for k in range(len(edges) - 1):
        t0, t1 = edges[k], edges[k + 1]
        mid = (t0 + (t0 + 1.0 if t1 == math.inf else t1)) / 2
        fixed = 0.0
        slope = 0.0
        for v in values:
            x = mid * v
            if x <= lo:
                fixed += lo
            elif x >= hi:
                fixed += hi
            else:
                slope += v
        if slope == 0:
            continue
        t = (total - fixed) / slope
        if t0 - 1e-12 <= t <= t1 + 1e-12:
            return [min(hi, max(lo, t * v)) for v in values]
    raise RuntimeError("scale_clamp: no solution")


def duel_target(ans: str, ta: int = 0, tb: int = 0) -> float:
    """ln(answer ratio) minus the tier gap: the target for v_a - v_b."""
    return math.log(RATIO[ans]) - (ta - tb) * math.log(TIER_STEP)


def unpack_duel(d: tuple) -> tuple[str, str, str, int, int]:
    """A duel is (a, b, ans) or (a, b, ans, ta, tb); absent tiers are equal."""
    a, b, ans, *tiers = d
    ta, tb = tiers if tiers else (0, 0)
    return a, b, ans, ta, tb


def estimate(best: str, worst: str, duels: list[tuple]) -> dict:
    prior = prior_from_cards(best, worst)
    mu = [math.log(prior[c]) for c in CRITERIA]
    A = [[0.0] * 4 for _ in range(4)]
    rhs = [0.0] * 4
    unpacked = [unpack_duel(d) for d in duels]
    for a, b, ans, ta, tb in unpacked:
        i, j = CRITERIA.index(a), CRITERIA.index(b)
        if i == j:
            raise ValueError("a duel needs two different criteria")
        y = duel_target(ans, ta, tb)
        A[i][i] += 1
        A[j][j] += 1
        A[i][j] -= 1
        A[j][i] -= 1
        rhs[i] += y
        rhs[j] -= y
    for i in range(4):
        A[i][i] += LAMBDA
        rhs[i] += LAMBDA * mu[i]
    v = solve_linear(A, rhs)
    m = max(v)
    e = [math.exp(x - m) for x in v]
    s = 0.0
    for x in e:
        s += x
    weights = scale_clamp([x / s for x in e], 1.0)
    residuals = [v[CRITERIA.index(a)] - v[CRITERIA.index(b)] - duel_target(ans, ta, tb)
                 for a, b, ans, ta, tb in unpacked]
    worst_index, max_residual = -1, 0.0
    for k, r in enumerate(residuals):
        if worst_index == -1 or abs(r) > max_residual:
            worst_index, max_residual = k, abs(r)
    return {
        "prior": prior,
        "v": dict(zip(CRITERIA, v, strict=True)),
        "weights": dict(zip(CRITERIA, weights, strict=True)),
        "residuals": residuals,
        "worstIndex": worst_index,
        "maxResidual": max_residual,
        "needsRecheck": worst_index >= 0 and max_residual > RECHECK_THRESHOLD,
    }


def snap_target(target: float) -> float:
    return min(CAP, max(FLOOR, math.floor(target * 20 + 0.5) / 20))


def adjust(weights: dict[str, float], criterion: str, target: float) -> dict[str, float]:
    t = snap_target(target)
    others = [c for c in CRITERIA if c != criterion]
    vals = scale_clamp([weights[c] for c in others], 1.0 - t)
    out = dict(weights)
    out[criterion] = t
    for c, v in zip(others, vals, strict=True):
        out[c] = v
    return {c: out[c] for c in CRITERIA}


def archetype(w: dict[str, float], skipped: bool) -> tuple[str, str | None]:
    vals = [w[c] for c in CRITERIA]
    if skipped or max(vals) - min(vals) < BALANCER_SPREAD:
        return ("balancer", None)
    order = sorted(CRITERIA, key=lambda c: (-w[c], CRITERIA.index(c)))
    top, second = order[0], order[1]
    flavour = ARCHETYPE_OF[second] if w[top] - w[second] <= FLAVOUR_MARGIN + 1e-9 else None
    return (ARCHETYPE_OF[top], flavour)
