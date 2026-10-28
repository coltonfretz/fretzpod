#!/usr/bin/env python3
"""Local dev server for Fretzpod (for development, never deployed).

Serves app/ on localhost with the same security headers as nginx, and passes
/jf/* through to Jellyfin so the UI can be tried in a browser that can't reach
Jellyfin itself (a sandboxed test browser, for example).

WHY the proxy swaps in a token: testing must not need anyone's password. The
proxy replaces the app's Authorization header with a Jellyfin API key
(JF_TOKEN; keep it out of your shell history, e.g. read it from a file), so
the page browses as the user id it was given (?UserId / userId) without
signing in. Set that in the page's console:
  localStorage['fp.session'] = JSON.stringify({token: 'dev', userId: '<id>', name: 'dev'})

Play reports (/Sessions/*) are answered locally with 204 and never reach
Jellyfin, so testing doesn't put fake plays on anyone's profile.

Usage: JF_URL=http://<jellyfin>:8096 JF_TOKEN=<api key> python3 -I dev/devserver.py [port]
"""
import http.server
import json
import os
import sys
import urllib.error
import urllib.request

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
JELLYFIN = os.environ["JF_URL"].rstrip("/")
TOKEN = os.environ["JF_TOKEN"]
AUTH = f'MediaBrowser Client="Fretzpod-dev", Device="dev", DeviceId="fretzpod-dev", Version="dev", Token="{TOKEN}"'

# Same policy as nginx/default.conf, with Jellyfin reached through /jf here,
# and the same TV servers (deploy.sh fills them into nginx's from the same
# file), so TV tries the channels' own servers first here too.
with open(os.path.join(APP, "tv-hosts.json")) as f:
    TV_HOSTS = " ".join("https://" + h for h in json.load(f)["hosts"])
CSP = (f"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' {TV_HOSTS}; "
       f"worker-src 'self' blob:; img-src 'self' data:; media-src 'self' blob: {TV_HOSTS}; frame-ancestors 'none'; "
       "base-uri 'none'; form-action 'none'; object-src 'none'")


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # needed for the chunked pass-through

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP, **kw)

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep query strings (ids, play session ids) out of the console.
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    def do_GET(self):
        if self.path.startswith("/jf/"):
            return self.proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/jf/Sessions/"):
            # Read the body even though it's dropped: on a kept-alive
            # connection, leftover bytes would be parsed as the next request.
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/jf/"):
            return self.proxy()
        self.send_error(405)

    def do_DELETE(self):
        self.send_error(405)

    def proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(JELLYFIN + self.path[3:], data=body, method=self.command)
        req.add_header("Authorization", AUTH)
        if body:
            req.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                status, ctype = r.status, r.headers.get("Content-Type", "application/octet-stream")
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                # Stream through in chunks: song transcodes arrive progressively.
                while chunk := r.read(64 * 1024):
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.write(b"0\r\n\r\n")
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8769
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Fretzpod dev server on http://localhost:{port}", flush=True)
    srv.serve_forever()
