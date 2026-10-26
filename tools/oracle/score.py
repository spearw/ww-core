"""Oracle for the app's scoring rules. Never shipped; generates conformance-app.json.

Starts from WW's engine/score.py (commit 6f01c29) and applies this app's changes. Every
change from WW is marked with the HANDOFF decision that made it (D20, D21, D33).
Brief-mandated simplifications with no D-marker: constants are module-level rather than config
fields, next_moves are typed dicts rather than prose, and there is no u_why.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field

DEFAULT_WEIGHTS = {"risk": 0.40, "value": 0.30, "finance": 0.20, "enablement": 0.10}
DEFAULT_CONFIDENCE = {"quoted": 1.0, "estimate": 0.85, "guess": 0.7}
CONFIDENCE_FALLBACK = 0.85
# Calibrated 2026-09-29, signed off by William (tools/oracle/calibration-report.md).
DEFAULT_BANDS = {"NOW": 121.5, "NEXT": 85.5, "SOON": 45.0}
EFFORT_K = 0.15
QUICK_WIN_COST = 200.0  # D33: WW's `quick` track survives only as a flag
QUICK_WIN_EFFORT = 2.0
SMALL_COST = 50.0  # P5c-6: costs below this rank as the "Under $50" chip amount
SMALL_COST_AS = 30.0
FORCED_NOW_DAYS = 30  # D21
FPR_ANCHORS = [(0.0, 0.0), (0.25, 1.5), (0.5, 3.0), (0.75, 4.5), (1.0, 6.0), (1.5, 7.5),
               (2.0, 8.5), (3.0, 10.0)]
BAND_RANK = {"NOW": 0, "NEXT": 1, "SOON": 2, "SOMEDAY": 3}
SCORED_STATUSES = frozenset({"open", "deferred", "in_progress"})
SATISFIES_STATUSES = frozenset({"done"})


@dataclass
class ProjectInput:
    id: str
    cost: float
    effort: float
    probability: float
    consequence: float
    reach: float
    impacts: dict[str, float]
    cost_confidence: str | None = "estimate"
    recoup_pct: float = 0.0
    annual_savings: float = 0.0
    annual_carrying_cost: float = 0.0
    urgency: str = "standard"
    identified: dt.date | None = None
    deadline: dt.date | None = None
    non_negotiable: str | None = None
    depends_on: list[str] = field(default_factory=list)
    status: str = "open"
    title: str = ""


@dataclass
class Config:
    members: list[str]  # D33: explicit members; WW derived people from impact keys
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    horizon_years: int = 10
    bands: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_BANDS))


@dataclass
class Scored:
    id: str
    title: str
    cost: float
    effort: float
    R: float
    V: float
    F: float
    E: float
    U: float
    C: float
    per_person: dict[str, float]
    disagreement: float
    fpr: float
    cod: float
    cod_adj: float
    size: float
    priority: float
    quick_win: bool
    non_negotiable: str | None
    forced_now: bool
    overdue: bool
    past_target: bool
    band: str
    urgency: str
    cost_confidence: str | None
    blocks: list[str]
    blocked_by: list[str]
    blocked: bool
    projection: dict[str, float] = field(default_factory=dict)
    next_moves: list[dict] = field(default_factory=list)


def score_risk(p: ProjectInput) -> float:
    return 10.0 * (float(p.probability) * float(p.consequence)) / 25.0


def score_value(p: ProjectInput, members: list[str]) -> tuple[float, dict[str, float], float]:
    reach = float(p.reach)
    per: dict[str, float] = {}
    for who in members:  # D33: every member counts; impact keys of non-members are ignored
        imp = float(p.impacts.get(who, 1.0))
        per[who] = min(10.0, reach * imp / 3.0)
    vals = list(per.values()) or [0.0]
    return sum(vals) / len(vals), per, (max(vals) - min(vals))


def score_finance(p: ProjectInput, horizon_years: int) -> tuple[float, float]:
    cost = max(float(p.cost), 1.0)
    net_annual = float(p.annual_savings) - float(p.annual_carrying_cost)
    fpr = (cost * float(p.recoup_pct) + horizon_years * net_annual) / cost
    x = max(0.0, fpr)
    if x >= FPR_ANCHORS[-1][0]:
        return FPR_ANCHORS[-1][1], fpr
    for (x0, y0), (x1, y1) in zip(FPR_ANCHORS, FPR_ANCHORS[1:], strict=False):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0), fpr
    return FPR_ANCHORS[-1][1], fpr


def score_enablement(n_dependents: int) -> float:
    if n_dependents >= 2:
        return 10.0
    if n_dependents == 1:
        return 7.0
    return 0.0


def combine_factors(f: dict[str, float], w: dict[str, float]) -> float:
    """D20: R and V always count; F and E count only when they raise the weighted average."""
    num = w["risk"] * f["risk"] + w["value"] * f["value"]
    den = w["risk"] + w["value"]
    for k in sorted(("finance", "enablement"), key=lambda k: -f[k]):
        if den > 0 and f[k] > num / den:
            num += w[k] * f[k]
            den += w[k]
    return num / den if den > 0 else 0.0


def _years_since(p: ProjectInput, as_of: dt.date) -> float:
    # Clamped at 0: a future `identified` date must not lower urgency (or reach U = 0).
    return max(0.0, (as_of - (p.identified or as_of)).days / 365.25)


def urgency_at(p: ProjectInput, as_of: dt.date, years_ahead: float) -> float:
    years = _years_since(p, as_of) + years_ahead
    profile = p.urgency or "standard"
    if profile == "expedite":
        return 2.0
    if profile in ("hard_deadline", "target_date"):  # D21: replaces WW's fixed_date
        if p.deadline is None:
            return 1.0
        months = (p.deadline - as_of).days / 30.44 - years_ahead * 12
        if profile == "hard_deadline":
            if months <= 0:
                return 2.5  # D21: a passed deadline never gets less urgent (WW: 1.0)
            return 1.0 + 1.5 * max(0.0, 1.0 - months / 6.0)
        if months <= 0:
            return 1.5
        return 1.0 + 0.5 * max(0.0, 1.0 - months / 3.0)
    if profile == "intangible":
        return min(2.5, 1.0 + 0.08 * years)
    if profile == "constant_benefit":
        return min(1.5, 1.0 + 0.05 * years)
    return 1.0


def date_flags(p: ProjectInput, as_of: dt.date) -> tuple[bool, bool, bool]:
    """D21: (overdue, past_target, forced_now)."""
    if p.deadline is None:
        return False, False, False
    days = (p.deadline - as_of).days
    hard = p.urgency == "hard_deadline"
    target = p.urgency == "target_date"
    return hard and days < 0, target and days < 0, hard and days <= FORCED_NOW_DAYS


def band_of(priority: float, non_negotiable: str | None, forced_now: bool,
            bands: dict[str, float]) -> str:
    if non_negotiable or forced_now:  # D21: forced_now
        return "NOW"
    for name in ("NOW", "NEXT", "SOON"):
        if priority >= bands[name]:
            return name
    return "SOMEDAY"


def next_moves(r: Scored, blocked_titles: list[str]) -> list[dict]:
    a: list[dict] = []
    if r.cost_confidence == "guess" and r.cost > 5000:
        a.append({"kind": "get_real_price", "cost": r.cost})
    if r.blocked_by:
        a.append({"kind": "blocked_by", "titles": list(blocked_titles)})
    if len(r.blocks) >= 2:
        a.append({"kind": "unblocks_many", "count": len(r.blocks)})
    if r.disagreement >= 3:
        a.append({"kind": "disagree"})
    if r.fpr < 0.5 and r.cost > 10000:
        a.append({"kind": "spending_not_investing"})
    if r.urgency == "intangible" and r.U > 1.3:
        a.append({"kind": "escalating"})
    if r.overdue:
        a.append({"kind": "overdue"})  # D21
    if r.past_target:
        a.append({"kind": "past_target"})  # D21
    return a


def score_all(projects: list[ProjectInput], cfg: Config, as_of: dt.date) -> list[Scored]:
    active = [p for p in projects if p.status in SCORED_STATUSES]
    active_ids = {p.id for p in active}
    done_ids = {p.id for p in projects if p.status in SATISFIES_STATUSES}
    titles = {p.id: (p.title or p.id) for p in active}

    # D33: WW's `enables` mirror is gone; the app stores only "do first" links.
    dependents: dict[str, list[str]] = {}
    for p in active:
        for dep in p.depends_on:
            if dep in active_ids and p.id not in dependents.setdefault(dep, []):
                dependents[dep].append(p.id)

    out: list[Scored] = []
    for p in active:
        R = score_risk(p)
        V, per, spread = score_value(p, cfg.members)
        F, fpr = score_finance(p, cfg.horizon_years)
        E = score_enablement(len(dependents.get(p.id, [])))
        U = urgency_at(p, as_of, 0)
        C = DEFAULT_CONFIDENCE.get(p.cost_confidence or "", CONFIDENCE_FALLBACK)
        cod = combine_factors({"risk": R, "value": V, "finance": F, "enablement": E},
                              cfg.weights)  # D20
        cod_adj = cod * U * C
        cost, effort = float(p.cost), float(p.effort)
        size_cost = SMALL_COST_AS if cost < SMALL_COST else cost
        size = math.log10(size_cost + 10.0) * (1.0 + EFFORT_K * effort)
        priority = round(100.0 * cod_adj / size, 1) if size > 0 else 0.0
        overdue, past_target, forced_now = date_flags(p, as_of)
        blocked_by = [d for d in p.depends_on if d in active_ids and d not in done_ids]
        rec = Scored(
            id=p.id, title=p.title or p.id, cost=cost, effort=effort,
            R=round(R, 2), V=round(V, 2), F=round(F, 2), E=round(E, 2), U=round(U, 3), C=C,
            per_person={k: round(v, 2) for k, v in per.items()},
            disagreement=round(spread, 2), fpr=round(fpr, 3),
            cod=round(cod, 3), cod_adj=round(cod_adj, 3), size=round(size, 3),
            priority=priority,
            quick_win=cost < QUICK_WIN_COST and effort <= QUICK_WIN_EFFORT,
            non_negotiable=p.non_negotiable, forced_now=forced_now,
            overdue=overdue, past_target=past_target,
            band=band_of(priority, p.non_negotiable, forced_now, cfg.bands),
            urgency=p.urgency, cost_confidence=p.cost_confidence,
            blocks=list(dependents.get(p.id, [])), blocked_by=blocked_by,
            blocked=bool(blocked_by),
        )
        rec.projection = {f"y{n}": round(priority * urgency_at(p, as_of, n) / U, 1)
                          for n in (0, 1, 3, 5)}
        rec.next_moves = next_moves(rec, [titles.get(d, d) for d in blocked_by])
        out.append(rec)

    # Non-negotiable first, then band (NOW < NEXT < SOON < SOMEDAY), then priority
    # descending, cost ascending, id. Band before priority keeps a forced-Now deadline
    # above Next and Soon even when its priority is low.
    out.sort(key=lambda r: (-int(bool(r.non_negotiable)), BAND_RANK[r.band], -r.priority,
                            r.cost, r.id))
    return out
