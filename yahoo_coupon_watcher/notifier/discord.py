"""Discord Webhook への通知。スクリーンショットをそのまま貼れる。"""

from __future__ import annotations

from pathlib import Path

import requests

TIMEOUT = 20


class DiscordNotifier:
    name = "discord"

    def __init__(self, webhook_url: str = "") -> None:
        self.webhook_url = webhook_url

    def send(self, title: str, message: str, image_path: Path | None = None) -> bool:
        content = f"**{title}**\n{message}"[:1900]
        if image_path and Path(image_path).exists():
            with Path(image_path).open("rb") as fh:
                response = requests.post(
                    self.webhook_url,
                    data={"content": content},
                    files={"file": (Path(image_path).name, fh, "image/png")},
                    timeout=TIMEOUT,
                )
        else:
            response = requests.post(
                self.webhook_url, json={"content": content}, timeout=TIMEOUT
            )
        response.raise_for_status()
        return True
