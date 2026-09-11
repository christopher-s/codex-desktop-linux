#!/usr/bin/env python3
"""Persistent Hermes lifecycle host for Codex Desktop ChatGPT turns.

The host imports the locally installed Hermes Agent runtime directly. It never
contacts or modifies the hermes-chatgpt bridge. In persistent mode it keeps one
MemoryManager and conversation transcript per Codex-created Hermes lifecycle
session so Hindsight, LCM, and hook state survive across turns.
"""

from __future__ import annotations

import atexit
import json
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


_HERMES: dict[str, Any] | None = None
_SESSIONS: dict[str, "SessionRuntime"] = {}
_REVIEW_PARENT: Any = None
_REVIEW_PARENT_LOCK = threading.Lock()
_REVIEW_PARENT_ERROR_LOGGED = False


def _patch_hermes_daemon_pool_for_python314() -> None:
    """Adapt Hermes's daemon ThreadPoolExecutor to CPython 3.14 internals.

    Hermes's current executor override mirrors the 3.8-3.13 private worker API
    (`_initializer` / `_initargs`). CPython 3.14 replaced that with a worker
    context object. Black Monolith runs 3.14, so keep the fix scoped to this
    Codex lifecycle host instead of mutating the installed Hermes checkout.
    """
    if sys.version_info < (3, 14):
        return

    import threading
    import weakref
    from concurrent.futures import ThreadPoolExecutor
    from concurrent.futures.thread import _worker
    from contextvars import copy_context
    import tools.daemon_pool as daemon_pool  # type: ignore

    current = daemon_pool.DaemonThreadPoolExecutor
    if getattr(current, "_codex_python314_compatible", False):
        return

    class CodexDaemonThreadPoolExecutor(ThreadPoolExecutor):
        _codex_python314_compatible = True

        def submit(self, fn, /, *args, **kwargs):
            ctx = copy_context()

            def _run_with_context(*call_args, **call_kwargs):
                return ctx.run(fn, *call_args, **call_kwargs)

            return super().submit(_run_with_context, *args, **kwargs)

        def _adjust_thread_count(self) -> None:
            if self._idle_semaphore.acquire(timeout=0):
                return

            def weakref_cb(_, q=self._work_queue):
                q.put(None)  # type: ignore[arg-type]

            num_threads = len(self._threads)
            if num_threads < self._max_workers:
                thread_name = "%s_%d" % (self._thread_name_prefix or self, num_threads)
                thread = threading.Thread(
                    name=thread_name,
                    target=_worker,
                    daemon=True,
                    args=(
                        weakref.ref(self, weakref_cb),
                        self._create_worker_context(),
                        self._work_queue,
                    ),
                )
                thread.start()
                self._threads.add(thread)  # type: ignore[attr-defined]

    daemon_pool.DaemonThreadPoolExecutor = CodexDaemonThreadPoolExecutor


def _conversation_alias_path() -> Path:
    state_dir = os.environ.get("CODEX_LINUX_APP_STATE_DIR")
    if state_dir:
        return Path(state_dir) / "hermes-chat-conversation-aliases.json"
    return Path.home() / ".local" / "state" / "codex-linux" / "hermes-chat-conversation-aliases.json"


def _load_conversation_aliases() -> dict[str, str]:
    path = _conversation_alias_path()
    try:
        if not path.is_file() or path.stat().st_size > 262144:
            return {}
        document = json.loads(path.read_text(encoding="utf-8"))
        aliases = document.get("aliases") if isinstance(document, dict) and document.get("version") == 1 else None
        if not isinstance(aliases, dict):
            return {}
        return {
            key: value
            for key, value in aliases.items()
            if isinstance(key, str)
            and key.startswith("local-chatgpt:")
            and isinstance(value, str)
            and value
            and not value.startswith("local-chatgpt:")
        }
    except (OSError, ValueError, TypeError):
        return {}


def _save_conversation_alias(local_id: str, server_id: str) -> None:
    if not local_id.startswith("local-chatgpt:") or not server_id or server_id.startswith("local-chatgpt:"):
        return
    path = _conversation_alias_path()
    aliases = _load_conversation_aliases()
    if aliases.get(local_id) == server_id:
        return
    aliases[local_id] = server_id
    document = {"version": 1, "aliases": dict(sorted(aliases.items()))}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _canonical_conversation_id(payload: dict[str, Any]) -> str:
    client_id = str(payload.get("client_conversation_id") or "")
    wire_id = str(payload.get("server_conversation_id") or payload.get("conversation_id") or "")
    aliases = _load_conversation_aliases()
    if client_id.startswith("local-chatgpt:"):
        established_id = aliases.get(client_id)
        if established_id and wire_id and wire_id != client_id and wire_id != established_id:
            _log({
                "event": "conversation_alias_conflict",
                "client_conversation_id": client_id,
                "established_conversation_id": established_id,
                "rejected_conversation_id": wire_id,
            })
        elif not established_id and wire_id and wire_id != client_id and not wire_id.startswith("local-chatgpt:"):
            _save_conversation_alias(client_id, wire_id)
        return client_id
    if wire_id:
        local_ids = [local_id for local_id, server_id in aliases.items() if server_id == wire_id]
        if len(local_ids) == 1:
            return local_ids[0]
    return wire_id or client_id


def _conversation_id(payload: dict[str, Any]) -> str:
    """Canonical Codex conversation identity for Hermes/LCM bindings."""
    return _canonical_conversation_id(payload)


def _task_id(conversation_id: str, session_id: str) -> str:
    """Stable Hermes operational task identity for one logical conversation.

    Lifecycle sessions are epoch-scoped and intentionally rotate across app/helper
    restart. Tool/process/CWD/browser state must instead follow the canonical
    logical conversation whenever it exists. Session identity remains the
    defensive fallback for payloads that predate conversation provisioning.
    """
    stable_id = str(conversation_id or "").strip() or str(session_id or "").strip()
    return f"chatgpt-codex:{stable_id}"


def _server_conversation_id(payload: dict[str, Any]) -> str:
    conversation_id = str(payload.get("conversation_id") or "")
    client_id = str(payload.get("client_conversation_id") or "")
    if conversation_id.startswith("local-chatgpt:") or conversation_id == client_id:
        return ""
    return conversation_id


def _message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, dict):
        return ""
    content = value.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, dict):
        return ""
    parts = content.get("parts")
    if isinstance(parts, list):
        return "\n".join(part for part in parts if isinstance(part, str))
    text = content.get("text")
    return text if isinstance(text, str) else ""


def _diagnostic_path() -> Path:
    state_dir = os.environ.get("CODEX_LINUX_APP_STATE_DIR")
    if state_dir:
        return Path(state_dir) / "hermes-chat-lifecycle.jsonl"
    return Path.home() / ".local" / "state" / "codex-linux" / "hermes-chat-lifecycle.jsonl"


def _log(event: dict[str, Any]) -> None:
    try:
        path = _diagnostic_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"ts": time.time(), **event}
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        pass


def _load_hermes() -> dict[str, Any]:
    global _HERMES
    if _HERMES is not None:
        return _HERMES

    root = os.environ.get("HERMES_AGENT_ROOT")
    hermes_root = Path(root).expanduser() if root else Path.home() / ".hermes" / "hermes-agent"
    if not hermes_root.is_dir():
        # Graceful local-Hermes detection: when Hermes is not installed locally,
        # the lifecycle host disables itself (and tool dispatch) rather than
        # raising, so plain-Chat turns proceed without a Hermes layer.
        raise HermesUnavailable(f"Hermes agent root not found: {hermes_root}")
    root_text = str(hermes_root)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)

    _patch_hermes_daemon_pool_for_python314()

    from agent.memory_manager import MemoryManager, build_memory_context_block  # type: ignore
    from agent.memory_provider import is_trivial_prompt  # type: ignore
    from hermes_cli.config import cfg_get, load_config  # type: ignore
    from hermes_cli.lifecycle import finalize_session, invoke_hook  # type: ignore
    from hermes_cli.plugins import get_plugin_context_engine  # type: ignore
    from hermes_constants import get_hermes_home  # type: ignore
    from plugins.memory import load_memory_provider  # type: ignore

    try:
        from hermes_cli.profiles import get_active_profile_name  # type: ignore
    except Exception:
        get_active_profile_name = lambda: ""  # noqa: E731

    # Tool dispatch: model_tools is imported lazily on first tool_call so the
    # lifecycle host does not pay the registry boot cost for memory-only turns.
    _HERMES = {
        "MemoryManager": MemoryManager,
        "build_memory_context_block": build_memory_context_block,
        "is_trivial_prompt": is_trivial_prompt,
        "cfg_get": cfg_get,
        "load_config": load_config,
        "invoke_hook": invoke_hook,
        "finalize_session": finalize_session,
        "get_plugin_context_engine": get_plugin_context_engine,
        "get_hermes_home": get_hermes_home,
        "load_memory_provider": load_memory_provider,
        "get_active_profile_name": get_active_profile_name,
        "model_tools": None,
    }
    return _HERMES


class HermesUnavailable(RuntimeError):
    """Raised when the local Hermes agent runtime is not installed/reachable."""


def _load_model_tools() -> Any:
    """Lazily import and boot the Hermes tool registry in this process.

    Shares the process's single Hermes runtime with the lifecycle session, so
    tool calls execute against the same registry and can be recorded into the
    same LCM transcript the lifecycle host maintains.
    """
    h = _load_hermes()
    mt = h.get("model_tools")
    if mt is not None:
        return mt
    try:
        import model_tools  # type: ignore

        model_tools.discover_builtin_tools()
        h["model_tools"] = model_tools
        _log({"event": "model_tools_boot", "tool_count": len(model_tools.get_all_tool_names())})
        return model_tools
    except Exception as exc:  # noqa
        _log({"event": "model_tools_boot_error", "error": f"{type(exc).__name__}: {exc}"})
        raise HermesUnavailable(f"model_tools unavailable: {type(exc).__name__}: {exc}")


def _env_enabled(name: str, *, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _qa_session_init_mode() -> str:
    mode = str(os.environ.get("CODEX_HERMES_QA_SESSION_INIT") or "").strip().lower()
    return mode if mode in {"no_memory", "no_context", "no_hooks", "minimal"} else ""


def _skill_review_interval() -> int:
    try:
        h = _load_hermes()
        config = h["load_config"]()
        raw = h["cfg_get"](config, "skills", "creation_nudge_interval", default=10)
        return max(0, int(raw))
    except Exception:
        return 10


def _review_summary_callback(message: str) -> None:
    _log({"event": "background_review_action", "message": str(message)[:4000]})


def _ensure_review_parent() -> Any:
    """Lazily create the real Hermes parent used only to fork skill reviewers."""
    global _REVIEW_PARENT, _REVIEW_PARENT_ERROR_LOGGED
    if not _env_enabled("CODEX_HERMES_BACKGROUND_REVIEW", default=True):
        return None
    if _REVIEW_PARENT is not None:
        return _REVIEW_PARENT
    with _REVIEW_PARENT_LOCK:
        if _REVIEW_PARENT is not None:
            return _REVIEW_PARENT
        try:
            h = _load_hermes()
            config = h["load_config"]()
            provider = str(h["cfg_get"](config, "model", "provider", default="") or "").strip()
            model = str(h["cfg_get"](config, "model", "default", default="") or "").strip()
            if not provider or not model:
                raise RuntimeError("Hermes main provider/model are not configured")
            from run_agent import AIAgent  # type: ignore

            parent = AIAgent(
                provider=provider,
                model=model,
                quiet_mode=True,
                platform="chatgpt-codex-review-host",
                session_id=f"hs_codex_review_host_{os.getpid()}",
                skip_context_files=True,
                load_soul_identity=False,
                skip_memory=True,
                skip_background_review=True,
            )
            parent.background_review_callback = _review_summary_callback
            _REVIEW_PARENT = parent
            aux_provider = str(h["cfg_get"](config, "auxiliary", "background_review", "provider", default="") or "")
            aux_model = str(h["cfg_get"](config, "auxiliary", "background_review", "model", default="") or "")
            _log(
                {
                    "event": "background_review_host_ready",
                    "provider": provider,
                    "model": model,
                    "aux_provider": aux_provider,
                    "aux_model": aux_model,
                    "skill_interval": int(getattr(parent, "_skill_nudge_interval", _skill_review_interval()) or 0),
                }
            )
            return parent
        except Exception as exc:
            if not _REVIEW_PARENT_ERROR_LOGGED:
                _REVIEW_PARENT_ERROR_LOGGED = True
                _log({"event": "background_review_host_error", "error": f"{type(exc).__name__}: {exc}"})
            return None


def _cancel_background_review_for_live_turn() -> None:
    parent = _REVIEW_PARENT
    if parent is None:
        return
    try:
        from agent.background_review import cancel_background_review_for_live_turn  # type: ignore

        run = getattr(parent, "_background_review_run", None)
        active = run is not None and not run.request_done.is_set()
        cancel_background_review_for_live_turn(parent)
        if active:
            _log({"event": "background_review_preempted", "reason": "foreground-chatgpt-turn"})
    except Exception as exc:
        _log({"event": "background_review_preempt_error", "error": f"{type(exc).__name__}: {exc}"})


def _monitor_background_review(run: Any, metadata: dict[str, Any]) -> None:
    started_at = time.time()
    try:
        completed = bool(run.request_done.wait(timeout=660.0))
        cancelled = bool(getattr(run, "cancel_requested", None) and run.cancel_requested.is_set())
        if not completed:
            event = "background_review_monitor_timeout"
        elif cancelled:
            event = "background_review_cancelled"
        else:
            event = "background_review_complete"
        _log(
            {
                "event": event,
                **metadata,
                "duration": max(0.0, time.time() - started_at),
                "cancelled": cancelled,
            }
        )
    except Exception as exc:
        _log({"event": "background_review_monitor_error", **metadata, "error": f"{type(exc).__name__}: {exc}"})


def _maybe_schedule_skill_review(
    runtime: "SessionRuntime", payload: dict[str, Any], history: list[dict[str, Any]],
) -> dict[str, Any]:
    if not _env_enabled("CODEX_HERMES_BACKGROUND_REVIEW", default=True):
        return {"scheduled": False, "reason": "disabled"}
    try:
        estimate = int(payload.get("model_iterations_estimate") or 1)
    except (TypeError, ValueError):
        estimate = 1
    estimate = max(1, min(100, estimate))
    runtime.review_iterations_since_skill += estimate
    interval = _skill_review_interval()
    force = os.environ.get("CODEX_HERMES_QA_FORCE_SKILL_REVIEW") == "1" and not runtime.qa_forced_review_consumed
    due = force or (interval > 0 and runtime.review_iterations_since_skill >= interval)
    if not due:
        return {
            "scheduled": False,
            "reason": "cadence",
            "iterations_since_skill": runtime.review_iterations_since_skill,
            "interval": interval,
            "iteration_estimate": estimate,
        }

    parent = _ensure_review_parent()
    if parent is None:
        return {
            "scheduled": False,
            "reason": "review-parent-unavailable",
            "iterations_since_skill": runtime.review_iterations_since_skill,
            "interval": interval,
            "forced": force,
        }

    # Hermes permits one active review per parent. Preserve this session's
    # cadence when another session already owns the native review slot.
    current_run = getattr(parent, "_background_review_run", None)
    if current_run is not None and not current_run.request_done.is_set():
        return {
            "scheduled": False,
            "reason": "active-review",
            "iterations_since_skill": runtime.review_iterations_since_skill,
            "interval": interval,
            "forced": force,
        }

    if force:
        runtime.qa_forced_review_consumed = True
    try:
        parent._spawn_background_review(
            messages_snapshot=list(history),
            review_memory=False,
            review_skills=True,
            explicit=force,
        )
        run = getattr(parent, "_background_review_run", None)
        if run is None:
            _log(
                {
                    "event": "background_review_not_spawned",
                    "session_id": runtime.session_id,
                    "turn_id": payload.get("turn_id"),
                    "forced": force,
                    "interval": interval,
                }
            )
            return {"scheduled": False, "reason": "native-gate-or-deferred", "forced": force, "interval": interval}
        runtime.review_iterations_since_skill = 0
        runtime.skill_review_count += 1
        metadata = {
            "session_id": runtime.session_id,
            "turn_id": str(payload.get("turn_id") or ""),
            "review_count": runtime.skill_review_count,
            "forced": force,
            "interval": interval,
            "iteration_estimate": estimate,
            "history_messages": len(history),
        }
        _log({"event": "background_review_spawned", **metadata})
        threading.Thread(
            target=_monitor_background_review,
            args=(run, metadata),
            daemon=True,
            name="codex-bg-review-monitor",
        ).start()
        return {
            "scheduled": True,
            "reason": "forced" if force else "cadence",
            "forced": force,
            "interval": interval,
            "review_count": runtime.skill_review_count,
        }
    except Exception as exc:
        _log(
            {
                "event": "background_review_spawn_error",
                "session_id": runtime.session_id,
                "turn_id": payload.get("turn_id"),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
        return {"scheduled": False, "reason": "spawn-error", "error": f"{type(exc).__name__}: {exc}"}


def _shutdown_review_parent() -> None:
    global _REVIEW_PARENT
    with _REVIEW_PARENT_LOCK:
        parent = _REVIEW_PARENT
        _REVIEW_PARENT = None
    if parent is None:
        return
    try:
        from agent.background_review import cancel_background_review_for_live_turn  # type: ignore

        cancel_background_review_for_live_turn(parent)
    except Exception:
        pass
    try:
        parent.close()
        _log({"event": "background_review_host_close"})
    except Exception as exc:
        _log({"event": "background_review_host_close_error", "error": f"{type(exc).__name__}: {exc}"})


@dataclass
class SessionRuntime:
    session_id: str
    conversation_id: str = ""
    server_conversation_id: str = ""
    model: str = "chatgpt"
    memory_manager: Any = None
    memory_provider_name: str = ""
    context_engine: Any = None
    context_engine_name: str = ""
    turn_number: int = 0
    api_call_count: int = 0
    api_requests: dict[str, dict[str, Any]] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)
    review_iterations_since_skill: int = 0
    skill_review_count: int = 0
    qa_forced_review_consumed: bool = False

    @property
    def task_id(self) -> str:
        return _task_id(self.conversation_id, self.session_id)

    def close(self, *, reason: str = "codex-close") -> None:
        h = _load_hermes()
        history = list(self.history)
        engine = self.context_engine
        if engine is not None:
            try:
                engine.on_session_end(self.session_id, history)
                _log({
                    "event": "context_engine_session_end",
                    "session_id": self.session_id,
                    "context_engine": self.context_engine_name,
                    "history_messages": len(history),
                })
            except Exception as exc:
                _log({
                    "event": "context_engine_session_end_error",
                    "session_id": self.session_id,
                    "context_engine": self.context_engine_name,
                    "error": f"{type(exc).__name__}: {exc}",
                })
        manager = self.memory_manager
        if manager is not None:
            try:
                manager.on_session_end(history)
                _log({
                    "event": "memory_session_end",
                    "session_id": self.session_id,
                    "memory_provider": self.memory_provider_name,
                    "history_messages": len(history),
                })
            except Exception as exc:
                _log({
                    "event": "memory_session_end_error",
                    "session_id": self.session_id,
                    "memory_provider": self.memory_provider_name,
                    "error": f"{type(exc).__name__}: {exc}",
                })
            try:
                manager.shutdown_all()
                _log({
                    "event": "memory_shutdown",
                    "session_id": self.session_id,
                    "memory_provider": self.memory_provider_name,
                })
            except Exception as exc:
                _log({
                    "event": "memory_shutdown_error",
                    "session_id": self.session_id,
                    "memory_provider": self.memory_provider_name,
                    "error": f"{type(exc).__name__}: {exc}",
                })
            self.memory_manager = None
        try:
            results = h["finalize_session"](
                session_id=self.session_id,
                model=self.model,
                platform="chatgpt-codex",
                reason=reason,
                conversation_id=self.conversation_id,
            )
            _log({
                "event": "session_finalize",
                "session_id": self.session_id,
                "reason": reason,
                "hook_result_count": len(results) if isinstance(results, list) else 0,
            })
        except Exception as exc:
            _log({
                "event": "session_finalize_error",
                "session_id": self.session_id,
                "error": f"{type(exc).__name__}: {exc}",
            })


def _create_memory_manager(session_id: str) -> tuple[Any, str]:
    h = _load_hermes()
    config = h["load_config"]()
    provider_name = str(h["cfg_get"](config, "memory", "provider", default="") or "").strip()
    if not provider_name:
        return None, ""

    manager = h["MemoryManager"]()
    provider = h["load_memory_provider"](provider_name)
    if provider is None or not provider.is_available():
        return None, provider_name

    manager.add_provider(provider)
    init_kwargs: dict[str, Any] = {
        "platform": "chatgpt-codex",
        "hermes_home": str(h["get_hermes_home"]()),
        "agent_context": "primary",
        "agent_workspace": "hermes",
    }
    try:
        profile = h["get_active_profile_name"]()
        if profile:
            init_kwargs["agent_identity"] = profile
    except Exception:
        pass
    manager.initialize_all(session_id=session_id, **init_kwargs)
    return manager, provider_name


def _session(session_id: str, payload: Optional[dict[str, Any]] = None) -> SessionRuntime:
    if not session_id:
        raise ValueError("session_id is required")
    runtime = _SESSIONS.get(session_id)
    if runtime is not None:
        if payload:
            # Learn the durable alias as soon as both wire identities coexist,
            # while retaining this runtime's original context-engine binding.
            # The canonical server identity takes effect on the next runtime.
            if "server_conversation_id" in payload:
                _log({
                    "event": "conversation_identity_observed",
                    "session_id": session_id,
                    "phase": str(payload.get("phase") or ""),
                    "conversation_id": str(payload.get("conversation_id") or ""),
                    "client_conversation_id": str(payload.get("client_conversation_id") or ""),
                    "server_conversation_id": str(payload.get("server_conversation_id") or ""),
                })
            _conversation_id(payload)
            runtime.server_conversation_id = _server_conversation_id(payload) or runtime.server_conversation_id
            runtime.model = str(payload.get("model") or runtime.model or "chatgpt")
        return runtime

    payload = payload or {}
    conversation_id = _conversation_id(payload)
    server_conversation_id = _server_conversation_id(payload)
    model = str(payload.get("model") or "chatgpt")
    h = _load_hermes()
    qa_session_init = _qa_session_init_mode()
    if qa_session_init in {"no_memory", "minimal"}:
        manager, provider_name = None, ""
    else:
        manager, provider_name = _create_memory_manager(session_id)

    context_engine = None
    context_engine_name = ""
    context_engine_error = ""
    if qa_session_init not in {"no_context", "minimal"}:
        try:
            context_engine = h["get_plugin_context_engine"]()
            context_engine_name = str(getattr(context_engine, "name", "") or "") if context_engine is not None else ""
            if context_engine is not None:
                context_engine.on_session_start(
                    session_id,
                    platform="chatgpt-codex",
                    conversation_id=conversation_id or session_id,
                    hermes_home=str(h["get_hermes_home"]()),
                    model=model,
                )
        except Exception as exc:
            context_engine_error = f"{type(exc).__name__}: {exc}"
            context_engine = None

    session_start_hook_count = 0
    session_start_hook_error = ""
    if qa_session_init not in {"no_hooks", "minimal"}:
        try:
            results = h["invoke_hook"](
                "on_session_start",
                session_id=session_id,
                model=model,
                platform="chatgpt-codex",
                conversation_id=conversation_id,
            )
            session_start_hook_count = len(results) if isinstance(results, list) else 0
        except Exception as exc:
            session_start_hook_error = f"{type(exc).__name__}: {exc}"

    runtime = SessionRuntime(
        session_id=session_id,
        conversation_id=conversation_id,
        server_conversation_id=server_conversation_id,
        model=model,
        memory_manager=manager,
        memory_provider_name=provider_name,
        context_engine=context_engine,
        context_engine_name=context_engine_name,
    )
    _SESSIONS[session_id] = runtime
    _log(
        {
            "event": "session_open",
            "session_id": session_id,
            "task_id": runtime.task_id,
            "conversation_id": conversation_id,
            "server_conversation_id": server_conversation_id,
            "memory_provider": provider_name,
            "memory_active": manager is not None,
            "context_engine": context_engine_name,
            "context_engine_active": context_engine is not None,
            "context_engine_error": context_engine_error,
            "session_start_hook_count": session_start_hook_count,
            "session_start_hook_error": session_start_hook_error,
            "qa_session_init": qa_session_init,
        }
    )
    return runtime


def _collect_context(results: Any) -> str:
    chunks: list[str] = []
    if not isinstance(results, list):
        return ""
    for result in results:
        if not isinstance(result, dict):
            continue
        context = result.get("context")
        if isinstance(context, str) and context.strip():
            chunks.append(context.strip())
    return "\n\n".join(chunks)


def _turn_history(runtime: SessionRuntime, user_text: str, assistant_text: str = "") -> list[dict[str, Any]]:
    history = list(runtime.history)
    if user_text:
        history.append({"role": "user", "content": user_text})
    if assistant_text:
        history.append({"role": "assistant", "content": assistant_text})
    return history


def _base_kwargs(payload: dict[str, Any], runtime: SessionRuntime, *, assistant_text: str = "") -> dict[str, Any]:
    user_text = _message_text(payload.get("user_message"))
    return {
        "session_id": runtime.session_id,
        "task_id": runtime.task_id,
        "turn_id": str(payload.get("turn_id") or ""),
        "user_message": user_text,
        "conversation_history": _turn_history(runtime, user_text, assistant_text),
        "model": str(payload.get("model") or "chatgpt"),
        "platform": "chatgpt-codex",
        "parent_session_id": "",
        "sender_id": "",
        "gizmo_id": payload.get("gizmo_id"),
        "conversation_id": runtime.conversation_id,
        "server_conversation_id": runtime.server_conversation_id,
        "context_compressor": runtime.context_engine,
    }


def _pre_api_request(payload: dict[str, Any], runtime: SessionRuntime) -> dict[str, Any]:
    h = _load_hermes()
    user_text = _message_text(payload.get("user_message"))
    turn_id = str(payload.get("turn_id") or "")
    runtime.api_call_count += 1
    api_call_count = runtime.api_call_count
    api_request_id = f"chatgpt-codex:{runtime.session_id}:{turn_id or api_call_count}:{api_call_count}"
    started_at = time.time()
    request_messages = _turn_history(runtime, user_text)
    request_chars = sum(len(item.get("content") or "") for item in request_messages)
    state = {
        "api_request_id": api_request_id,
        "started_at": started_at,
        "api_call_count": api_call_count,
        "request_message_count": len(request_messages),
    }
    runtime.api_requests[turn_id] = state
    hook_results: Any = []
    hook_error = ""
    try:
        hook_results = h["invoke_hook"](
            "pre_api_request",
            task_id=runtime.task_id,
            turn_id=turn_id,
            api_request_id=api_request_id,
            session_id=runtime.session_id,
            user_message=user_text,
            conversation_history=list(request_messages),
            platform="chatgpt-codex",
            model=runtime.model,
            provider="chatgpt",
            base_url="https://chatgpt.com",
            api_mode="chatgpt_conversation",
            api_call_count=api_call_count,
            retry_count=0,
            request_messages=list(request_messages),
            system_prompt="",
            message_count=len(request_messages),
            tool_count=0,
            approx_input_tokens=None,
            request_char_count=request_chars,
            max_tokens=None,
            started_at=started_at,
            middleware_trace=[],
            request={
                "transport": "codex-desktop-chatgpt",
                "logical_client_request": True,
                "gizmo_id": payload.get("gizmo_id"),
                "conversation_id": runtime.conversation_id,
                "server_conversation_id": runtime.server_conversation_id,
            },
        )
    except Exception as exc:
        hook_error = f"{type(exc).__name__}: {exc}"
    hook_count = len(hook_results) if isinstance(hook_results, list) else 0
    _log(
        {
            "event": "pre_api_request",
            "session_id": runtime.session_id,
            "turn_id": turn_id,
            "api_request_id": api_request_id,
            "api_call_count": api_call_count,
            "hook_result_count": hook_count,
            "hook_error": hook_error,
        }
    )
    return {
        "ok": True,
        "enabled": True,
        "phase": "pre_api_request",
        "session_id": runtime.session_id,
        "api_request_id": api_request_id,
        "api_call_count": api_call_count,
        "hook_result_count": hook_count,
        "hook_error": hook_error,
    }


def _post_api_request(payload: dict[str, Any], runtime: SessionRuntime, assistant_text: str) -> tuple[int, str]:
    h = _load_hermes()
    turn_id = str(payload.get("turn_id") or "")
    state = runtime.api_requests.pop(turn_id, None) or {}
    api_request_id = str(state.get("api_request_id") or f"chatgpt-codex:{runtime.session_id}:{turn_id}")
    started_at = float(state.get("started_at") or time.time())
    api_call_count = int(state.get("api_call_count") or runtime.api_call_count or 1)
    ended_at = time.time()
    duration = max(0.0, ended_at - started_at)
    hook_results: Any = []
    hook_error = ""
    try:
        hook_results = h["invoke_hook"](
            "post_api_request",
            task_id=runtime.task_id,
            turn_id=turn_id,
            api_request_id=api_request_id,
            session_id=runtime.session_id,
            platform="chatgpt-codex",
            model=runtime.model,
            provider="chatgpt",
            base_url="https://chatgpt.com",
            api_mode="chatgpt_conversation",
            api_call_count=api_call_count,
            api_duration=duration,
            started_at=started_at,
            ended_at=ended_at,
            first_chunk_at=None,
            finish_reason="stop",
            message_count=int(state.get("request_message_count") or 0),
            response_model=runtime.model,
            response={
                "transport": "codex-desktop-chatgpt",
                "logical_client_response": True,
                "assistant_content_chars": len(assistant_text),
            },
            usage={},
            assistant_message={"role": "assistant", "content": assistant_text},
            assistant_content_chars=len(assistant_text),
            assistant_tool_call_count=0,
            moa_references=None,
        )
    except Exception as exc:
        hook_error = f"{type(exc).__name__}: {exc}"
    hook_count = len(hook_results) if isinstance(hook_results, list) else 0
    _log(
        {
            "event": "post_api_request",
            "session_id": runtime.session_id,
            "turn_id": turn_id,
            "api_request_id": api_request_id,
            "api_call_count": api_call_count,
            "api_duration": duration,
            "hook_result_count": hook_count,
            "hook_error": hook_error,
        }
    )
    return hook_count, hook_error


def _api_request_error(payload: dict[str, Any], runtime: SessionRuntime) -> tuple[int, str]:
    h = _load_hermes()
    turn_id = str(payload.get("turn_id") or "")
    state = runtime.api_requests.pop(turn_id, None) or {}
    api_request_id = str(state.get("api_request_id") or f"chatgpt-codex:{runtime.session_id}:{turn_id}")
    started_at = float(state.get("started_at") or time.time())
    api_call_count = int(state.get("api_call_count") or runtime.api_call_count or 1)
    error_value = payload.get("error")
    error_text = str(error_value or "ChatGPT model request failed")
    hook_results: Any = []
    hook_error = ""
    try:
        hook_results = h["invoke_hook"](
            "api_request_error",
            task_id=runtime.task_id,
            turn_id=turn_id,
            api_request_id=api_request_id,
            session_id=runtime.session_id,
            platform="chatgpt-codex",
            model=runtime.model,
            provider="chatgpt",
            base_url="https://chatgpt.com",
            api_mode="chatgpt_conversation",
            api_call_count=api_call_count,
            retry_count=0,
            started_at=started_at,
            error_type="chatgpt_client_error",
            error_message=error_text[:2000],
            retryable=False,
        )
    except Exception as exc:
        hook_error = f"{type(exc).__name__}: {exc}"
    hook_count = len(hook_results) if isinstance(hook_results, list) else 0
    _log(
        {
            "event": "api_request_error",
            "session_id": runtime.session_id,
            "turn_id": turn_id,
            "api_request_id": api_request_id,
            "api_call_count": api_call_count,
            "hook_result_count": hook_count,
            "hook_error": hook_error,
            "error": error_text[:2000],
        }
    )
    return hook_count, hook_error


def _turn_end_hook(
    payload: dict[str, Any], runtime: SessionRuntime, *, completed: bool, failed: bool,
    interrupted: bool, turn_exit_reason: str,
) -> tuple[int, str]:
    h = _load_hermes()
    results: Any = []
    hook_error = ""
    try:
        results = h["invoke_hook"](
            "on_session_end",
            session_id=runtime.session_id,
            task_id=runtime.task_id,
            turn_id=str(payload.get("turn_id") or ""),
            completed=completed,
            failed=failed,
            interrupted=interrupted,
            turn_exit_reason=turn_exit_reason,
            model=runtime.model,
            platform="chatgpt-codex",
            conversation_id=runtime.conversation_id,
        )
    except Exception as exc:
        hook_error = f"{type(exc).__name__}: {exc}"
    hook_count = len(results) if isinstance(results, list) else 0
    _log(
        {
            "event": "on_session_end",
            "session_id": runtime.session_id,
            "turn_id": payload.get("turn_id"),
            "completed": completed,
            "failed": failed,
            "interrupted": interrupted,
            "turn_exit_reason": turn_exit_reason,
            "hook_result_count": hook_count,
            "hook_error": hook_error,
        }
    )
    return hook_count, hook_error


def _begin_turn(payload: dict[str, Any], runtime: SessionRuntime) -> dict[str, Any]:
    _cancel_background_review_for_live_turn()
    h = _load_hermes()
    user_text = _message_text(payload.get("user_message"))
    runtime.turn_number += 1

    manager = runtime.memory_manager
    memory_context = ""
    memory_prompt = ""
    recall_status = ""
    if manager is not None:
        try:
            manager.on_turn_start(
                runtime.turn_number,
                user_text,
                session_id=runtime.session_id,
                platform="chatgpt-codex",
                conversation_id=runtime.conversation_id,
            )
        except Exception:
            pass
        try:
            memory_prompt = manager.build_system_prompt() or ""
        except Exception:
            memory_prompt = ""
        try:
            memory_context = manager.prefetch_all(user_text, session_id=runtime.session_id) or ""
            recall_status = manager.describe_recall() or ""
        except Exception:
            memory_context = ""
            recall_status = ""

    kwargs = _base_kwargs(payload, runtime)
    kwargs["is_first_turn"] = runtime.turn_number == 1
    results = h["invoke_hook"]("pre_llm_call", **kwargs)
    plugin_context = _collect_context(results)

    system_context = memory_prompt.strip() if isinstance(memory_prompt, str) else ""
    fenced_memory_context = ""
    if isinstance(memory_context, str) and memory_context.strip():
        try:
            fenced_memory_context = h["build_memory_context_block"](memory_context) or ""
        except Exception:
            fenced_memory_context = memory_context.strip()
    user_chunks = [
        chunk.strip()
        for chunk in (fenced_memory_context, plugin_context)
        if isinstance(chunk, str) and chunk.strip()
    ]
    user_context = "\n\n".join(user_chunks)
    response = {
        "ok": True,
        "enabled": True,
        "phase": "begin_turn",
        "session_id": runtime.session_id,
        "system_context": system_context,
        "user_context": user_context,
        "hook_result_count": len(results) if isinstance(results, list) else 0,
        "memory_provider": runtime.memory_provider_name,
        "memory_active": manager is not None,
        "memory_context_chars": len(memory_context),
        "memory_prompt_chars": len(memory_prompt),
        "recall_status": recall_status,
        "turn_number": runtime.turn_number,
    }
    _log(
        {
            "event": "begin_turn",
            "session_id": runtime.session_id,
            "turn_id": payload.get("turn_id"),
            "gizmo_id": payload.get("gizmo_id"),
            "turn_number": runtime.turn_number,
            "is_first_turn": runtime.turn_number == 1,
            "context_chars": len(system_context) + len(user_context),
            "system_context_chars": len(system_context),
            "user_context_chars": len(user_context),
            "plugin_context_chars": len(plugin_context),
            "memory_prompt_chars": len(memory_prompt),
            "memory_context_chars": len(memory_context),
            "fenced_memory_context_chars": len(fenced_memory_context),
            "memory_provider": runtime.memory_provider_name,
            "memory_active": manager is not None,
            "recall_status": recall_status,
            "hook_result_count": response["hook_result_count"],
        }
    )
    return response


def _complete_turn(payload: dict[str, Any], runtime: SessionRuntime) -> dict[str, Any]:
    h = _load_hermes()
    user_text = _message_text(payload.get("user_message"))
    assistant_text = _message_text(payload.get("assistant_message"))
    history = _turn_history(runtime, user_text, assistant_text)

    # Native order: provider/API response hook precedes final model/turn hooks.
    post_api_hook_count, post_api_hook_error = _post_api_request(payload, runtime, assistant_text)

    kwargs = _base_kwargs(payload, runtime, assistant_text=assistant_text)
    kwargs["assistant_response"] = assistant_text
    results = h["invoke_hook"]("post_llm_call", **kwargs)

    context_engine_turn_error = ""
    engine = runtime.context_engine
    if engine is not None:
        try:
            engine.on_turn_complete(
                list(history),
                usage=None,
                turn_id=str(payload.get("turn_id") or ""),
                task_id=runtime.task_id,
                api_call_count=runtime.api_call_count,
                interrupted=False,
                failed=False,
                turn_exit_reason="completed",
            )
        except Exception as exc:
            context_engine_turn_error = f"{type(exc).__name__}: {exc}"

    manager = runtime.memory_manager
    memory_sync_queued = False
    memory_sync_error = ""
    if manager is not None and user_text and assistant_text:
        try:
            manager.sync_all(user_text, assistant_text, session_id=runtime.session_id, messages=history)
            if not h["is_trivial_prompt"](user_text):
                manager.queue_prefetch_all(user_text, session_id=runtime.session_id)
            memory_sync_queued = True
        except Exception as exc:
            memory_sync_queued = False
            memory_sync_error = f"{type(exc).__name__}: {exc}"

    runtime.history = history
    review = _maybe_schedule_skill_review(runtime, payload, history)
    turn_end_hook_count, turn_end_hook_error = _turn_end_hook(
        payload,
        runtime,
        completed=True,
        failed=False,
        interrupted=False,
        turn_exit_reason="completed",
    )
    hook_count = len(results) if isinstance(results, list) else 0
    _log(
        {
            "event": "complete_turn",
            "session_id": runtime.session_id,
            "turn_id": payload.get("turn_id"),
            "gizmo_id": payload.get("gizmo_id"),
            "turn_number": runtime.turn_number,
            "assistant_chars": len(assistant_text),
            "history_messages": len(runtime.history),
            "hook_result_count": hook_count,
            "post_api_hook_count": post_api_hook_count,
            "post_api_hook_error": post_api_hook_error,
            "turn_end_hook_count": turn_end_hook_count,
            "turn_end_hook_error": turn_end_hook_error,
            "memory_provider": runtime.memory_provider_name,
            "memory_sync_queued": memory_sync_queued,
            "memory_sync_error": memory_sync_error,
            "context_engine": runtime.context_engine_name,
            "context_engine_turn_error": context_engine_turn_error,
            "background_review": review,
        }
    )
    return {
        "ok": True,
        "enabled": True,
        "phase": "complete_turn",
        "session_id": runtime.session_id,
        "hook_result_count": hook_count,
        "post_api_hook_count": post_api_hook_count,
        "turn_end_hook_count": turn_end_hook_count,
        "memory_sync_queued": memory_sync_queued,
        "memory_sync_error": memory_sync_error,
        "context_engine": runtime.context_engine_name,
        "context_engine_turn_error": context_engine_turn_error,
        "history_messages": len(runtime.history),
        "background_review": review,
    }


# Hermes's Tool Search bridge tools (tools/tool_search.py). They are bridge
# names, never registry entries, so the advertised `hermes_`-prefixed surface
# maps them onto the bridge dispatch in model_tools.handle_function_call.
BRIDGE_TOOL_NAMES = frozenset({"tool_search", "tool_describe", "tool_call"})


def _ensure_tool_session(session_id: str, conversation_id: str) -> SessionRuntime:
    """Get-or-create the lifecycle runtime that owns plain-Chat tool calls.

    The main-bundle `tool_call` branch always key-maps the conversation to an
    `hs_codex_*` session, so this normally finds an existing runtime. If the
    host received a conversation-keyed payload without a session id (defensive:
    older probes or direct IPC), a session is derived here instead of failing
    the call. The runtime is the same object gizmo turns use, so tool calls
    accumulate into the same transcript that close_session finalizes.

    The tool_call IPC carries one wire conversation id and no model. Preserve
    that id as wire identity so persisted aliases can reverse-resolve reopened
    server ids without mutating an existing runtime's context-engine binding.
    """
    key = session_id or (f"tool\0{conversation_id}" if conversation_id else "")
    if not key:
        raise ValueError("session_id or conversation_id is required")
    payload = {"conversation_id": conversation_id} if conversation_id else None
    return _session(key, payload)


def _handle_tool_call(payload: dict[str, Any]) -> dict[str, Any]:
    """Execute a Hermes tool in this shared process and return its result.

    The Codex ChatGPT executor routes client-advertised local-function calls
    here instead of to a separate HTTP endpoint, so the call runs against the
    same Hermes runtime (and is recorded into the same LCM transcript) that the
    lifecycle session maintains. Works in plain Chat: the session is keyed by
    the conversation, not a Custom-GPT gizmo.

    Three kinds of advertised names reach the host:
    - `hermes_<bare>` where `<bare>` is a registry tool (prefix stripped);
    - `hermes_tool_search` / `hermes_tool_describe` / `hermes_tool_call`,
      which map onto Hermes's native Tool Search bridge (progressive
      disclosure over the full registry; string arguments are acceptable and
      the bridge handles them internally);
    - bare names, passed through so registry errors surface truthfully.

    Every executed call is appended to the session runtime's transcript
    (tool_call + tool-result rows) so the conversation's Hindsight sync and
    LCM ingestion see the tool activity, and `handle_function_call` receives
    the session and call ids for its hook identity fields.
    """
    name = payload.get("name")
    args = payload.get("arguments") or {}
    if not isinstance(name, str) or not name:
        return {"ok": False, "enabled": True, "phase": "tool_call", "error": "missing-name"}
    if not isinstance(args, dict):
        return {"ok": False, "enabled": True, "phase": "tool_call", "error": "arguments-not-object"}

    # Map the advertised name: bridge names first (they are never registry
    # entries, so the registry set can never contain them), then the
    # model-facing `hermes_` prefix strip to a bare registry tool; anything
    # else passes through so the registry's own "Unknown tool" error
    # surfaces truthfully.
    registry_name = name
    try:
        mt = _load_model_tools()
        if name.startswith("hermes_"):
            bare = name[len("hermes_"):]
            if bare in BRIDGE_TOOL_NAMES:
                registry_name = bare
            elif bare in set(mt.get_all_tool_names()):
                registry_name = bare
    except HermesUnavailable as exc:
        return {"ok": False, "enabled": False, "phase": "tool_call", "name": name, "error": str(exc)}

    conversation_id = str(payload.get("conversation_id") or payload.get("client_conversation_id") or "")
    session_id = str(payload.get("session_id") or "")
    try:
        runtime = _ensure_tool_session(session_id, conversation_id)
    except ValueError as exc:
        return {
            "ok": False,
            "enabled": True,
            "phase": "tool_call",
            "name": name,
            "registry_name": registry_name,
            "error": f"{type(exc).__name__}: {exc}",
        }
    session_id = runtime.session_id
    task_id = runtime.task_id
    tool_call_id = str(payload.get("callId") or payload.get("tool_call_id") or "")

    started = time.time()
    try:
        out = mt.handle_function_call(
            registry_name, args, task_id=task_id, session_id=session_id, tool_call_id=tool_call_id
        )
        try:
            result = json.loads(out)
        except Exception:  # noqa
            result = out
        # Record the executed call and its result in the shared transcript:
        # the row shape matches Hermes's own tool-call/tool-result pairs, so
        # LCM ingestion (store.append) and Hindsight sync see the activity.
        runtime.history.append(
            {
                "role": "tool_call",
                "content": registry_name,
                "tool_name": registry_name,
                "tool_call_id": tool_call_id,
                "args": args,
                "timestamp": started,
            }
        )
        runtime.history.append(
            {
                "role": "tool",
                "content": str(result),
                "tool_name": registry_name,
                "tool_call_id": tool_call_id,
                "timestamp": time.time(),
            }
        )
        elapsed_ms = int((time.time() - started) * 1000)
        _log(
            {
                "event": "tool_call",
                "session_id": session_id,
                "task_id": task_id,
                "conversation_id": runtime.conversation_id,
                "name": name,
                "registry_name": registry_name,
                "tool_call_id": tool_call_id,
                "ok": True,
                "elapsed_ms": elapsed_ms,
                "arg_keys": sorted(args.keys()),
                "history_messages": len(runtime.history),
            }
        )
        return {
            "ok": True,
            "enabled": True,
            "phase": "tool_call",
            "name": name,
            "registry_name": registry_name,
            "session_id": session_id,
            "task_id": task_id,
            "result": result,
            "elapsed_ms": elapsed_ms,
            "history_messages": len(runtime.history),
        }
    except Exception as exc:  # noqa
        elapsed_ms = int((time.time() - started) * 1000)
        _log(
            {
                "event": "tool_call_error",
                "session_id": session_id,
                "task_id": task_id,
                "conversation_id": runtime.conversation_id,
                "name": name,
                "registry_name": registry_name,
                "tool_call_id": tool_call_id,
                "error": f"{type(exc).__name__}: {exc}",
                "elapsed_ms": elapsed_ms,
            }
        )
        return {
            "ok": False,
            "enabled": True,
            "phase": "tool_call",
            "name": name,
            "registry_name": registry_name,
            "session_id": session_id,
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_ms": elapsed_ms,
            "history_messages": len(runtime.history),
        }


def _handle(payload: dict[str, Any]) -> dict[str, Any]:
    phase = payload.get("phase")
    if phase == "tool_call":
        return _handle_tool_call(payload)
    if phase not in {
        "begin_turn", "pre_api_request", "complete_turn", "abort_turn",
        "model_call_error", "conversation_identity", "close_session",
    }:
        return {"ok": False, "error": "unsupported-phase"}

    session_id = str(payload.get("session_id") or "")
    if phase == "close_session":
        runtime = _SESSIONS.pop(session_id, None)
        if runtime is not None:
            runtime.close(reason=str(payload.get("reason") or "codex-close"))
        _log({"event": "session_close", "session_id": session_id, "reason": payload.get("reason")})
        return {"ok": True, "enabled": True, "phase": phase, "session_id": session_id}

    runtime = _session(session_id, payload)
    if phase == "conversation_identity":
        return {
            "ok": True,
            "enabled": True,
            "phase": phase,
            "session_id": runtime.session_id,
            "conversation_id": runtime.conversation_id,
            "server_conversation_id": runtime.server_conversation_id,
        }
    if phase == "begin_turn":
        return _begin_turn(payload, runtime)
    if phase == "pre_api_request":
        return _pre_api_request(payload, runtime)
    if phase == "complete_turn":
        return _complete_turn(payload, runtime)

    api_hook_count = 0
    api_hook_error = ""
    if phase == "model_call_error":
        api_hook_count, api_hook_error = _api_request_error(payload, runtime)
        turn_end_hook_count, turn_end_hook_error = _turn_end_hook(
            payload,
            runtime,
            completed=False,
            failed=True,
            interrupted=False,
            turn_exit_reason="model_call_error",
        )
    else:
        # Cancellation is not classified as a provider error in Hermes. Drop the
        # outstanding logical request and emit only the interrupted turn boundary.
        runtime.api_requests.pop(str(payload.get("turn_id") or ""), None)
        turn_end_hook_count, turn_end_hook_error = _turn_end_hook(
            payload,
            runtime,
            completed=False,
            failed=False,
            interrupted=True,
            turn_exit_reason="interrupted",
        )

    _log(
        {
            "event": str(phase),
            "session_id": runtime.session_id,
            "turn_id": payload.get("turn_id"),
            "gizmo_id": payload.get("gizmo_id"),
            "turn_number": runtime.turn_number,
            "error": payload.get("error"),
            "api_hook_count": api_hook_count,
            "api_hook_error": api_hook_error,
            "turn_end_hook_count": turn_end_hook_count,
            "turn_end_hook_error": turn_end_hook_error,
        }
    )
    return {
        "ok": True,
        "enabled": True,
        "phase": phase,
        "session_id": runtime.session_id,
        "api_hook_count": api_hook_count,
        "turn_end_hook_count": turn_end_hook_count,
    }


def _shutdown_sessions() -> None:
    _shutdown_review_parent()
    for runtime in list(_SESSIONS.values()):
        try:
            runtime.close()
        except Exception:
            pass
    _SESSIONS.clear()


atexit.register(_shutdown_sessions)


def _run_once() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("request must be a JSON object")
        response = _handle(payload)
    except Exception as exc:
        _log({"event": "helper_error", "error": f"{type(exc).__name__}: {exc}"})
        response = {"ok": False, "enabled": False, "error": f"{type(exc).__name__}: {exc}"}
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0 if response.get("ok") else 1


def _run_persistent() -> int:
    _log({"event": "host_start", "pid": os.getpid()})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request_id = None
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("request must be a JSON object")
            request_id = payload.pop("_request_id", None)
            response = _handle(payload)
        except Exception as exc:
            _log({"event": "helper_error", "error": f"{type(exc).__name__}: {exc}"})
            response = {"ok": False, "enabled": False, "error": f"{type(exc).__name__}: {exc}"}
        if request_id is not None:
            response["_request_id"] = request_id
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    _log({"event": "host_eof", "pid": os.getpid()})
    _shutdown_sessions()
    return 0


def main() -> int:
    if "--persistent" in sys.argv[1:]:
        return _run_persistent()
    return _run_once()


if __name__ == "__main__":
    raise SystemExit(main())
