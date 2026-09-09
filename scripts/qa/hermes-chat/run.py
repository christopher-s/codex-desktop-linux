#!/usr/bin/env python3
"""Scenario CLI for Hermes regular-Chat QA."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import app
from cdp_client import CDPClient, wait_for_shell_target
import chat
from computer_use import ComputerUseClient, ComputerUseError
from evidence import EvidenceRun
from lcm import LCMDatabase
from lifecycle import LifecycleLog


async def current_shell_state(config: app.QAAppConfig) -> dict[str, object]:
    target = wait_for_shell_target(config.host, config.port)
    async with CDPClient(target, host=config.host, port=config.port) as client:
        shell = await chat.state(client)
    return {
        "target": {
            "id": target.id,
            "type": target.type,
            "url": target.url,
            "title": target.title,
        },
        "shell": shell,
    }


def command_state(args: argparse.Namespace) -> int:
    config = app.QAAppConfig()
    if args.start:
        app.start(config)
    result: dict[str, object] = {
        "active": app.unit_is_active(config),
        "port_listening": app.port_listening(config.host, config.port),
    }
    if result["active"]:
        result["service"] = app.service_snapshot(config)
    if result["port_listening"]:
        result.update(asyncio.run(current_shell_state(config)))
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


async def _sanity_async(run: EvidenceRun, config: app.QAAppConfig) -> None:
    lifecycle = LifecycleLog()
    lcm = LCMDatabase()
    lifecycle_before = lifecycle.baseline()
    lcm_before = lcm.total_messages()
    run.record(
        "baselines",
        lifecycle={"line_count": lifecycle_before.line_count, "size": lifecycle_before.size},
        lcm_messages=lcm_before,
        lcm_integrity=lcm.integrity(),
    )

    target = wait_for_shell_target(config.host, config.port)
    run.record(
        "cdp_target",
        id=target.id,
        type=target.type,
        url=target.url,
        title=target.title,
    )

    marker = f"E0-DRAFT-{uuid.uuid4().hex[:12]}"
    async with CDPClient(target, host=config.host, port=config.port) as client:
        await chat.ensure_regular_chat(client)
        ready = await chat.wait_for_visible_composer(client, timeout=45)
        run.record("composer_ready", shell=ready)

        inserted = await chat.insert_draft(client, marker, replace=True)
        draft_state = await chat.state(client)
        if draft_state.get("composerLength", 0) < len(marker):
            raise AssertionError(f"CDP draft did not remain in the visible composer: {draft_state}")
        run.record("cdp_draft_inserted", marker=marker, insertion=inserted, shell=draft_state)
        blur_result = await client.evaluate(
            "(() => { const v=[...document.querySelectorAll('[contenteditable=true]')].filter(n=>n.offsetParent!==null&&n.isContentEditable); const e=v[v.length-1]; const r=e?.getBoundingClientRect(); if (document.activeElement) document.activeElement.blur(); return {activeIsComposer:document.activeElement===e,text:e?.textContent||'',rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}; })()"
        )
        if not isinstance(blur_result, dict) or blur_result.get("activeIsComposer"):
            raise AssertionError(f"could not blur visible composer before Computer Use focus test: {blur_result}")
        run.record("cdp_composer_blurred", shell=blur_result)

        screenshot_path = run.directory / "computer-use-draft.png"
        with ComputerUseClient() as computer:
            window: dict[str, object] | None = None
            window_error: str | None = None
            try:
                window = computer.find_chatgpt_window()
            except ComputerUseError as exc:
                # GNOME may deny compositor window enumeration when the Codex
                # WindowControl extension is absent. AT-SPI remains usable with
                # --force-renderer-accessibility and provides an independent
                # semantic input path for this acceptance test.
                window_error = str(exc)

            if window is not None:
                screenshot = computer.screenshot_window(screenshot_path, window)
            else:
                screenshot = computer.screenshot_full_screen(screenshot_path)
            run.record(
                "computer_use_screenshot",
                window=window,
                window_enumeration_error=window_error,
                path=str(screenshot.path.relative_to(run.directory)),
                mime_type=screenshot.mime_type,
                structured=screenshot.structured,
                bytes=screenshot.path.stat().st_size,
            )

            app_state = computer.get_app_state("Codex", include_screenshot=False)
            entries = [
                node
                for node in app_state.get("accessibility_tree", [])
                if isinstance(node, dict)
                and node.get("role") == "entry"
                and node.get("name") == "Message ChatGPT"
                and "showing" in (node.get("states") or [])
                and "visible" in (node.get("states") or [])
            ]
            if len(entries) != 1:
                raise AssertionError(f"expected one accessible ChatGPT composer, found {len(entries)}")
            composer_node = entries[0]
            composer_bounds = composer_node.get("bounds")
            if not isinstance(composer_bounds, dict):
                raise AssertionError(f"accessible composer has no bounds: {composer_node}")
            frames = [
                node
                for node in app_state.get("accessibility_tree", [])
                if isinstance(node, dict) and node.get("role") == "frame" and isinstance(node.get("bounds"), dict)
            ]
            containing_frames = []
            cx = float(composer_bounds.get("x", 0)) + float(composer_bounds.get("width", 0)) / 2
            cy = float(composer_bounds.get("y", 0)) + float(composer_bounds.get("height", 0)) / 2
            for frame in frames:
                bounds = frame["bounds"]
                left = float(bounds.get("x", 0))
                top = float(bounds.get("y", 0))
                right = left + float(bounds.get("width", 0))
                bottom = top + float(bounds.get("height", 0))
                if left <= cx <= right and top <= cy <= bottom:
                    containing_frames.append(frame)
            if len(containing_frames) != 1:
                raise AssertionError(
                    f"expected exactly one accessible frame containing composer center, found {len(containing_frames)}"
                )
            frame = containing_frames[0]
            frame_bounds = frame["bounds"]
            dom_rect = blur_result.get("rect")
            if not isinstance(dom_rect, dict):
                raise AssertionError(f"CDP composer has no DOM rect: {blur_result}")
            expected = {
                "x": float(frame_bounds.get("x", 0)) + float(dom_rect.get("x", 0)),
                "y": float(frame_bounds.get("y", 0)) + float(dom_rect.get("y", 0)),
                "width": float(dom_rect.get("width", 0)),
                "height": float(dom_rect.get("height", 0)),
            }
            deltas = {
                key: abs(float(composer_bounds.get(key, 0)) - expected[key])
                for key in ("x", "y", "width", "height")
            }
            if max(deltas.values()) > 3.0:
                raise AssertionError(
                    f"Computer Use/CDP composer geometry mismatch: expected={expected}, "
                    f"accessible={composer_bounds}, deltas={deltas}"
                )
            focus_result = computer.click_accessible(element_index=int(composer_node["index"]))
            run.record(
                "computer_use_composer_proof",
                targeted_window=window is not None,
                composer_node={
                    key: composer_node.get(key)
                    for key in ("index", "role", "name", "states", "bounds")
                },
                containing_frame={
                    key: frame.get(key) for key in ("index", "role", "name", "bounds")
                },
                expected_global_bounds=expected,
                geometry_deltas=deltas,
                pointer_focus_attempt=focus_result,
            )

        post_pointer_state = await client.evaluate(
            "(() => { const v=[...document.querySelectorAll('[contenteditable=true]')].filter(n=>n.offsetParent!==null&&n.isContentEditable); const e=v[v.length-1]; return {activeIsComposer:document.activeElement===e,text:e?.textContent||''}; })()"
        )
        if marker not in str(post_pointer_state.get("text") or ""):
            raise AssertionError(f"draft marker changed during Computer Use proof: {post_pointer_state}")
        run.record(
            "computer_use_pointer_postcheck",
            shell=post_pointer_state,
            input_verdict=("observed" if post_pointer_state.get("activeIsComposer") else "environment_limited"),
        )

        await chat.clear_draft(client)
        cleared_state = await chat.state(client)
        if cleared_state.get("composerLength") != 0:
            raise AssertionError(f"CDP safety cleanup did not clear E0 draft: {cleared_state}")
        run.record("cdp_cleared_draft_without_send", shell=cleared_state)

    lifecycle_after = lifecycle.events_since(lifecycle_before)
    lcm_after = lcm.total_messages()
    integrity_after = lcm.integrity()
    run.write_json("lifecycle-delta.json", lifecycle_after)
    run.record(
        "postconditions",
        lifecycle_delta=len(lifecycle_after),
        lcm_delta=lcm_after - lcm_before,
        lcm_integrity=integrity_after,
    )
    if integrity_after.get("integrity_check") != "ok":
        raise AssertionError(f"LCM integrity failed after E0: {integrity_after}")
    if integrity_after.get("foreign_key_violations"):
        raise AssertionError(f"LCM foreign-key violations after E0: {integrity_after}")
    if not integrity_after.get("fts_matches_messages"):
        raise AssertionError(f"LCM FTS/message count mismatch after E0: {integrity_after}")


def command_sanity(args: argparse.Namespace) -> int:
    config = app.QAAppConfig()
    run = EvidenceRun("e0-sanity")
    try:
        app.start(config)
        service = app.service_snapshot(config)
        run.record("qa_app_started", service=service)
        asyncio.run(_sanity_async(run, config))
    except Exception as exc:
        run.finish("FAIL", error=f"{type(exc).__name__}: {exc}")
        print(json.dumps({"verdict": "FAIL", "run": str(run.directory), "error": str(exc)}, indent=2))
        return 1
    run.finish("PASS")
    print(json.dumps({"verdict": "PASS", "run": str(run.directory)}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    state_parser = subparsers.add_parser("state", help="report QA app/CDP shell state")
    state_parser.add_argument("--start", action="store_true", help="start the independent QA unit first")
    state_parser.set_defaults(func=command_state)

    sanity_parser = subparsers.add_parser("sanity", help="run E0 CDP + Computer Use harness sanity")
    sanity_parser.set_defaults(func=command_sanity)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
