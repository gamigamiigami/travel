import json

import pytest

from yahoo_coupon_watcher.detector import CouponHit, scan_json, scan_text


POPUP_TEXT = """
スペシャルクーポン
5,000円OFF
残り180分限定
クーポンを獲得する
"""


def test_popup_text_hit():
    hits = scan_text(POPUP_TEXT, browser="edge", url="https://travel.yahoo.co.jp/")
    assert len(hits) == 1
    hit = hits[0]
    assert hit.amount == 5000
    assert hit.time_limit_min == 180
    assert hit.browser == "edge"
    assert "5,000円OFFクーポン出現" in hit.title()


@pytest.mark.parametrize(
    "text,expected",
    [
        ("スペシャルクーポン 1,000円OFF", 1000),
        ("スペシャルクーポン ２，０００円オフ", 2000),
        ("限定クーポン 3000円割引", 3000),
        ("あなただけのクーポン 50,000円OFF", 50000),
    ],
)
def test_amount_variants(text, expected):
    hits = scan_text(text)
    assert [h.amount for h in hits] == [expected]


def test_amount_coupon_form_without_off():
    hits = scan_text("いまなら5,000円クーポンをプレゼント")
    assert [h.amount for h in hits] == [5000]


def test_strict_mode_rejects_bare_amount():
    # 「クーポン」という語がどこにも無い、ただの割引表記は拾わない。
    assert scan_text("本日限り 5,000円OFF の宿はこちら") == []


def test_strict_mode_rejects_distant_keyword():
    text = "スペシャルクーポンについて" + ("あ" * 500) + "宿泊料金 5,000円OFF"
    assert scan_text(text) == []


def test_non_strict_mode_allows_weak_keyword():
    text = "クーポン 3,000円OFF"
    assert scan_text(text, strict=True) == []
    hits = scan_text(text, strict=False, source="popup")
    assert [h.amount for h in hits] == [3000]
    assert hits[0].source == "popup"


def test_min_amount_filter():
    assert scan_text("スペシャルクーポン 500円OFF") == []
    assert scan_text("スペシャルクーポン 500円OFF", min_amount=100)[0].amount == 500


def test_whitelist_filter():
    text = "スペシャルクーポン 1,500円OFF"
    assert scan_text(text, amounts_whitelist=[1000, 3000, 5000]) == []
    assert scan_text(text, amounts_whitelist=[1500])[0].amount == 1500


def test_ignore_patterns_suppress_known_noise():
    text = "ヤフーパックで使えるクーポン スペシャルクーポン 5,000円OFF"
    assert scan_text(text, ignore_patterns=[r"ヤフーパックで使える"]) == []


def test_code_extraction_prefers_alphanumeric():
    hits = scan_text("スペシャルクーポン 5,000円OFF クーポンコード YT5000AB を利用")
    assert hits[0].code == "YT5000AB"


def test_highest_amount_first():
    text = "スペシャルクーポン 1,000円OFF と スペシャルクーポン 5,000円OFF"
    assert [h.amount for h in scan_text(text)] == [5000, 1000]


def test_scan_json_structured():
    payload = {
        "result": {
            "specialCoupon": {
                "couponCode": "ABCD1234",
                "discountAmount": 5000,
                "title": "スペシャルクーポン",
            }
        }
    }
    hits = scan_json(payload, url="https://travel.yahoo.co.jp/api/x", browser="chrome")
    assert len(hits) == 1
    assert hits[0].amount == 5000
    assert hits[0].code == "ABCD1234"
    assert hits[0].source == "network"
    assert hits[0].browser == "chrome"


def test_scan_json_list_container():
    payload = {"coupons": [{"code": "Z9Z9Z9Z9", "discount": "3,000"}]}
    hits = scan_json(payload)
    assert hits[0].amount == 3000
    assert hits[0].code == "Z9Z9Z9Z9"


def test_scan_json_text_fallback():
    payload = {"modules": [{"html": "<div>スペシャルクーポン 2,000円OFF</div>"}]}
    hits = scan_json(payload)
    assert [h.amount for h in hits] == [2000]


def test_scan_json_ignores_unrelated_numbers():
    payload = {"hotel": {"price": 48000, "name": "温泉旅館"}}
    assert scan_json(payload) == []


def test_signature_separates_browsers():
    a = CouponHit(amount=5000, source="popup", snippet="", code="X1", browser="edge")
    b = CouponHit(amount=5000, source="popup", snippet="", code="X1", browser="chrome")
    assert a.signature != b.signature
    assert a.signature == "edge|5000"


def test_body_contains_key_fields():
    hit = CouponHit(
        amount=5000,
        source="popup",
        snippet="スペシャルクーポン",
        code="X1Y2",
        time_limit_min=180,
        url="https://travel.yahoo.co.jp/",
    )
    body = hit.body()
    assert "5,000円OFF" in body
    assert "X1Y2" in body
    assert "180分" in body
    assert "https://travel.yahoo.co.jp/" in body


def test_signature_ignores_code_so_one_coupon_notifies_once():
    # 同じクーポンでも、ポップアップからはコードが取れてページ全体からは
    # 取れないことがある。コードをキーに含めると二重通知になる。
    with_code = CouponHit(amount=5000, source="popup", snippet="", code="X1", browser="edge")
    without = CouponHit(amount=5000, source="page", snippet="", browser="edge")
    assert with_code.signature == without.signature


@pytest.mark.parametrize(
    "text,expected",
    [
        ("スペシャルクーポン 5,000円分OFF", 5000),
        ("スペシャルクーポン ¥5,000 OFF", 5000),
        ("スペシャルクーポン ￥3,000 割引", 3000),
        ("割引クーポンが届きました 3,000円OFF", 3000),
        ("クーポン当選！ 2,000円OFF", 2000),
        ("クーポンを配布中 1,000円OFF", 1000),
    ],
)
def test_wording_and_format_variants(text, expected):
    """実際に取り逃がした事例を踏まえて表記ゆれを広げた分の回帰テスト。"""
    assert [h.amount for h in scan_text(text)] == [expected]


def test_yen_mark_alone_is_not_enough():
    # 円記号だけの価格表示はクーポンではない
    assert scan_text("このホテル ¥5,000 から") == []
