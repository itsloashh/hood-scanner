"""Economic data: FRED (keyless CSV) and Bank of Canada Valet. Official statistics."""
from __future__ import annotations

import csv
import io

from ..http import Http

UA = "Mozilla/5.0 (compatible; hood-desk-stocks/1.0; +github.com/itsloashh/hood-scanner)"

FRED_SERIES = {
    "DFF": ("Fed funds rate", "%"),
    "CPIAUCSL": ("US CPI (index)", "index"),
    "PCEPILFE": ("US core PCE (index)", "index"),
    "UNRATE": ("US unemployment", "%"),
    "GDPC1": ("US real GDP", "bn"),
    "DGS10": ("US 10-year yield", "%"),
    "DGS2": ("US 2-year yield", "%"),
    "T10Y2Y": ("US 10y–2y curve", "pp"),
    "BAMLH0A0HYM2": ("US high-yield credit spread", "%"),
    "DCOILWTICO": ("WTI oil", "USD"),
    "DHHNGSP": ("Henry Hub natural gas", "USD"),
    "PCOPPUSDM": ("Copper", "USD/t"),
    "DEXCAUS": ("USD/CAD", "CAD"),
    "IPMAN": ("US manufacturing production (index)", "index"),
}
BOC_SERIES = {
    "V39079": ("Bank of Canada policy rate", "%"),
    "FXUSDCAD": ("USD/CAD (BoC)", "CAD"),
    "BD.CDN.10YR.DQ.YLD": ("Canada 10-year yield", "%"),
    "BD.CDN.2YR.DQ.YLD": ("Canada 2-year yield", "%"),
}


def fred(http: Http, sid: str) -> list[tuple[str, float]]:
    text = http.get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", ua=UA, accept="text/csv,*/*", cache_hours=6).decode()
    out = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2 or row[0] in ("DATE", "observation_date"):
            continue
        try:
            out.append((row[0], float(row[1])))
        except ValueError:
            continue
    return out


def boc(http: Http, ids: list[str], recent: int = 400) -> dict[str, list[tuple[str, float]]]:
    j = http.json(f"https://www.bankofcanada.ca/valet/observations/{','.join(ids)}/json?recent={recent}", cache_hours=6)
    out: dict[str, list] = {i: [] for i in ids}
    for o in j.get("observations", []):
        for i in ids:
            v = (o.get(i) or {}).get("v")
            if v not in (None, ""):
                try:
                    out[i].append((o["d"], float(v)))
                except ValueError:
                    pass
    return out
