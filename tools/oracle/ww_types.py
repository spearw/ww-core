"""Engine data types and constants. No Django imports in this package."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

# ---- constants (the reference implementation's defaults; tunable via EngineConfig)
DEFAULT_WEIGHTS = {"risk": 0.40, "value": 0.30, "finance": 0.20, "enablement": 0.10}
DEFAULT_CONFIDENCE = {"quoted": 1.0, "estimate": 0.85, "guess": 0.7}
DEFAULT_CONFIDENCE_FALLBACK = 0.85
DEFAULT_BANDS = {"NOW": 85.0, "NEXT": 60.0, "SOON": 35.0}
DEFAULT_EFFORT_K = 0.15
DEFAULT_HORIZON_YEARS = 10
DEFAULT_TRACK_QUICK_COST = 200.0
DEFAULT_TRACK_QUICK_EFFORT = 2.0
DEFAULT_TRACK_CAPITAL_COST = 10_000.0
DEFAULT_FPR_ANCHORS = [
    (0.0, 0.0),
    (0.25, 1.5),
    (0.5, 3.0),
    (0.75, 4.5),
    (1.0, 6.0),
    (1.5, 7.5),
    (2.0, 8.5),
    (3.0, 10.0),
]

GATES = ("safety", "habitability", "legal", "coverage")
URGENCY_PROFILES = ("expedite", "fixed_date", "standard", "intangible", "constant_benefit")
BAND_ORDER = ("NOW", "NEXT", "SOON", "SOMEDAY")
BAND_LABELS = {"NOW": "Now", "NEXT": "Next", "SOON": "Soon", "SOMEDAY": "Later"}
TRACKS = ("quick", "projects", "capital")

SCORED_STATUSES = frozenset({"open", "deferred", "committed"})
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
    cost_confidence: str = "estimate"
    recoup_pct: float = 0.0
    annual_savings: float = 0.0
    annual_carrying_cost: float = 0.0
    urgency: str = "standard"
    identified: dt.date | None = None
    deadline: dt.date | None = None
    gate: str | None = None
    depends_on: list[str] = field(default_factory=list)
    enables: list[str] = field(default_factory=list)
    status: str = "open"
    title: str = ""
    track_budget_key: str = ""  # unused by score; reserved for budget.py


@dataclass
class EngineConfig:
    weights: dict[str, float]
    horizon_years: int = DEFAULT_HORIZON_YEARS
    bands: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_BANDS))
    effort_k: float = DEFAULT_EFFORT_K
    confidence: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_CONFIDENCE))
    confidence_fallback: float = DEFAULT_CONFIDENCE_FALLBACK
    track_quick_cost: float = DEFAULT_TRACK_QUICK_COST
    track_quick_effort: float = DEFAULT_TRACK_QUICK_EFFORT
    track_capital_cost: float = DEFAULT_TRACK_CAPITAL_COST
    fpr_anchors: list[tuple[float, float]] = field(
        default_factory=lambda: list(DEFAULT_FPR_ANCHORS)
    )

    @classmethod
    def default(cls) -> EngineConfig:
        return cls(weights=dict(DEFAULT_WEIGHTS))

    @classmethod
    def from_tuning(
        cls, *, weights: dict[str, float], horizon_years: int, tuning: dict
    ) -> EngineConfig:
        """Build a config from settings; any key absent from `tuning` keeps the default."""
        cfg = cls(weights=dict(weights), horizon_years=int(horizon_years))
        if "bands" in tuning:
            cfg.bands = {k: float(v) for k, v in tuning["bands"].items()}
        if "effort_k" in tuning:
            cfg.effort_k = float(tuning["effort_k"])
        if "confidence" in tuning:
            cfg.confidence = {k: float(v) for k, v in tuning["confidence"].items()}
        if "confidence_fallback" in tuning:
            cfg.confidence_fallback = float(tuning["confidence_fallback"])
        if "track_quick_cost" in tuning:
            cfg.track_quick_cost = float(tuning["track_quick_cost"])
        if "track_quick_effort" in tuning:
            cfg.track_quick_effort = float(tuning["track_quick_effort"])
        if "track_capital_cost" in tuning:
            cfg.track_capital_cost = float(tuning["track_capital_cost"])
        if "fpr_anchors" in tuning:
            cfg.fpr_anchors = [(float(x), float(y)) for x, y in tuning["fpr_anchors"]]
        return cfg


@dataclass
class ScoredProject:
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
    u_why: str
    cod: float
    cod_adj: float
    size: float
    priority: float
    track: str
    gate: str | None
    band: str
    urgency: str
    confidence: str
    status: str
    depends_on: list[str]
    blocks: list[str]
    blocked_by: list[str]
    blocked: bool
    projection: dict[str, float]
    actions: list[str]
    unstable: bool = False

    @property
    def band_label(self) -> str:
        return BAND_LABELS[self.band]
