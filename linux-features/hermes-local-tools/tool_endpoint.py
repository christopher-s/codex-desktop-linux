#!/usr/bin/env python3
"""Phase 1 QA: owner-only loopback Hermes tool endpoint.

Disposable QA harness component. Maps POST {name, arguments} to
model_tools.handle_function_call in-process. Binds 127.0.0.1 only.
This is the seam where the full Hermes ExternalToolSession facade later
plugs in; for Phase 1 we prove the protocol round trip with one
deterministic local tool (read_file).
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.environ.get("HERMES_AGENT_ROOT", os.path.expanduser("~/.hermes/hermes-agent")))

_READY = {"ok": False, "err": None}
_mt = None


def _boot():
    global _mt, _READY
    try:
        import model_tools  # noqa
        model_tools.discover_builtin_tools()
        _mt = model_tools
        _READY = {"ok": True, "err": None}
    except Exception as e:  # noqa
        _READY = {"ok": False, "err": f"{type(e).__name__}: {e}"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Allow the sandboxed webview (app://- origin) to fetch loopback.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_GET(self):
        if self.path in ("/health", "/healthz", "/"):
            self._send(200, {"ready": _READY["ok"], "err": _READY["err"]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/call", "/tool", "/invoke"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa
            self._send(400, {"error": f"bad json: {e}"})
            return
        name = payload.get("name")
        args = payload.get("arguments") or {}
        if not isinstance(name, str) or not name:
            self._send(400, {"error": "missing name"})
            return
        # Advertised model-facing names carry a `hermes_` prefix to avoid
        # collisions with built-in local functions; strip it to reach the
        # Hermes registry tool of the same bare name. If the bare name is not
        # registered, fall back to the advertised name so the registry's own
        # "Unknown tool" error surfaces truthfully.
        registry_name = name
        if name.startswith("hermes_"):
            bare = name[len("hermes_"):]
            try:
                if bare in set(_mt.get_all_tool_names()):
                    registry_name = bare
            except Exception:  # noqa
                pass
        if not _READY["ok"] or _mt is None:
            self._send(503, {"error": f"hermes not ready: {_READY['err']}"})
            return
        try:
            out = _mt.handle_function_call(registry_name, args, task_id=payload.get("task_id") or "codex-phase1")
            # out is a JSON string per registry contract; parse to embed.
            try:
                result = json.loads(out)
            except Exception:  # noqa
                result = out
            self._send(200, {"ok": True, "name": name, "result": result})
        except Exception as e:  # noqa
            self._send(200, {"ok": False, "name": name, "error": f"{type(e).__name__}: {e}"})


def main():
    _boot()
    port = int(os.environ.get("PHASE1_TOOL_PORT", "9473"))
    srv = HTTPServer(("127.0.0.1", port), H)
    print(f"phase1-tool-endpoint listening on 127.0.0.1:{port} ready={_READY['ok']} err={_READY['err']}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
