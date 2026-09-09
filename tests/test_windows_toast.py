"""Windowsトースト通知。GPT版は文字列を素で埋め込んでいて壊れやすいので、
UTF-16LE+Base64 の -EncodedCommand で渡す方式にした。そのエンコードのテスト。"""

import base64

from yahoo_coupon_watcher.notifier.windows_toast import (
    WindowsToastNotifier,
    build_script,
    encode_command,
)


def test_japanese_survives_encoding():
    script = build_script("Yahoo!トラベル 5,000円OFFクーポン出現！", "根拠: スペシャルクーポン")
    decoded = base64.b64decode(encode_command(script)).decode("utf-16-le")
    assert decoded == script
    assert "5,000円OFFクーポン出現！" in decoded


def test_single_quote_cannot_break_out_of_powershell_string():
    script = build_script("It's a coupon", "don't panic")
    # PowerShell のシングルクォート文字列では ' は '' でエスケープする。
    # XMLエスケープ後なので生の ' はそもそも残らない。
    assert "&apos;" in script
    assert script.count("$xml.LoadXml('") == 1


def test_xml_special_chars_escaped():
    script = build_script("<b>タグ</b> & \"引用\"", "a < b > c")
    assert "&lt;b&gt;" in script
    assert "&amp;" in script
    assert "<b>" not in script.split("LoadXml")[1].split("\n")[0].replace("<toast>", "")


def test_body_is_trimmed_to_a_few_lines():
    body = "\n".join(f"行{i}" for i in range(20))
    script = build_script("t", body)
    assert "行0" in script
    assert "行9" not in script


def test_non_windows_is_a_noop():
    # Linux 上のテストなので send は False を返して何もしない
    assert WindowsToastNotifier().send("t", "m") is False


def test_disabled_notifier_is_a_noop():
    assert WindowsToastNotifier(enabled=False).send("t", "m") is False
