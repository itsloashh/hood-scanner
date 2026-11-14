"""All fixtures here are SYNTHETIC test data, not real market information."""
import json
import os
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("STOCKS_DATA_DIR", tempfile.mkdtemp(prefix="stocks-data-"))
os.environ.setdefault("STOCKS_CACHE_DIR", tempfile.mkdtemp(prefix="stocks-cache-"))

FIX = Path(__file__).parent / "fixtures"


def fx(name):
    return (FIX / name).read_text()


def q(start, end, val, filed, form="10-Q", accn="0000000000-00-000001"):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form, "accn": accn}


@pytest.fixture
def facts():
    """SYNTHETIC company facts: 8 quarters + 2 fiscal years, USD."""
    rev = [
        q("2023-01-01", "2023-03-31", 100, "2023-05-01"), q("2023-04-01", "2023-06-30", 110, "2023-08-01"),
        q("2023-07-01", "2023-09-30", 120, "2023-11-01"), q("2023-01-01", "2023-12-31", 460, "2024-02-15", "10-K"),
        q("2024-01-01", "2024-03-31", 125, "2024-05-01"), q("2024-04-01", "2024-06-30", 135, "2024-08-01"),
        q("2024-07-01", "2024-09-30", 145, "2024-11-01"), q("2024-01-01", "2024-12-31", 560, "2025-02-15", "10-K"),
    ]
    ni = [dict(r, val=r["val"] * 0.2) for r in rev]
    ocf = [dict(r, val=r["val"] * 0.3) for r in rev]
    capex = [dict(r, val=r["val"] * 0.05) for r in rev]
    inst = lambda end, val, filed: {"end": end, "val": val, "filed": filed, "form": "10-K", "accn": "0000000000-00-000002"}  # noqa: E731
    return {
        "cik": 1, "entityName": "SYNTHETIC CO",
        "facts": {
            "us-gaap": {
                "Revenues": {"units": {"USD": rev}},
                "NetIncomeLoss": {"units": {"USD": ni}},
                "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": ocf}},
                "PaymentsToAcquirePropertyPlantAndEquipment": {"units": {"USD": capex}},
                "OperatingIncomeLoss": {"units": {"USD": [dict(r, val=r["val"] * 0.25) for r in rev]}},
                "DepreciationDepletionAndAmortization": {"units": {"USD": [dict(r, val=r["val"] * 0.05) for r in rev]}},
                "CashAndCashEquivalentsAtCarryingValue": {"units": {"USD": [inst("2023-12-31", 200, "2024-02-15"), inst("2024-12-31", 300, "2025-02-15")]}},
                "LongTermDebtNoncurrent": {"units": {"USD": [inst("2023-12-31", 100, "2024-02-15"), inst("2024-12-31", 100, "2025-02-15")]}},
                "StockholdersEquity": {"units": {"USD": [inst("2023-12-31", 800, "2024-02-15"), inst("2024-12-31", 900, "2025-02-15")]}},
                "Assets": {"units": {"USD": [inst("2023-12-31", 1200, "2024-02-15"), inst("2024-12-31", 1400, "2025-02-15")]}},
            },
            "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [inst("2024-01-31", 100, "2024-02-15"), inst("2025-01-31", 100, "2025-02-15")]}}},
        },
    }


def bars_linear(start="2020-01-02", n=1300, p0=10.0, step=0.01, vol=1_000_000):
    from datetime import date, timedelta
    d = date.fromisoformat(start)
    out = []
    p = p0
    while len(out) < n:
        if d.weekday() < 5:
            out.append({"t": d.isoformat(), "o": p, "h": p * 1.01, "l": p * 0.99, "c": p, "v": vol, "adj": p})
            p += step
        d += timedelta(days=1)
    return out
