"""Convert between fixture JSON (app input format) and oracle / WW inputs."""

from __future__ import annotations

import datetime as dt

import ww_types
from score import ProjectInput, Scored

# WW's habitability and coverage gates fold into safety and legal (HANDOFF §6.6).
GATE_TO_NON_NEGOTIABLE = {"safety": "safety", "habitability": "safety", "legal": "legal",
                          "coverage": "legal"}
CONFIDENCES = {"quoted", "estimate", "guess"}


def _date(s: str | None) -> dt.date | None:
    return dt.date.fromisoformat(s) if s else None


def parse_case(c: dict) -> ProjectInput:
    return ProjectInput(
        id=c["id"], title=c.get("title", ""), cost=float(c["cost"]), effort=float(c["effort"]),
        probability=float(c["risk"]["probability"]), consequence=float(c["risk"]["consequence"]),
        reach=float(c["value"]["reach"]),
        impacts={k: float(v) for k, v in c["value"]["impact"].items()},
        cost_confidence=c.get("cost_confidence"),
        recoup_pct=float(c["finance"]["recoup_pct"]),
        annual_savings=float(c["finance"]["annual_savings"]),
        annual_carrying_cost=float(c["finance"]["annual_carrying_cost"]),
        urgency=c.get("urgency", "standard"), identified=_date(c.get("identified")),
        deadline=_date(c.get("deadline")), non_negotiable=c.get("non_negotiable"),
        depends_on=list(c.get("depends_on") or []), status=c.get("status", "open"),
    )


def deep_merge(base: dict, over: dict) -> dict:
    """Dicts merge recursively; everything else (lists included) is replaced."""
    out = dict(base)
    for k, v in over.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def expand_suite(suite: dict) -> list[dict]:
    """A cases.json suite → full app inputs (the suite's `base` merged under each case)."""
    base = suite.get("base", {})
    return [deep_merge(base, {**c["input"], "id": c["id"]}) for c in suite["cases"]]


def ww_cases_to_app(inputs: list[dict]) -> list[dict]:
    """WW fixture inputs → app inputs: gates renamed, fixed_date → hard_deadline,
    committed → in_progress, unknown confidence → null, `enables` folded into the
    target's depends_on."""
    out = []
    for c in inputs:
        a = {k: v for k, v in c.items() if k not in ("gate", "enables")}
        conf = c.get("cost_confidence", "estimate")
        a["cost_confidence"] = conf if conf in CONFIDENCES else None
        a["non_negotiable"] = GATE_TO_NON_NEGOTIABLE[c["gate"]] if c.get("gate") else None
        if a.get("urgency") == "fixed_date":
            a["urgency"] = "hard_deadline"
        if a.get("status") == "committed":
            a["status"] = "in_progress"
        a["depends_on"] = list(c.get("depends_on") or [])
        out.append(a)
    by_id = {a["id"]: a for a in out}
    for c in inputs:
        for target in c.get("enables") or []:
            deps = by_id[target]["depends_on"]
            if c["id"] not in deps:
                deps.append(c["id"])
    return out


def app_to_ww(c: dict) -> ww_types.ProjectInput:
    """App input → WW input, for scoring the calibration projects under WW's rules."""
    p = parse_case(c)
    return ww_types.ProjectInput(
        id=p.id, title=p.title, cost=p.cost, effort=p.effort, probability=p.probability,
        consequence=p.consequence, reach=p.reach, impacts=dict(p.impacts),
        cost_confidence=p.cost_confidence or "unknown", recoup_pct=p.recoup_pct,
        annual_savings=p.annual_savings, annual_carrying_cost=p.annual_carrying_cost,
        urgency="fixed_date" if p.urgency in ("hard_deadline", "target_date") else p.urgency,
        identified=p.identified, deadline=p.deadline, gate=p.non_negotiable,
        depends_on=list(p.depends_on),
        status="committed" if p.status == "in_progress" else p.status,
    )


def expect_of(r: Scored) -> dict:
    return {
        "R": r.R, "V": r.V, "split": r.disagreement, "fpr": r.fpr, "F": r.F, "E": r.E,
        "U": r.U, "C": r.C, "cod": r.cod, "cod_adj": r.cod_adj, "size": r.size,
        "priority": r.priority, "quick_win": r.quick_win, "band": r.band,
        "blocked": r.blocked, "blocks": sorted(r.blocks), "overdue": r.overdue,
        "past_target": r.past_target, "forced_now": r.forced_now,
        "projection": r.projection, "next_moves": [m["kind"] for m in r.next_moves],
    }
