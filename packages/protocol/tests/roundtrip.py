"""JSON-only bridge for the TypeScript -> Python -> TypeScript contract test."""

import json
import sys

from privacagent_protocol import is_message, parse_message


def main() -> None:
    cases = json.load(sys.stdin)
    results = []
    for case in cases:
        valid = is_message(case["message"], case["payload"])
        result = {"name": case["name"], "valid": valid}
        if valid:
            model = parse_message(case["message"], case["payload"])
            # Omitted optional properties must remain absent, not become null.
            result["payload"] = model.model_dump(mode="json", exclude_unset=True)
        results.append(result)
    json.dump(results, sys.stdout, allow_nan=False, ensure_ascii=False)


if __name__ == "__main__":
    main()
