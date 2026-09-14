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


# ------------------------------------------------------------------
# iframe 走査と履歴記録を、実ブラウザ無しで確かめる
# ------------------------------------------------------------------

class FakeLocator:
    def __init__(self, text=""):
        self._text = text

    def inner_text(self, timeout=None):
        return self._text

    def count(self):
        return 0

    def is_visible(self, timeout=None):
        return False

    @property
    def first(self):
        return self


class FakeElement:
    def __init__(self, text):
        self._text = text

    def is_visible(self):
        return True

    def inner_text(self):
        return self._text


class FakeFrame:
    def __init__(self, url, body_text="", popup_texts=(), badge_texts=()):
        self.url = url
        self._body = body_text
        self._popups = list(popup_texts)
        # スペシャルクーポンは「残155分」のカウントダウンを必ず伴う。
        # 既定でそれを持たせ、無い場合を明示的にテストする。
        self._badges = list(badge_texts)

    def locator(self, selector):
        return FakeLocator(self._body)

    def query_selector_all(self, selector):
        # 最初のセレクタでだけ返す（同じ要素を何度も返さないため）
        if selector == "[role='dialog']":
            return [FakeElement(text) for text in self._popups]
        if selector == "[class*='popup-badge']":
            return [FakeElement(text) for text in self._badges]
        return []


def coupon_frame(url, body_text="", popup_texts=(), minutes=155):
    """クーポンが出ている状態のフレーム（カウントダウン付き）。"""
    return FakeFrame(
        url,
        body_text=body_text,
        popup_texts=popup_texts,
        badge_texts=[f"残{minutes}分"],
    )


class FakeMouse:
    def wheel(self, dx, dy):
        pass


class FakePage:
    def __init__(self, frames):
        self.frames = frames
        self.url = frames[0].url
        self.mouse = FakeMouse()
        self.screenshots = []

    def goto(self, url, wait_until=None):
        self.url = url

    def wait_for_load_state(self, state, timeout=None):
        pass

    def on(self, event, handler):
        pass

    def get_by_text(self, pattern):
        return FakeLocator()

    def content(self):
        return "<html></html>"

    def screenshot(self, path, full_page=False):
        self.screenshots.append(path)


TOP = "https://travel.yahoo.co.jp/"


def test_coupon_inside_iframe_is_detected(watcher):
    """GPT版から取り入れた点。メインフレームだけ見ていると取りこぼす。"""
    page = FakePage([
        coupon_frame(TOP, body_text="宿泊プランを探す"),
        FakeFrame(TOP + "promo/iframe",
                  popup_texts=["スペシャルクーポン\n5,000円OFF\n残り180分限定"]),
    ])
    hits = watcher.check(page, "edge")
    assert [h.amount for h in hits] == [5000]
    assert hits[0].source == "popup"
    assert hits[0].frame_url.endswith("promo/iframe")


def test_main_frame_only_page_still_works(watcher):
    page = FakePage([
        coupon_frame(TOP, body_text="スペシャルクーポン 3,000円OFF 残り90分限定")
    ])
    hits = watcher.check(page, "chrome")
    assert [h.amount for h in hits] == [3000]


def test_ordinary_page_produces_no_hits(watcher):
    page = FakePage([
        FakeFrame(TOP, body_text="人気の温泉宿ランキング 1泊 5,000円から")
    ])
    assert watcher.check(page, "edge") == []


def test_visit_records_detection_in_history(watcher):
    page = FakePage([
        coupon_frame(TOP, body_text="スペシャルクーポン 5,000円OFF 残り180分限定")
    ])
    notified = watcher.visit(page, "edge", TOP, "トップページ")
    assert notified == 1

    from yahoo_coupon_watcher.history import read_rows

    rows = read_rows(watcher.history.path)
    assert len(rows) == 1
    assert rows[0].detected is True
    assert rows[0].amount == 5000
    assert rows[0].browser == "edge"
    assert rows[0].target == "トップページ"


def test_visit_records_miss_in_history(watcher):
    page = FakePage([FakeFrame(TOP, body_text="宿を探す")])
    assert watcher.visit(page, "edge", TOP, "トップページ") == 0

    from yahoo_coupon_watcher.history import read_rows

    rows = read_rows(watcher.history.path)
    assert len(rows) == 1
    assert rows[0].detected is False


def test_same_coupon_notifies_once(watcher):
    page = FakePage([
        coupon_frame(TOP, body_text="スペシャルクーポン 5,000円OFF 残り180分限定")
    ])
    assert watcher.visit(page, "edge", TOP, "トップページ") == 1
    assert watcher.visit(page, "edge", TOP, "トップページ") == 0  # 抑止される


def test_same_coupon_notifies_per_browser(watcher):
    page = FakePage([
        coupon_frame(TOP, body_text="スペシャルクーポン 5,000円OFF 残り180分限定")
    ])
    assert watcher.visit(page, "edge", TOP, "トップページ") == 1
    assert watcher.visit(page, "chrome", TOP, "トップページ") == 1


def test_screenshot_saved_on_hit(watcher):
    page = FakePage([
        coupon_frame(TOP, body_text="スペシャルクーポン 5,000円OFF 残り180分限定")
    ])
    watcher.visit(page, "edge", TOP, "トップページ")
    assert len(page.screenshots) == 1
    assert page.screenshots[0].endswith(".png")


# ------------------------------------------------------------------
# 畳まれたクーポンバッジ（「残155分」しか出ない状態）の検出
# ------------------------------------------------------------------

def test_countdown_badge_is_treated_as_a_coupon(watcher):
    """金額が無くても、残り時間バッジが出ていればクーポンはある。"""
    page = FakePage([
        FakeFrame(TOP, body_text="宿泊プランを探す", badge_texts=["残155分"])
    ])
    hits = watcher.check(page, "edge")
    assert len(hits) == 1
    assert hits[0].amount is None
    assert hits[0].time_limit_min == 155
    assert hits[0].source == "badge"


def test_badge_is_ignored_when_amount_is_known(watcher):
    """金額が取れているなら、そちらを使う。バッジで二重に数えない。"""
    page = FakeFrame(
        TOP,
        body_text="スペシャルクーポン 5,000円OFF 残り180分限定",
        badge_texts=["残155分"],
    )
    hits = watcher.check(FakePage([page]), "edge")
    assert [h.amount for h in hits] == [5000]


def test_long_text_is_not_a_badge(watcher):
    """本文中の「残り155分」のような長い文はバッジとみなさない。"""
    long_text = "こちらの宿は人気です。" * 8 + "残155分"  # 60文字を超える
    page = FakePage([FakeFrame(TOP, badge_texts=[long_text])])
    assert watcher.check(page, "edge") == []


def test_badge_notifies(watcher):
    page = FakePage([FakeFrame(TOP, badge_texts=["残155分"])])
    assert watcher.visit(page, "edge", TOP, "トップページ") == 1

    from yahoo_coupon_watcher.history import read_rows

    rows = read_rows(watcher.history.path)
    assert rows[0].detected is True
    assert rows[0].amount is None


# ------------------------------------------------------------------
# スペシャルクーポンと宿ごとのクーポンの区別
# ------------------------------------------------------------------

def test_hotel_coupon_without_countdown_is_ignored(watcher):
    """宿ごとのクーポンは静的な表示でカウントダウンが無い。通知しない。"""
    page = FakePage([
        FakeFrame(TOP + "dp/hotel-1/", body_text="この宿で使える割引クーポン 3,000円OFF")
    ])
    assert watcher.check(page, "edge") == []


def test_same_text_with_countdown_is_a_special_coupon(watcher):
    """同じ文言でも、カウントダウンがあればスペシャルクーポン。"""
    page = FakePage([
        coupon_frame(TOP, body_text="スペシャルクーポン 3,000円OFF")
    ])
    assert [h.amount for h in watcher.check(page, "edge")] == [3000]


@pytest.mark.parametrize("amount", [1000, 2000, 3000, 5000])
def test_special_coupon_amounts_are_notified(watcher, amount):
    page = FakePage([
        coupon_frame(TOP, body_text=f"スペシャルクーポン {amount:,}円OFF")
    ])
    assert [h.amount for h in watcher.check(page, "edge")] == [amount]


@pytest.mark.parametrize("amount", [500, 1500, 4000, 10000, 50000])
def test_other_amounts_without_countdown_are_ignored(watcher, amount):
    """スペシャルクーポンの金額は 1000/2000/3000/5000円。
    それ以外でカウントダウンも無いものは宿ごとのクーポン。"""
    page = FakePage([
        FakeFrame(TOP, body_text=f"割引クーポン {amount:,}円OFF")
    ])
    assert watcher.check(page, "edge") == []


@pytest.mark.parametrize("amount", [1500, 4000, 50000])
def test_out_of_range_amount_falls_back_to_unknown(watcher, amount):
    """カウントダウンがある以上スペシャルクーポンではある。ただし読み取った
    金額が対象外なら、その金額を名乗らず「金額不明」として知らせる。"""
    page = FakePage([
        coupon_frame(TOP, body_text=f"スペシャルクーポン {amount:,}円OFF")
    ])
    hits = watcher.check(page, "edge")
    assert len(hits) == 1
    assert hits[0].amount is None
    assert hits[0].source == "badge"


def test_countdown_over_the_limit_is_not_a_special_coupon(watcher):
    """有効時間は最長180分。それを超えるカウントダウンはセールなど別物。"""
    page = FakePage([FakeFrame(TOP, badge_texts=["残600分"])])
    assert watcher.check(page, "edge") == []


@pytest.mark.parametrize("minutes", [60, 120, 150, 180])
def test_all_special_coupon_durations_are_accepted(watcher, minutes):
    page = FakePage([FakeFrame(TOP, badge_texts=[f"残{minutes}分"])])
    hits = watcher.check(page, "edge")
    assert len(hits) == 1
    assert hits[0].time_limit_min == minutes


def test_countdown_with_surrounding_text_is_not_a_badge(watcher):
    """「セール残り30分」のような文はバッジではない。完全一致のみ。"""
    page = FakePage([FakeFrame(TOP, badge_texts=["セール残30分です"])])
    assert watcher.check(page, "edge") == []


def test_require_countdown_can_be_turned_off(watcher):
    watcher.detect = {**watcher.detect, "require_countdown": False}
    page = FakePage([
        FakeFrame(TOP, body_text="スペシャルクーポン 3,000円OFF")
    ])
    assert [h.amount for h in watcher.check(page, "edge")] == [3000]
