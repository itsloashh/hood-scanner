"""Shared shape for every engine result: points earned out of a maximum, with reasons for awarding and withholding."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Component:
    name: str
    earned: float = 0.0      # 0..1 fraction of this component's weight
    reasons: list[str] = field(default_factory=list)    # why points were awarded
    withheld: list[str] = field(default_factory=list)   # why points were not awarded
    missing: list[str] = field(default_factory=list)    # data not available → zero points, never positive
    na: list[str] = field(default_factory=list)         # metric not applicable to this business model
    evidence: list[str] = field(default_factory=list)   # source keys this component relied on

    def add(self, pts: float, reason: str):
        self.earned += pts
        self.reasons.append(reason)

    def miss(self, what: str):
        self.missing.append(what)

    def no(self, why: str):
        self.withheld.append(why)

    def clamp(self) -> "Component":
        self.earned = max(0.0, min(1.0, self.earned))
        return self

    def to_dict(self, weight: float) -> dict:
        return {"name": self.name, "points": round(self.earned * weight, 1), "max": weight, "reasons": self.reasons,
                "withheld": self.withheld, "missing": self.missing, "not_applicable": self.na}


def pct(x, d=0):
    return "n/a" if x is None else f"{x * 100:.{d}f}%"


def num(x, d=1):
    return "n/a" if x is None else f"{x:.{d}f}"
