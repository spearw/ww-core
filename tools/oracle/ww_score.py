"""Projects scoring engine. Port of the reference House Priority scorer.

Priority = 100 * (wR*R + wV*V + wF*F + wE*E) * U(t) * C / (log10(cost+10) * (1 + k*effort))

Every scale is absolutely anchored; adding an item never re-scores the others.
The clock is injected (`as_of`) so the urgency term is reproducible.
"""

from __future__ import annotations

import datetime as dt
import math

from ww_types import (
    SATISFIES_STATUSES,
    SCORED_STATUSES,
    EngineConfig,
    ProjectInput,
    ScoredProject,
)


def score_risk(p: ProjectInput) -> float:
    """R = 10 * (P x C) / 25."""
    return 10.0 * (float(p.probability) * float(p.consequence)) / 25.0


def score_value(p: ProjectInput, people: list[str]) -> tuple[float, dict[str, float], float]:
    """V = min(10, reach x impact / 3) per person -> (mean, per_person, spread)."""
    reach = float(p.reach)
    impacts = p.impacts or {}
    per: dict[str, float] = {}
    for who in people:
        imp = float(impacts.get(who, 1.0))
        per[who] = min(10.0, reach * imp / 3.0)
    vals = list(per.values()) or [0.0]
    return sum(vals) / len(vals), per, (max(vals) - min(vals))


def score_finance(p: ProjectInput, cfg: EngineConfig) -> tuple[float, float]:
    """Piecewise-anchored payback ratio -> 0-10. Returns (F, FPR)."""
    cost = max(float(p.cost), 1.0)
    net_annual = float(p.annual_savings) - float(p.annual_carrying_cost)
    fpr = (cost * float(p.recoup_pct) + cfg.horizon_years * net_annual) / cost
    anchors = cfg.fpr_anchors
    x = max(0.0, fpr)
    if x >= anchors[-1][0]:
        return anchors[-1][1], fpr
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:], strict=False):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0), fpr
    return anchors[-1][1], fpr


def score_enablement(n_dependents: int) -> float:
    if n_dependents >= 2:
        return 10.0
    if n_dependents == 1:
        return 7.0
    return 0.0


def _years_since(p: ProjectInput, as_of: dt.date) -> float:
    ident = p.identified or as_of
    return (as_of - ident).days / 365.25


def urgency_multiplier(p: ProjectInput, as_of: dt.date) -> tuple[float, str]:
    years = _years_since(p, as_of)
    profile = p.urgency or "standard"
    if profile == "expedite":
        return 2.0, "constant high loss"
    if profile == "fixed_date":
        if p.deadline is None:
            return 1.0, "fixed date with no deadline set"
        months = (p.deadline - as_of).days / 30.44
        if months <= 0:
            return 1.0, "deadline passed"
        ramp = max(0.0, 1.0 - months / 6.0)
        return 1.0 + 1.5 * ramp, f"{months:.1f} months to deadline"
    if profile == "intangible":
        return min(2.5, 1.0 + 0.08 * years), f"deferred {years:.1f}y, escalating 8%/yr"
    if profile == "constant_benefit":
        return min(1.5, 1.0 + 0.05 * years), f"losing savings for {years:.1f}y"
    return 1.0, "standard"


def urgency_at(p: ProjectInput, as_of: dt.date, years_ahead: float) -> float:
    """U evaluated `years_ahead` from `as_of`; priority is linear in U."""
    years = _years_since(p, as_of) + years_ahead
    profile = p.urgency or "standard"
    if profile == "expedite":
        return 2.0
    if profile == "fixed_date":
        if p.deadline is None:
            return 1.0
        months = (p.deadline - as_of).days / 30.44 - years_ahead * 12
        if months <= 0:
            return 1.0
        return 1.0 + 1.5 * max(0.0, 1.0 - months / 6.0)
    if profile == "intangible":
        return min(2.5, 1.0 + 0.08 * years)
    if profile == "constant_benefit":
        return min(1.5, 1.0 + 0.05 * years)
    return 1.0


def track_of(p: ProjectInput, cfg: EngineConfig) -> str:
    """Exclusive on cost, inclusive on effort. Pinned by the conformance suite."""
    cost, effort = float(p.cost), float(p.effort)
    if cost < cfg.track_quick_cost and effort <= cfg.track_quick_effort:
        return "quick"
    if cost > cfg.track_capital_cost:
        return "capital"
    return "projects"


def band_of(priority: float, gate: str | None, cfg: EngineConfig) -> str:
    if gate:
        return "NOW"
    for name in ("NOW", "NEXT", "SOON"):
        if priority >= cfg.bands[name]:
            return name
    return "SOMEDAY"


def next_actions(r: ScoredProject, blocked_by_titles: list[str] | None = None) -> list[str]:
    a: list[str] = []
    if r.confidence == "guess" and r.cost > 5000:
        a.append(
            f"Get a quote. At ${r.cost:,.0f} on a guess, turning the estimate into a number "
            "is worth more than starting the work."
        )
    if r.blocked_by:
        a.append("Blocked by: " + ", ".join(blocked_by_titles or r.blocked_by))
    if len(r.blocks) >= 2:
        a.append(
            f"Unblocks {len(r.blocks)} other projects. Doing it early is worth more "
            "than its own score suggests."
        )
    if r.disagreement >= 3:
        a.append(f"You are {r.disagreement:.1f} points apart on this. Talk before scheduling.")
    if r.fpr < 0.5 and r.cost > 10000:
        a.append(
            f"Payback ratio {r.fpr:.2f} over the horizon. This is consumption, not "
            "investment. Fine, as long as it is deliberate."
        )
    if r.urgency == "intangible" and r.U > 1.3:
        a.append(f"Escalating on its own ({r.u_why}). Do it or drop it.")
    return a


def score_all(
    projects: list[ProjectInput], cfg: EngineConfig, as_of: dt.date
) -> list[ScoredProject]:
    """Score every project in a scored status. Dependencies resolve against the whole list."""
    by_id = {p.id: p for p in projects}
    active = [p for p in projects if p.status in SCORED_STATUSES]
    active_ids = {p.id for p in active}
    done_ids = {p.id for p in projects if p.status in SATISFIES_STATUSES}
    titles = {p.id: (p.title or p.id) for p in active}

    people: list[str] = []
    for p in active:
        for who in p.impacts or {}:
            if who not in people:
                people.append(who)

    # reverse dependency index over active projects; `enables` mirrors depends_on
    dependents: dict[str, list[str]] = {}
    for p in active:
        for dep in p.depends_on:
            if dep in active_ids and p.id not in dependents.setdefault(dep, []):
                dependents[dep].append(p.id)
        for en in p.enables:
            if en in active_ids and en not in by_id[en].depends_on:
                if en not in dependents.setdefault(p.id, []):
                    dependents[p.id].append(en)

    out: list[ScoredProject] = []
    w = cfg.weights
    for p in active:
        R = score_risk(p)
        V, per_person, spread = score_value(p, people)
        F, fpr = score_finance(p, cfg)
        E = score_enablement(len(dependents.get(p.id, [])))
        U, u_why = urgency_multiplier(p, as_of)
        C = cfg.confidence.get(p.cost_confidence, cfg.confidence_fallback)
        cod = w["risk"] * R + w["value"] * V + w["finance"] * F + w["enablement"] * E
        cod_adj = cod * U * C
        cost, effort = float(p.cost), float(p.effort)
        size = math.log10(cost + 10.0) * (1.0 + cfg.effort_k * effort)
        priority = round(100.0 * cod_adj / size, 1) if size > 0 else 0.0
        blocked_by = [d for d in p.depends_on if d in active_ids and d not in done_ids]
        rec = ScoredProject(
            id=p.id,
            title=p.title or p.id,
            cost=cost,
            effort=effort,
            R=round(R, 2),
            V=round(V, 2),
            F=round(F, 2),
            E=round(E, 2),
            U=round(U, 3),
            C=C,
            per_person={k: round(v, 2) for k, v in per_person.items()},
            disagreement=round(spread, 2),
            fpr=round(fpr, 3),
            u_why=u_why,
            cod=round(cod, 3),
            cod_adj=round(cod_adj, 3),
            size=round(size, 3),
            priority=round(priority, 1),
            track=track_of(p, cfg),
            gate=p.gate,
            band=band_of(priority, p.gate, cfg),
            urgency=p.urgency,
            confidence=p.cost_confidence,
            status=p.status,
            depends_on=list(p.depends_on),
            blocks=list(dependents.get(p.id, [])),
            blocked_by=blocked_by,
            blocked=bool(blocked_by),
            projection={},
            actions=[],
        )
        rec.projection = (
            {f"y{n}": round(priority * urgency_at(p, as_of, n) / U, 1) for n in (0, 1, 3, 5)}
            if U
            else {}
        )
        rec.actions = next_actions(rec, [titles.get(d, d) for d in blocked_by])
        out.append(rec)

    out.sort(key=lambda r: (-int(bool(r.gate)), -r.priority, r.cost, r.id))
    return out
