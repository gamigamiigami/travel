import pytest
import yaml

from yahoo_coupon_watcher.config import (
    ConfigError,
    load_config,
    load_dotenv,
    rand_range,
)


def write(tmp_path, data):
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    return path


def load(tmp_path, data):
    """テストが実行環境の .env を拾わないよう、必ず tmp を見させる。"""
    return load_config(write(tmp_path, data), env_path=tmp_path / ".env")


def test_defaults_are_merged(tmp_path):
    config = load(tmp_path, {"notify": {"providers": ["ntfy"], "ntfy": {"topic": "abc"}}})
    assert config["notify"]["ntfy"]["server"] == "https://ntfy.sh"
    assert config["browsers"] == ["edge", "chrome"]
    assert config["detect"]["dedupe_minutes"] == 180
    assert config["crawl"]["targets"][0]["url"] == "https://travel.yahoo.co.jp/"


def test_missing_file(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / "nope.yaml", env_path=tmp_path / ".env")


def test_ntfy_topic_required(tmp_path):
    with pytest.raises(ConfigError, match="トピック"):
        load(tmp_path, {"notify": {"providers": ["ntfy"]}})


def test_unknown_provider_rejected(tmp_path):
    with pytest.raises(ConfigError, match="line"):
        load(tmp_path, {"notify": {"providers": ["line"]}})


def test_unknown_browser_rejected(tmp_path):
    with pytest.raises(ConfigError, match="firefox"):
        load(
            tmp_path,
            {"notify": {"providers": ["console"]}, "browsers": ["edge", "firefox"]},
        )


def test_console_provider_needs_nothing(tmp_path):
    config = load(tmp_path, {"notify": {"providers": ["console"]}})
    assert config["notify"]["providers"] == ["console"]


def test_multiple_providers(tmp_path):
    config = load(
        tmp_path, {"notify": {"providers": ["ntfy", "windows"], "ntfy": {"topic": "t"}}}
    )
    assert config["notify"]["providers"] == ["ntfy", "windows"]


def test_empty_targets_rejected(tmp_path):
    with pytest.raises(ConfigError, match="targets"):
        load(tmp_path, {"notify": {"providers": ["console"]}, "crawl": {"targets": []}})


def test_malformed_target_rejected(tmp_path):
    with pytest.raises(ConfigError, match="targets"):
        load(
            tmp_path,
            {"notify": {"providers": ["console"]}, "crawl": {"targets": [{"name": "x"}]}},
        )


# ----------------------------------------------------------------- .env

def test_dotenv_parsing(tmp_path, monkeypatch):
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    env = tmp_path / ".env"
    env.write_text(
        "\n".join(
            [
                "# コメント行",
                "",
                'NTFY_TOPIC="quoted-topic"',
                "DISCORD_WEBHOOK_URL=https://example.com/hook",
                "壊れた行",
            ]
        ),
        encoding="utf-8",
    )
    loaded = load_dotenv(env)
    assert loaded["NTFY_TOPIC"] == "quoted-topic"
    assert loaded["DISCORD_WEBHOOK_URL"] == "https://example.com/hook"
    assert "壊れた行" not in loaded


def test_env_overrides_config(tmp_path, monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "from-env")
    config = load(tmp_path, {"notify": {"providers": ["ntfy"], "ntfy": {"topic": "from-yaml"}}})
    assert config["notify"]["ntfy"]["topic"] == "from-env"


def test_env_satisfies_validation_without_yaml(tmp_path, monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "secret-topic")
    config = load(tmp_path, {"notify": {"providers": ["ntfy"]}})
    assert config["notify"]["ntfy"]["topic"] == "secret-topic"


def test_dotenv_does_not_override_real_env(tmp_path, monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "already-set")
    (tmp_path / ".env").write_text("NTFY_TOPIC=from-file", encoding="utf-8")
    load_dotenv(tmp_path / ".env")
    import os

    assert os.environ["NTFY_TOPIC"] == "already-set"


def test_rand_range():
    assert rand_range([5, 10]) == (5.0, 10.0)
    assert rand_range([10, 5]) == (5.0, 10.0)
    assert rand_range(7) == (7.0, 7.0)
    with pytest.raises(ConfigError):
        rand_range([1, 2, 3])
