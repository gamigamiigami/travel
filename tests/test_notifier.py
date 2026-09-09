import pytest

from yahoo_coupon_watcher.notifier import MultiNotifier, build_notifier


class Recorder:
    def __init__(self, name, ok=True, raises=False):
        self.name = name
        self.ok = ok
        self.raises = raises
        self.calls = []

    def send(self, title, message, image_path=None):
        self.calls.append((title, message, image_path))
        if self.raises:
            raise RuntimeError("boom")
        return self.ok


def test_all_providers_receive_the_notification():
    a, b = Recorder("a"), Recorder("b")
    assert MultiNotifier([a, b]).send("t", "m") is True
    assert len(a.calls) == 1 and len(b.calls) == 1


def test_one_failure_does_not_stop_the_others():
    broken, working = Recorder("broken", raises=True), Recorder("working")
    assert MultiNotifier([broken, working]).send("t", "m") is True
    assert len(working.calls) == 1


def test_returns_false_when_nothing_delivered():
    assert MultiNotifier([Recorder("a", ok=False)]).send("t", "m") is False


def test_build_notifier_combines_providers():
    notifier = build_notifier(
        {"providers": ["console", "windows"], "also_console": False, "windows": {}}
    )
    assert isinstance(notifier, MultiNotifier)
    assert [n.name for n in notifier.notifiers] == ["console", "windows"]


def test_build_notifier_appends_console_when_requested():
    notifier = build_notifier({"providers": ["windows"], "also_console": True, "windows": {}})
    assert [n.name for n in notifier.notifiers] == ["windows", "console"]


def test_build_notifier_rejects_unknown():
    with pytest.raises(ValueError, match="line"):
        build_notifier({"providers": ["line"], "also_console": False})
