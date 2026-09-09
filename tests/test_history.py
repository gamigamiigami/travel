from datetime import datetime

from yahoo_coupon_watcher.history import (
    HistoryLog,
    amount_counts,
    format_report,
    read_rows,
    summarize,
)


def make_log(tmp_path):
    return HistoryLog(tmp_path / "history.csv")


def test_records_round_trip(tmp_path):
    log = make_log(tmp_path)
    log.record(
        browser="edge",
        target="トップページ",
        url="https://travel.yahoo.co.jp/",
        detected=True,
        amount=5000,
        score=9,
        reasons=("スペシャルクーポン", "180分限定"),
        now=datetime(2026, 9, 9, 14, 30),
    )
    rows = read_rows(tmp_path / "history.csv")
    assert len(rows) == 1
    row = rows[0]
    assert row.browser == "edge"
    assert row.detected is True
    assert row.amount == 5000
    assert row.hour == 14
    assert row.weekday == "水"
    assert row.reasons == "スペシャルクーポン・180分限定"


def test_records_misses_too(tmp_path):
    """分母が無いと出現率が出せないので、検出しなかった回も残す。"""
    log = make_log(tmp_path)
    log.record(browser="edge", target="t", url="u", detected=False,
               now=datetime(2026, 9, 9, 10, 0))
    rows = read_rows(tmp_path / "history.csv")
    assert rows[0].detected is False
    assert rows[0].amount is None


def test_appends_single_header(tmp_path):
    log = make_log(tmp_path)
    for _ in range(3):
        log.record(browser="edge", target="t", url="u", detected=False)
    text = (tmp_path / "history.csv").read_text(encoding="utf-8-sig")
    assert text.count("timestamp,date") == 1
    assert len(read_rows(tmp_path / "history.csv")) == 3


def test_disabled_writes_nothing(tmp_path):
    HistoryLog(tmp_path / "h.csv", enabled=False).record(
        browser="edge", target="t", url="u", detected=True
    )
    assert not (tmp_path / "h.csv").exists()


def test_read_missing_file(tmp_path):
    assert read_rows(tmp_path / "nope.csv") == []


def _seed(tmp_path):
    log = make_log(tmp_path)
    # edge: 4回中2回検出 / chrome: 4回中0回検出
    for hour, detected in ((10, True), (10, False), (22, True), (22, False)):
        log.record(browser="edge", target="トップ", url="u", detected=detected,
                   amount=5000 if detected else None, score=9 if detected else 0,
                   now=datetime(2026, 9, 9, hour, 0))
    for hour in (10, 10, 22, 22):
        log.record(browser="chrome", target="トップ", url="u", detected=False,
                   now=datetime(2026, 9, 9, hour, 0))
    return read_rows(tmp_path / "history.csv")


def test_summarize_by_browser(tmp_path):
    rows = _seed(tmp_path)
    result = dict((name, (checks, hits, rate)) for name, checks, hits, rate in
                  summarize(rows, "browser"))
    assert result["edge"] == (4, 2, 50.0)
    assert result["chrome"] == (4, 0, 0.0)


def test_summarize_by_hour(tmp_path):
    rows = _seed(tmp_path)
    result = dict((name, hits) for name, _, hits, _ in summarize(rows, "hour"))
    assert result["10時台"] == 1
    assert result["22時台"] == 1


def test_summarize_sorted_by_rate(tmp_path):
    rows = _seed(tmp_path)
    assert summarize(rows, "browser")[0][0] == "edge"


def test_amount_counts(tmp_path):
    rows = _seed(tmp_path)
    assert amount_counts(rows) == [(5000, 2)]


def test_format_report_contains_sections(tmp_path):
    report = format_report(_seed(tmp_path))
    for section in ("ブラウザ別", "曜日別", "時間帯別", "ページ別", "金額別"):
        assert section in report
    assert "edge" in report
    assert "50.00%" in report


def test_format_report_when_empty():
    assert "履歴がまだありません" in format_report([])


def test_format_report_notes_zero_detection(tmp_path):
    log = make_log(tmp_path)
    log.record(browser="edge", target="t", url="u", detected=False)
    assert "まだ検出ゼロ" in format_report(read_rows(tmp_path / "history.csv"))


def test_display_width_counts_fullwidth_as_two():
    from yahoo_coupon_watcher.history import display_width, pad

    assert display_width("edge") == 4
    assert display_width("トップページ") == 12
    assert display_width("07時台") == 6  # 半角数字2 + 全角2文字
    assert display_width(pad("edge", 10)) == 10
    assert display_width(pad("トップページ", 16)) == 16
    assert pad("超過してもはみ出すだけ", 4) == "超過してもはみ出すだけ"


def test_report_warns_about_small_sample(tmp_path):
    log = make_log(tmp_path)
    log.record(browser="edge", target="t", url="u", detected=True, amount=5000)
    report = format_report(read_rows(tmp_path / "history.csv"))
    assert "偶然の範囲" in report
