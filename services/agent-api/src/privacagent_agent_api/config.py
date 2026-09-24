"""Runtime settings for the agent API.

Values come from the environment and are fixed at process start. Nothing here
reads page or task data: this module only picks connection and safety bounds.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

PROTOCOL_MAX_SESSION_TTL = 1800
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"
DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024
DEFAULT_DEBUG_LOG_PATH = "debug.log"


@dataclass(frozen=True)
class Settings:
    redis_url: str
    session_ttl: int
    max_body_bytes: int
    debug_log_path: str = DEFAULT_DEBUG_LOG_PATH

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            redis_url=os.environ.get("PA_REDIS_URL", DEFAULT_REDIS_URL),
            session_ttl=int(os.environ.get("PA_SESSION_TTL", str(PROTOCOL_MAX_SESSION_TTL))),
            max_body_bytes=int(
                os.environ.get("PA_MAX_BODY_BYTES", str(DEFAULT_MAX_BODY_BYTES))
            ),
            debug_log_path=os.environ.get(
                "PA_DEBUG_LOG", DEFAULT_DEBUG_LOG_PATH
            ),
        )

    def __post_init__(self) -> None:
        if not 1 <= self.session_ttl <= PROTOCOL_MAX_SESSION_TTL:
            raise ValueError(
                f"PA_SESSION_TTL must be in [1, {PROTOCOL_MAX_SESSION_TTL}] seconds "
                f"(protocol ceiling), got {self.session_ttl}"
            )
        if self.max_body_bytes < 1:
            raise ValueError(f"PA_MAX_BODY_BYTES must be positive, got {self.max_body_bytes}")