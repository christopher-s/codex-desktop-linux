#!/usr/bin/env python3
"""Regular-Chat shell primitives built on the CDP client."""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
import json
import time
from typing import Any

from cdp_client import CDPClient, CDPError


STATE_JS = r"""
(() => {
  const visible = [...document.querySelectorAll('[contenteditable=true]')]
    .filter((node) => node.offsetParent !== null && node.isContentEditable);
  const composer = visible.length ? visible[visible.length - 1] : null;
  const body = document.body ? (document.body.innerText || '') : '';
  const turns = [...document.querySelectorAll('[data-turn-key]')]
    .filter((node) => node.offsetParent !== null)
    .map((node) => node.innerText || node.textContent || '');
  const dialogTranscript = [...document.querySelectorAll('[role=dialog]')]
    .filter((node) => node.offsetParent !== null)
    .map((node) => node.innerText || node.textContent || '');
  const transcript = [...turns, ...dialogTranscript].join('\n');
  const stop = [...document.querySelectorAll('button')].some((button) => {
    const label = button.getAttribute('aria-label') || button.title || '';
    return /stop|cancel/i.test(label) && button.offsetParent !== null;
  });
  return {
    url: location.href,
    visibleComposerCount: visible.length,
    composerLength: composer ? (composer.textContent || '').trim().length : -1,
    composerId: composer ? (composer.id || '(no-id)') : null,
    you: (transcript.match(/You said:/g) || []).length,
    said: (transcript.match(/ChatGPT said:/g) || []).length,
    stop,
    bodyLength: body.length,
    transcriptLength: transcript.length,
    tail: transcript ? transcript.slice(-1200) : body.slice(-1200),
  };
})()
"""


@dataclass(frozen=True)
class TurnResult:
    accepted: bool
    completed: bool
    seconds: float
    before: dict[str, Any]
    after: dict[str, Any]


def _decode_json_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return parsed
    raise CDPError(f"expected JSON object from shell expression, got {value!r}")


async def state(client: CDPClient) -> dict[str, Any]:
    value = await client.evaluate(STATE_JS)
    return _decode_json_value(value)


async def visible_text_present(client: CDPClient, text: str) -> bool:
    expression = r"""
((want) => {
  const body = document.body ? (document.body.innerText || '') : '';
  const turns = [...document.querySelectorAll('[data-turn-key]')]
    .filter((node) => node.offsetParent !== null)
    .map((node) => node.innerText || node.textContent || '')
    .join('\n');
  const dialogs = [...document.querySelectorAll('[role=dialog]')]
    .filter((node) => node.offsetParent !== null)
    .map((node) => node.innerText || node.textContent || '')
    .join('\n');
  return body.includes(want) || turns.includes(want) || dialogs.includes(want);
})(%s)
""" % json.dumps(text)
    return bool(await client.evaluate(expression))


async def click_visible_control(client: CDPClient, names: list[str]) -> bool:
    expression = r"""
((names) => {
  const wanted = new Set(names);
  const candidates = [...document.querySelectorAll('button,[role=button],a')]
    .filter((node) => node.offsetParent !== null)
    .filter((node) => {
      const text = (node.textContent || '').trim();
      const aria = (node.getAttribute('aria-label') || '').trim();
      const title = (node.getAttribute('title') || '').trim();
      return wanted.has(text) || wanted.has(aria) || wanted.has(title);
    });
  if (!candidates.length) return null;
  const node = candidates[0];
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    text: (node.textContent || '').trim(),
    aria: node.getAttribute('aria-label'),
  };
})(%s)
""" % json.dumps(names)
    point = await client.evaluate(expression)
    if not isinstance(point, dict):
        return False
    await client.click(float(point["x"]), float(point["y"]))
    return True


async def click_visible_text(client: CDPClient, text: str) -> bool:
    expression = r"""
((want) => {
  const candidates = [...document.querySelectorAll('button,[role=button],[role=tab],a,span,div')]
    .filter((node) => node.offsetParent !== null && (node.textContent || '').trim() === want);
  const node = candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: node.tagName, role: node.getAttribute('role')};
})(%s)
""" % json.dumps(text)
    point = await client.evaluate(expression)
    if not isinstance(point, dict):
        return False
    await client.click(float(point["x"]), float(point["y"]))
    return True


async def wait_for_visible_composer(client: CDPClient, timeout: float = 30.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = await state(client)
        if last.get("visibleComposerCount", 0) >= 1 and last.get("composerLength", -1) >= 0:
            return last
        await asyncio.sleep(0.8)
    raise CDPError(f"visible shell composer did not become ready; last={last}")


def _draft_expression(text: str, *, replace: bool) -> str:
    encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
    replace_literal = "true" if replace else "false"
    return r"""
(() => {
  const encoded = %s;
  const raw = atob(encoded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const text = new TextDecoder('utf-8').decode(bytes);
  const visible = [...document.querySelectorAll('[contenteditable=true]')]
    .filter((node) => node.offsetParent !== null && node.isContentEditable);
  const composer = visible.length ? visible[visible.length - 1] : null;
  if (!composer) return {ok:false, error:'no visible composer'};
  composer.focus();
  if (%s) document.execCommand('selectAll', false, null);
  if (%s) document.execCommand('delete', false, null);
  const inserted = document.execCommand('insertText', false, text);
  const actual = composer.textContent || '';
  return {
    ok: inserted && actual.includes(text),
    inserted,
    expectedLength: text.length,
    actualLength: actual.length,
    composerId: composer.id || '(no-id)',
    visibleComposerCount: visible.length,
  };
})()
""" % (json.dumps(encoded), replace_literal, replace_literal)


async def insert_draft(client: CDPClient, text: str, *, replace: bool = True, timeout: float = 30.0) -> dict[str, Any]:
    await wait_for_visible_composer(client, timeout=timeout)
    result = await client.evaluate(_draft_expression(text, replace=replace))
    result = _decode_json_value(result)
    if not result.get("ok"):
        raise CDPError(f"draft insertion failed: {result}")
    return result


async def clear_draft(client: CDPClient, timeout: float = 30.0) -> None:
    await wait_for_visible_composer(client, timeout=timeout)
    expression = r"""
(() => {
  const visible = [...document.querySelectorAll('[contenteditable=true]')]
    .filter((node) => node.offsetParent !== null && node.isContentEditable);
  const composer = visible.length ? visible[visible.length - 1] : null;
  if (!composer) return {ok:false, error:'no visible composer'};
  composer.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  return {ok:(composer.textContent || '').trim().length === 0, length:(composer.textContent || '').trim().length};
})()
"""
    result = _decode_json_value(await client.evaluate(expression))
    if not result.get("ok"):
        raise CDPError(f"draft clear failed: {result}")


async def ensure_regular_chat(client: CDPClient) -> None:
    # Avoid re-clicking an already-selected mode: current upstream can remount
    # the composer during mode navigation, creating a transient detached state.
    selected = await client.evaluate(r"""
(() => {
  const button = [...document.querySelectorAll('button,[role=tab]')]
    .find((node) => node.offsetParent !== null && (node.textContent || '').trim() === 'Chat');
  if (!button) return null;
  return button.getAttribute('aria-pressed') === 'true' || button.getAttribute('aria-selected') === 'true';
})()
""")
    if selected is True:
        return
    clicked = await click_visible_text(client, "Chat")
    if clicked:
        await asyncio.sleep(0.8)


async def new_chat(client: CDPClient, timeout: float = 30.0) -> dict[str, Any]:
    await ensure_regular_chat(client)
    current = await state(client)
    if (
        current.get("visibleComposerCount", 0) >= 1
        and current.get("you", 0) == 0
        and current.get("said", 0) == 0
        and current.get("composerLength") == 0
    ):
        return current

    deadline = time.monotonic() + timeout
    clicked = False
    while time.monotonic() < deadline:
        clicked = await click_visible_control(client, ["New chat", "New conversation"])
        if clicked:
            break
        await asyncio.sleep(0.4)
    if not clicked:
        raise CDPError("could not find a visible New chat/New conversation control by text, aria-label, or title")
    await asyncio.sleep(1.0)
    ready = await wait_for_visible_composer(client, timeout=max(1.0, deadline - time.monotonic()))
    if ready.get("composerLength", 0) > 0:
        await clear_draft(client)
        ready = await state(client)
    return ready


async def dismiss_stay_in_chat(client: CDPClient) -> bool:
    clicked = await click_visible_text(client, "Stay in Chat")
    if clicked:
        await asyncio.sleep(0.8)
    return clicked


def _needs_send_fallback(before: dict[str, Any], after: dict[str, Any]) -> bool:
    return (
        int(after.get("you", 0)) <= int(before.get("you", 0))
        and int(after.get("composerLength", -1)) > 0
    )


async def send_and_wait(
    client: CDPClient,
    prompt: str,
    *,
    accept_timeout: float = 45.0,
    complete_timeout: float = 240.0,
    poll_interval: float = 2.0,
) -> TurnResult:
    before = await state(client)
    await insert_draft(client, prompt, replace=True)
    await client.press_enter()

    accept_deadline = time.monotonic() + accept_timeout
    accepted = False
    send_fallback_attempted = False
    last = before
    while time.monotonic() < accept_deadline:
        await asyncio.sleep(min(1.5, poll_interval))
        last = await state(client)
        if last.get("you", 0) > before.get("you", 0) or await visible_text_present(client, prompt):
            accepted = True
            break
        if not send_fallback_attempted and _needs_send_fallback(before, last):
            send_fallback_attempted = True
            await click_visible_control(client, ["Send", "Send message"])
        await dismiss_stay_in_chat(client)
    if not accepted:
        return TurnResult(False, False, 0.0, before, last)

    started = time.monotonic()
    deadline = started + complete_timeout
    reply_seen = False
    stable = 0
    last_tail = None
    while time.monotonic() < deadline:
        await asyncio.sleep(poll_interval)
        last = await state(client)
        await dismiss_stay_in_chat(client)
        if last.get("said", 0) > before.get("said", 0):
            reply_seen = True
        if reply_seen and not last.get("stop"):
            tail = last.get("tail")
            if tail == last_tail:
                stable += 1
            else:
                stable = 0
                last_tail = tail
            if stable >= 2:
                return TurnResult(True, True, time.monotonic() - started, before, last)
        else:
            stable = 0
    return TurnResult(True, False, time.monotonic() - started, before, last)
