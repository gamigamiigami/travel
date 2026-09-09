"""Windows のトースト通知。PC作業中はこれが一番早く気づける。

PowerShell スクリプトに文字列を素で埋め込むと、日本語やクォートで簡単に壊れる。
ここではスクリプト全体を UTF-16LE + Base64 にして -EncodedCommand で渡すので、
文言に何が入っていてもエンコード事故が起きない。
"""

from __future__ import annotations

import base64
import logging
import platform
import subprocess

log = logging.getLogger(__name__)

APP_ID = "Yahoo Travel Coupon Watcher"

_TEMPLATE = """
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml({payload})
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier({app_id}).Show($toast)
"""


def _ps_single_quote(value: str) -> str:
    """PowerShell のシングルクォート文字列にする（' は '' でエスケープ）。"""
    return "'" + str(value).replace("'", "''") + "'"


def _xml_escape(value: str) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def build_script(title: str, message: str, app_id: str = APP_ID) -> str:
    # トーストは行数が限られるので本文は先頭数行に絞る。
    lines = [line for line in str(message).splitlines() if line.strip()][:4]
    body = "\n".join(lines)
    toast_xml = (
        "<toast><visual><binding template='ToastGeneric'>"
        f"<text>{_xml_escape(title)}</text>"
        f"<text>{_xml_escape(body)}</text>"
        "</binding></visual><audio src='ms-winsoundevent:Notification.Reminder'/></toast>"
    )
    return _TEMPLATE.format(
        payload=_ps_single_quote(toast_xml), app_id=_ps_single_quote(app_id)
    )


def encode_command(script: str) -> str:
    """PowerShell -EncodedCommand 用の Base64(UTF-16LE)。"""
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


class WindowsToastNotifier:
    name = "windows"

    def __init__(self, app_id: str = APP_ID, enabled: bool = True) -> None:
        self.app_id = app_id
        self.enabled = enabled

    def send(self, title: str, message: str, image_path=None) -> bool:
        if not self.enabled:
            return False
        if platform.system() != "Windows":
            log.debug("Windows以外なのでトースト通知はスキップします")
            return False
        script = build_script(title, message, self.app_id)
        try:
            subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-EncodedCommand",
                    encode_command(script),
                ],
                check=True,
                capture_output=True,
                timeout=20,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return True
        except Exception:
            log.warning("Windowsトースト通知に失敗しました", exc_info=True)
            return False
