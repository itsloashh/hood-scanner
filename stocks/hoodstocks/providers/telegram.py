"""Telegram delivery through the existing Hood Scanner bot (same token and chat)."""
from __future__ import annotations

import json
import os

from ..http import Http


def send(http: Http, text: str, *, buttons: list[list[dict]] | None = None) -> bool:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("[telegram] not configured — message not sent")
        return False
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
