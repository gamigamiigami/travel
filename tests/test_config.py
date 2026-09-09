import pytest
import yaml

from yahoo_coupon_watcher.config import ConfigError, load_config, rand_range


def write(tmp_path, data):
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    return path


def test_defaults_are_merged(tmp_path):
    path = write(tmp_path, {"notify": {"provider": "ntfy", "ntfy": {"topic": "abc"}}})
    config = load_config(path)
    assert config["notify"]["ntfy"]["server"] == "https://ntfy.sh"
    assert config["notify"]["ntfy"]["topic"] == "abc"
    assert config["browsers"] == ["edge", "chrome"]
    assert config["detect"]["dedupe_minutes"] == 180


def test_missing_file(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / "nope.yaml")


def test_ntfy_topic_required(tmp_path):
    path = write(tmp_path, {"notify": {"provider": "ntfy"}})
    with pytest.raises(ConfigError, match="topic"):
        load_config(path)


def test_unknown_browser_rejected(tmp_path):
    path = write(
        tmp_path,
        {"notify": {"provider": "console"}, "browsers": ["edge", "firefox"]},
    )
    with pytest.raises(ConfigError, match="firefox"):
        load_config(path)


def test_console_provider_needs_nothing(tmp_path):
    config = load_config(write(tmp_path, {"notify": {"provider": "console"}}))
    assert config["notify"]["provider"] == "console"


def test_rand_range():
    assert rand_range([5, 10]) == (5.0, 10.0)
    assert rand_range([10, 5]) == (5.0, 10.0)
    assert rand_range(7) == (7.0, 7.0)
    with pytest.raises(ConfigError):
        rand_range([1, 2, 3])
