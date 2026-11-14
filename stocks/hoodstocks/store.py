"""Data store: plain JSON/JSONL files under data/stocks, committed to the repo so the dashboard can read them.
Tables keep their provenance (source records); history files are append-only and never rewritten."""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import config


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def path(name: str) -> Path:
    return config.DATA / name


def read(name: str, default=None):
    p = path(name)
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return default


def write(name: str, obj, *, compact: bool = False) -> None:
    p = path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"), default=str)
        else:
            json.dump(obj, f, indent=1, default=str)
    os.replace(tmp, p)


def append(name: str, rows: list[dict]) -> None:
    """Append-only history (JSON lines). Nothing here is ever edited in place."""
    if not rows:
        return
    p = path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":"), default=str) + "\n")


def read_lines(name: str) -> list[dict]:
    p = path(name)
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def source(provider: str, url: str, *, reliability: str, publication_date: str | None = None, event_date: str | None = None,
           reporting_period: str | None = None, verification: str = "primary") -> dict:
    """A SOURCES record. reliability: primary (regulator/issuer), official_stats, market_data, aggregator, derived."""
    return {
        "provider": provider,
        "url": url,
        "reliability": reliability,
        "publication_date": publication_date,
        "event_date": event_date,
        "reporting_period": reporting_period,
        "retrieved": now_iso(),
        "verification": verification,
    }
