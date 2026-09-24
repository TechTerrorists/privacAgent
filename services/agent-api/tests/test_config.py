"""Settings validation and environment parsing bounds."""

from __future__ import annotations

import pytest

from privacagent_agent_api.config import Settings


def test_settings_rejects_zero_session_ttl() -> None:
    with pytest.raises(ValueError):
        Settings(redis_url="redis://x", session_ttl=0, max_body_bytes=1)


def test_settings_rejects_session_ttl_above_protocol_ceiling() -> None:
    with pytest.raises(ValueError):
        Settings(redis_url="redis://x", session_ttl=1801, max_body_bytes=1)


def test_settings_rejects_zero_max_body_bytes() -> None:
    with pytest.raises(ValueError):
        Settings(redis_url="redis://x", session_ttl=1, max_body_bytes=0)


def test_settings_accepts_boundary_values() -> None:
    Settings(redis_url="redis://x", session_ttl=1, max_body_bytes=1)
    Settings(redis_url="redis://x", session_ttl=1800, max_body_bytes=1)


def test_from_env_defaults_when_pa_vars_unset(monkeypatch) -> None:
    for var in ("PA_REDIS_URL", "PA_SESSION_TTL", "PA_MAX_BODY_BYTES"):
        monkeypatch.delenv(var, raising=False)
    settings = Settings.from_env()
    assert settings.redis_url == "redis://127.0.0.1:6379/0"
    assert settings.session_ttl == 1800
    assert settings.max_body_bytes == 5242880


def test_from_env_respects_pa_overrides(monkeypatch) -> None:
    monkeypatch.setenv("PA_REDIS_URL", "redis://example.test:6379/1")
    monkeypatch.setenv("PA_SESSION_TTL", "600")
    monkeypatch.setenv("PA_MAX_BODY_BYTES", "1024")
    settings = Settings.from_env()
    assert settings.redis_url == "redis://example.test:6379/1"
    assert settings.session_ttl == 600
    assert settings.max_body_bytes == 1024


def test_from_env_rejects_non_integer_session_ttl(monkeypatch) -> None:
    monkeypatch.setenv("PA_SESSION_TTL", "abc")
    with pytest.raises(ValueError):
        Settings.from_env()
