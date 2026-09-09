"""通知プロバイダ。複数を同時に有効にできる（例: スマホ通知＋Windowsトースト）。"""

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
    """有効なプロバイダ全部に投げる。1つ失敗しても他は送る。"""

    name = "multi"

    def __init__(self, notifiers: list[Notifier]) -> None:
        self.notifiers = notifiers

    def send(self, title: str, message: str, image_path: Path | None = None) -> bool:
        delivered = False
        for notifier in self.notifiers:
            try:
                if notifier.send(title, message, image_path):
                    delivered = True
            except Exception:  # 通知の失敗で巡回まで止めない
                log.exception("通知に失敗しました: %s", getattr(notifier, "name", "?"))
        return delivered


def _build_one(provider: str, notify_config: dict[str, Any]) -> Notifier:
    if provider == "ntfy":
        from .ntfy import NtfyNotifier

        return NtfyNotifier(**notify_config["ntfy"])
    if provider == "discord":
        from .discord import DiscordNotifier

        return DiscordNotifier(**notify_config["discord"])
    if provider == "email":
        from .email_smtp import EmailNotifier

        return EmailNotifier(**notify_config["email"])
    if provider == "windows":
        from .windows_toast import WindowsToastNotifier

        return WindowsToastNotifier(**notify_config.get("windows", {}))
    if provider == "console":
        return ConsoleNotifier()
    raise ValueError(f"未対応の通知プロバイダです: {provider}")


def build_notifier(notify_config: dict[str, Any]) -> Notifier:
    providers = list(notify_config.get("providers") or [])
    if notify_config.get("also_console", True) and "console" not in providers:
        providers.append("console")
    notifiers = [_build_one(name, notify_config) for name in providers]
    if not notifiers:
        notifiers = [ConsoleNotifier()]
    return notifiers[0] if len(notifiers) == 1 else MultiNotifier(notifiers)
