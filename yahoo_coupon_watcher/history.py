"""全チェック結果をCSVに残し、出現傾向を集計する。

検出したときだけでなく「見なかったこと」も記録するのが肝。分母が無いと
出現率が出せず、「Edgeのほうが出やすい」といった噂を検証できない。
"""

from __future__ import annotations

import csv
import logging
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence

log = logging.getLogger(__name__)

FIELDS = (
    "timestamp", "date", "weekday", "hour",
    "browser", "target", "url",
    "detected", "amount", "score", "reasons",
)

WEEKDAY_JA = ("月", "火", "水", "木", "金", "土", "日")


@dataclass(frozen=True)
class Row:
    timestamp: str
    date: str
    weekday: str
    hour: int
    browser: str
    target: str
    url: str
    detected: bool
    amount: int | None
    score: int
    reasons: str


class HistoryLog:
    def __init__(self, path: str | Path, enabled: bool = True) -> None:
        self.path = Path(path)
        self.enabled = enabled

    def record(
        self,
        *,
        browser: str,
        target: str,
        url: str,
        detected: bool,
        amount: int | None = None,
        score: int = 0,
        reasons: Sequence[str] = (),
        now: datetime | None = None,
    ) -> None:
        if not self.enabled:
            return
        now = now or datetime.now()
        row = {
            "timestamp": now.isoformat(timespec="seconds"),
            "date": now.strftime("%Y-%m-%d"),
            "weekday": WEEKDAY_JA[now.weekday()],
            "hour": now.hour,
            "browser": browser,
            "target": target,
            "url": url,
            "detected": int(bool(detected)),
            "amount": amount if amount is not None else "",
            "score": score,
            "reasons": "・".join(reasons),
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            is_new = not self.path.exists()
            with self.path.open("a", encoding="utf-8-sig", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=FIELDS)
                if is_new:
                    writer.writeheader()
                writer.writerow(row)
        except OSError:
            log.warning("履歴CSVの書き込みに失敗しました: %s", self.path, exc_info=True)


def read_rows(path: str | Path) -> list[Row]:
    path = Path(path)
    if not path.exists():
        return []
    rows: list[Row] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for raw in csv.DictReader(fh):
            try:
                amount = int(raw["amount"]) if raw.get("amount") else None
            except ValueError:
                amount = None
            try:
                hour = int(raw.get("hour") or 0)
                score = int(raw.get("score") or 0)
            except ValueError:
                hour, score = 0, 0
            rows.append(
                Row(
                    timestamp=raw.get("timestamp", ""),
                    date=raw.get("date", ""),
                    weekday=raw.get("weekday", ""),
                    hour=hour,
                    browser=raw.get("browser", ""),
                    target=raw.get("target", ""),
                    url=raw.get("url", ""),
                    detected=str(raw.get("detected", "0")).strip() in {"1", "True", "true"},
                    amount=amount,
                    score=score,
                    reasons=raw.get("reasons", ""),
                )
            )
    return rows


def summarize(rows: Iterable[Row], key: str) -> list[tuple[str, int, int, float]]:
    """(区分, チェック回数, 検出回数, 出現率%) を出現率の高い順で返す。"""
    checks: dict[str, int] = defaultdict(int)
    hits: dict[str, int] = defaultdict(int)
    for row in rows:
        bucket = _bucket(row, key)
        checks[bucket] += 1
        if row.detected:
            hits[bucket] += 1
    result = [
        (bucket, checks[bucket], hits[bucket], 100.0 * hits[bucket] / checks[bucket])
        for bucket in checks
    ]
    return sorted(result, key=lambda item: (-item[3], item[0]))


def _bucket(row: Row, key: str) -> str:
    if key == "hour":
        return f"{row.hour:02d}時台"
    if key == "weekday":
        return row.weekday
    if key == "browser":
        return row.browser
    if key == "target":
        return row.target
    if key == "amount":
        return f"{row.amount:,}円" if row.amount else "（金額不明）"
    raise ValueError(f"未対応の集計軸です: {key}")


def amount_counts(rows: Iterable[Row]) -> list[tuple[int, int]]:
    counts: dict[int, int] = defaultdict(int)
    for row in rows:
        if row.detected and row.amount:
            counts[row.amount] += 1
    return sorted(counts.items(), key=lambda item: -item[1])


def display_width(text: str) -> int:
    """全角を2桁として数える。表の桁をそろえるため。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "FWA" else 1 for ch in text)


def pad(text: str, width: int) -> str:
    return text + " " * max(0, width - display_width(text))


def format_report(rows: Sequence[Row]) -> str:
    if not rows:
        return "履歴がまだありません。しばらく run を回してから見てください。"

    total = len(rows)
    detected = sum(1 for row in rows if row.detected)
    days = len({row.date for row in rows if row.date})
    lines = [
        "===== スペシャルクーポン出現傾向 =====",
        f"集計期間      : {rows[0].date} 〜 {rows[-1].date} ({days}日)",
        f"総チェック回数: {total:,}",
        f"検出回数      : {detected:,} ({100.0 * detected / total:.2f}%)",
    ]

    for key, label in (
        ("browser", "ブラウザ別"),
        ("weekday", "曜日別"),
        ("hour", "時間帯別"),
        ("target", "ページ別"),
    ):
        lines.append("")
        lines.append(f"-- {label} --")
        lines.append(f"  {pad('区分', 16)}{'チェック':>6}{'検出':>7}{'出現率':>10}")
        for bucket, checks, hits, rate in summarize(rows, key):
            lines.append(f"  {pad(bucket, 16)}{checks:>8,}{hits:>8,}{rate:>9.2f}%")

    counts = amount_counts(rows)
    if counts:
        lines.append("")
        lines.append("-- 金額別の検出回数 --")
        for amount, count in counts:
            lines.append(f"  {amount:>7,}円 : {count:,}回")

    lines.append("")
    if detected == 0:
        lines.append("※ まだ検出ゼロです。スペシャルクーポンは抽選なので、"
                     "数日〜数週間ぶんのデータが貯まってから見るのが現実的です。")
    elif detected < 30:
        lines.append(f"※ 検出がまだ {detected} 件しかありません。この段階の差は"
                     "ほぼ偶然の範囲です。30件を超えたあたりから傾向として読めます。")
    return "\n".join(lines)
