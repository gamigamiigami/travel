"""config.yaml の読み込みとデフォルト値。"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

# .env でも設定できる項目。環境変数のほうが優先される。
# パスワードやトピック名を config.yaml に書かずに済ませるための仕組み。
ENV_OVERRIDES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("NTFY_TOPIC", ("notify", "ntfy", "topic")),
    ("NTFY_SERVER", ("notify", "ntfy", "server")),
    ("DISCORD_WEBHOOK_URL", ("notify", "discord", "webhook_url")),
    ("EMAIL_USERNAME", ("notify", "email", "username")),
    ("EMAIL_PASSWORD", ("notify", "email", "password")),
    ("EMAIL_TO", ("notify", "email", "to_addr")),
    ("EMAIL_SMTP_HOST", ("notify", "email", "smtp_host")),
)

DEFAULTS: dict[str, Any] = {
    "notify": {
        # 複数同時に有効にできる: ntfy / discord / email / windows / console
        "providers": ["ntfy", "windows"],
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
        "windows": {"app_id": "Yahoo Travel Coupon Watcher", "enabled": True},
    },
    "browsers": ["edge", "chrome"],
    "crawl": {
        "headless": False,
        "start_url": "https://travel.yahoo.co.jp/",
        # 毎回かならず見に行くページ。実際にクーポンが出たページを足していくと強い。
        "targets": [{"name": "トップページ", "url": "https://travel.yahoo.co.jp/"}],
        # 各ターゲットから何ページぶんリンクを辿って潜るか [最小, 最大]
        "wander_pages_per_target": [2, 4],
        # 1日あたりの巡回ラウンド上限（アクセスしすぎの歯止め）
        "max_rounds_per_day": 40,
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
        # 何点以上でクーポンとみなすか。ページ全体は厳しく、ポップアップ内は緩く。
        "min_score_page": 7,
        "min_score_popup": 4,
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
    # 検出の有無にかかわらず全チェック結果をCSVに残す。
    # 曜日・時間帯・ブラウザ別の出現率を後から集計するためのデータ。
    "history": {"enabled": True, "file": "history.csv"},
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


def load_dotenv(path: str | Path = ".env") -> dict[str, str]:
    """.env を読んで os.environ に載せる（既存の環境変数は上書きしない）。

    外部ライブラリを足したくないので最小限の実装にしてある。
    KEY=VALUE 形式、# 始まりはコメント、値のクォートは剥がす。
    """
    path = Path(path)
    loaded: dict[str, str] = {}
    if not path.exists():
        return loaded
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        loaded[key] = value
        os.environ.setdefault(key, value)
    return loaded


def _apply_env_overrides(config: dict[str, Any]) -> None:
    for env_name, path in ENV_OVERRIDES:
        value = os.environ.get(env_name)
        if value in (None, ""):
            continue
        node = config
        for part in path[:-1]:
            node = node.setdefault(part, {})
        node[path[-1]] = value


def load_config(path: str | Path = "config.yaml", env_path: str | Path = ".env") -> dict[str, Any]:
    path = Path(path)
    if not path.exists():
        raise ConfigError(
            f"{path} が見つかりません。config.example.yaml をコピーして作成してください。"
        )
    with path.open("r", encoding="utf-8") as fh:
        user_config = yaml.safe_load(fh) or {}
    if not isinstance(user_config, dict):
        raise ConfigError(f"{path} の形式が不正です（トップレベルはマッピングにしてください）。")
    load_dotenv(env_path)
    config = _deep_merge(DEFAULTS, user_config)
    _apply_env_overrides(config)
    _validate(config)
    return config


KNOWN_PROVIDERS = {"ntfy", "discord", "email", "windows", "console"}


def _validate(config: dict[str, Any]) -> None:
    providers = config["notify"].get("providers")
    if not isinstance(providers, list) or not providers:
        raise ConfigError("notify.providers を1つ以上指定してください（例: [ntfy, windows]）。")
    unknown = set(providers) - KNOWN_PROVIDERS
    if unknown:
        raise ConfigError(f"notify.providers に未対応の値があります: {sorted(unknown)}")
    if "ntfy" in providers and not config["notify"]["ntfy"]["topic"]:
        raise ConfigError(
            "ntfy のトピックが未設定です。.env の NTFY_TOPIC か config.yaml に"
            "推測されにくい文字列を設定してください。"
        )
    if "discord" in providers and not config["notify"]["discord"]["webhook_url"]:
        raise ConfigError("Discord の webhook_url が未設定です（.env の DISCORD_WEBHOOK_URL）。")
    if "email" in providers:
        email = config["notify"]["email"]
        for key in ("smtp_host", "username", "password", "to_addr"):
            if not email.get(key):
                raise ConfigError(f"メール通知の {key} が未設定です。")
    targets = config["crawl"].get("targets")
    if not isinstance(targets, list) or not targets:
        raise ConfigError("crawl.targets を1つ以上指定してください。")
    for target in targets:
        if not isinstance(target, dict) or not target.get("url"):
            raise ConfigError(f"crawl.targets の形式が不正です: {target}")
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
