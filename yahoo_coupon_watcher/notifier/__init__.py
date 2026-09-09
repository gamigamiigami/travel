"""通知プロバイダ。設定に応じて ntfy / Discord / メール / コンソール を切り替える。"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)


class Notifier(Protocol):
    name: str

    def send(self, title: str, message: str, image_path: Path | None = None) -> bool:
        ...


class ConsoleNotifier:
    name = "console"

    def send(self, title: str, message: str, image_path: Path | None = None) -> bool:
        extra = f"\n(スクリーンショット: {image_path})" if image_path else ""
        log.warning("=== 通知 ===\n%s\n%s%s", title, message, extra)
        return True


class MultiNotifier:
    """本命の1つに加えて、必要ならコンソールにも出す。"""

    name = "multi"

    def __init__(self, notifiers: list[Notifier]) -> None:
        self.notifiers = notifiers

    def send(self, title: str, message: str, image_path: Path | None = None) -> bool:
        ok = False
        for notifier in self.notifiers:
            try:
                ok = notifier.send(title, message, image_path) or ok
            except Exception:  # 通知の失敗で巡回まで止めない
                log.exception("通知に失敗しました: %s", getattr(notifier, "name", "?"))
        return ok


def build_notifier(notify_config: dict[str, Any]) -> Notifier:
    provider = notify_config.get("provider", "console")
    notifiers: list[Notifier] = []

    if provider == "ntfy":
        from .ntfy import NtfyNotifier

        notifiers.append(NtfyNotifier(**notify_config["ntfy"]))
    elif provider == "discord":
        from .discord import DiscordNotifier

        notifiers.append(DiscordNotifier(**notify_config["discord"]))
    elif provider == "email":
        from .email_smtp import EmailNotifier

        notifiers.append(EmailNotifier(**notify_config["email"]))

    if provider == "console" or notify_config.get("also_console", True):
        notifiers.append(ConsoleNotifier())

    return notifiers[0] if len(notifiers) == 1 else MultiNotifier(notifiers)
