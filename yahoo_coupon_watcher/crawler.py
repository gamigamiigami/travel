"""Yahoo!トラベルを人間っぽく散策し、クーポンが出たら通知する。

噂ベースの前提（公式には非公開）:
  - スペシャルクーポンはランダム抽選で、対象者にのみ表示される
  - 具体的に宿を調べたり、何度もサイトを訪れると出やすいと言われている
  - Edge と Chrome では抽選が別枠の可能性がある

なので「複数回訪問する」「宿の詳細ページまで潜る」「ブラウザ2つで別々に回す」を
実装している。ただしサイトに負荷をかけないよう、既定の巡回間隔は十数分に1回。
"""

from __future__ import annotations

import logging
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.parse import urljoin, urlparse

from playwright.sync_api import BrowserContext, Error as PlaywrightError, Page

from .config import rand_range
from .detector import CouponHit, scan_json, scan_text
from .history import HistoryLog
from .notifier import Notifier
from .state import DailyCounter, NotifyState

log = logging.getLogger(__name__)

# クーポンのポップアップが入っていそうな入れ物。どれか当たれば良い、という発想。
POPUP_SELECTORS = (
    "[role='dialog']",
    "[aria-modal='true']",
    "dialog",
    "[class*='oupon']",
    "[id*='oupon']",
    "[data-testid*='oupon']",
    "[class*='odal']",
    "[class*='opup']",
    "[class*='alloon']",
    "[class*='oast']",
)

# クーポン獲得ボタンでも、これらの語を含むものは絶対に押さない。
CLICK_FORBIDDEN = re.compile(
    r"予約|決済|購入|支払|申込|申し込|確定|キャンセル|退会|ログアウト|削除"
)

MAX_POPUP_TEXT = 6000
MAX_BODY_TEXT = 200_000
MAX_JSON_BYTES = 1_500_000
MAX_RESPONSES_PER_PAGE = 60
MAX_FRAMES = 12


@dataclass
class CrawlPaths:
    data_dir: Path
    screenshots_dir: Path
    captures_dir: Path

    @classmethod
    def create(cls, data_dir: str | Path) -> "CrawlPaths":
        base = Path(data_dir)
        shots = base / "screenshots"
        caps = base / "captures"
        for path in (base, shots, caps):
            path.mkdir(parents=True, exist_ok=True)
        return cls(base, shots, caps)


class Watcher:
    def __init__(
        self,
        config: dict[str, Any],
        notifier: Notifier,
        state: NotifyState,
        *,
        history: HistoryLog | None = None,
        daily: DailyCounter | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        rng: random.Random | None = None,
    ) -> None:
        self.config = config
        self.crawl = config["crawl"]
        self.detect = config["detect"]
        self.notifier = notifier
        self.state = state
        self.sleep = sleeper
        self.rng = rng or random.Random()
        self.paths = CrawlPaths.create(config["paths"]["data_dir"])
        self.history = history or HistoryLog(
            self.paths.data_dir / config.get("history", {}).get("file", "history.csv"),
            enabled=config.get("history", {}).get("enabled", True),
        )
        self.daily = daily or DailyCounter(self.paths.data_dir / "rounds.json")
        self.current_target = "-"
        self._blocked = [re.compile(p, re.IGNORECASE) for p in self.crawl["blocked_url_patterns"]]
        self._preferred = [
            re.compile(p, re.IGNORECASE) for p in self.crawl["preferred_url_patterns"]
        ]
        self._network_hits: list[CouponHit] = []
        self._responses_seen = 0

    # ------------------------------------------------------------------ URL

    def is_allowed_url(self, url: str) -> bool:
        """散策先として踏んで良いURLか。予約・決済系は絶対に踏まない。"""
        try:
            parsed = urlparse(url)
        except ValueError:
            return False
        if parsed.scheme not in {"http", "https"}:
            return False
        host = (parsed.hostname or "").lower()
        suffix = self.crawl["allowed_host_suffix"].lower()
        if not (host == suffix or host.endswith("." + suffix)):
            return False
        return not any(pattern.search(url) for pattern in self._blocked)

    def _link_weight(self, url: str) -> float:
        """宿の詳細ページなど「具体的に調べている」感が出るリンクを優先する。"""
        return 4.0 if any(p.search(url) for p in self._preferred) else 1.0

    def collect_links(self, page: Page) -> list[str]:
        try:
            hrefs = page.eval_on_selector_all(
                "a[href]", "els => els.map(e => e.getAttribute('href'))"
            )
        except PlaywrightError:
            return []
        base = page.url
        seen: set[str] = set()
        links: list[str] = []
        for href in hrefs or []:
            if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
                continue
            absolute = urljoin(base, href).split("#")[0]
            if absolute in seen or absolute == base:
                continue
            if not self.is_allowed_url(absolute):
                continue
            seen.add(absolute)
            links.append(absolute)
        return links

    def choose_link(self, links: Sequence[str]) -> str | None:
        if not links:
            return None
        weights = [self._link_weight(url) for url in links]
        return self.rng.choices(list(links), weights=weights, k=1)[0]

    # -------------------------------------------------------------- 検出

    def _attach_network_listener(self, page: Page, browser: str) -> None:
        if not self.detect.get("network_scan", True):
            return

        def handle(response) -> None:
            if self._responses_seen >= MAX_RESPONSES_PER_PAGE:
                return
            try:
                content_type = (response.headers or {}).get("content-type", "")
                if "json" not in content_type.lower():
                    return
                self._responses_seen += 1
                body = response.body()
                if not body or len(body) > MAX_JSON_BYTES:
                    return
                import json as _json

                payload = _json.loads(body.decode("utf-8", errors="replace"))
            except Exception:
                return
            try:
                hits = scan_json(
                    payload,
                    url=response.url,
                    browser=browser,
                    min_amount=self.detect["min_amount"],
                    max_amount=self.detect["max_amount"],
                    amounts_whitelist=self.detect["amounts_whitelist"],
                )
            except Exception:
                log.debug("ネットワークレスポンスの解析に失敗", exc_info=True)
                return
            if hits:
                log.info("ネットワークからクーポン候補を検出: %s", response.url)
                self._network_hits.extend(hits)

        page.on("response", handle)

    def _frames(self, page: Page) -> list:
        """メインフレームだけでなく iframe も走査対象にする。

        クーポンのポップアップが iframe の中に描画されている場合、メインフレームの
        innerText には出てこない。ここを見ないと丸ごと取りこぼす。
        """
        try:
            return list(page.frames)[:MAX_FRAMES]
        except PlaywrightError:
            return []

    def _scan_args(self, source: str, page: Page, browser: str, frame_url: str) -> dict:
        return {
            "min_amount": self.detect["min_amount"],
            "max_amount": self.detect["max_amount"],
            "amounts_whitelist": self.detect["amounts_whitelist"],
            "ignore_patterns": self.detect["ignore_patterns"],
            "source": source,
            "url": page.url,
            "browser": browser,
            "frame_url": frame_url,
            "target": self.current_target,
        }

    def scan_popups(self, page: Page, browser: str) -> list[CouponHit]:
        """ポップアップらしき要素の中を、ゆるい条件で見る（全フレーム）。"""
        hits: list[CouponHit] = []
        for frame in self._frames(page):
            try:
                frame_url = frame.url
            except PlaywrightError:
                continue
            for selector in POPUP_SELECTORS:
                try:
                    elements = frame.query_selector_all(selector)
                except PlaywrightError:
                    continue
                for element in elements[:8]:
                    try:
                        if not element.is_visible():
                            continue
                        text = element.inner_text()
                    except PlaywrightError:
                        continue
                    if not text or len(text) > MAX_POPUP_TEXT:
                        continue
                    hits.extend(
                        scan_text(
                            text,
                            strict=False,
                            min_score=self.detect["min_score_popup"],
                            **self._scan_args("popup", page, browser, frame_url),
                        )
                    )
        return hits

    def scan_page(self, page: Page, browser: str) -> list[CouponHit]:
        """各フレームの全文を、強いキーワード必須の厳しい条件で見る。"""
        hits: list[CouponHit] = []
        for frame in self._frames(page):
            try:
                frame_url = frame.url
                text = frame.locator("body").inner_text(timeout=3000)
            except PlaywrightError:
                continue
            if not text:
                continue
            hits.extend(
                scan_text(
                    text[:MAX_BODY_TEXT],
                    strict=True,
                    min_score=self.detect["min_score_page"],
                    **self._scan_args("page", page, browser, frame_url),
                )
            )
        return hits

    def check(self, page: Page, browser: str) -> list[CouponHit]:
        hits = list(self._network_hits)
        self._network_hits.clear()
        hits.extend(self.scan_popups(page, browser))
        hits.extend(self.scan_page(page, browser))
        return dedupe_hits(hits)

    # ---------------------------------------------------------- クーポン獲得

    def try_claim(self, page: Page) -> bool:
        """「クーポンを獲得」系のボタンがあれば押す。予約・決済系は絶対に押さない。"""
        if not self.detect.get("auto_claim", True):
            return False
        for label in self.detect["claim_button_texts"]:
            try:
                locator = page.get_by_text(re.compile(re.escape(label))).first
                if locator.count() == 0 or not locator.is_visible(timeout=1500):
                    continue
                text = (locator.inner_text() or "")[:120]
            except PlaywrightError:
                continue
            if CLICK_FORBIDDEN.search(text):
                log.info("危険そうな文言のため押しません: %r", text)
                continue
            try:
                locator.click(timeout=4000)
                log.info("クーポン獲得ボタンを押しました: %r", text)
                self.sleep(2)
                return True
            except PlaywrightError:
                log.debug("クリックに失敗: %r", text, exc_info=True)
        return False

    # -------------------------------------------------------------- 通知

    def handle_hits(self, page: Page, hits: Sequence[CouponHit]) -> int:
        notified = 0
        for hit in hits:
            if not self.state.should_notify(hit.signature):
                log.info("通知済みなのでスキップ: %s", hit.signature)
                continue

            self.try_claim(page)

            shot = self._capture(page, hit)
            try:
                self.notifier.send(hit.title(), hit.body(), shot)
                self.state.mark_notified(hit.signature)
                notified += 1
                log.warning("クーポン検出＆通知: %s", hit.signature)
            except Exception:
                log.exception("通知に失敗しました: %s", hit.signature)
        return notified

    def _capture(self, page: Page, hit: CouponHit) -> Path | None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = f"{stamp}_{hit.browser or 'unknown'}_{hit.amount}"
        # HTMLも残す。セレクタが変わったときの調査に使う。
        try:
            (self.paths.captures_dir / f"{base}.html").write_text(
                page.content(), encoding="utf-8"
            )
        except Exception:
            log.debug("HTMLの保存に失敗", exc_info=True)
        if not self.detect.get("screenshot", True):
            return None
        shot = self.paths.screenshots_dir / f"{base}.png"
        try:
            page.screenshot(path=str(shot), full_page=False)
            return shot
        except Exception:
            log.debug("スクリーンショットの保存に失敗", exc_info=True)
            return None

    # -------------------------------------------------------------- 散策

    def human_dwell(self, page: Page) -> None:
        """人間っぽく少し眺める。読み込み直後に消えるポップアップも拾える。"""
        lo, hi = rand_range(self.crawl["page_dwell_seconds"])
        steps_lo, steps_hi = rand_range(self.crawl["scroll_steps"])
        steps = self.rng.randint(int(steps_lo), max(int(steps_lo), int(steps_hi)))
        total = self.rng.uniform(lo, hi)
        per_step = total / max(steps, 1)
        for _ in range(max(steps, 1)):
            try:
                page.mouse.wheel(0, self.rng.randint(300, 1200))
            except PlaywrightError:
                pass
            self.sleep(per_step)

    def goto(self, page: Page, url: str) -> bool:
        self._responses_seen = 0
        try:
            page.goto(url, wait_until="domcontentloaded")
        except PlaywrightError as exc:
            log.warning("遷移に失敗しました %s (%s)", url, exc)
            return False
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except PlaywrightError:
            pass  # networkidle まで待てなくても検出は試す
        return True

    def visit(self, page: Page, browser: str, url: str, target_name: str) -> int:
        """1ページ見て、検出したら通知し、結果を履歴に残す。通知件数を返す。"""
        self.current_target = target_name
        if not self.goto(page, url):
            return 0
        self.human_dwell(page)
        hits = self.check(page, browser)
        notified = self.handle_hits(page, hits)

        best = hits[0] if hits else None
        self.history.record(
            browser=browser,
            target=target_name,
            url=page.url,
            detected=bool(hits),
            amount=best.amount if best else None,
            score=best.score if best else 0,
            reasons=best.reasons if best else (),
        )
        return notified

    def run_round(self, context: BrowserContext, browser: str) -> int:
        """1ラウンド分の散策。

        設定した targets を必ず1回ずつ見て、そこを起点にリンクを辿って宿の詳細まで
        潜る。「決め打ちのページを確実に見る」と「毎回違うページを見る」の両立。
        """
        page = context.pages[0] if context.pages else context.new_page()
        self._network_hits.clear()
        self._attach_network_listener(page, browser)

        notified = 0
        lo, hi = rand_range(self.crawl["wander_pages_per_target"])
        targets = list(self.crawl["targets"])
        self.rng.shuffle(targets)

        for target in targets:
            name = target.get("name") or target["url"]
            url = target["url"]
            if not self.is_allowed_url(url):
                log.warning("targets のURLが巡回対象外なので飛ばします: %s", url)
                continue

            log.info("[%s] ターゲット: %s", browser, name)
            notified += self.visit(page, browser, url, name)

            wander = self.rng.randint(int(lo), max(int(lo), int(hi)))
            for index in range(wander):
                next_url = self.choose_link(self.collect_links(page))
                if next_url is None:
                    log.info("たどれるリンクがないので次のターゲットへ")
                    break
                log.info("[%s]   潜行 %d/%d %s", browser, index + 1, wander, next_url)
                notified += self.visit(page, browser, next_url, f"{name} > 散策")

        return notified

    # -------------------------------------------------------------- 時間帯

    def in_quiet_hours(self, now: datetime | None = None) -> bool:
        quiet = self.crawl.get("quiet_hours")
        if not quiet:
            return False
        start, end = int(quiet[0]), int(quiet[1])
        hour = (now or datetime.now()).hour
        if start == end:
            return False
        if start < end:
            return start <= hour < end
        return hour >= start or hour < end  # 日をまたぐ指定

    def next_interval_seconds(self) -> float:
        lo, hi = rand_range(self.crawl["interval_minutes"])
        return self.rng.uniform(lo, hi) * 60


def dedupe_hits(hits: Sequence[CouponHit]) -> list[CouponHit]:
    """同じシグネチャのヒットをまとめ、コードが取れている方を残す。"""
    best: dict[str, CouponHit] = {}
    for hit in hits:
        prev = best.get(hit.signature)
        if prev is None or (prev.code is None and hit.code is not None):
            best[hit.signature] = hit
    return sorted(best.values(), key=lambda h: h.amount, reverse=True)
