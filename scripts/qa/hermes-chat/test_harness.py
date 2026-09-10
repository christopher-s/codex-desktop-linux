#!/usr/bin/env python3
"""Offline regression tests for the Hermes regular-Chat QA harness."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app import sh_quote, transient_environment_args
from cdp_client import CDPError, CDPTarget, select_shell_target
from chat import _draft_expression
from lifecycle import identity_pairs
from lcm import LCMDatabase, assert_prefix_unchanged, tool_pairs


class CDPTargetTests(unittest.TestCase):
    def target(self, kind: str, url: str, ident: str) -> CDPTarget:
        return CDPTarget(ident, kind, url, ident, f"ws://127.0.0.1/{ident}")

    def test_select_shell_ignores_overlay_and_hidden_webview(self) -> None:
        shell = self.target("page", "app://-/index.html", "shell")
        targets = [
            self.target("page", "app://-/index.html?initialRoute=%2Favatar-overlay", "overlay"),
            self.target("webview", "https://chatgpt.com/?source=codex-embedded-checkout#pricing", "guest"),
            shell,
        ]
        self.assertEqual(select_shell_target(targets), shell)

    def test_select_shell_fails_closed_on_ambiguity(self) -> None:
        targets = [
            self.target("page", "app://-/index.html", "one"),
            self.target("page", "app://-/index.html", "two"),
        ]
        with self.assertRaises(CDPError):
            select_shell_target(targets)


class PromptEncodingTests(unittest.TestCase):
    def test_draft_expression_does_not_embed_raw_prompt(self) -> None:
        prompt = "apostrophe ' quote \" slash \\ newline\nemoji 🧪"
        expression = _draft_expression(prompt, replace=True)
        self.assertNotIn(prompt, expression)
        self.assertIn("TextDecoder('utf-8')", expression)
        self.assertIn("atob", expression)
        self.assertIn("document.execCommand('insertText'", expression)


class LifecycleTests(unittest.TestCase):
    def test_identity_pairs_deduplicate_and_filter(self) -> None:
        events = [
            {
                "event": "conversation_identity_observed",
                "client_conversation_id": "local-chatgpt:abc",
                "server_conversation_id": "11111111-1111-1111-1111-111111111111",
            },
            {
                "event": "conversation_identity_observed",
                "client_conversation_id": "local-chatgpt:abc",
                "server_conversation_id": "11111111-1111-1111-1111-111111111111",
            },
            {
                "event": "session_open",
                "conversation_id": "local-chatgpt:def",
                "server_conversation_id": "22222222-2222-2222-2222-222222222222",
            },
        ]
        self.assertEqual(
            identity_pairs(events),
            [
                ("local-chatgpt:abc", "11111111-1111-1111-1111-111111111111"),
                ("local-chatgpt:def", "22222222-2222-2222-2222-222222222222"),
            ],
        )


class LCMTests(unittest.TestCase):
    def make_db(self, path: Path) -> None:
        con = sqlite3.connect(path)
        con.executescript(
            """
            CREATE TABLE messages (
              store_id INTEGER PRIMARY KEY,
              session_id TEXT,
              role TEXT NOT NULL,
              content TEXT,
              tool_call_id TEXT,
              tool_name TEXT,
              conversation_id TEXT
            );
            CREATE VIRTUAL TABLE messages_fts USING fts5(content);
            CREATE TABLE lcm_lifecycle_state (
              conversation_id TEXT PRIMARY KEY,
              current_session_id TEXT
            );
            """
        )
        con.executemany(
            "INSERT INTO messages(store_id,session_id,role,content,tool_call_id,tool_name,conversation_id) VALUES(?,?,?,?,?,?,?)",
            [
                (1, "hs_one", "tool_call", "call", "call-1", "process_manage", "local-chatgpt:abc"),
                (2, "hs_one", "tool", "result", "call-1", "process_manage", "local-chatgpt:abc"),
            ],
        )
        con.executemany("INSERT INTO messages_fts(content) VALUES(?)", [("call",), ("result",)])
        con.commit()
        con.close()

    def test_rows_pairs_integrity_and_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "lcm.db"
            self.make_db(path)
            db = LCMDatabase(path)
            before = db.rows("local-chatgpt:abc")
            self.assertEqual(len(tool_pairs(before)), 1)
            self.assertEqual(db.integrity()["integrity_check"], "ok")
            self.assertTrue(db.integrity()["fts_matches_messages"])

            con = sqlite3.connect(path)
            con.executemany(
                "INSERT INTO messages(store_id,session_id,role,content,tool_call_id,tool_name,conversation_id) VALUES(?,?,?,?,?,?,?)",
                [
                    (3, "hs_two", "tool_call", "call2", "call-2", "process_manage", "local-chatgpt:abc"),
                    (4, "hs_two", "tool", "result2", "call-2", "process_manage", "local-chatgpt:abc"),
                ],
            )
            con.executemany("INSERT INTO messages_fts(content) VALUES(?)", [("call2",), ("result2",)])
            con.commit()
            con.close()

            after = db.rows("local-chatgpt:abc")
            assert_prefix_unchanged(before, after)
            self.assertEqual(len(tool_pairs(after)), 2)

    def test_logical_message_reads_force_base_table(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "lcm.db"
            self.make_db(path)
            db = LCMDatabase(path)
            statements: list[str] = []
            original_connect = db._connect

            def traced_connect() -> sqlite3.Connection:
                connection = original_connect()
                connection.set_trace_callback(statements.append)
                return connection

            db._connect = traced_connect  # type: ignore[method-assign]
            db.total_messages()
            db.rows("local-chatgpt:abc")
            db.conversation_counts()
            db.integrity()

            normalized = [" ".join(statement.split()) for statement in statements]
            self.assertTrue(any("SELECT COUNT(*) FROM messages NOT INDEXED" in sql for sql in normalized))
            self.assertTrue(
                any(
                    "FROM messages NOT INDEXED WHERE conversation_id = 'local-chatgpt:abc'" in sql
                    for sql in normalized
                )
            )
            self.assertTrue(
                any(
                    "FROM messages NOT INDEXED WHERE conversation_id IS NOT NULL GROUP BY conversation_id"
                    in sql
                    for sql in normalized
                )
            )


class AppEnvironmentTests(unittest.TestCase):
    def test_transient_unit_forwards_only_isolated_lcm_and_qa_controls(self) -> None:
        keys = (
            "LCM_DATABASE_PATH",
            "CODEX_HERMES_QA_FAULT",
            "CODEX_HERMES_QA_FAST_BEGIN",
            "CODEX_HERMES_QA_FAST_IDENTITY",
            "CODEX_HERMES_QA_SESSION_INIT",
            "HERMES_HOME",
        )
        old = {key: os.environ.get(key) for key in keys}
        try:
            os.environ["LCM_DATABASE_PATH"] = "/tmp/hermes-qa-isolated-lcm.db"
            os.environ["CODEX_HERMES_QA_FAULT"] = "identity_only"
            os.environ["CODEX_HERMES_QA_FAST_BEGIN"] = "1"
            os.environ["CODEX_HERMES_QA_FAST_IDENTITY"] = "1"
            os.environ["CODEX_HERMES_QA_SESSION_INIT"] = "minimal"
            os.environ["HERMES_HOME"] = "/tmp/must-not-forward"
            self.assertEqual(
                transient_environment_args(),
                [
                    "--setenv=LCM_DATABASE_PATH=/tmp/hermes-qa-isolated-lcm.db",
                    "--setenv=CODEX_HERMES_QA_FAULT=identity_only",
                    "--setenv=CODEX_HERMES_QA_FAST_BEGIN=1",
                    "--setenv=CODEX_HERMES_QA_FAST_IDENTITY=1",
                    "--setenv=CODEX_HERMES_QA_SESSION_INIT=minimal",
                ],
            )
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class ShellQuoteTests(unittest.TestCase):
    def test_shell_quote_handles_apostrophe(self) -> None:
        self.assertEqual(sh_quote("a'b"), "'a'\"'\"'b'")


if __name__ == "__main__":
    unittest.main(verbosity=2)
