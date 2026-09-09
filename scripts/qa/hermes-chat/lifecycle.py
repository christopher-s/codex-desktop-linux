#!/usr/bin/env python3
"""Read and correlate Hermes lifecycle JSONL evidence."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any, Iterable


DEFAULT_LOG = Path(
    os.environ.get(
        "CODEX_HERMES_QA_LIFECYCLE_LOG",
        "/home/chris/.local/state/codex-desktop/hermes-chat-lifecycle.jsonl",
    )
)


@dataclass(frozen=True)
class LifecycleBaseline:
    line_count: int
    size: int


class LifecycleLog:
    def __init__(self, path: Path = DEFAULT_LOG):
        self.path = path

    def baseline(self) -> LifecycleBaseline:
        if not self.path.exists():
            return LifecycleBaseline(0, 0)
        with self.path.open("r", encoding="utf-8", errors="replace") as handle:
            lines = sum(1 for _ in handle)
        return LifecycleBaseline(lines, self.path.stat().st_size)

    def events_since(self, baseline: LifecycleBaseline) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        events: list[dict[str, Any]] = []
        with self.path.open("r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                if index < baseline.line_count:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    events.append({"event": "qa_unparseable_lifecycle_line", "raw": line})
                    continue
                if isinstance(value, dict):
                    events.append(value)
        return events


def by_session(events: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        session_id = event.get("session_id")
        if isinstance(session_id, str) and session_id:
            result.setdefault(session_id, []).append(event)
    return result


def conversation_ids(events: Iterable[dict[str, Any]]) -> set[str]:
    result: set[str] = set()
    for event in events:
        for key in ("conversation_id", "client_conversation_id", "server_conversation_id"):
            value = event.get(key)
            if isinstance(value, str) and value:
                result.add(value)
    return result


def session_open_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event.get("event") == "session_open"]


def finalization_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event.get("event") == "session_finalize"]


def conversation_identity_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event.get("event") == "conversation_identity_observed"]


def identity_pairs(events: Iterable[dict[str, Any]]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for event in conversation_identity_events(events):
        client_id = event.get("client_conversation_id")
        server_id = event.get("server_conversation_id")
        if not isinstance(client_id, str) or not client_id.startswith("local-chatgpt:"):
            continue
        if not isinstance(server_id, str) or not server_id or server_id.startswith("local-chatgpt:"):
            continue
        pair = (client_id, server_id)
        if pair not in seen:
            seen.add(pair)
            pairs.append(pair)
    return pairs


def failed_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for event in events:
        if event.get("ok") is False or event.get("event") in {"conversation_alias_conflict", "qa_unparseable_lifecycle_line"}:
            failures.append(event)
    return failures


def event_names(events: Iterable[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for event in events:
        value = event.get("event") or event.get("phase")
        if isinstance(value, str):
            names.append(value)
    return names


def assert_subsequence(actual: Iterable[str], expected: Iterable[str]) -> None:
    actual_list = list(actual)
    cursor = 0
    for expected_value in expected:
        while cursor < len(actual_list) and actual_list[cursor] != expected_value:
            cursor += 1
        if cursor >= len(actual_list):
            raise AssertionError(f"missing ordered lifecycle event {expected_value!r}; actual={actual_list}")
        cursor += 1
