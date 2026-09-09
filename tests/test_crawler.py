import random
from datetime import datetime

import pytest

from yahoo_coupon_watcher.config import DEFAULTS
from yahoo_coupon_watcher.crawler import Watcher, dedupe_hits
from yahoo_coupon_watcher.detector import CouponHit
from yahoo_coupon_watcher.notifier import ConsoleNotifier
from yahoo_coupon_watcher.state import NotifyState


@pytest.fixture
def watcher(tmp_path):
    config = {
        **DEFAULTS,
        "paths": {
            "profiles_dir": str(tmp_path / "profiles"),
            "data_dir": str(tmp_path / "data"),
            "logs_dir": str(tmp_path / "logs"),
        },
    }
    state = NotifyState(tmp_path / "notified.json", 600)
    return Watcher(config, ConsoleNotifier(), state, sleeper=lambda _: None,
                   rng=random.Random(0))


@pytest.mark.parametrize(
    "url",
    [
        "https://travel.yahoo.co.jp/",
        "https://travel.yahoo.co.jp/dp/hotel-12345/",
        "https://www.travel.yahoo.co.jp/domestic/area/tokyo/",
    ],
)
def test_allowed_urls(watcher, url):
    assert watcher.is_allowed_url(url)


@pytest.mark.parametrize(
    "url",
    [
        # 別サイトには出て行かない
        "https://shopping.yahoo.co.jp/",
        "https://example.com/travel.yahoo.co.jp",
        # 予約・決済・アカウント操作は絶対に踏まない
        "https://travel.yahoo.co.jp/dp/hotel-1/reserve/",
        "https://travel.yahoo.co.jp/booking/step1",
        "https://travel.yahoo.co.jp/payment/",
        "https://travel.yahoo.co.jp/mypage/",
        "https://login.yahoo.co.jp/config/login",
        "javascript:void(0)",
    ],
)
def test_blocked_urls(watcher, url):
    assert not watcher.is_allowed_url(url)


def test_hotel_links_are_preferred(watcher):
    links = ["https://travel.yahoo.co.jp/help/"] * 5 + [
        "https://travel.yahoo.co.jp/dp/hotel-999/"
    ]
    picks = [watcher.choose_link(links) for _ in range(300)]
    hotel = sum(1 for p in picks if "/dp/" in p)
    # 重み4倍 → 5本の一般リンク(重み1)に対して 4/9 程度が期待値
    assert 0.25 < hotel / len(picks) < 0.65


def test_choose_link_handles_empty(watcher):
    assert watcher.choose_link([]) is None


@pytest.mark.parametrize(
    "hour,expected",
    [(0, False), (1, True), (3, True), (6, True), (7, False), (12, False)],
)
def test_quiet_hours(watcher, hour, expected):
    assert watcher.in_quiet_hours(datetime(2026, 1, 1, hour, 30)) is expected


def test_quiet_hours_wrapping_midnight(watcher):
    watcher.crawl = {**watcher.crawl, "quiet_hours": [23, 5]}
    assert watcher.in_quiet_hours(datetime(2026, 1, 1, 23, 30))
    assert watcher.in_quiet_hours(datetime(2026, 1, 1, 2, 0))
    assert not watcher.in_quiet_hours(datetime(2026, 1, 1, 12, 0))


def test_quiet_hours_disabled(watcher):
    watcher.crawl = {**watcher.crawl, "quiet_hours": []}
    assert not watcher.in_quiet_hours(datetime(2026, 1, 1, 3, 0))


def test_interval_within_configured_range(watcher):
    lo, hi = watcher.crawl["interval_minutes"]
    for _ in range(50):
        seconds = watcher.next_interval_seconds()
        assert lo * 60 <= seconds <= hi * 60


def test_dedupe_hits_prefers_one_with_code():
    without = CouponHit(amount=5000, source="page", snippet="a", browser="edge")
    with_code = CouponHit(amount=5000, source="popup", snippet="b", code="AB12", browser="edge")
    result = dedupe_hits([without, with_code])
    assert len(result) == 1
    assert result[0].code == "AB12"


def test_dedupe_hits_keeps_distinct_amounts():
    hits = [
        CouponHit(amount=1000, source="page", snippet="", browser="edge"),
        CouponHit(amount=5000, source="page", snippet="", browser="edge"),
    ]
    assert [h.amount for h in dedupe_hits(hits)] == [5000, 1000]
