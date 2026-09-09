"""通知済みクーポンの記憶と、1日あたりの巡回回数の管理。"""

from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path


class NotifyState:
    def __init__(self, path: str | Path, dedupe_seconds: float) -> None:
        self.path = Path(path)
        self.dedupe_seconds = float(dedupe_seconds)
        self._seen: dict[str, float] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        if isinstance(raw, dict):
            self._seen = {
                str(k): float(v) for k, v in raw.items() if isinstance(v, (int, float))
            }

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._seen, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def prune(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self._seen = {
            key: ts for key, ts in self._seen.items() if now - ts < self.dedupe_seconds
        }

    def should_notify(self, signature: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        last = self._seen.get(signature)
        return last is None or (now - last) >= self.dedupe_seconds

    def mark_notified(self, signature: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self._seen[signature] = now
        self.prune(now)
        self._save()


class DailyCounter:
    """1日あたりの巡回回数を数える。アクセスしすぎの歯止め。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._date = ""
        self._count = 0
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            self._date = str(raw.get("date", ""))
            self._count = int(raw.get("count", 0))
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            self._date, self._count = "", 0

    def _today(self, now: float | None = None) -> str:
        return datetime.fromtimestamp(time.time() if now is None else now).strftime("%Y-%m-%d")

    def count_today(self, now: float | None = None) -> int:
        return self._count if self._date == self._today(now) else 0

    def remaining(self, limit: int, now: float | None = None) -> int:
        if limit <= 0:
            return 1 << 30  # 上限なし
        return max(0, limit - self.count_today(now))

    def increment(self, now: float | None = None) -> int:
        today = self._today(now)
        if self._date != today:
            self._date, self._count = today, 0
        self._count += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({"date": self._date, "count": self._count}), encoding="utf-8"
        )
        return self._count
