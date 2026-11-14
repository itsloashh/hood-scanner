"""Google News RSS — discovery only. We keep headline, link, outlet and time; never article text."""
from __future__ import annotations

import hashlib
import re
import urllib.parse
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

from ..http import Http

TRUSTED = {"Reuters", "Bloomberg", "CNBC", "Financial Times", "The Wall Street Journal", "WSJ", "Barron's", "MarketWatch",
           "The Globe and Mail", "Financial Post", "Associated Press", "AP News", "Business Wire", "PR Newswire", "GlobeNewswire",
           "Yahoo Finance", "Investor's Business Daily", "Forbes", "Morningstar", "BNN Bloomberg", "CBC News", "Axios", "The Motley Fool"}
PRESS = {"Business Wire", "PR Newswire", "GlobeNewswire", "Newsfile", "ACCESSWIRE"}


def norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()


def headlines(http: Http, query: str, days: int = 14) -> list[dict]:
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": f"{query} when:{days}d", "hl": "en-US", "gl": "US", "ceid": "US:en"})
    xml = http.get(url, accept="application/rss+xml,*/*", cache_hours=2).decode("utf-8", "replace")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out, seen = [], set()
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        src = (it.findtext("source") or "").strip()
        if src and title.endswith(f" - {src}"):
            title = title[: -len(src) - 3]
        key = norm_title(title)[:90]
        if not title or key in seen:
            continue  # same story from several outlets counts once
        seen.add(key)
        try:
            pub = parsedate_to_datetime(it.findtext("pubDate")).isoformat()
        except Exception:
            pub = None
        out.append({
            "id": hashlib.sha1(key.encode()).hexdigest()[:12],
            "headline": title,
            "outlet": src,
            "url": it.findtext("link"),
            "published": pub,
            "trusted": src in TRUSTED,
            "press_release": src in PRESS,
        })
    return out
