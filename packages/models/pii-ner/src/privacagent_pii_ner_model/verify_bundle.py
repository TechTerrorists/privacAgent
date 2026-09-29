"""Verify extracted runtime artifacts before handing them to D-08.

First verify the downloaded archive against the committed artifact_manifest.json;
an untrusted manifest stored inside an archive is not a trust anchor.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .export_onnx import sha256_of_file


def verify(directory: str, trusted_manifest: str) -> None:
    root = Path(directory).resolve()
    manifest = json.loads(Path(trusted_manifest).read_text())
    for relative, metadata in manifest["files"].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("missing or invalid artifact path")
        if (
            path.stat().st_size != metadata["size_bytes"]
            or sha256_of_file(str(path)) != metadata["sha256"]
        ):
            raise ValueError(f"artifact checksum mismatch: {relative}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    verify(args.directory, args.manifest)


if __name__ == "__main__":
    main()
