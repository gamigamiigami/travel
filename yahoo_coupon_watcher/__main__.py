"""CLI エントリポイント。

    python -m yahoo_coupon_watcher login          # 初回だけ手動ログイン
    python -m yahoo_coupon_watcher run            # 巡回開始（これを常駐させる）
    python -m yahoo_coupon_watcher run --once     # 1ラウンドだけ試す
    python -m yahoo_coupon_watcher test-notify    # 通知の疎通確認
    python -m yahoo_coupon_watcher capture        # ページを保存して検出を調整する用
    python -m yahoo_coupon_watcher doctor         # 設定と環境の確認
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
import time
from datetime import datetime
from pathlib import Path

from .browser import CHANNELS, open_context, profile_dir
from .config import ConfigError, load_config
from .crawler import Watcher
from .detector import CouponHit, scan_text
from .logging_setup import setup_logging
from .notifier import build_notifier
from .state import NotifyState

log = logging.getLogger("yahoo_coupon_watcher")

LOGIN_HINT = """
------------------------------------------------------------------
{browser} のウィンドウを開きました。

  1. 画面右上の「ログイン」から Yahoo! JAPAN にログインしてください
  2. 「ログイン状態を保持する」は必ずONのままにしてください
  3. トップページが表示されたらこのウィンドウは触らずに、
     ここ（コンソール）で Enter を押してください

ログイン情報はこのプロファイルフォルダに保存され、次回からは自動で
ログイン済みになります（毎日ログインする必要はありません）:
  {profile}
------------------------------------------------------------------
"""


def _resolve_browsers(config: dict, requested: str | None) -> list[str]:
    if requested in (None, "config"):
        return list(config["browsers"])
    if requested == "both":
        return ["edge", "chrome"]
    return [requested]


def cmd_login(args, config: dict) -> int:
    for browser in _resolve_browsers(config, args.browser):
        with open_context(
            browser,
            config["paths"]["profiles_dir"],
            headless=False,  # ログインは必ず画面を出す
            nav_timeout_seconds=config["crawl"]["nav_timeout_seconds"],
        ) as context:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(config["crawl"]["start_url"], wait_until="domcontentloaded")
            print(
                LOGIN_HINT.format(
                    browser=browser,
                    profile=profile_dir(config["paths"]["profiles_dir"], browser),
                )
            )
            input("ログインが終わったら Enter を押してください > ")
            log.info("%s のログイン状態を保存しました", browser)
    return 0


def cmd_test_notify(args, config: dict) -> int:
    notifier = build_notifier(config["notify"])
    hit = CouponHit(
        amount=5000,
        source="popup",
        snippet="スペシャルクーポン 5,000円OFF 残り180分限定（これはテスト通知です）",
        code="TESTCODE",
        time_limit_min=180,
        url=config["crawl"]["start_url"],
        browser="test",
    )
    notifier.send("【テスト】" + hit.title(), hit.body(), None)
    print("通知を送信しました。スマホに届いたか確認してください。")
    return 0


def cmd_capture(args, config: dict) -> int:
    """ページのテキストとHTMLを保存する。検出条件を調整したいときに使う。"""
    browser = _resolve_browsers(config, args.browser)[0]
    out_dir = Path(config["paths"]["data_dir"]) / "captures"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    with open_context(
        browser,
        config["paths"]["profiles_dir"],
        headless=False,
        nav_timeout_seconds=config["crawl"]["nav_timeout_seconds"],
    ) as context:
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(args.url or config["crawl"]["start_url"], wait_until="domcontentloaded")
        input("保存したい状態になったら Enter を押してください > ")
        text = page.inner_text("body")
        (out_dir / f"{stamp}_{browser}.txt").write_text(text, encoding="utf-8")
        (out_dir / f"{stamp}_{browser}.html").write_text(page.content(), encoding="utf-8")
        page.screenshot(path=str(out_dir / f"{stamp}_{browser}.png"), full_page=True)

    hits = scan_text(
        text,
        strict=True,
        min_amount=config["detect"]["min_amount"],
        max_amount=config["detect"]["max_amount"],
        amounts_whitelist=config["detect"]["amounts_whitelist"],
        ignore_patterns=config["detect"]["ignore_patterns"],
        browser=browser,
    )
    print(f"保存先: {out_dir}")
    print(f"このページからの検出結果: {[h.amount for h in hits] or 'なし'}")
    return 0


def cmd_scan_file(args, config: dict) -> int:
    """保存済みのテキスト/HTMLに対して検出ロジックを試す（ブラウザ不要）。"""
    text = Path(args.path).read_text(encoding="utf-8", errors="replace")
    for strict in (True, False):
        hits = scan_text(
            text,
            strict=strict,
            min_amount=config["detect"]["min_amount"],
            max_amount=config["detect"]["max_amount"],
            amounts_whitelist=config["detect"]["amounts_whitelist"],
            ignore_patterns=config["detect"]["ignore_patterns"],
        )
        label = "strict(ページ全体と同じ条件)" if strict else "loose(ポップアップ内と同じ条件)"
        print(f"[{label}] {len(hits)}件")
        for hit in hits:
            print(f"  - {hit.amount:,}円 code={hit.code} {hit.snippet[:120]!r}")
    return 0


def cmd_doctor(args, config: dict) -> int:
    print("== 設定 ==")
    print(f"  通知先          : {config['notify']['provider']}")
    print(f"  ブラウザ        : {', '.join(config['browsers'])}")
    print(f"  巡回間隔(分)    : {config['crawl']['interval_minutes']}")
    print(f"  1回のページ数   : {config['crawl']['pages_per_round']}")
    print(f"  停止時間帯      : {config['crawl']['quiet_hours']}")
    print(f"  検出下限        : {config['detect']['min_amount']:,}円")
    print(f"  自動獲得        : {config['detect']['auto_claim']}")
    print("== プロファイル ==")
    for browser in config["browsers"]:
        path = profile_dir(config["paths"]["profiles_dir"], browser)
        logged_in = (path / "Default" / "Cookies").exists() or (path / "Cookies").exists()
        state = "ログイン済みの可能性あり" if logged_in else "未ログイン（login を実行してください）"
        print(f"  {browser:6s} ({CHANNELS[browser]}): {path} — {state}")
    print("== Playwright ==")
    try:
        import playwright  # noqa: F401

        print("  playwright: OK")
    except ImportError:
        print("  playwright: 未インストール（setup.bat を実行してください）")
        return 1
    return 0


def cmd_run(args, config: dict) -> int:
    notifier = build_notifier(config["notify"])
    state = NotifyState(
        Path(config["paths"]["data_dir"]) / "notified.json",
        config["detect"]["dedupe_minutes"] * 60,
    )
    watcher = Watcher(config, notifier, state, rng=random.Random())
    browsers = _resolve_browsers(config, args.browser)
    max_rounds = 1 if args.once else int(config["crawl"]["max_rounds"])

    log.info("巡回を開始します: browsers=%s", browsers)
    round_index = 0
    try:
        while True:
            round_index += 1
            if max_rounds and round_index > max_rounds:
                log.info("指定ラウンド数に達したので終了します")
                break

            if not args.once and watcher.in_quiet_hours():
                log.info("停止時間帯なので30分待機します")
                time.sleep(1800)
                continue

            for browser in browsers:
                try:
                    with open_context(
                        browser,
                        config["paths"]["profiles_dir"],
                        headless=config["crawl"]["headless"],
                        nav_timeout_seconds=config["crawl"]["nav_timeout_seconds"],
                    ) as context:
                        found = watcher.run_round(context, browser)
                        log.info("[%s] ラウンド%d 完了 (通知 %d件)", browser, round_index, found)
                except Exception:
                    log.exception("[%s] ラウンド中にエラーが発生しました", browser)

            if max_rounds and round_index >= max_rounds:
                break
            wait = watcher.next_interval_seconds()
            log.info("次のラウンドまで %.1f 分待機します", wait / 60)
            time.sleep(wait)
    except KeyboardInterrupt:
        log.info("停止しました")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="yahoo_coupon_watcher",
        description="Yahoo!トラベルのスペシャルクーポンを見張ってスマホに通知します。",
    )
    parser.add_argument("-c", "--config", default="config.yaml", help="設定ファイル")
    parser.add_argument("-v", "--verbose", action="store_true", help="詳細ログ")
    sub = parser.add_subparsers(dest="command", required=True)

    browser_choices = ["edge", "chrome", "both", "config"]

    login = sub.add_parser("login", help="初回の手動ログイン")
    login.add_argument("--browser", choices=browser_choices, default="config")
    login.set_defaults(func=cmd_login)

    run = sub.add_parser("run", help="巡回して見張る")
    run.add_argument("--browser", choices=browser_choices, default="config")
    run.add_argument("--once", action="store_true", help="1ラウンドだけ実行して終了")
    run.set_defaults(func=cmd_run)

    test = sub.add_parser("test-notify", help="通知の疎通確認")
    test.set_defaults(func=cmd_test_notify)

    capture = sub.add_parser("capture", help="ページを保存して検出条件の調整に使う")
    capture.add_argument("--browser", choices=browser_choices, default="config")
    capture.add_argument("--url", default=None)
    capture.set_defaults(func=cmd_capture)

    scan = sub.add_parser("scan-file", help="保存済みファイルに検出ロジックを試す")
    scan.add_argument("path")
    scan.set_defaults(func=cmd_scan_file)

    doctor = sub.add_parser("doctor", help="設定と環境の確認")
    doctor.set_defaults(func=cmd_doctor)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"設定エラー: {exc}", file=sys.stderr)
        return 2
    setup_logging(config["paths"]["logs_dir"], args.verbose)
    return args.func(args, config)


if __name__ == "__main__":
    raise SystemExit(main())
