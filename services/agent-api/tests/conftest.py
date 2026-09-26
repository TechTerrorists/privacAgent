"""Pytest fixtures for the agent API test suites.

Redis is a hard requirement here by design (E-02 acceptance): if the test
Redis is unreachable the suite fails with instructions instead of silently
skipping. CI runs the same suite against a redis service container.
"""

from __future__ import annotations

import os

import pytest
import redis as redis_lib
from fastapi.testclient import TestClient

from privacagent_agent_api.app import create_app
from privacagent_agent_api.config import Settings
from privacagent_agent_api.fixtures import builtin_scenarios
from privacagent_agent_api.planner import ScriptedFakePlanner
from privacagent_agent_api.session_store import RedisSessionStore

# Dedicated logical DB keeps the test run from touching other data.
REDIS_URL = os.environ.get("PA_TEST_REDIS_URL", "redis://127.0.0.1:6379/15")

_REDIS_HINT = (
    "agent-api tests need a real Redis at "
    f"{REDIS_URL}; start one with "
    "'docker run --name pa-redis -p 6379:6379 -d redis:7-alpine'"
)


@pytest.fixture(scope="session")
def redis_client():
    client = redis_lib.Redis.from_url(
        REDIS_URL,
        decode_responses=True,
        socket_connect_timeout=2.0,
        socket_timeout=2.0,
    )
    try:
        client.ping()
    except redis_lib.RedisError as err:
        pytest.fail(f"{_REDIS_HINT} ({err})")
    client.flushdb()
    yield client
    client.flushdb()
    client.close()


@pytest.fixture
def store(redis_client):
    return RedisSessionStore(redis_client, ttl=1800)


@pytest.fixture
def planner():
    return ScriptedFakePlanner(builtin_scenarios())


@pytest.fixture
def make_client(redis_client):
    def _make(*, store=None, planner=None, settings=None, ttl=1800):
        settings = settings or Settings(
            redis_url=REDIS_URL, session_ttl=ttl, max_body_bytes=5 * 1024 * 1024
        )
        test_store = store or RedisSessionStore(redis_client, ttl=settings.session_ttl)
        test_planner = planner or ScriptedFakePlanner(builtin_scenarios())
        return TestClient(
            create_app(store=test_store, planner=test_planner, settings=settings),
            raise_server_exceptions=False,
        )

    return _make


@pytest.fixture
def client(make_client):
    return make_client()
