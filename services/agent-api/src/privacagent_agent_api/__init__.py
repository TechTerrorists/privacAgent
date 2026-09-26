"""E-02 Agent API skeleton.

FastAPI service that lets extension and server contributors exercise the shared
E-01 protocol against a deterministic local service before planner models exist.
Perception, redaction and egress remain client-side concerns; this server only
ever sees the sanitized Screen State and returns structured Actions.
"""

from .app import create_app

__all__ = ["create_app"]
__version__ = "0.1.0"
