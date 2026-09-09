#!/usr/bin/env python3
"""LCM database assertions for Hermes regular-Chat QA."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from typing import Any


DEFAULT_DB = Path(os.environ.get("CODEX_HERMES_QA_LCM_DB", "/home/chris/.hermes/lcm.db"))


@dataclass(frozen=True)
class LCMRow:
    rowid: int
    store_id: int
    session_id: str | None
    role: str
    content: str
    tool_call_id: str | None
    tool_name: str | None
    conversation_id: str | None

    def digest(self) -> str:
        payload = json.dumps(
            {
                "rowid": self.rowid,
                "store_id": self.store_id,
                "session_id": self.session_id,
                "role": self.role,
                "content": self.content,
                "tool_call_id": self.tool_call_id,
                "tool_name": self.tool_name,
                "conversation_id": self.conversation_id,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8", "replace")
        return hashlib.sha256(payload).hexdigest()


class LCMDatabase:
    def __init__(self, path: Path = DEFAULT_DB):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        if not self.path.is_file():
            raise FileNotFoundError(self.path)
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def total_messages(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0])

    def rows(self, conversation_id: str) -> list[LCMRow]:
        with self._connect() as connection:
            values = connection.execute(
                """
                SELECT rowid AS qa_rowid, store_id, session_id, role, content, tool_call_id,
                       tool_name, conversation_id
                FROM messages
                WHERE conversation_id = ?
                ORDER BY rowid
                """,
                (conversation_id,),
            ).fetchall()
        return [
            LCMRow(
                rowid=int(row["qa_rowid"]),
                store_id=int(row["store_id"]),
                session_id=row["session_id"],
                role=str(row["role"]),
                content=str(row["content"] or ""),
                tool_call_id=row["tool_call_id"],
                tool_name=row["tool_name"],
                conversation_id=row["conversation_id"],
            )
            for row in values
        ]

    def conversation_counts(self) -> dict[str, int]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT conversation_id, COUNT(*) AS count FROM messages WHERE conversation_id IS NOT NULL GROUP BY conversation_id"
            ).fetchall()
        return {str(row["conversation_id"]): int(row["count"]) for row in rows}

    def integrity(self) -> dict[str, Any]:
        with self._connect() as connection:
            integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            foreign_keys = [dict(row) for row in connection.execute("PRAGMA foreign_key_check").fetchall()]
            messages = int(connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0])
            fts = int(connection.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0])
        return {
            "integrity_check": integrity,
            "foreign_key_violations": foreign_keys,
            "messages": messages,
            "messages_fts": fts,
            "fts_matches_messages": messages == fts,
        }

    def lifecycle_state(self, conversation_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM lcm_lifecycle_state WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return dict(row) if row is not None else None


def row_digests(rows: list[LCMRow]) -> dict[int, str]:
    return {row.rowid: row.digest() for row in rows}


def assert_prefix_unchanged(before: list[LCMRow], after: list[LCMRow]) -> None:
    before_hashes = row_digests(before)
    after_hashes = row_digests(after)
    for rowid, digest in before_hashes.items():
        if after_hashes.get(rowid) != digest:
            raise AssertionError(f"LCM row {rowid} changed or disappeared across reopen")


def tool_pairs(rows: list[LCMRow]) -> list[tuple[LCMRow, LCMRow]]:
    pairs: list[tuple[LCMRow, LCMRow]] = []
    pending: dict[str, LCMRow] = {}
    for row in rows:
        if row.role == "tool_call" and row.tool_call_id:
            pending[row.tool_call_id] = row
        elif row.role == "tool" and row.tool_call_id and row.tool_call_id in pending:
            pairs.append((pending.pop(row.tool_call_id), row))
    return pairs
