"""Local dashboard server.

Serves the static dashboard from public/ and a small read-only JSON API.
The only mutating endpoint is POST /api/run, which executes the same pipeline as
`python main.py` and writes timestamped reports. There is no order endpoint.

Usage:
    python main.py --serve [--port 8765] [--host 0.0.0.0]
"""

from __future__ import annotations

import json
import threading
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import data
from .config import Config, ConfigError, load_config
from .pipeline import PipelineError, load_index, load_latest, load_run, run_index_entry, run_pipeline

PUBLIC = Path(__file__).resolve().parents[2] / "public"
RUN_LOCK = threading.Lock()


class DeskServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, config_path: str | None = None):
        super().__init__(address, handler)
        self.config_path = config_path


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OpusAgentDesk/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    # -- utilities ---------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib signature
        print(f"[desk] {self.address_string()} {fmt % args}")

    def _config(self) -> Config:
        return load_config(self.server.config_path)  # type: ignore[attr-defined]

    def _send(self, status: int, payload: Any, content_type: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"ok": False, "error": message})

    # -- GET ---------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - stdlib signature
        path = urllib.parse.urlsplit(self.path).path
        try:
            cfg = self._config()
        except ConfigError as exc:
            self._error(500, f"configuration error: {exc}")
            return

        if path == "/api/health":
            self._send(200, {"ok": True, "mode": cfg.mode, "live_orders": cfg.allow_live_orders})
            return
        if path == "/api/config":
            self._send(200, {
                "ok": True,
                "config": cfg.public_dict(),
                "sources": ["fixture", "test", "live"],
                "paper_only": cfg.mode == "paper" and cfg.allow_live_orders is False,
            })
            return
        if path == "/api/reports":
            self._send(200, {"ok": True, **load_index(cfg)})
            return
        if path == "/api/latest":
            run = load_latest(cfg)
            if run is None:
                self._error(404, "no runs yet; POST /api/run or run `python main.py`")
            else:
                self._send(200, {"ok": True, "run": run})
            return
        if path.startswith("/api/reports/"):
            run_id = urllib.parse.unquote(path[len("/api/reports/"):])
            run = load_run(cfg, run_id)
            if run is None:
                self._error(404, f"run not found: {run_id}")
            else:
                self._send(200, {"ok": True, "run": run})
            return
        if path.startswith("/api/"):
            self._error(404, "unknown API route")
            return

        if path in ("", "/"):
            self.path = "/index.html"
        return super().do_GET()

    # -- POST --------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802 - stdlib signature
        path = urllib.parse.urlsplit(self.path).path
        if path != "/api/run":
            self._error(405, "only POST /api/run exists; this server has no order endpoints")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > 4096:
            self._error(413, "request body too large")
            return
        payload: dict[str, Any] = {}
        if length:
            try:
                parsed = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                payload = parsed if isinstance(parsed, dict) else {}
            except (ValueError, UnicodeDecodeError):
                self._error(400, "request body must be JSON")
                return

        source = str(payload.get("source") or "").strip().lower()
        if source and source not in ("fixture", "test", "live"):
            self._error(400, "source must be one of fixture, test, live")
            return

        if not RUN_LOCK.acquire(blocking=False):
            self._error(409, "a run is already in progress")
            return
        try:
            overrides = {"source": source} if source else None
            cfg = load_config(self.server.config_path, overrides)  # type: ignore[attr-defined]
            run = run_pipeline(cfg)
            self._send(200, {
                "ok": True,
                "run_id": run["run_id"],
                "decision": run["boss"]["meta"]["decision"],
                "summary": run["boss"]["summary"],
                "index": run_index_entry(run),
                "files": run.get("files", {}),
                "run": run,
            })
        except ConfigError as exc:
            self._error(400, f"configuration error: {exc}")
        except PipelineError as exc:
            self._error(500, f"pipeline validation failed: {exc}")
        except Exception as exc:  # noqa: BLE001 - surface the failure to the dashboard
            self._error(500, f"run failed: {exc.__class__.__name__}: {exc}")
        finally:
            RUN_LOCK.release()

    def do_PUT(self) -> None:  # noqa: N802
        self._error(405, "read-only server: no order endpoints exist")

    do_PATCH = do_PUT
    do_DELETE = do_PUT


def serve(config_path: str | None = None, host: str = "0.0.0.0", port: int = 8765,
          open_browser: bool = False) -> None:
    cfg = load_config(config_path)
    server = DeskServer((host, port), Handler, config_path=config_path)
    url = f"http://localhost:{port}/"
    print(f"Opus Agent Desk running at {url}")
    print(f"mode={cfg.mode} · live_orders={cfg.allow_live_orders} · source={cfg.source}")
    print("Read-only APIs; the only mutating route is POST /api/run. No order endpoint exists.")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001 - headless environments
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


def preview_run(config_path: str | None = None) -> dict[str, Any] | None:
    """Return the newest saved run without executing anything (used by tests)."""
    cfg = load_config(config_path)
    run = load_latest(cfg)
    if run is not None:
        return run
    index = load_index(cfg)
    return load_run(cfg, index["runs"][0]["run_id"]) if index.get("runs") else None


__all__ = ["serve", "preview_run", "Handler", "DeskServer", "data"]
