"""Generate src/quiz/__fixtures__/weights-golden.json from quiz.py. Never edit it by hand."""

from __future__ import annotations

import json
from pathlib import Path

import quiz

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "src" / "quiz" / "__fixtures__" / "weights-golden.json"


def five(best, worst, m1, m2, answers):
    pairs = [(best, m1), (best, m2), (best, worst), (m1, worst), (m2, worst)]
    return [(a, b, ans) for (a, b), ans in zip(pairs, answers, strict=True)]


def five_t(best, worst, m1, m2, answers, tiers):
    pairs = [(best, m1), (best, m2), (best, worst), (m1, worst), (m2, worst)]
    return [(a, b, ans, ta, tb)
            for (a, b), ans, (ta, tb) in zip(pairs, answers, tiers, strict=True)]


ESTIMATES = [
    ("all-toss-ups", "risk", "enablement", "value", "finance", ["tossUp"] * 5),
    ("consistent-definite", "risk", "enablement", "value", "finance", ["definitelyA"] * 5),
    ("consistent-lean", "risk", "enablement", "value", "finance", ["leanA"] * 5),
    ("all-reversed", "risk", "enablement", "value", "finance", ["definitelyB"] * 5),
    ("symmetric-middles", "value", "finance", "risk", "enablement",
     ["leanA", "leanA", "definitelyA", "leanA", "leanA"]),
    ("close-top-two", "finance", "risk", "enablement", "value",
     ["tossUp", "leanA", "definitelyA", "leanA", "leanA"]),
    ("mixed", "enablement", "value", "risk", "finance",
     ["leanB", "leanA", "definitelyA", "tossUp", "leanA"]),
    ("intransitive-resolvable", "risk", "enablement", "value", "finance",
     ["definitelyA", "definitelyA", "leanB", "definitelyA", "definitelyA"]),
    ("intransitive-stuck", "risk", "enablement", "value", "finance",
     ["definitelyA", "definitelyA", "definitelyB", "definitelyA", "definitelyA"]),
]

# Same shape plus five (tierA, tierB) pairs, one per duel.
TIERED_ESTIMATES = [
    ("tiered-toss-ups", "risk", "enablement", "value", "finance", ["tossUp"] * 5,
     [(1, 2), (1, 1), (0, 1), (2, 2), (1, 2)]),
    ("tiered-consistent", "risk", "enablement", "value", "finance", ["leanA"] * 5,
     [(0, 1), (2, 2), (1, 2), (1, 2), (0, 0)]),
    ("tiered-against", "value", "finance", "risk", "enablement",
     ["leanB", "tossUp", "leanA", "leanA", "definitelyA"],
     [(2, 1), (1, 1), (1, 2), (1, 0), (2, 2)]),
    ("tiered-recheck", "risk", "enablement", "value", "finance",
     ["definitelyA", "definitelyA", "definitelyB", "definitelyA", "definitelyA"],
     [(1, 2), (0, 1), (1, 2), (1, 1), (1, 2)]),
    ("tiered-recheck-resolvable", "risk", "enablement", "value", "finance",
     ["definitelyA", "definitelyA", "leanB", "definitelyA", "definitelyA"],
     [(1, 2), (0, 1), (1, 2), (1, 1), (2, 2)]),
]

# Cases where no answer to the repeated duel clears the re-check. Any other case that flags one
# must have an answer that clears it, or generation fails.
STUCK = {"intransitive-stuck", "tiered-recheck"}

# (name, criterion, target, base estimate). The base is the estimate case whose weights are adjusted.
ADJUSTS = [
    ("raise-worst", "enablement", 0.5, "consistent-lean"),
    ("lower-best", "risk", 0.05, "consistent-lean"),
    ("snap-middle", "value", 0.33, "consistent-lean"),
    ("half-step-rounds-up", "finance", 0.125, "consistent-lean"),
    ("above-cap", "finance", 0.9, "consistent-lean"),
    ("below-floor", "finance", -1.0, "consistent-lean"),
    # Skewed start: shrinking the others in proportion would put enablement under the floor,
    # so it is held at 0.05 and the rest is shared between risk and finance.
    ("raise-middle-floors-worst", "value", 0.5, "consistent-definite"),
]


def duel_json(d):
    out = {"a": d[0], "b": d[1], "answer": d[2]}
    if len(d) == 5:
        out["tierA"], out["tierB"] = d[3], d[4]
    return out


def build() -> dict:
    estimates, rechecks = [], []
    cases = [(n, b, w, m1, m2, five(b, w, m1, m2, ans))
             for n, b, w, m1, m2, ans in ESTIMATES]
    cases += [(n, b, w, m1, m2, five_t(b, w, m1, m2, ans, tiers))
              for n, b, w, m1, m2, ans, tiers in TIERED_ESTIMATES]
    for name, best, worst, m1, m2, duels in cases:
        e = quiz.estimate(best, worst, duels)
        key, flavour = quiz.archetype(e["weights"], False)
        estimates.append({"name": name, "best": best, "worst": worst,
                          "duels": [duel_json(d) for d in duels],
                          "expect": {**e, "archetype": key, "flavour": flavour}})
        if e["needsRecheck"]:
            a, b, original, *tiers = duels[e["worstIndex"]]
            clears = [ans for ans in quiz.ANSWERS
                      if not quiz.estimate(best, worst,
                                           duels + [(a, b, ans, *tiers)])["needsRecheck"]]
            if name in STUCK:
                if clears:
                    raise AssertionError(f"{name} is listed as stuck but {clears} clear it")
                chosen = original
            elif clears:
                chosen = clears[0]
            else:
                raise AssertionError(f"{name}: no answer to the repeated duel clears the re-check")
            again = (a, b, chosen, *tiers)
            e2 = quiz.estimate(best, worst, duels + [again])
            key2, flavour2 = quiz.archetype(e2["weights"], False)
            rechecks.append({"name": name, "best": best, "worst": worst,
                             "duels": [duel_json(d) for d in duels],
                             "recheck": duel_json(again),
                             "expect": {"weights": e2["weights"], "lessSure": e2["needsRecheck"],
                                        "archetype": key2, "flavour": flavour2}})
    base = {x["name"]: x["expect"]["weights"] for x in estimates}
    adjusts = [{"name": name, "weights": base[b], "criterion": c, "target": t,
                "expect": quiz.adjust(base[b], c, t)} for name, c, t, b in ADJUSTS]
    key, flavour = quiz.archetype(dict(quiz.DEFAULT_WEIGHTS), True)
    return {
        "note": "Generated by tools/oracle/quiz_golden.py. Do not edit by hand.",
        "constants": {"tierStep": quiz.TIER_STEP, "lambda": quiz.LAMBDA, "floor": quiz.FLOOR,
                      "cap": quiz.CAP,
                      "recheckThreshold": quiz.RECHECK_THRESHOLD,
                      "flavourMargin": quiz.FLAVOUR_MARGIN, "balancerSpread": quiz.BALANCER_SPREAD,
                      "defaultWeights": dict(quiz.DEFAULT_WEIGHTS)},
        "estimates": estimates,
        "rechecks": rechecks,
        "adjusts": adjusts,
        "skipped": {"expect": {"archetype": key, "flavour": flavour}},
    }


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), indent=1, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
