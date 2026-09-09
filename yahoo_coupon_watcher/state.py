"""通知済みクーポンを覚えておき、同じものを何度も通知しないようにする。"""

from __future__ import annotations

import json
import time
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
