# Local helper: serves the bot from ../public and relays Polymarket's public data.
# Run:  python tools/local-server.py   (only Python is needed, nothing to install)
import http.server, urllib.request, os, mimetypes, webbrowser, threading

PORT = 8765
ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public"))
UP = {"/gamma/": "https://gamma-api.polymarket.com/", "/clob/": "https://clob.polymarket.com/"}

class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        for prefix, base in UP.items():
            if self.path.startswith(prefix):
                try:
                    req = urllib.request.Request(base + self.path[len(prefix):],
                        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
                    with urllib.request.urlopen(req, timeout=10) as r:
                        return self._send(200, r.read(), "application/json")
                except Exception as e:
                    return self._send(502, str(e).encode(), "text/plain")
        rel = self.path.split("?")[0].lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(ROOT, rel))
        if full.startswith(ROOT) and os.path.isfile(full):
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            with open(full, "rb") as f:
                return self._send(200, f.read(), ctype)
        self._send(404, b"not found", "text/plain")

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print("Bot running at http://localhost:%d  (close this window to stop)" % PORT)
    threading.Timer(1, lambda: webbrowser.open("http://localhost:%d" % PORT)).start()
    srv.serve_forever()
