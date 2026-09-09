"""Edge / Chrome を「専用プロファイル」で永続起動する。

launch_persistent_context を使うので、Cookie もログイン状態もプロファイル
ディレクトリに残る。つまり最初に1回だけ手動ログインすれば、あとはずっと
ログインしたまま動く（Yahoo!側でセッションが切れない限り）。

Edge と Chrome でプロファイルを分けているのは、抽選が別枠である可能性に
賭けるため。同じプロファイルを使い回すと意味がなくなる。
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from playwright.sync_api import BrowserContext, sync_playwright

log = logging.getLogger(__name__)

CHANNELS = {"edge": "msedge", "chrome": "chrome"}

# 自動操作であることを必要以上に主張しないための最小限の設定。
# あくまで自分のアカウントで自分の分の抽選を回すための個人用ツール。
LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-default-browser-check",
    "--no-first-run",
    "--disable-features=Translate,MediaRouter",
]

INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
"""


def profile_dir(profiles_root: str | Path, browser: str) -> Path:
    path = Path(profiles_root) / browser
    path.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def open_context(
    browser: str,
    profiles_root: str | Path,
    *,
    headless: bool = False,
    nav_timeout_seconds: float = 45,
) -> Iterator[BrowserContext]:
    """指定ブラウザの永続コンテキストを開く。"""
    if browser not in CHANNELS:
        raise ValueError(f"未対応のブラウザです: {browser}")

    user_data_dir = profile_dir(profiles_root, browser)
    log.info("%s を起動します (profile=%s, headless=%s)", browser, user_data_dir, headless)

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(user_data_dir),
            channel=CHANNELS[browser],
            headless=headless,
            args=LAUNCH_ARGS,
            locale="ja-JP",
            timezone_id="Asia/Tokyo",
            viewport={"width": 1280, "height": 900},
            ignore_default_args=["--enable-automation"],
        )
        context.set_default_navigation_timeout(nav_timeout_seconds * 1000)
        context.set_default_timeout(min(nav_timeout_seconds, 15) * 1000)
        try:
            context.add_init_script(INIT_SCRIPT)
        except Exception:
            log.debug("init script の登録に失敗しました", exc_info=True)
        try:
            yield context
        finally:
            try:
                context.close()
            except Exception:
                log.debug("コンテキストのクローズに失敗しました", exc_info=True)
