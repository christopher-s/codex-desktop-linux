#!/usr/bin/env python3
"""Minimal MCP client for the repository's Linux Computer Use backend.

This QA-side client deliberately talks to `codex-computer-use-linux mcp`
directly. It gives the Hermes regular-Chat tests an independent visual/input
channel without adding test-only behavior to the production backend.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_BINARY = Path(
    os.environ.get(
        "CODEX_HERMES_QA_COMPUTER_USE_BIN",
        str(REPO_ROOT / "target" / "release" / "codex-computer-use-linux"),
    )
)


class ComputerUseError(RuntimeError):
    pass


@dataclass(frozen=True)
class ScreenshotEvidence:
    path: Path
    mime_type: str
    structured: dict[str, Any]


class ComputerUseClient:
    def __init__(self, binary: Path = DEFAULT_BINARY, timeout: float = 120.0):
        self.binary = binary
        self.timeout = timeout
        self._process: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._lock = threading.Lock()

    def __enter__(self) -> "ComputerUseClient":
        if not self.binary.is_file():
            raise ComputerUseError(
                f"Linux Computer Use binary is missing: {self.binary}; build with "
                "cargo build --release -p codex-computer-use-linux --bin codex-computer-use-linux"
            )
        self._process = subprocess.Popen(
            [str(self.binary), "mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "hermes-regular-chat-qa", "version": "1"},
            },
        )
        self.notify("notifications/initialized", {})
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.stdin:
            process.stdin.close()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    def _write(self, message: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise ComputerUseError("ComputerUseClient is not running")
        process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        process.stdin.flush()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        with self._lock:
            self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            process = self._process
            if process is None or process.stdout is None:
                raise ComputerUseError("ComputerUseClient is not running")
            request_id = self._next_id
            self._next_id += 1
            self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            deadline = time.monotonic() + self.timeout
            while time.monotonic() < deadline:
                # stdout is line-oriented by the MCP stdio transport. select()
                # avoids an unbounded blocking readline when a backend stalls.
                import select

                remaining = max(0.0, deadline - time.monotonic())
                ready, _, _ = select.select([process.stdout], [], [], min(remaining, 1.0))
                if not ready:
                    if process.poll() is not None:
                        stderr = process.stderr.read() if process.stderr else ""
                        raise ComputerUseError(
                            f"Linux Computer Use exited with {process.returncode}: {stderr[-2000:]}"
                        )
                    continue
                line = process.stdout.readline()
                if line == "":
                    stderr = process.stderr.read() if process.stderr else ""
                    raise ComputerUseError(f"Linux Computer Use stdout closed: {stderr[-2000:]}")
                try:
                    message = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ComputerUseError(f"Linux Computer Use returned invalid JSON: {line[:500]!r}") from exc
                if not isinstance(message, dict):
                    continue
                if message.get("id") != request_id:
                    # Notifications are permitted. Server-initiated requests are
                    # not expected from this backend and are rejected explicitly.
                    if message.get("id") is not None and message.get("method"):
                        self._write(
                            {
                                "jsonrpc": "2.0",
                                "id": message["id"],
                                "error": {"code": -32601, "message": "QA client does not support server requests"},
                            }
                        )
                    continue
                if message.get("error"):
                    raise ComputerUseError(f"Linux Computer Use RPC {method} failed: {message['error']}")
                result = message.get("result")
                if not isinstance(result, dict):
                    raise ComputerUseError(f"Linux Computer Use RPC {method} returned malformed result")
                return result
            raise ComputerUseError(f"Linux Computer Use RPC {method} timed out")

    def tool_call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            text = self._text_content(result)
            raise ComputerUseError(text or f"Computer Use tool {name} failed")
        return result

    @staticmethod
    def _text_content(result: dict[str, Any]) -> str:
        parts: list[str] = []
        content = result.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
        return "\n".join(parts)

    @staticmethod
    def structured(result: dict[str, Any]) -> dict[str, Any]:
        value = result.get("structuredContent")
        if isinstance(value, dict):
            return value
        text = ComputerUseClient._text_content(result)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ComputerUseError("Computer Use tool returned no structured JSON") from exc
        if not isinstance(parsed, dict):
            raise ComputerUseError("Computer Use structured result is not an object")
        return parsed

    def list_windows(self) -> list[dict[str, Any]]:
        result = self.tool_call("list_windows", {})
        structured = self.structured(result)
        error = structured.get("error")
        if error:
            raise ComputerUseError(f"Computer Use window listing failed: {error}")
        windows = structured.get("windows")
        if not isinstance(windows, list):
            raise ComputerUseError("Computer Use list_windows returned no windows array")
        return [item for item in windows if isinstance(item, dict)]

    def find_chatgpt_window(self) -> dict[str, Any]:
        candidates = []
        for window in self.list_windows():
            haystack = " ".join(
                str(window.get(key) or "") for key in ("title", "app_id", "wm_class", "process_name")
            ).lower()
            if "chatgpt" in haystack or "codex" in haystack:
                candidates.append(window)
        if not candidates:
            raise ComputerUseError("Computer Use could not find a ChatGPT/Codex window")
        candidates.sort(key=lambda item: (not bool(item.get("focused")), str(item.get("title") or "")))
        return candidates[0]

    def screenshot_window(self, output_path: Path, window: dict[str, Any] | None = None) -> ScreenshotEvidence:
        window = window or self.find_chatgpt_window()
        arguments: dict[str, Any] = {"raise_window": True, "format": "png"}
        window_id = window.get("window_id")
        if isinstance(window_id, int):
            arguments["window_id"] = window_id
        elif isinstance(window_id, str) and window_id.isdigit():
            arguments["window_id"] = int(window_id)
        elif window.get("pid") is not None:
            arguments["pid"] = int(window["pid"])
        elif window.get("title"):
            arguments["title"] = str(window["title"])
        else:
            raise ComputerUseError(f"Computer Use window has no usable target identity: {window}")

        result = self.tool_call("screenshot", arguments)
        structured = self.structured(result)
        images = [
            item
            for item in result.get("content", [])
            if isinstance(item, dict) and item.get("type") == "image" and item.get("data")
        ]
        if len(images) != 1:
            raise ComputerUseError(f"expected one screenshot image, received {len(images)}")
        image = images[0]
        mime_type = str(image.get("mimeType") or "")
        if mime_type not in {"image/png", "image/jpeg"}:
            raise ComputerUseError(f"unexpected screenshot MIME type: {mime_type!r}")
        try:
            raw = base64.b64decode(str(image["data"]), validate=True)
        except Exception as exc:
            raise ComputerUseError("Computer Use screenshot returned invalid base64") from exc
        if not raw:
            raise ComputerUseError("Computer Use screenshot returned an empty image")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(raw)
        return ScreenshotEvidence(output_path, mime_type, structured)

    def click(self, x: int, y: int) -> dict[str, Any]:
        return self.structured(self.tool_call("click", {"x": x, "y": y, "button": "left", "click_count": 1}))

    def press_key(self, key: str) -> dict[str, Any]:
        return self.structured(self.tool_call("press_key", {"key": key}))
