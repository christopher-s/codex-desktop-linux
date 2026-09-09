#!/usr/bin/env python3
"""Lifecycle for the independent staged ChatGPT Community QA app."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import socket
import subprocess
import time
from typing import Sequence


@dataclass(frozen=True)
class QAAppConfig:
    app_dir: Path = Path(os.environ.get("CODEX_HERMES_QA_APP_DIR", "/home/chris/.cache/codex-merge-app"))
    unit: str = os.environ.get("CODEX_HERMES_QA_UNIT", "codex-hermes-qa")
    host: str = os.environ.get("CODEX_HERMES_QA_CDP_HOST", "127.0.0.1")
    port: int = int(os.environ.get("CODEX_HERMES_QA_CDP_PORT", "9243"))

    @property
    def origin(self) -> str:
        return f"http://{self.host}:{self.port}"


class QAAppError(RuntimeError):
    pass


_TRANSIENT_ENV_KEYS = ("LCM_DATABASE_PATH",)


def transient_environment_args() -> list[str]:
    """Explicit environment forwarded into the transient Electron unit.

    systemd-run services do not inherit arbitrary caller environment reliably.
    Keep this allowlist narrow so an isolated LCM QA run survives the app restart
    inside E6 without redirecting unrelated Hermes state.
    """
    args: list[str] = []
    for key in _TRANSIENT_ENV_KEYS:
        value = os.environ.get(key)
        if value:
            args.append(f"--setenv={key}={value}")
    return args


def _run(argv: Sequence[str], *, check: bool = True, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(list(argv), capture_output=True, text=True, timeout=timeout, check=False)
    if check and result.returncode != 0:
        raise QAAppError(
            f"command failed ({result.returncode}): {' '.join(argv)}\n"
            f"stdout: {result.stdout.strip()}\nstderr: {result.stderr.strip()}"
        )
    return result


def port_listening(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def wait_for_port(host: str, port: int, *, listening: bool, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_listening(host, port) is listening:
            return
        time.sleep(0.25)
    state = "listening" if listening else "free"
    raise QAAppError(f"timed out waiting for {host}:{port} to become {state}")


def unit_is_active(config: QAAppConfig) -> bool:
    result = _run(["systemctl", "--user", "is-active", "--quiet", config.unit], check=False, timeout=10)
    return result.returncode == 0


def unit_exists(config: QAAppConfig) -> bool:
    result = _run(["systemctl", "--user", "show", config.unit, "-p", "LoadState", "--value"], check=False, timeout=10)
    return result.returncode == 0 and result.stdout.strip() not in {"", "not-found"}


def start(config: QAAppConfig, timeout: float = 90.0) -> None:
    if not config.app_dir.is_dir():
        raise QAAppError(f"QA app directory does not exist: {config.app_dir}")
    start_script = config.app_dir / "start.sh"
    if not start_script.is_file():
        raise QAAppError(f"QA app has no start.sh: {start_script}")

    if unit_is_active(config):
        wait_for_port(config.host, config.port, listening=True, timeout=timeout)
        return

    if unit_exists(config):
        result = _run(["systemctl", "--user", "start", config.unit], check=False, timeout=30)
        if result.returncode == 0:
            wait_for_port(config.host, config.port, listening=True, timeout=timeout)
            return

    # The transient unit may have been collected after a previous stop. Recreate
    # it outside the Hermes bridge service cgroup.
    command = (
        f"cd {sh_quote(str(config.app_dir))} && exec ./start.sh --no-sandbox "
        f"--force-renderer-accessibility "
        f"--remote-debugging-port={config.port} "
        f"--remote-allow-origins={config.origin}"
    )
    _run(
        [
            "systemd-run",
            "--user",
            f"--unit={config.unit}",
            "--collect",
            *transient_environment_args(),
            "/bin/bash",
            "-lc",
            command,
        ],
        timeout=30,
    )
    wait_for_port(config.host, config.port, listening=True, timeout=timeout)


def stop(config: QAAppConfig, timeout: float = 90.0) -> None:
    _run(["systemctl", "--user", "stop", config.unit], check=False, timeout=30)
    # A collected transient unit can disappear before its child fully exits.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not port_listening(config.host, config.port):
            return
        time.sleep(0.25)
    raise QAAppError(f"CDP port {config.port} stayed occupied after stopping {config.unit}")


def restart(config: QAAppConfig, timeout: float = 120.0) -> None:
    stop(config, timeout=timeout / 2)
    wait_for_port(config.host, config.port, listening=False, timeout=timeout / 2)
    start(config, timeout=timeout / 2)


def main_pid(config: QAAppConfig) -> int:
    result = _run(["systemctl", "--user", "show", config.unit, "-p", "MainPID", "--value"], timeout=10)
    try:
        pid = int(result.stdout.strip())
    except ValueError as exc:
        raise QAAppError(f"invalid MainPID for {config.unit}: {result.stdout!r}") from exc
    if pid <= 0:
        raise QAAppError(f"{config.unit} has no live MainPID")
    return pid


def executable_path(pid: int) -> Path:
    try:
        return Path(os.readlink(f"/proc/{pid}/exe"))
    except OSError as exc:
        raise QAAppError(f"cannot resolve executable for pid {pid}: {exc}") from exc


def command_line(pid: int) -> list[str]:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError as exc:
        raise QAAppError(f"cannot read command line for pid {pid}: {exc}") from exc
    return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]


def service_snapshot(config: QAAppConfig) -> dict[str, object]:
    pid = main_pid(config)
    exe = executable_path(pid)
    cmdline = command_line(pid)
    # The exact executable location varies with upstream packaging; the start
    # script/cmdline and unit ownership are the primary isolation proof.
    return {
        "unit": config.unit,
        "pid": pid,
        "exe": str(exe),
        "cmdline": cmdline,
        "app_dir": str(config.app_dir),
        "cdp": f"http://{config.host}:{config.port}",
        "port_listening": port_listening(config.host, config.port),
    }


def sh_quote(value: str) -> str:
    """POSIX single-quote one argument for the one intentional bash -lc boundary."""
    return "'" + value.replace("'", "'\"'\"'") + "'"
