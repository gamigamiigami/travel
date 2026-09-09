"""ntfy.sh への通知。

アカウント登録が要らず、スマホにアプリを入れてトピック名を購読するだけで届く。
トピック名は事実上のパスワードなので、推測されにくい文字列にすること。
"""

from __future__ import annotations

import logging
from pathlib import Path

import requests

log = logging.getLogger(__name__)

TIMEOUT = 15


class NtfyNotifier:
    name = "ntfy"

    def __init__(
        self,
        server: str = "https://ntfy.sh",
        topic: str = "",
        priority: int = 5,
        attach_screenshot: bool = True,
    ) -> None:
        self.server = server.rstrip("/")
        self.topic = topic
        self.priority = int(priority)
        self.attach_screenshot = bool(attach_screenshot)

    def send(self, title: str, message: str, image_path: Path | None = None) -> bool:
        # ヘッダはASCIIしか通らないので、日本語を含む本文はJSON APIで送る。
        payload = {
            "topic": self.topic,
            "title": title,
            "message": message,
            "priority": self.priority,
            "tags": ["tickets"],
            "click": "https://travel.yahoo.co.jp/",
        }
        response = requests.post(self.server, json=payload, timeout=TIMEOUT)
        response.raise_for_status()

        if self.attach_screenshot and image_path and Path(image_path).exists():
            self._put_image(Path(image_path))
        return True

    def _put_image(self, image_path: Path) -> None:
        try:
            with image_path.open("rb") as fh:
                response = requests.put(
                    f"{self.server}/{self.topic}",
                    data=fh,
                    headers={
                        "Filename": image_path.name,
                        "Title": "screenshot",
                        "Priority": "min",
                    },
                    timeout=TIMEOUT * 2,
                )
            response.raise_for_status()
        except Exception:
            log.warning("スクリーンショットの添付に失敗しました（本文は送信済み）", exc_info=True)
