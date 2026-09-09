"""Yahoo!トラベルのスペシャルクーポンを検出するロジック。

実際のDOM構造は公開されておらず、しかも頻繁に変わる。なので単一のCSSセレクタに
賭けるのではなく、次の3層で拾う:

1. ネットワーク層 ... クーポン関連のXHR/fetchレスポンス(JSON)を覗く
2. ポップアップ層 ... dialog/modal/クーポンらしきコンテナのテキスト
3. ページ全体層 ... body全体のテキスト（誤検知を避けるため強キーワード必須）

このモジュールはブラウザに依存しない純粋な関数だけを持つ。テストしやすくするため。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

# 「これが出ていればほぼクーポンの話」と言える強いキーワード。
# ページ全体テキストを見るときはこれを必須にして誤検知を潰す。
STRONG_KEYWORDS: tuple[str, ...] = (
    "スペシャルクーポン",
    "限定クーポン",
    "クーポンを獲得",
    "クーポン獲得",
    "クーポンをゲット",
    "クーポンをもらう",
    "クーポンを受け取",
    "クーポンプレゼント",
    "クーポンが当たり",
    "クーポンをプレゼント",
    "あなただけのクーポン",
    "タイムセールクーポン",
    "割引クーポン",
    "クーポンが届",
    "クーポンを配布",
    "クーポン当選",
    "クーポンを進呈",
)

# ポップアップの中だけを見るときに許す弱いキーワード。
WEAK_KEYWORDS: tuple[str, ...] = STRONG_KEYWORDS + ("クーポン", "coupon", "COUPON")

# 「5,000円OFF」「5000円割引」「５０００円オフ」などを拾う。
_AMOUNT_OFF = re.compile(
    r"([0-9０-９][0-9０-９,，、]{0,9})\s*円\s*(?:分\s*)?(?:OFF|off|Off|ＯＦＦ|オフ|割引|引き|引)",
)
# 「1,000円分」形式。クーポンのポップアップはこの書き方をする。
_AMOUNT_YEN_BUN = re.compile(r"([0-9０-９][0-9０-９,，、]{0,9})\s*円\s*分")
# 「¥5,000 OFF」のように円記号で書かれる場合
_AMOUNT_YEN_MARK = re.compile(
    r"(?:¥|￥)\s*([0-9０-９][0-9０-９,，、]{0,9})\s*(?:OFF|off|Off|ＯＦＦ|オフ|割引|引き|引)?",
)
# 「OFF」等が付かない「5,000円クーポン」形式も拾う。
_AMOUNT_COUPON = re.compile(
    r"([0-9０-９][0-9０-９,，、]{0,9})\s*円\s*(?:分\s*)?(?:の\s*)?クーポン",
)
# 「180分限定」「残り60分」などの有効時間。
# スペシャルクーポンの有効時間は 60分 / 90分 / 180分 の3種が確認されている。
# 180分だけを決め打ちすると残り2種を取りこぼすので、分表記全般を拾う。
_TIME_LIMIT = re.compile(r"(?:残り|あと|以内|限定)?\s*([0-9]{1,4})\s*分\s*(?:限定|以内|間)?")

# 検出の「確からしさ」を点数化する。何点で通知するかは設定で変えられる。
# 通知には根拠も載せるので、誤検出したときに何が効いたのかがすぐ分かる。
SCORE_RULES: tuple[tuple[str, int, str], ...] = (
    (r"スペシャルクーポン", 5, "スペシャルクーポン"),
    (
        r"限定クーポン|あなただけのクーポン|クーポンプレゼント|クーポンをプレゼント"
        r"|割引クーポン|クーポンが届|クーポン当選",
        4,
        "限定クーポン",
    ),
    (r"クーポンを?(?:獲得|ゲット|もらう|受け取)", 3, "獲得ボタン"),
    (r"時間限定|期間限定|今だけ", 3, "時間限定"),
    (r"クーポン", 1, "クーポン表記"),
)
SCORE_TIME_LIMIT = 4      # 60分/90分/180分などの残り時間表記があれば加点
SCORE_AMOUNT_BUN = 2      # 「1,000円分」はクーポンのパネル特有の書き方
SCORE_AMOUNT_OFF = 2      # 「◯◯円OFF」形式の金額表記があれば加点
SCORE_COUPON_CODE = 2     # クーポンコードらしき英数字があれば加点
# クーポンコードらしき英数字（8桁が多いと言われている）。
_CODE = re.compile(r"\b([A-Z0-9]{6,16})\b")

_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")

# JSONを再帰探索するときに「クーポンっぽい」と判断するキー名。
_COUPON_KEY = re.compile(r"coupon|クーポン|discount|割引", re.IGNORECASE)
_CODE_KEY = re.compile(r"code|couponid|coupon_id|couponno", re.IGNORECASE)
_AMOUNT_KEY = re.compile(
    r"discount|amount|price|value|off|yen|金額|割引額", re.IGNORECASE
)


@dataclass(frozen=True)
class CouponHit:
    """検出したクーポン1件。

    amount は None になりうる。畳まれた状態のクーポンバッジには「残155分」と
    しか書かれておらず、金額は開くまで画面に出てこないため。金額が分からなくても
    「クーポンが出ている」ことは分かるので、見逃すより先に知らせる。
    """

    amount: int | None
    source: str  # "network" | "popup" | "page"
    snippet: str
    code: str | None = None
    time_limit_min: int | None = None
    url: str | None = None
    browser: str | None = None
    score: int = 0
    reasons: tuple[str, ...] = ()
    frame_url: str | None = None
    target: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def signature(self) -> str:
        """重複通知を抑えるためのキー。同じクーポンは何度も通知しない。

        コードは含めない。同じクーポンでもポップアップからは取れてページ全体からは
        取れない、ということが起きるため、含めると同じものを2回通知してしまう。
        """
        if self.amount is None:
            return f"{self.browser or '-'}|badge"
        return f"{self.browser or '-'}|{self.amount}"

    def title(self) -> str:
        who = f"[{self.browser}] " if self.browser else ""
        if self.amount is None:
            remaining = f"（残{self.time_limit_min}分）" if self.time_limit_min else ""
            return f"{who}🎫 クーポンが出ています！{remaining}"
        return f"{who}🎫 {self.amount:,}円OFFクーポン出現！"

    def body(self) -> str:
        lines = [
            "金額: 画面にまだ出ていません（バッジを開くと分かります）"
            if self.amount is None
            else f"金額: {self.amount:,}円OFF"
        ]
        if self.code:
            lines.append(f"コード: {self.code}")
        if self.time_limit_min:
            lines.append(f"有効時間: 約{self.time_limit_min}分")
        if self.target:
            lines.append(f"ページ: {self.target}")
        lines.append(f"検出元: {self.source} (score={self.score})")
        if self.reasons:
            lines.append(f"根拠: {'・'.join(self.reasons)}")
        if self.url:
            lines.append(f"URL: {self.url}")
        snippet = re.sub(r"\s+", " ", self.snippet).strip()
        if snippet:
            lines.append(f"---\n{snippet[:300]}")
        return "\n".join(lines)


def _to_int(raw: str) -> int | None:
    normalized = raw.translate(_FULLWIDTH_DIGITS)
    normalized = re.sub(r"[,，、]", "", normalized)
    if not normalized.isdigit():
        return None
    try:
        return int(normalized)
    except ValueError:
        return None


def _keyword_spans(text: str, keywords: Iterable[str]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    lowered = text.lower()
    for kw in keywords:
        start = 0
        needle = kw.lower()
        while True:
            idx = lowered.find(needle, start)
            if idx < 0:
                break
            spans.append((idx, idx + len(needle)))
            start = idx + 1
    return spans


def score_text(text: str) -> tuple[int, tuple[str, ...]]:
    """テキストがどれくらいクーポンらしいかを点数と根拠で返す。"""
    score = 0
    reasons: list[str] = []
    for pattern, points, label in SCORE_RULES:
        if re.search(pattern, text):
            score += points
            reasons.append(label)
    limit = _find_time_limit(text)
    if limit is not None:
        score += SCORE_TIME_LIMIT
        reasons.append(f"{limit}分限定")
    if _AMOUNT_OFF.search(text):
        score += SCORE_AMOUNT_OFF
        reasons.append("円OFF表記")
    if _AMOUNT_YEN_BUN.search(text):
        score += SCORE_AMOUNT_BUN
        reasons.append("円分表記")
    if _find_code(text):
        score += SCORE_COUPON_CODE
        reasons.append("クーポンコード")
    return score, tuple(reasons)


def _nearby(spans: Sequence[tuple[int, int]], pos: int, window: int) -> bool:
    return any(pos >= s - window and pos <= e + window for s, e in spans)


def scan_text(
    text: str,
    *,
    strict: bool = True,
    min_amount: int = 1000,
    max_amount: int = 100_000,
    amounts_whitelist: Sequence[int] = (),
    ignore_patterns: Sequence[str] = (),
    window: int = 160,
    min_score: int = 0,
    source: str = "page",
    url: str | None = None,
    browser: str | None = None,
    frame_url: str | None = None,
    target: str | None = None,
) -> list[CouponHit]:
    """テキストからクーポンを探す。

    2つの関門を両方通ったものだけをクーポンとみなす。

      1. 金額がクーポン系キーワードの近く(±window文字)にあること
         （宿の価格を「クーポン額」と誤認しないため）
      2. 周辺テキストのスコアが min_score 以上であること
         （どれくらいクーポンらしいかの総合判定）

    strict=True は STRONG_KEYWORDS のみを近接判定に使う。ページ全体を舐めるときは
    strict=True + 高めの min_score、ポップアップの中だけを見るときは strict=False +
    低めの min_score で呼ぶ想定。
    """
    if not text:
        return []

    for pattern in ignore_patterns:
        try:
            if re.search(pattern, text):
                return []
        except re.error:
            continue

    keywords = STRONG_KEYWORDS if strict else WEAK_KEYWORDS
    spans = _keyword_spans(text, keywords)
    if not spans:
        return []

    whitelist = set(amounts_whitelist)
    hits: dict[str, CouponHit] = {}

    for regex, needs_keyword in (
        (_AMOUNT_OFF, True),
        (_AMOUNT_YEN_BUN, True),
        (_AMOUNT_YEN_MARK, True),
        (_AMOUNT_COUPON, False),
    ):
        for match in regex.finditer(text):
            amount = _to_int(match.group(1))
            if amount is None:
                continue
            if whitelist:
                if amount not in whitelist:
                    continue
            elif not (min_amount <= amount <= max_amount):
                continue
            # 「5,000円クーポン」形式は文言自体がクーポンを名指ししているので
            # 近接判定を緩める。それ以外はキーワードの近くにあることを要求する。
            if needs_keyword and not _nearby(spans, match.start(), window):
                continue

            lo = max(0, match.start() - window)
            hi = min(len(text), match.end() + window)
            snippet = text[lo:hi]

            score, reasons = score_text(snippet)
            if score < min_score:
                continue

            hit = CouponHit(
                amount=amount,
                source=source,
                snippet=snippet,
                code=_find_code(snippet),
                time_limit_min=_find_time_limit(snippet),
                url=url,
                browser=browser,
                score=score,
                reasons=reasons,
                frame_url=frame_url,
                target=target,
            )
            # 同じ金額で複数ヒットしたら、根拠が強い方を残す。
            prev = hits.get(str(amount))
            if prev is None or _better(hit, prev):
                hits[str(amount)] = hit

    return sorted(hits.values(), key=lambda h: (h.amount or 0), reverse=True)


def _better(candidate: CouponHit, current: CouponHit) -> bool:
    """より信用できるヒットか。スコア優先、同点ならコードが取れている方。"""
    if candidate.score != current.score:
        return candidate.score > current.score
    return current.code is None and candidate.code is not None


def _find_code(snippet: str) -> str | None:
    for match in _CODE.finditer(snippet):
        candidate = match.group(1)
        # 「5000」のような純粋な数字や、OFF/COUPONといった単語自体は除外。
        if candidate.isdigit():
            continue
        if candidate in {"COUPON", "SPECIAL", "YAHOO", "TRAVEL", "OFF"}:
            continue
        if not any(ch.isdigit() for ch in candidate):
            continue
        return candidate
    return None


def _find_time_limit(snippet: str) -> int | None:
    best: int | None = None
    for match in _TIME_LIMIT.finditer(snippet):
        value = _to_int(match.group(1))
        if value is None or not (1 <= value <= 1440):
            continue
        if best is None or value > best:
            best = value
    return best


def _walk_json(node: Any, depth: int = 0):
    """JSONを再帰的に歩いて (キー, 値) を吐く。"""
    if depth > 12:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            yield key, value
            yield from _walk_json(value, depth + 1)
    elif isinstance(node, list):
        for value in node[:200]:
            yield from _walk_json(value, depth + 1)


def scan_json(
    payload: Any,
    *,
    url: str | None = None,
    browser: str | None = None,
    min_amount: int = 1000,
    max_amount: int = 100_000,
    amounts_whitelist: Sequence[int] = (),
) -> list[CouponHit]:
    """APIレスポンス(JSON)からクーポンを探す。

    キー名は公開されていないので決め打ちできない。「クーポン」を名前に含む
    オブジェクトを拾い、その中の金額らしき数値とコードらしき文字列を取る。
    それでも取れなければJSONを文字列化してテキスト検出にかける。
    """
    whitelist = set(amounts_whitelist)
    hits: dict[str, CouponHit] = {}

    for key, value in _walk_json(payload):
        if not _COUPON_KEY.search(str(key)):
            continue
        containers = value if isinstance(value, list) else [value]
        for container in containers:
            if not isinstance(container, dict):
                continue
            amount = _extract_amount(container)
            if amount is None:
                continue
            if whitelist:
                if amount not in whitelist:
                    continue
            elif not (min_amount <= amount <= max_amount):
                continue
            code = _extract_code(container)
            snippet = json.dumps(container, ensure_ascii=False)[:400]
            score, reasons = score_text(snippet)
            # APIレスポンスにクーポン用のキーがある時点で確度が高いので下駄を履かせる。
            score += 3
            reasons = reasons + ("クーポンAPI",)
            hit = CouponHit(
                amount=amount,
                source="network",
                snippet=snippet,
                code=code,
                time_limit_min=None,
                url=url,
                browser=browser,
                score=score,
                reasons=reasons,
                extra={"key": str(key)},
            )
            prev = hits.get(str(amount))
            if prev is None or _better(hit, prev):
                hits[str(amount)] = hit

    if hits:
        return sorted(hits.values(), key=lambda h: (h.amount or 0), reverse=True)

    # 構造から取れなかった場合のフォールバック。
    try:
        blob = json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):
        return []
    return scan_text(
        blob,
        strict=True,
        min_amount=min_amount,
        max_amount=max_amount,
        amounts_whitelist=amounts_whitelist,
        source="network",
        url=url,
        browser=browser,
    )


def _extract_amount(container: dict) -> int | None:
    best: int | None = None
    for key, value in container.items():
        if not _AMOUNT_KEY.search(str(key)):
            continue
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            candidate: int | None = value
        elif isinstance(value, float):
            candidate = int(value)
        elif isinstance(value, str):
            candidate = _to_int(value)
        else:
            candidate = None
        if candidate is None or candidate <= 0:
            continue
        if best is None or candidate > best:
            best = candidate
    return best


def _extract_code(container: dict) -> str | None:
    for key, value in container.items():
        if not _CODE_KEY.search(str(key)):
            continue
        if isinstance(value, str) and 4 <= len(value) <= 32:
            return value
        if isinstance(value, int):
            return str(value)
    return None
