"""config.yaml の読み込みとデフォルト値。"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

DEFAULTS: dict[str, Any] = {
    "notify": {
        "provider": "ntfy",
        "also_console": True,
        "ntfy": {
            "server": "https://ntfy.sh",
            "topic": "",
            "priority": 5,
            "attach_screenshot": True,
        },
        "discord": {"webhook_url": ""},
        "email": {
            "smtp_host": "smtp.gmail.com",
            "smtp_port": 465,
            "username": "",
            "password": "",
            "from_addr": "",
            "to_addr": "",
        },
    },
    "browsers": ["edge", "chrome"],
    "crawl": {
        "headless": False,
        "start_url": "https://travel.yahoo.co.jp/",
        "pages_per_round": [4, 8],
        "interval_minutes": [12, 25],
        "page_dwell_seconds": [6, 18],
        "scroll_steps": [2, 5],
        "nav_timeout_seconds": 45,
        "quiet_hours": [1, 7],
        "max_rounds": 0,
        "allowed_host_suffix": "travel.yahoo.co.jp",
        # 予約確定・決済・ログアウトなど、絶対に踏んではいけないURL。
        "blocked_url_patterns": [
            r"/reserve", r"/reservation", r"/booking", r"/payment", r"/order",
            r"/cart", r"/checkout", r"/confirm", r"/settlement",
            r"logout", r"login", r"signin", r"account", r"mypage",
            r"edit\.yahoo", r"login\.yahoo", r"accounts\.yahoo",
            r"/review/(post|write)", r"/inquiry", r"/contact", r"/cancel",
        ],
        # 「宿を具体的に調べる」動きを再現するため、この形のリンクを優先的に選ぶ。
        "preferred_url_patterns": [
            r"/dp/", r"/hotel", r"/domestic", r"/area", r"/search", r"/onsen",
            r"/theme", r"/ranking",
        ],
    },
    "detect": {
        "min_amount": 1000,
        "max_amount": 100000,
        "amounts_whitelist": [],
        "auto_claim": True,
        "claim_button_texts": [
            "クーポンを獲得", "獲得する", "クーポンをもらう", "受け取る",
            "クーポンをゲット", "ゲットする", "今すぐ獲得",
        ],
        "ignore_patterns": [],
        "dedupe_minutes": 180,
        "screenshot": True,
        # クーポンAPIのレスポンス(JSON)も覗くかどうか。DOMが変わっても拾えるので既定でON。
        "network_scan": True,
    },
    "paths": {
        "profiles_dir": "profiles",
        "data_dir": "data",
        "logs_dir": "logs",
    },
}


class ConfigError(RuntimeError):
    pass


def _deep_merge(base: dict, override: dict) -> dict:
    merged = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(path: str | Path = "config.yaml") -> dict[str, Any]:
    path = Path(path)
    if not path.exists():
        raise ConfigError(
            f"{path} が見つかりません。config.example.yaml をコピーして作成してください。"
        )
    with path.open("r", encoding="utf-8") as fh:
        user_config = yaml.safe_load(fh) or {}
    if not isinstance(user_config, dict):
        raise ConfigError(f"{path} の形式が不正です（トップレベルはマッピングにしてください）。")
    config = _deep_merge(DEFAULTS, user_config)
    _validate(config)
    return config


def _validate(config: dict[str, Any]) -> None:
    provider = config["notify"]["provider"]
    if provider not in {"ntfy", "discord", "email", "console"}:
        raise ConfigError(f"notify.provider が不正です: {provider}")
    if provider == "ntfy" and not config["notify"]["ntfy"]["topic"]:
        raise ConfigError("notify.ntfy.topic を設定してください（推測されにくい文字列にすること）。")
    if provider == "discord" and not config["notify"]["discord"]["webhook_url"]:
        raise ConfigError("notify.discord.webhook_url を設定してください。")
    if provider == "email":
        email = config["notify"]["email"]
        for key in ("smtp_host", "username", "password", "to_addr"):
            if not email.get(key):
                raise ConfigError(f"notify.email.{key} を設定してください。")
    unknown = set(config["browsers"]) - {"edge", "chrome"}
    if unknown:
        raise ConfigError(f"browsers に未対応の値があります: {sorted(unknown)}")
    if not config["browsers"]:
        raise ConfigError("browsers が空です。edge / chrome のいずれかを指定してください。")


def rand_range(value: Any) -> tuple[float, float]:
    """[min, max] または単一の数値を (min, max) に正規化する。"""
    if isinstance(value, (list, tuple)):
        if len(value) != 2:
            raise ConfigError(f"範囲指定は [最小, 最大] の2要素にしてください: {value}")
        lo, hi = float(value[0]), float(value[1])
        return (lo, hi) if lo <= hi else (hi, lo)
    return (float(value), float(value))
