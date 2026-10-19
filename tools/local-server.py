#!/usr/bin/env python3
"""
Local server for the Opus Agent Desk.

Serves /public and proxies three read-only upstreams so the browser sees one origin:
  /gamma/*  -> https://gamma-api.polymarket.com/*
  /clob/*   -> https://clob.polymarket.com/*
  /news?q=  -> https://news.google.com/rss/search?q=

There is no order, wallet or signing endpoint here. Upstreams are read-only public APIs.

Usage:
  python3 tools/local-server.py [--port 8765] [--no-browser]
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")

PROXIES = {
    "/gamma": "https://gamma-api.polymarket.com",
    "/clob": "https://clob.polymarket.com",
}
NEWS_URL = "https://news.google.com/rss/search"
USER_AGENT = "opus-agent-desk/1.0 (paper-trading research; no orders)"


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[desk] %s\n" % (fmt % args))

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _proxy(self, url: str):
        request = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
        })
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read()
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                self._send(200, body, content_type)
        except urllib.error.HTTPError as exc:
            body = exc.read() if hasattr(exc, "read") else b""
            self._send(exc.code, body or str(exc).encode(), "text/plain; charset=utf-8")
        except Exception as exc:  # noqa: BLE001 - surface the failure to the browser
            self._send(502, f"proxy error: {exc}".encode(), "text/plain; charset=utf-8")

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path

        if path == "/news":
            query = urllib.parse.parse_qs(parsed.query).get("q", [""])[0]
            if not query.strip():
                self._send(400, b"missing q parameter", "text/plain; charset=utf-8")
                return
            params = urllib.parse.urlencode({"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})
            self._proxy(f"{NEWS_URL}?{params}")
            return

        for prefix, target in PROXIES.items():
            if path == prefix or path.startswith(prefix + "/"):
                suffix = path[len(prefix):] or "/"
                url = target + suffix + (("?" + parsed.query) if parsed.query else "")
                self._proxy(url)
                return

        return super().do_GET()

    def do_POST(self):  # noqa: N802
        # Hard stop: this server never accepts order-like requests.
        self._send(405, b"read-only server: no order endpoints exist", "text/plain; charset=utf-8")

    do_PUT = do_POST
    do_DELETE = do_POST
    do_PATCH = do_POST


def main():
    parser = argparse.ArgumentParser(description="Serve the Opus Agent Desk locally.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"Opus Agent Desk running at {url}")
    print("Read-only: /gamma and /clob proxy public Polymarket data; /news proxies Google News RSS.")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
