"""スコアリング（GPT版の良い部分）と、私の近接判定を組み合わせた挙動のテスト。"""

import pytest

from yahoo_coupon_watcher.detector import scan_text, score_text


def test_special_coupon_scores_high():
    score, reasons = score_text("スペシャルクーポン 5,000円OFF 残り180分")
    assert score >= 7
    assert "スペシャルクーポン" in reasons
    assert "180分限定" in reasons


@pytest.mark.parametrize("minutes", [60, 90, 180])
def test_all_three_time_limits_are_credited(minutes):
    """有効時間は60/90/180分の3種。180分だけ決め打ちすると2/3を取り逃す。"""
    score, reasons = score_text(f"5,000円OFFクーポン 残り{minutes}分")
    assert f"{minutes}分限定" in reasons
    assert score >= 4


@pytest.mark.parametrize("minutes", [60, 90, 180])
def test_all_three_time_limits_are_detected(minutes):
    hits = scan_text(f"5,000円OFFクーポン 残り{minutes}分", strict=False, min_score=4)
    assert [h.amount for h in hits] == [5000]
    assert hits[0].time_limit_min == minutes


def test_plain_mention_scores_low():
    score, _ = score_text("クーポンについてのご案内")
    assert score <= 2


def test_min_score_gate_blocks_weak_hits():
    text = "クーポン 3,000円OFF"
    assert scan_text(text, strict=False, min_score=0)
    assert scan_text(text, strict=False, min_score=99) == []


def test_hit_carries_score_and_reasons():
    hits = scan_text("スペシャルクーポン 5,000円OFF 残り180分限定", min_score=5)
    hit = hits[0]
    assert hit.score >= 7
    assert hit.reasons
    assert "根拠:" in hit.body()
    assert f"score={hit.score}" in hit.body()


def test_higher_score_wins_for_same_amount():
    text = (
        "クーポン 5,000円OFF"
        + "。" * 400
        + "スペシャルクーポン 5,000円OFF 残り180分限定 コード AB12CD34"
    )
    hits = scan_text(text, strict=False, min_score=0)
    assert len(hits) == 1
    assert hits[0].code == "AB12CD34"
    assert hits[0].score >= 7


def test_network_hits_get_confidence_bonus():
    from yahoo_coupon_watcher.detector import scan_json

    hits = scan_json({"specialCoupon": {"discountAmount": 5000, "couponCode": "AB12"}})
    assert hits[0].score >= 3
    assert "クーポンAPI" in hits[0].reasons


def test_target_and_frame_are_recorded():
    hits = scan_text(
        "スペシャルクーポン 5,000円OFF",
        min_score=5,
        target="トップページ",
        frame_url="https://travel.yahoo.co.jp/iframe",
    )
    assert hits[0].target == "トップページ"
    assert hits[0].frame_url == "https://travel.yahoo.co.jp/iframe"
    assert "ページ: トップページ" in hits[0].body()
