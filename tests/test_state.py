from yahoo_coupon_watcher.state import NotifyState


def test_first_time_notifies(tmp_path):
    state = NotifyState(tmp_path / "s.json", dedupe_seconds=600)
    assert state.should_notify("edge|5000|X")


def test_repeat_suppressed_then_allowed_after_window(tmp_path):
    state = NotifyState(tmp_path / "s.json", dedupe_seconds=600)
    state.mark_notified("edge|5000|X", now=1000.0)
    assert not state.should_notify("edge|5000|X", now=1100.0)
    assert state.should_notify("edge|5000|X", now=1000.0 + 600)


def test_persists_across_instances(tmp_path):
    path = tmp_path / "s.json"
    NotifyState(path, 600).mark_notified("edge|5000|X", now=1000.0)
    assert not NotifyState(path, 600).should_notify("edge|5000|X", now=1100.0)


def test_prune_drops_expired(tmp_path):
    path = tmp_path / "s.json"
    state = NotifyState(path, 600)
    state.mark_notified("old", now=0.0)
    state.mark_notified("new", now=10_000.0)
    assert state.should_notify("old", now=10_000.0)
    assert not state.should_notify("new", now=10_000.0)


def test_corrupted_file_is_ignored(tmp_path):
    path = tmp_path / "s.json"
    path.write_text("{ not json", encoding="utf-8")
    assert NotifyState(path, 600).should_notify("anything")
