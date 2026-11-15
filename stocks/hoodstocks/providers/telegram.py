"""Telegram delivery through the existing Hood Scanner bot (same token and chat)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
import urllib.request

from ..http import Http


def to_hub(http: Http, text: str, *, kind: str, url: str | None) -> dict | None:
    """Post to the Hood Desk hub (bot Worker), signed with the bot token. Returns {"telegram": bool, ...} or None."""
    hub, token = os.environ.get("HUB_URL", "").strip().rstrip("/"), os.environ.get("TELEGRAM_BOT_TOKEN")
    if not hub or not token:
        return None
    lines = text.split("\n")
    i = next((n for n, l in enumerate(lines) if l.strip()), 0)
    event = {"kind": kind, "source": "stocks", "title": re.sub(r"<[^>]+>", "", lines[i] if lines else "Update").strip() or "Update",
             "body": "\n".join(lines[i + 1:]).lstrip("\n"), "html": True, "url": url}
    raw = json.dumps({"ts": int(time.time() * 1000), "event": event}).encode()
    sig = hmac.new(token.encode(), raw, hashlib.sha256).hexdigest()
    # plain urllib, not the shared client: its per-host stats are written to public health files
    req = urllib.request.Request(f"{hub}/api/event", data=raw, headers={"content-type": "application/json", "x-hub-signature": f"sha256={sig}",
                                                                         "user-agent": "hood-desk-stocks/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}")
    except Exception as e:
        print(f"[hub] send failed: {getattr(e, 'code', type(e).__name__)}")  # never print the URL
        return None


def send(http: Http, text: str, *, buttons: list[list[dict]] | None = None, kind: str = "stocks", url: str | None = None) -> bool:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    hub = to_hub(http, text, kind=kind, url=url)
    if hub and hub.get("telegram") is False:
        return True  # Telegram switched off in Hood Desk; the app has it
    if not token or not chat:
        print("[telegram] not configured — message not sent")
        return bool(hub and hub.get("stored"))
    body = {"chat_id": chat, "text": text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}
    if buttons:
        body["reply_markup"] = {"inline_keyboard": buttons}
    try:
        http.get(f"https://api.telegram.org/bot{token}/sendMessage", data=json.dumps(body).encode())
        return True
    except Exception as e:
        # never print the URL (it contains the token)
        print(f"[telegram] send failed: {getattr(e, 'status', '?')}")
        return False
