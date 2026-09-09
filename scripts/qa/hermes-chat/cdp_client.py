#!/usr/bin/env python3
"""Small CDP client specialized for the visible ChatGPT Community shell.

The packaged app exposes multiple targets. Only the exact page target
`app://-/index.html` owns the painted composer/transcript/sidebar. The hidden
chatgpt.com webview target is deliberately rejected by `select_shell_target`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
from typing import Any
import urllib.request

import websockets
from websockets.typing import Origin


DEFAULT_HOST = os.environ.get("CODEX_HERMES_QA_CDP_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("CODEX_HERMES_QA_CDP_PORT", "9243"))
SHELL_URL = "app://-/index.html"


class CDPError(RuntimeError):
    pass


@dataclass(frozen=True)
class CDPTarget:
    id: str
    type: str
    url: str
    title: str
    websocket_url: str

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "CDPTarget":
        return cls(
            id=str(value.get("id") or ""),
            type=str(value.get("type") or ""),
            url=str(value.get("url") or ""),
            title=str(value.get("title") or ""),
            websocket_url=str(value.get("webSocketDebuggerUrl") or ""),
        )


def list_targets(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, timeout: float = 5.0) -> list[CDPTarget]:
    with urllib.request.urlopen(f"http://{host}:{port}/json/list", timeout=timeout) as response:
        raw = json.load(response)
    if not isinstance(raw, list):
        raise CDPError("CDP /json/list returned a non-list payload")
    return [CDPTarget.from_json(item) for item in raw if isinstance(item, dict)]


def select_shell_target(targets: list[CDPTarget]) -> CDPTarget:
    exact = [target for target in targets if target.type == "page" and target.url == SHELL_URL]
    if len(exact) != 1:
        summary = [(target.type, target.url) for target in targets]
        raise CDPError(f"expected exactly one visible shell target {SHELL_URL!r}; found {len(exact)}: {summary}")
    target = exact[0]
    if not target.websocket_url:
        raise CDPError("visible shell target has no webSocketDebuggerUrl")
    return target


class CDPClient:
    def __init__(self, target: CDPTarget, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT):
        self.target = target
        self.host = host
        self.port = port
        self.origin = f"http://{host}:{port}"
        self._socket = None
        self._next_id = 1

    async def __aenter__(self) -> "CDPClient":
        self._socket = await websockets.connect(
            self.target.websocket_url,
            origin=Origin(self.origin),
            max_size=64 * 1024 * 1024,
            open_timeout=10,
        )
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._socket is not None:
            await self._socket.close()
            self._socket = None

    async def rpc(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> dict[str, Any]:
        if self._socket is None:
            raise CDPError("CDPClient must be used as an async context manager")
        request_id = self._next_id
        self._next_id += 1
        await self._socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            try:
                message = json.loads(await asyncio.wait_for(self._socket.recv(), timeout=timeout))
            except TimeoutError as exc:
                raise CDPError(f"CDP {method} timed out") from exc
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise CDPError(f"CDP {method} failed: {message['error']}")
            result = message.get("result")
            if not isinstance(result, dict):
                raise CDPError(f"CDP {method} returned malformed result: {message!r}")
            return result

    async def evaluate(self, expression: str, timeout: float = 30.0) -> Any:
        result = await self.rpc(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            description = (
                details.get("exception", {}).get("description")
                if isinstance(details.get("exception"), dict)
                else details.get("text")
            )
            raise CDPError(f"Runtime.evaluate exception: {description or details}")
        remote = result.get("result")
        if not isinstance(remote, dict):
            return None
        return remote.get("value")

    async def press_enter(self) -> None:
        common = {
            "key": "Enter",
            "code": "Enter",
            "windowsVirtualKeyCode": 13,
            "nativeVirtualKeyCode": 13,
        }
        await self.rpc("Input.dispatchKeyEvent", {"type": "rawKeyDown", **common}, timeout=10)
        await self.rpc("Input.dispatchKeyEvent", {"type": "keyUp", **common}, timeout=10)

    async def click(self, x: float, y: float) -> None:
        await self.rpc(
            "Input.dispatchMouseEvent",
            {"type": "mouseMoved", "x": x, "y": y, "button": "none"},
            timeout=10,
        )
        await self.rpc(
            "Input.dispatchMouseEvent",
            {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1},
            timeout=10,
        )
        await self.rpc(
            "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1},
            timeout=10,
        )


def shell_target(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> CDPTarget:
    return select_shell_target(list_targets(host=host, port=port))
