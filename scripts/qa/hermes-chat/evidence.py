#!/usr/bin/env python3
"""Durable per-run evidence bundles for Hermes regular-Chat QA."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import uuid
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ROOT = REPO_ROOT / ".codex-linux" / "qa" / "hermes-chat"


def _git(args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


@dataclass
class EvidenceRun:
    name: str
    root: Path = DEFAULT_ROOT
    run_id: str = field(init=False)
    directory: Path = field(init=False)
    document: dict[str, Any] = field(init=False)

    def __post_init__(self) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.run_id = f"{stamp}-{self.name}-{uuid.uuid4().hex[:8]}"
        self.directory = self.root / self.run_id
        self.directory.mkdir(parents=True, exist_ok=False)
        self.document = {
            "schema": 1,
            "run_id": self.run_id,
            "name": self.name,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "git": {
                "head": _git(["rev-parse", "HEAD"]),
                "branch": _git(["branch", "--show-current"]),
                "status": _git(["status", "--short"]),
            },
            "steps": [],
        }
        self.flush()

    def record(self, step: str, **values: Any) -> None:
        self.document["steps"].append(
            {
                "at": datetime.now(timezone.utc).isoformat(),
                "step": step,
                **values,
            }
        )
        self.flush()

    def finish(self, verdict: str, **values: Any) -> None:
        self.document["finished_at"] = datetime.now(timezone.utc).isoformat()
        self.document["verdict"] = verdict
        self.document.update(values)
        self.flush()

    def write_text(self, name: str, content: str) -> Path:
        path = self.directory / name
        path.write_text(content, encoding="utf-8")
        return path

    def write_json(self, name: str, value: Any) -> Path:
        path = self.directory / name
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path

    def flush(self) -> None:
        (self.directory / "evidence.json").write_text(
            json.dumps(self.document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
