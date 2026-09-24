"""Run the agent API with uvicorn: ``python -m privacagent_agent_api``."""

from __future__ import annotations

import uvicorn


def main() -> None:
    uvicorn.run(
        "privacagent_agent_api.app:app",
        host="127.0.0.1",
        port=8000,
        log_level="info",
    )


if __name__ == "__main__":
    main()