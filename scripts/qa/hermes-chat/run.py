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
from lcm import LCMDatabase, assert_prefix_unchanged, tool_pairs
from lifecycle import (
    LifecycleLog,
    assert_subsequence,
    by_session,
    event_names,
    failed_events,
    identity_pairs,
    session_open_events,
)
import recents


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
            if not containing_frames:
                raise AssertionError("no accessible frame contains the composer center")
            dom_rect = blur_result.get("rect")
            if not isinstance(dom_rect, dict):
                raise AssertionError(f"CDP composer has no DOM rect: {blur_result}")

            frame_candidates: list[tuple[float, dict[str, object], dict[str, float], dict[str, float]]] = []
            for candidate in containing_frames:
                candidate_bounds = candidate["bounds"]
                expected = {
                    "x": float(candidate_bounds.get("x", 0)) + float(dom_rect.get("x", 0)),
                    "y": float(candidate_bounds.get("y", 0)) + float(dom_rect.get("y", 0)),
                    "width": float(dom_rect.get("width", 0)),
                    "height": float(dom_rect.get("height", 0)),
                }
                deltas = {
                    key: abs(float(composer_bounds.get(key, 0)) - expected[key])
                    for key in ("x", "y", "width", "height")
                }
                frame_candidates.append((max(deltas.values()), candidate, expected, deltas))
            frame_candidates.sort(key=lambda item: item[0])
            score, frame, expected, deltas = frame_candidates[0]
            if score > 3.0:
                scored = [
                    {
                        "index": candidate.get("index"),
                        "bounds": candidate.get("bounds"),
                        "score": candidate_score,
                        "deltas": candidate_deltas,
                    }
                    for candidate_score, candidate, _candidate_expected, candidate_deltas in frame_candidates
                ]
                raise AssertionError(
                    f"Computer Use/CDP composer geometry mismatch: accessible={composer_bounds}, "
                    f"candidates={scored}"
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


async def _wait_for_identity_pair(
    lifecycle: LifecycleLog,
    baseline,
    *,
    timeout: float = 45.0,
) -> tuple[str, str, list[dict[str, object]]]:
    deadline = time.monotonic() + timeout
    latest_events: list[dict[str, object]] = []
    while time.monotonic() < deadline:
        latest_events = lifecycle.events_since(baseline)
        pairs = identity_pairs(latest_events)
        if pairs:
            client_id, server_id = pairs[-1]
            return client_id, server_id, latest_events
        await asyncio.sleep(1.0)
    raise AssertionError(
        f"no fresh client/server conversation identity pair observed within {timeout:.0f}s"
    )


def _process_list_prompt(marker: str) -> str:
    return (
        f"{marker} — You must use the advertised local functions, not answer from memory. "
        "Call hermes_tool_search with queries set to 'process management'. Then call "
        "hermes_tool_describe for process_manage. Then call hermes_tool_call with name "
        "process_manage and arguments set to the JSON object string {\"action\":\"list\"}. "
        "After those local function calls complete, report exactly what hermes_tool_call returned."
    )


async def _e6_create_phase(
    run: EvidenceRun,
    config: app.QAAppConfig,
    lifecycle: LifecycleLog,
    baseline,
    marker_one: str,
) -> tuple[str, str]:
    target = wait_for_shell_target(config.host, config.port)
    prompt_one = _process_list_prompt(marker_one)
    async with CDPClient(target, host=config.host, port=config.port) as client:
        await chat.new_chat(client, timeout=45)
        turn_one = await chat.send_and_wait(client, prompt_one, complete_timeout=300)
        if not turn_one.accepted or not turn_one.completed:
            raise AssertionError(f"E6 create turn 1 did not complete: {turn_one}")
        run.record("e6_create_turn_one", marker=marker_one, seconds=turn_one.seconds, after=turn_one.after)

    client_id, server_id, events = await _wait_for_identity_pair(lifecycle, baseline)
    run.write_json("e6-create-lifecycle.json", events)
    run.record(
        "e6_identity_pair",
        client_conversation_id=client_id,
        server_conversation_id=server_id,
    )
    return client_id, server_id


async def _e6_reopen_phase(
    run: EvidenceRun,
    config: app.QAAppConfig,
    server_id: str,
    marker_one: str,
    marker_three: str,
) -> None:
    target = wait_for_shell_target(config.host, config.port)
    prompt_three = _process_list_prompt(marker_three)
    async with CDPClient(target, host=config.host, port=config.port) as client:
        row = await recents.open_by_server_id(
            client,
            server_id,
            transcript_marker=marker_one,
            timeout=180,
        )
        run.record("e6_reopened_by_server_id", server_conversation_id=server_id, row=row)

        # Independent visual evidence for the reopened real UI. Whole-screen
        # capture is used when current-session GNOME window enumeration is unavailable.
        screenshot_path = run.directory / "e6-reopened.png"
        with ComputerUseClient() as computer:
            try:
                window = computer.find_chatgpt_window()
            except ComputerUseError:
                window = None
            screenshot = (
                computer.screenshot_window(screenshot_path, window)
                if window is not None
                else computer.screenshot_full_screen(screenshot_path)
            )
            run.record(
                "e6_reopen_computer_use_screenshot",
                path=str(screenshot.path.relative_to(run.directory)),
                mime_type=screenshot.mime_type,
                bytes=screenshot.path.stat().st_size,
                structured=screenshot.structured,
            )

        turn_three = await chat.send_and_wait(client, prompt_three, complete_timeout=300)
        if not turn_three.accepted or not turn_three.completed:
            raise AssertionError(f"E6 reopened turn did not complete: {turn_three}")
        run.record("e6_reopen_turn_three", marker=marker_three, seconds=turn_three.seconds, after=turn_three.after)


def _wait_for_tool_pairs(
    lcm: LCMDatabase,
    conversation_id: str,
    *,
    minimum: int = 1,
    timeout: float = 20.0,
) -> tuple[list, list]:
    deadline = time.monotonic() + timeout
    rows = lcm.rows(conversation_id)
    pairs = tool_pairs(rows)
    while len(pairs) < minimum and time.monotonic() < deadline:
        time.sleep(0.25)
        rows = lcm.rows(conversation_id)
        pairs = tool_pairs(rows)
    return rows, pairs


def _wait_for_rows(
    lcm: LCMDatabase,
    conversation_id: str,
    *,
    minimum: int,
    timeout: float = 20.0,
) -> list:
    deadline = time.monotonic() + timeout
    rows = lcm.rows(conversation_id)
    while len(rows) < minimum and time.monotonic() < deadline:
        time.sleep(0.25)
        rows = lcm.rows(conversation_id)
    return rows


def _plain_text_prompt(marker: str) -> str:
    return (
        f"{marker} — Reply in plain text with exactly {marker}-ACK. "
        "Do not call or describe any tools."
    )


async def _e1_two_turns(
    run: EvidenceRun,
    config: app.QAAppConfig,
    lifecycle: LifecycleLog,
    baseline,
    marker_one: str,
    marker_two: str,
) -> tuple[str, str]:
    target = wait_for_shell_target(config.host, config.port)
    async with CDPClient(target, host=config.host, port=config.port) as client:
        await chat.new_chat(client, timeout=45)
        for logical_turn, marker_value in enumerate((marker_one, marker_two), start=1):
            before_events = lifecycle.events_since(baseline)
            before_tool_count = len(
                [event for event in before_events if event.get("event") in {"tool_call", "tool_call_error"}]
            )
            result = await chat.send_and_wait(
                client,
                _plain_text_prompt(marker_value),
                complete_timeout=300,
            )
            if not result.accepted or not result.completed:
                raise AssertionError(f"E1 turn {logical_turn} did not complete: {result}")
            after_events = lifecycle.events_since(baseline)
            new_tools = [
                event
                for event in after_events
                if event.get("event") in {"tool_call", "tool_call_error"}
            ][before_tool_count:]
            if new_tools:
                raise AssertionError(
                    f"E1 turn {logical_turn} unexpectedly executed a tool: {new_tools}"
                )
            shell = await chat.wait_for_visible_composer(client, timeout=45)
            run.record(
                "e1_turn",
                logical_turn=logical_turn,
                marker=marker_value,
                seconds=result.seconds,
                shell=shell,
            )

    client_id, server_id, events = await _wait_for_identity_pair(lifecycle, baseline)
    run.write_json("e1-live-lifecycle.json", events)
    return client_id, server_id


async def _e1_reopen(
    run: EvidenceRun,
    config: app.QAAppConfig,
    server_id: str,
    marker_one: str,
    marker_two: str,
) -> None:
    target = wait_for_shell_target(config.host, config.port)
    async with CDPClient(target, host=config.host, port=config.port) as client:
        row = await recents.open_by_server_id(
            client,
            server_id,
            transcript_marker=marker_one,
            timeout=180,
        )
        transcript = await client.evaluate(
            "(() => [...document.querySelectorAll('[data-turn-key]')].filter(n=>n.offsetParent!==null).map(n=>n.innerText||n.textContent||'').join('\\n'))()"
        )
        transcript_text = str(transcript or "")
        if marker_one not in transcript_text or marker_two not in transcript_text:
            raise AssertionError(
                f"E1 reopened transcript does not contain both turn markers: {transcript_text[-2400:]}"
            )
        shell = await chat.wait_for_visible_composer(client, timeout=45)
        run.record(
            "e1_reopened",
            server_conversation_id=server_id,
            row=row,
            shell=shell,
            transcript_tail=transcript_text[-2400:],
        )


def command_e1(args: argparse.Namespace) -> int:
    config = app.QAAppConfig()
    lifecycle = LifecycleLog()
    lcm = LCMDatabase()
    run = EvidenceRun("e1-no-tool-lifecycle")
    suffix = uuid.uuid4().hex[:10]
    marker_one = f"E1-{suffix}-TURN1"
    marker_two = f"E1-{suffix}-TURN2"
    lifecycle_baseline = lifecycle.baseline()
    lcm_total_before = lcm.total_messages() if lcm.path.is_file() else 0

    try:
        app.start(config)
        run.record("e1_app_started", service=app.service_snapshot(config))
        client_id, server_id = asyncio.run(
            _e1_two_turns(
                run,
                config,
                lifecycle,
                lifecycle_baseline,
                marker_one,
                marker_two,
            )
        )

        events = lifecycle.events_since(lifecycle_baseline)
        pairs = identity_pairs(events)
        if (client_id, server_id) not in pairs:
            raise AssertionError(f"E1 canonical/server identity pair missing: {pairs}")
        opens = [
            event
            for event in session_open_events(events)
            if event.get("conversation_id") == client_id
        ]
        if len(opens) != 1:
            raise AssertionError(f"E1 expected exactly one session_open for {client_id}, found {opens}")
        session_id = str(opens[0].get("session_id") or "")
        expected_task_id = f"chatgpt-codex:{client_id}"
        if str(opens[0].get("task_id") or "") != expected_task_id:
            raise AssertionError(
                f"E1 task identity mismatch: expected {expected_task_id}, got {opens[0].get('task_id')}"
            )
        session_events = by_session(events).get(session_id, [])
        tool_events = [
            event
            for event in session_events
            if event.get("event") in {"tool_call", "tool_call_error"}
        ]
        if tool_events:
            raise AssertionError(f"E1 produced tool lifecycle events: {tool_events}")
        failures = failed_events(session_events)
        if failures:
            raise AssertionError(f"E1 lifecycle failure events: {failures}")

        begin_events = [event for event in session_events if event.get("event") == "begin_turn"]
        if len(begin_events) != 2:
            raise AssertionError(f"E1 expected two begin_turn events, found {begin_events}")
        expected_order = [
            "begin_turn",
            "pre_api_request",
            "post_api_request",
            "on_session_end",
            "complete_turn",
        ]
        turn_evidence = []
        for begin in begin_events:
            turn_id = str(begin.get("turn_id") or "")
            turn_events = [event for event in session_events if str(event.get("turn_id") or "") == turn_id]
            names = event_names(turn_events)
            assert_subsequence(names, expected_order)
            for event_name in expected_order:
                if names.count(event_name) != 1:
                    raise AssertionError(
                        f"E1 turn {turn_id} expected one {event_name}, got {names.count(event_name)}; names={names}"
                    )
            errors = []
            for event in turn_events:
                for key, value in event.items():
                    if (key == "error" or key.endswith("_error")) and value not in (None, "", False):
                        errors.append({"event": event.get("event"), "field": key, "value": value})
            if errors:
                raise AssertionError(f"E1 turn {turn_id} lifecycle errors: {errors}")
            turn_evidence.append({"turn_id": turn_id, "events": names})
        run.record(
            "e1_lifecycle_acceptance",
            conversation_id=client_id,
            server_conversation_id=server_id,
            session_id=session_id,
            task_id=expected_task_id,
            turns=turn_evidence,
            tool_events=0,
        )

        app.stop(config)
        rows = _wait_for_rows(lcm, client_id, minimum=4)
        server_rows = lcm.rows(server_id)
        if len(rows) != 4:
            raise AssertionError(f"E1 expected four finalized user/assistant rows, found {len(rows)}")
        roles = [row.role for row in rows]
        if roles != ["user", "assistant", "user", "assistant"]:
            raise AssertionError(f"E1 finalized row roles are unexpected: {roles}")
        tool_rows = [
            row
            for row in rows
            if row.role == "tool" or row.tool_call_id is not None or row.tool_name is not None
        ]
        if tool_rows:
            raise AssertionError(f"E1 created tool rows: {tool_rows}")
        if server_rows:
            raise AssertionError(f"E1 wrote {len(server_rows)} rows under bare server UUID {server_id}")
        row_sessions = sorted({row.session_id for row in rows if row.session_id})
        if row_sessions != [session_id]:
            raise AssertionError(f"E1 finalized rows span unexpected lifecycle sessions: {row_sessions}")
        integrity = lcm.integrity()
        if integrity.get("integrity_check") != "ok" or integrity.get("foreign_key_violations"):
            raise AssertionError(f"LCM integrity failure after E1: {integrity}")
        if not integrity.get("fts_matches_messages"):
            raise AssertionError(f"LCM FTS/message mismatch after E1: {integrity}")
        if lcm.total_messages() - lcm_total_before != 4:
            raise AssertionError(
                f"E1 expected global isolated LCM delta 4, got {lcm.total_messages() - lcm_total_before}"
            )
        run.write_json("e1-finalized-rows.json", [row.__dict__ for row in rows])
        run.record(
            "e1_finalized",
            rows=len(rows),
            roles=roles,
            tool_rows=0,
            server_key_rows=len(server_rows),
            lcm_total_delta=lcm.total_messages() - lcm_total_before,
            integrity=integrity,
        )

        reopen_baseline = lifecycle.baseline()
        app.start(config)
        asyncio.run(_e1_reopen(run, config, server_id, marker_one, marker_two))
        reopen_events = lifecycle.events_since(reopen_baseline)
        run.write_json("e1-reopen-lifecycle.json", reopen_events)
        unexpected_reopen_turns = [
            event
            for event in reopen_events
            if event.get("event") in {"begin_turn", "pre_api_request", "tool_call", "complete_turn"}
        ]
        if unexpected_reopen_turns:
            raise AssertionError(
                f"E1 read-only reopen unexpectedly created a lifecycle turn/tool call: {unexpected_reopen_turns}"
            )
        app.stop(config)
        rows_after_reopen = lcm.rows(client_id)
        if rows_after_reopen != rows:
            raise AssertionError("E1 read-only reopen changed finalized canonical rows")
        final_integrity = lcm.integrity()
        if final_integrity.get("integrity_check") != "ok" or final_integrity.get("foreign_key_violations"):
            raise AssertionError(f"LCM integrity failure after E1 reopen: {final_integrity}")
        if not final_integrity.get("fts_matches_messages"):
            raise AssertionError(f"LCM FTS/message mismatch after E1 reopen: {final_integrity}")
        run.record(
            "e1_postconditions",
            conversation_id=client_id,
            server_conversation_id=server_id,
            session_id=session_id,
            task_id=expected_task_id,
            rows=len(rows_after_reopen),
            tool_rows=0,
            server_key_rows=len(lcm.rows(server_id)),
            reopen_lifecycle_events=len(reopen_events),
            integrity=final_integrity,
        )
    except Exception as exc:
        try:
            if not app.unit_is_active(config):
                app.start(config)
        except Exception:
            pass
        run.finish("FAIL", error=f"{type(exc).__name__}: {exc}")
        print(json.dumps({"verdict": "FAIL", "run": str(run.directory), "error": str(exc)}, indent=2))
        return 1

    app.start(config)
    run.finish("PASS")
    print(json.dumps({"verdict": "PASS", "run": str(run.directory)}, indent=2))
    return 0


async def _e5_turns(
    run: EvidenceRun,
    config: app.QAAppConfig,
    lifecycle: LifecycleLog,
    baseline,
    marker_one: str,
    marker_two: str,
) -> tuple[str, str]:
    target = wait_for_shell_target(config.host, config.port)
    client_id = ""
    server_id = ""
    expected_names = ["hermes_tool_search", "hermes_tool_describe", "hermes_tool_call"]

    async with CDPClient(target, host=config.host, port=config.port) as client:
        await chat.new_chat(client, timeout=45)
        for logical_turn, marker in enumerate((marker_one, marker_two), start=1):
            for attempt in range(1, 4):
                attempt_marker = marker if attempt == 1 else f"{marker}-RETRY{attempt - 1}"
                before_events = lifecycle.events_since(baseline)
                before_tool_count = len(
                    [event for event in before_events if event.get("event") == "tool_call"]
                )
                result = await chat.send_and_wait(
                    client,
                    _process_list_prompt(attempt_marker),
                    complete_timeout=300,
                )
                if not result.accepted or not result.completed:
                    raise AssertionError(
                        f"E5 logical turn {logical_turn} attempt {attempt} did not complete: {result}"
                    )

                after_events = lifecycle.events_since(baseline)
                new_tool_events = [
                    event
                    for event in after_events
                    if event.get("event") == "tool_call"
                ][before_tool_count:]
                names = [str(event.get("name") or "") for event in new_tool_events]
                run.record(
                    "e5_turn_attempt",
                    logical_turn=logical_turn,
                    attempt=attempt,
                    marker=attempt_marker,
                    seconds=result.seconds,
                    tool_names=names,
                    after=result.after,
                )

                if names == expected_names:
                    if not client_id:
                        client_id, server_id, _events = await _wait_for_identity_pair(
                            lifecycle,
                            baseline,
                        )
                    break
                if names:
                    raise AssertionError(
                        f"E5 logical turn {logical_turn} attempt {attempt} produced unexpected tool sequence: {names}"
                    )
            else:
                raise AssertionError(
                    f"E5 logical turn {logical_turn} exhausted three completed model attempts without Hermes tool execution"
                )

    if not client_id or not server_id:
        raise AssertionError("E5 completed tool turns without resolving a client/server identity pair")
    return client_id, server_id


def command_e5(args: argparse.Namespace) -> int:
    config = app.QAAppConfig()
    lifecycle = LifecycleLog()
    lcm = LCMDatabase()
    run = EvidenceRun("e5-same-process-reuse")
    suffix = uuid.uuid4().hex[:10]
    marker_one = f"E5-{suffix}-TURN1"
    marker_two = f"E5-{suffix}-TURN2"
    lifecycle_baseline = lifecycle.baseline()
    lcm_total_before = lcm.total_messages()

    try:
        app.start(config)
        run.record("e5_app_started", service=app.service_snapshot(config))
        client_id, server_id = asyncio.run(
            _e5_turns(
                run,
                config,
                lifecycle,
                lifecycle_baseline,
                marker_one,
                marker_two,
            )
        )

        events = lifecycle.events_since(lifecycle_baseline)
        run.write_json("e5-lifecycle.json", events)
        conversation_events = [event for event in events if event.get("conversation_id") == client_id]
        opens = session_open_events(conversation_events)
        session_ids = sorted(
            {
                str(event.get("session_id"))
                for event in conversation_events
                if event.get("session_id")
            }
        )
        if len(opens) != 1:
            raise AssertionError(f"expected exactly one E5 session_open, found {len(opens)}: {opens}")
        if len(session_ids) != 1:
            raise AssertionError(f"E5 rotated lifecycle session inside one process: {session_ids}")
        session_id = session_ids[0]
        expected_task_id = f"chatgpt-codex:{client_id}"
        task_ids = sorted(
            {
                str(event.get("task_id"))
                for event in conversation_events
                if event.get("task_id")
            }
        )
        if task_ids != [expected_task_id]:
            raise AssertionError(f"E5 task identity mismatch: expected {expected_task_id}, got {task_ids}")
        successful_tools = [event for event in conversation_events if event.get("event") == "tool_call"]
        if len(successful_tools) != 6:
            raise AssertionError(f"expected six successful Hermes meta-tool calls across E5, found {len(successful_tools)}")
        run.record(
            "e5_identity",
            conversation_id=client_id,
            server_conversation_id=server_id,
            session_id=session_id,
            task_id=expected_task_id,
            successful_tool_calls=len(successful_tools),
        )

        app.stop(config)
        rows, pairs = _wait_for_tool_pairs(lcm, client_id, minimum=6)
        server_rows = lcm.rows(server_id)
        if len(rows) != 12 or len(pairs) != 6:
            raise AssertionError(
                f"expected 12 finalized rows / 6 tool pairs after E5, got {len(rows)} / {len(pairs)}"
            )
        if server_rows:
            raise AssertionError(f"E5 wrote {len(server_rows)} rows under bare server UUID {server_id}")
        row_sessions = sorted({row.session_id for row in rows if row.session_id})
        if row_sessions != [session_id]:
            raise AssertionError(f"E5 finalized rows span unexpected lifecycle sessions: {row_sessions}")
        integrity = lcm.integrity()
        if integrity.get("integrity_check") != "ok" or integrity.get("foreign_key_violations"):
            raise AssertionError(f"LCM integrity failure after E5: {integrity}")
        if not integrity.get("fts_matches_messages"):
            raise AssertionError(f"LCM FTS/message mismatch after E5: {integrity}")
        run.write_json("e5-rows.json", [row.__dict__ for row in rows])
        run.record(
            "e5_postconditions",
            conversation_id=client_id,
            server_conversation_id=server_id,
            session_id=session_id,
            task_id=expected_task_id,
            rows=len(rows),
            tool_pairs=len(pairs),
            server_key_rows=len(server_rows),
            lcm_total_delta=lcm.total_messages() - lcm_total_before,
            integrity=integrity,
        )
    except Exception as exc:
        try:
            if not app.unit_is_active(config):
                app.start(config)
        except Exception:
            pass
        run.finish("FAIL", error=f"{type(exc).__name__}: {exc}")
        print(json.dumps({"verdict": "FAIL", "run": str(run.directory), "error": str(exc)}, indent=2))
        return 1

    app.start(config)
    run.finish("PASS")
    print(json.dumps({"verdict": "PASS", "run": str(run.directory)}, indent=2))
    return 0


def command_e6(args: argparse.Namespace) -> int:
    config = app.QAAppConfig()
    lifecycle = LifecycleLog()
    lcm = LCMDatabase()
    run = EvidenceRun("e6-restart-reopen")
    marker_suffix = uuid.uuid4().hex[:10]
    marker_one = f"E6-{marker_suffix}-TURN1"
    marker_three = f"E6-{marker_suffix}-TURN2-REOPEN"
    lifecycle_baseline = lifecycle.baseline()
    lcm_total_before = lcm.total_messages()

    try:
        app.start(config)
        run.record("e6_app_started_create", service=app.service_snapshot(config))
        client_id, server_id = asyncio.run(
            _e6_create_phase(
                run,
                config,
                lifecycle,
                lifecycle_baseline,
                marker_one,
            )
        )

        create_events = lifecycle.events_since(lifecycle_baseline)
        create_opens = [
            event
            for event in session_open_events(create_events)
            if event.get("conversation_id") == client_id
        ]
        if not create_opens:
            raise AssertionError(
                f"no pre-restart session_open found for canonical key {client_id}"
            )
        pre_open = create_opens[-1]
        pre_session_id = str(pre_open.get("session_id") or "")
        pre_task_id = str(pre_open.get("task_id") or "")
        expected_task_id = f"chatgpt-codex:{client_id}"
        if pre_task_id != expected_task_id:
            raise AssertionError(
                f"pre-restart task identity mismatch: expected {expected_task_id}, got {pre_task_id or '<missing>'}"
            )
        run.record(
            "e6_pre_restart_identity",
            session_id=pre_session_id,
            task_id=pre_task_id,
            conversation_id=client_id,
            server_conversation_id=server_id,
        )

        # A clean stop is part of the acceptance criterion and forces lifecycle/LCM flush.
        app.stop(config)
        run.record("e6_app_stopped", port_listening=app.port_listening(config.host, config.port))

        before_restart_rows, before_pairs = _wait_for_tool_pairs(lcm, client_id, minimum=1)
        before_server_rows = lcm.rows(server_id)
        if len(before_pairs) < 1:
            raise AssertionError(
                f"expected at least one finalized tool call/result pair before restart under {client_id}; "
                f"found {len(before_pairs)}"
            )
        if before_server_rows:
            raise AssertionError(
                f"fresh pre-restart conversation unexpectedly has rows under server key {server_id}: "
                f"{len(before_server_rows)}"
            )
        run.write_json(
            "e6-before-restart-rows.json",
            [row.__dict__ for row in before_restart_rows],
        )
        run.record(
            "e6_before_restart",
            client_rows=len(before_restart_rows),
            tool_pairs=len(before_pairs),
            server_rows=len(before_server_rows),
            integrity=lcm.integrity(),
        )

        reopen_baseline = lifecycle.baseline()
        app.start(config)
        run.record("e6_app_started_reopen", service=app.service_snapshot(config))
        asyncio.run(_e6_reopen_phase(run, config, server_id, marker_one, marker_three))
        app.stop(config)

        after_rows, after_pairs = _wait_for_tool_pairs(
            lcm,
            client_id,
            minimum=len(before_pairs) + 1,
        )
        server_rows_after = lcm.rows(server_id)
        assert_prefix_unchanged(before_restart_rows, after_rows)
        if len(after_rows) <= len(before_restart_rows):
            raise AssertionError("reopened tool turn did not append rows under the canonical local key")
        if len(after_pairs) <= len(before_pairs):
            raise AssertionError("reopened tool turn did not append a tool call/result pair")
        if server_rows_after:
            raise AssertionError(
                f"D10 split-key regression: reopened rows were written under bare server UUID {server_id}: "
                f"{len(server_rows_after)} rows"
            )

        reopen_events = lifecycle.events_since(reopen_baseline)
        run.write_json("e6-reopen-lifecycle.json", reopen_events)
        opens = session_open_events(reopen_events)
        canonical_opens = [event for event in opens if event.get("conversation_id") == client_id]
        if not canonical_opens:
            raise AssertionError(
                f"no reopened session_open resolved server ID {server_id} to canonical key {client_id}; opens={opens}"
            )
        post_open = canonical_opens[-1]
        post_session_id = str(post_open.get("session_id") or "")
        post_task_id = str(post_open.get("task_id") or "")
        if post_task_id != pre_task_id:
            raise AssertionError(
                f"stable task identity rotated across restart: before {pre_task_id}, after {post_task_id or '<missing>'}"
            )
        if post_task_id != expected_task_id:
            raise AssertionError(
                f"reopened task identity mismatch: expected {expected_task_id}, got {post_task_id or '<missing>'}"
            )
        if not pre_session_id or not post_session_id or post_session_id == pre_session_id:
            raise AssertionError(
                f"lifecycle session did not rotate across restart: before {pre_session_id or '<missing>'}, after {post_session_id or '<missing>'}"
            )
        run.record(
            "e6_post_restart_identity",
            pre_session_id=pre_session_id,
            post_session_id=post_session_id,
            pre_task_id=pre_task_id,
            post_task_id=post_task_id,
            conversation_id=client_id,
            server_conversation_id=server_id,
        )
        reopened_sessions = sorted(by_session(reopen_events))
        run.write_json("e6-after-restart-rows.json", [row.__dict__ for row in after_rows])
        integrity = lcm.integrity()
        if integrity.get("integrity_check") != "ok" or integrity.get("foreign_key_violations"):
            raise AssertionError(f"LCM integrity failure after E6: {integrity}")
        if not integrity.get("fts_matches_messages"):
            raise AssertionError(f"LCM FTS/message mismatch after E6: {integrity}")

        run.record(
            "e6_postconditions",
            client_conversation_id=client_id,
            server_conversation_id=server_id,
            before_rows=len(before_restart_rows),
            after_rows=len(after_rows),
            appended_rows=len(after_rows) - len(before_restart_rows),
            before_tool_pairs=len(before_pairs),
            after_tool_pairs=len(after_pairs),
            server_key_rows=len(server_rows_after),
            pre_session_id=pre_session_id,
            post_session_id=post_session_id,
            pre_task_id=pre_task_id,
            post_task_id=post_task_id,
            reopened_sessions=reopened_sessions,
            lcm_total_delta=lcm.total_messages() - lcm_total_before,
            integrity=integrity,
        )
    except Exception as exc:
        # Preserve evidence and leave the app usable for inspection after a failed run.
        try:
            if not app.unit_is_active(config):
                app.start(config)
        except Exception:
            pass
        run.finish("FAIL", error=f"{type(exc).__name__}: {exc}")
        print(json.dumps({"verdict": "FAIL", "run": str(run.directory), "error": str(exc)}, indent=2))
        return 1

    app.start(config)
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

    e1_parser = subparsers.add_parser("e1", help="run E1 no-tool plain-Chat lifecycle + restart/reopen")
    e1_parser.set_defaults(func=command_e1)

    e5_parser = subparsers.add_parser("e5", help="run E5 same-process conversation/session reuse")
    e5_parser.set_defaults(func=command_e5)

    e6_parser = subparsers.add_parser("e6", help="run E6 restart/reopen conversation continuity")
    e6_parser.set_defaults(func=command_e6)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
