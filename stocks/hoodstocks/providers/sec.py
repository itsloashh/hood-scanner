"""SEC EDGAR adapter: company tickers, submissions, XBRL company facts, daily filing index, Form 4 and 13F documents.
Primary regulatory source. Every record we derive keeps the accession number and filing URL."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import date, timedelta

from ..http import FetchError, Http

WWW = "https://www.sec.gov"
DATA = "https://data.sec.gov"


def cik10(cik: str | int) -> str:
    return str(int(cik)).zfill(10)


def filing_url(cik: str | int, accession: str, doc: str | None = None) -> str:
    acc = accession.replace("-", "")
    base = f"{WWW}/Archives/edgar/data/{int(cik)}/{acc}"
    return f"{base}/{doc}" if doc else f"{base}/{accession}-index.htm"


class Sec:
    def __init__(self, http: Http):
        self.http = http

    # ── identity ─────────────────────────────────────────
    def tickers(self) -> list[dict]:
        """[{cik, name, ticker, exchange}] for every listed issuer SEC knows about."""
        j = self.http.json(f"{WWW}/files/company_tickers_exchange.json", cache_hours=20)
        f = j["fields"]
        return [dict(zip(f, row)) for row in j["data"]]

    def submissions(self, cik, cache_hours: float = 20) -> dict:
        return self.http.json(f"{DATA}/submissions/CIK{cik10(cik)}.json", cache_hours=cache_hours)

    def company_facts(self, cik, cache_hours: float = 20) -> dict:
        return self.http.json(f"{DATA}/api/xbrl/companyfacts/CIK{cik10(cik)}.json", cache_hours=cache_hours)

    # ── filings index ────────────────────────────────────
    def daily_index(self, day: date) -> list[dict]:
        """Every filing accepted on a business day: [{form, company, cik, date, path}]. Empty on holidays."""
        q = (day.month - 1) // 3 + 1
        url = f"{WWW}/Archives/edgar/daily-index/{day.year}/QTR{q}/form.{day:%Y%m%d}.idx"
        try:
            text = self.http.get(url, accept="text/plain", cache_hours=24 * 30 if day < date.today() else 0.5).decode("latin-1")
        except FetchError as e:
            if e.status in (404, 403):
                return []
            raise
        return parse_form_index(text)

    def recent_filings(self, days: int, forms: set[str]) -> list[dict]:
        out, d = [], date.today()
        for i in range(days + 4):  # include weekends
            day = d - timedelta(days=i)
            if day.weekday() >= 5:
                continue
            out += [r for r in self.daily_index(day) if r["form"] in forms]
            if (d - day).days >= days:
                break
        return out

    def text(self, path_or_url: str, cache_hours: float | None = None) -> str:
        url = path_or_url if path_or_url.startswith("http") else f"{WWW}/Archives/{path_or_url}"
        return self.http.get(url, accept="*/*", cache_hours=cache_hours).decode("utf-8", "replace")

    def filing_index(self, cik, accession: str) -> dict:
        acc = accession.replace("-", "")
        return self.http.json(f"{WWW}/Archives/edgar/data/{int(cik)}/{acc}/index.json", cache_hours=24 * 365)


def parse_form_index(text: str) -> list[dict]:
    rows, started = [], False
    for line in text.splitlines():
        if line.startswith("-----"):
            started = True
            continue
        if not started or not line.strip():
            continue
        # fixed-width-ish: form type, company, CIK, date, file name — split from the right
        m = re.match(r"^(\S+(?: \S+)*?)\s{2,}(.+?)\s{2,}(\d+)\s{2,}(\d{8})\s{2,}(\S+)\s*$", line)
        if not m:
            continue
        form, company, cik, d, path = m.groups()
        rows.append({"form": form.strip(), "company": company.strip(), "cik": cik, "date": f"{d[:4]}-{d[4:6]}-{d[6:]}", "path": path})
    return rows


# ── Form 4 ───────────────────────────────────────────────
TX_CODES = {
    "P": "open_market_purchase",
    "S": "open_market_sale",
    "M": "option_exercise",
    "C": "conversion",
    "A": "award",
    "F": "tax_withholding",
    "G": "gift",
    "D": "disposition_to_issuer",
    "J": "other",
    "X": "option_exercise",
    "W": "inheritance",
    "V": "voluntary_report",
}


def _t(el, path):
    x = el.find(path)
    return x.text.strip() if x is not None and x.text else None


def _num(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def parse_form4(xml_text: str) -> dict | None:
    """Parse an ownership document (Form 4). Returns issuer, owners and non-derivative transactions."""
    start = xml_text.find("<ownershipDocument")
    if start < 0:
        return None
    end = xml_text.find("</ownershipDocument>")
    try:
        root = ET.fromstring(xml_text[start:end + len("</ownershipDocument>")])
    except ET.ParseError:
        return None
    owners = []
    for o in root.findall("reportingOwner"):
        rel = o.find("reportingOwnerRelationship")
        title = _t(rel, "officerTitle") if rel is not None else None
        flags = {k: (_t(rel, k) or "").lower() in ("1", "true") for k in ("isDirector", "isOfficer", "isTenPercentOwner", "isOther")} if rel is not None else {}
        owners.append({"name": _t(o, "reportingOwnerId/rptOwnerName"), "cik": _t(o, "reportingOwnerId/rptOwnerCik"), "title": title, **flags})
    plan_flag = (_t(root, "aff10b5One") or "").lower() in ("1", "true")
    footnotes = " ".join((f.text or "") for f in root.findall(".//footnote")).lower()
    txs = []
    for tx in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        code = _t(tx, "transactionCoding/transactionCode")
        shares = _num(_t(tx, "transactionAmounts/transactionShares/value"))
        price = _num(_t(tx, "transactionAmounts/transactionPricePerShare/value"))
        ad = _t(tx, "transactionAmounts/transactionAcquiredDisposedCode/value")
        after = _num(_t(tx, "postTransactionAmounts/sharesOwnedFollowingTransaction/value"))
        direct = _t(tx, "ownershipNature/directOrIndirectOwnership/value")
        kind = TX_CODES.get(code or "", "other")
        txs.append({
            "date": _t(tx, "transactionDate/value"),
            "code": code,
            "type": kind,
            "acquired": ad == "A",
            "shares": shares,
            "price": price,
            "value": round(shares * price, 2) if shares and price else None,
            "owned_after": after,
            "owned_before": (after - shares if ad == "A" else after + shares) if after is not None and shares is not None else None,
            "direct": direct == "D",
            "plan_10b5_1": plan_flag or "10b5-1" in footnotes,
        })
    return {
        "issuer_cik": _t(root, "issuer/issuerCik"),
        "issuer_name": _t(root, "issuer/issuerName"),
        "issuer_ticker": _t(root, "issuer/issuerTradingSymbol"),
        "period": _t(root, "periodOfReport"),
        "owners": owners,
        "transactions": txs,
    }


# ── 13F ──────────────────────────────────────────────────
def parse_13f_table(xml_text: str) -> list[dict]:
    """13F information table → [{cusip, issuer, class, value_usd, shares, put_call}]. Namespaces vary; strip them."""
    xml_text = re.sub(r'\sxmlns(:\w+)?="[^"]*"', "", xml_text)
    xml_text = re.sub(r'\s\w+:\w+="[^"]*"', "", xml_text)  # prefixed attributes such as xsi:schemaLocation
    xml_text = re.sub(r"<(/?)\w+:", r"<\1", xml_text)
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    rows = []
    for it in root.iter("infoTable"):
        sh = it.find("shrsOrPrnAmt")
        rows.append({
            "cusip": (_t(it, "cusip") or "").upper(),
            "issuer": _t(it, "nameOfIssuer"),
            "class": _t(it, "titleOfClass"),
            "value_raw": _num(_t(it, "value")),
            "shares": _num(_t(sh, "sshPrnamt")) if sh is not None else None,
            "share_type": _t(sh, "sshPrnamtType") if sh is not None else None,
            "put_call": _t(it, "putCall"),
        })
    return rows


def thirteenf_value_usd(value_raw: float | None, filing_date: str) -> float | None:
    """13F 'value' was reported in thousands of dollars until filings made on/after 2023-01-03, then whole dollars."""
    if value_raw is None:
        return None
    return value_raw * 1000 if filing_date < "2023-01-03" else value_raw


# ── 8-K items (catalysts) ────────────────────────────────
ITEM_8K = {
    "1.01": ("material_agreement", "Entered a material agreement (e.g. contract, partnership)"),
    "1.02": ("agreement_terminated", "Terminated a material agreement"),
    "1.03": ("bankruptcy", "Bankruptcy or receivership"),
    "2.01": ("acquisition_completed", "Completed an acquisition or disposition"),
    "2.02": ("earnings", "Results of operations (earnings release)"),
    "2.03": ("new_debt", "Created a material financial obligation"),
    "2.05": ("restructuring", "Exit / restructuring costs"),
    "2.06": ("impairment", "Material impairment"),
    "3.01": ("delisting_notice", "Delisting notice or listing-rule failure"),
    "3.02": ("unregistered_sale", "Unregistered sale of equity (possible dilution)"),
    "4.01": ("auditor_change", "Change of auditor"),
    "4.02": ("non_reliance", "Prior financial statements should no longer be relied on"),
    "5.01": ("control_change", "Change in control"),
    "5.02": ("management_change", "Director or officer change"),
    "7.01": ("reg_fd", "Regulation FD disclosure"),
    "8.01": ("other_event", "Other material event"),
}
RED_FLAG_ITEMS = {"1.03", "3.01", "4.02"}
REVIEW_ITEMS = {"4.01", "2.06", "3.02"}
