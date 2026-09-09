#!/usr/bin/env python3
"""Virtualized Recents navigation for the current ChatGPT Community shell."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from cdp_client import CDPClient, CDPError
from chat import visible_text_present


ROWS_JS = r"""
(() => {
  function valueId(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.conversationId === 'string') return value.conversationId;
    if (value.conversation && typeof value.conversation.id === 'string') return value.conversation.id;
    for (const key of ['item', 'route', 'shortcutKey', 'key']) {
      const candidate = value[key];
      if (typeof candidate !== 'string') continue;
      const match = candidate.match(/(?:chatgpt:conversation:|\/c\/)([0-9a-f-]{36})/i);
      if (match) return match[1];
      if (/^[0-9a-f-]{36}$/i.test(candidate)) return candidate;
    }
    return null;
  }

  const rows = [];
  for (const button of document.querySelectorAll('div[role=button]')) {
    const rect = button.getBoundingClientRect();
    if (button.offsetParent === null || rect.width <= 0 || rect.height <= 0 || rect.left >= 380) continue;
    const fiberKey = Object.keys(button).find((key) => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? button[fiberKey] : null;
    let conversationId = null;
    let depth = 0;
    while (fiber && depth++ < 40) {
      conversationId = valueId(fiber.memoizedProps) || valueId(fiber.pendingProps);
      if (conversationId) break;
      fiber = fiber.return;
    }
    if (!conversationId) continue;
    rows.push({
      conversationId,
      title: (button.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      top: rect.top,
      bottom: rect.bottom,
    });
  }
  return rows;
})()
"""


SCROLLER_JS = r"""
(() => {
  const candidates = [...document.querySelectorAll('*')].filter((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 50 && rect.left < 380 && rect.width > 0;
  });
  if (!candidates.length) return null;
  const node = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  return {
    scrollTop: node.scrollTop,
    max: Math.max(0, node.scrollHeight - node.clientHeight),
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  };
})()
"""


def _json_object(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else None
    return None


async def rendered_rows(client: CDPClient) -> list[dict[str, Any]]:
    value = await client.evaluate(ROWS_JS)
    if not isinstance(value, list):
        raise CDPError(f"Recents row probe returned non-list: {value!r}")
    return [row for row in value if isinstance(row, dict)]


async def scroller_state(client: CDPClient) -> dict[str, Any] | None:
    return _json_object(await client.evaluate(SCROLLER_JS))


async def set_scroll_top(client: CDPClient, value: float) -> dict[str, Any] | None:
    expression = r"""
((nextTop) => {
  const candidates = [...document.querySelectorAll('*')].filter((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 50 && rect.left < 380 && rect.width > 0;
  });
  if (!candidates.length) return null;
  const node = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  node.scrollTop = Math.max(0, Math.min(nextTop, node.scrollHeight - node.clientHeight));
  node.dispatchEvent(new Event('scroll', {bubbles:true}));
  return {scrollTop:node.scrollTop,max:Math.max(0,node.scrollHeight-node.clientHeight)};
})(%s)
""" % json.dumps(value)
    return _json_object(await client.evaluate(expression))


async def wake_recents(client: CDPClient) -> None:
    # Interaction-gated hydration is a current shell behavior. Use native CDP
    # coordinates for the header toggle, then jiggle the sidebar scroller.
    expression = r"""
(() => {
  const controls = [...document.querySelectorAll('button,[role=button]')].filter((node) => {
    const rect = node.getBoundingClientRect();
    return node.offsetParent !== null && rect.left < 380 && rect.width > 0 &&
      (node.textContent || '').trim() === 'Recents';
  });
  if (!controls.length) return null;
  const rect = controls[0].getBoundingClientRect();
  return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
})()
"""
    point = _json_object(await client.evaluate(expression))
    if point:
        # With zero rendered conversation rows, treat Recents as collapsed or
        # unhydrated and click once to open/kick hydration. Once rows exist,
        # collapse+re-expand is the proven refresh stimulus.
        rows_before = await rendered_rows(client)
        await client.click(float(point["x"]), float(point["y"]))
        if rows_before:
            await asyncio.sleep(0.25)
            await client.click(float(point["x"]), float(point["y"]))
    state = await scroller_state(client)
    if state:
        current = float(state.get("scrollTop", 0))
        maximum = float(state.get("max", 0))
        await set_scroll_top(client, min(maximum, current + 120))
        await asyncio.sleep(0.15)
        await set_scroll_top(client, max(0, current))


async def open_by_server_id(
    client: CDPClient,
    server_conversation_id: str,
    *,
    transcript_marker: str,
    timeout: float = 240.0,
) -> dict[str, Any]:
    """Open one conversation by stable server ID and verify rendered identity.

    React fiber props are used only as a discovery aid for the virtualized row;
    the rendered transcript marker is the acceptance proof after the native click.
    """
    deadline = time.monotonic() + timeout
    last_seen: list[str] = []
    wake_at = 0.0
    while time.monotonic() < deadline:
        if time.monotonic() >= wake_at:
            await wake_recents(client)
            wake_at = time.monotonic() + 8.0
        await set_scroll_top(client, 0)
        await asyncio.sleep(0.35)

        previous_top = -1.0
        for _ in range(60):
            rows = await rendered_rows(client)
            last_seen = [str(row.get("conversationId")) for row in rows[-20:]]
            target = next((row for row in rows if row.get("conversationId") == server_conversation_id), None)
            if target:
                viewport_height = float(await client.evaluate("window.innerHeight"))
                target_y = float(target["y"])
                if target_y < 100 or target_y > viewport_height - 80:
                    scroller = await scroller_state(client)
                    if scroller:
                        current_top = float(scroller.get("scrollTop", 0))
                        await set_scroll_top(client, current_top + target_y - viewport_height / 2)
                        await asyncio.sleep(0.35)
                        rows = await rendered_rows(client)
                        target = next(
                            (row for row in rows if row.get("conversationId") == server_conversation_id),
                            None,
                        )
                if not target:
                    break
                await client.click(float(target["x"]), float(target["y"]))
                marker_deadline = min(deadline, time.monotonic() + 30.0)
                while time.monotonic() < marker_deadline:
                    if await visible_text_present(client, transcript_marker):
                        return target
                    await asyncio.sleep(0.8)
                # A click without the expected transcript is insufficient identity
                # proof; continue scanning after another hydration wake.
                break

            scroller = await scroller_state(client)
            if not scroller:
                break
            top = float(scroller.get("scrollTop", 0))
            maximum = float(scroller.get("max", 0))
            if top >= maximum - 1 or top == previous_top:
                break
            previous_top = top
            await set_scroll_top(client, min(maximum, top + 300))
            await asyncio.sleep(0.35)
        await asyncio.sleep(2.0)

    raise CDPError(
        f"conversation {server_conversation_id} was not opened/verified before timeout; "
        f"last rendered ids={last_seen}"
    )
