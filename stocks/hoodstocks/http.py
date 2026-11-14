"""One HTTP client for every provider: per-host throttling, retries with exponential backoff,
a circuit breaker, an optional disk cache, and health stats the dashboard shows."""
from __future__ import annotations

import gzip
import hashlib
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from . import config


class FetchError(Exception):
    def __init__(self, url: str, status: int, msg: str = ""):
        super().__init__(f"{status} {url} {msg}".strip())
        self.url, self.status = url, status


@dataclass
class HostStats:
    calls: int = 0
    ok: int = 0
    errors: int = 0
    retries: int = 0
    r429: int = 0
    seconds: float = 0.0
    cache_hits: int = 0
    last_error: str | None = None
    consecutive_fail: int = 0
    open_until: float = 0.0  # circuit breaker


@dataclass
class Http:
    timeout: float = 30.0
    max_retries: int = 4
    stats: dict[str, HostStats] = field(default_factory=dict)
    _last: dict[str, float] = field(default_factory=dict)
    cache_dir: Path | None = None
    transport: object | None = None  # tests inject a fake: callable(url, headers, data) -> (status, bytes)

    def _host(self, url: str) -> str:
        return urllib.parse.urlparse(url).netloc

    def _wait(self, host: str):
        rate = config.RATE.get(host, 2.0)
        gap = 1.0 / rate
        last = self._last.get(host, 0.0)
        now = time.monotonic()
        if now - last < gap:
            time.sleep(gap - (now - last))
        self._last[host] = time.monotonic()

    def _cache_path(self, url: str, data: bytes | None) -> Path | None:
        if not self.cache_dir:
            return None
        h = hashlib.sha1(url.encode() + (data or b"")).hexdigest()
        return self.cache_dir / h[:2] / f"{h}.gz"

    def get(self, url: str, *, ua: str | None = None, accept: str = "application/json", data: bytes | None = None,
            headers: dict | None = None, cache_hours: float | None = None) -> bytes:
        host = self._host(url)
        st = self.stats.setdefault(host, HostStats())
        cp = self._cache_path(url, data) if cache_hours else None
        if cp and cp.exists() and (time.time() - cp.stat().st_mtime) < cache_hours * 3600:
            st.cache_hits += 1
            return gzip.decompress(cp.read_bytes())
        if st.open_until > time.monotonic():
            raise FetchError(url, 0, "circuit open (host failing)")
        if ua is None:
            ua = config.SEC_USER_AGENT if host.endswith("sec.gov") else config.BROWSER_UA
        h = {"User-Agent": ua, "Accept": accept, "Accept-Encoding": "gzip"}
        if data is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        err: FetchError | None = None
        for attempt in range(self.max_retries + 1):
            self._wait(host)
            st.calls += 1
            t0 = time.monotonic()
            try:
                status, body = self._send(url, h, data)
            except Exception as e:  # network error
                status, body = 0, str(e).encode()
            st.seconds += time.monotonic() - t0
            if status == 200:
                st.ok += 1
                st.consecutive_fail = 0
                if cp:
                    cp.parent.mkdir(parents=True, exist_ok=True)
                    cp.write_bytes(gzip.compress(body))
                return body
            if status == 404:
                st.errors += 1
                raise FetchError(url, 404)
            if status == 429:
                st.r429 += 1
            err = FetchError(url, status, body[:120].decode("utf-8", "replace"))
            if status in (400, 401, 403) and attempt >= 1:
                break  # won't fix itself
            st.retries += 1
            time.sleep(min(60, (2 ** attempt) * (3 if status == 429 else 1)) + random.random())
        st.errors += 1
        st.consecutive_fail += 1
        st.last_error = str(err)[:200]
        if st.consecutive_fail >= 5:
            st.open_until = time.monotonic() + 300
        raise err  # type: ignore[misc]

    def _send(self, url, headers, data):
        if self.transport:
            return self.transport(url, headers, data)
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return r.status, body
        except urllib.error.HTTPError as e:
            return e.code, e.read()[:500]

    def json(self, url: str, **kw):
        return json.loads(self.get(url, **kw))

    def health(self) -> dict:
        return {h: {k: (round(v, 1) if isinstance(v, float) else v) for k, v in vars(s).items() if k != "open_until"} for h, s in self.stats.items()}
