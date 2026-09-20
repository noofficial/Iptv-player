#!/usr/bin/env python3
"""
Tiny CORS/mixed-content proxy for CableVision 2004.

Listens on 127.0.0.1:8091 and forwards GET /proxy?url=<encoded>
to the upstream URL, streaming the response body back with CORS
headers added. Forwards Range/If-* request headers and the upstream
Content-Type/Content-Length/Accept-Ranges so <video> seeking works.

Meant to sit behind Caddy at https://iptv.silverbasin.vegas/proxy.

Zero third-party deps — stdlib only.
"""

import http.server
import socketserver
import ssl
import urllib.request
import urllib.parse
import sys

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8091
MAX_BODY_CHUNK = 64 * 1024
# Many IPTV providers filter their playlist size by User-Agent — a known
# player like VLC gets the full catalog, an unknown UA gets a subset or
# a 403. Send a VLC UA by default; a browser can still override it by
# passing ?ua=... in the query.
DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20"
# Reads block up to this many seconds without data before we give up.
# Big M3Us with slow origins can take a while, so keep it generous.
UPSTREAM_TIMEOUT = 120

# IPTV redirects often land on bare-IP HTTPS with certs that don't
# match the IP — trust anything, like every real IPTV client does.
INSECURE_SSL_CTX = ssl.create_default_context()
INSECURE_SSL_CTX.check_hostname = False
INSECURE_SSL_CTX.verify_mode = ssl.CERT_NONE

FORWARD_REQ_HEADERS = (
    "range", "if-range", "if-none-match", "if-modified-since",
    "accept", "accept-encoding", "accept-language",
)
FORWARD_RES_HEADERS = (
    "content-type", "content-length", "content-range", "accept-ranges",
    "cache-control", "etag", "last-modified",
)
CORS = (
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
    ("Access-Control-Allow-Headers", "*"),
    ("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges"),
)


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    server_version = "CableVisionProxy/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[proxy] " + (fmt % args) + "\n")

    def _write_cors(self):
        for k, v in CORS:
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self._write_cors()
        self.end_headers()

    def do_HEAD(self):
        self._proxy(method="HEAD")

    def do_GET(self):
        self._proxy(method="GET")

    def _proxy(self, method):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/proxy":
            self.send_response(404); self._write_cors(); self.end_headers()
            return
        qs = urllib.parse.parse_qs(parsed.query)
        target = qs.get("url", [None])[0]
        if not target or not target.startswith(("http://", "https://")):
            self.send_response(400); self._write_cors(); self.end_headers()
            self.wfile.write(b"missing or invalid url= parameter")
            return

        ua = qs.get("ua", [DEFAULT_UA])[0]
        headers = {"User-Agent": ua}
        for h in FORWARD_REQ_HEADERS:
            v = self.headers.get(h)
            if v:
                headers[h] = v

        req = urllib.request.Request(target, headers=headers, method=method)
        # IPTV origins routinely 302 to a bare-IP HTTPS URL whose cert
        # isn't valid for the IP (or is self-signed). urllib's default
        # is to verify — an app like VLC or TiViMate does not. Match
        # that behavior so the redirect chain resolves.
        try:
            with urllib.request.urlopen(
                req, timeout=UPSTREAM_TIMEOUT, context=INSECURE_SSL_CTX
            ) as up:
                self.send_response(up.status)
                for h in FORWARD_RES_HEADERS:
                    v = up.headers.get(h)
                    if v:
                        self.send_header(h.title(), v)
                self._write_cors()
                self.end_headers()
                if method == "HEAD":
                    return
                while True:
                    chunk = up.read(MAX_BODY_CHUNK)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for h in FORWARD_RES_HEADERS:
                v = e.headers.get(h) if e.headers else None
                if v:
                    self.send_header(h.title(), v)
            self._write_cors()
            self.end_headers()
            try:
                self.wfile.write(e.read())
            except Exception:
                pass
        except Exception as e:
            self.send_response(502); self._write_cors(); self.end_headers()
            self.wfile.write(f"upstream error: {e}".encode("utf-8", "replace"))


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    with ThreadingServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler) as httpd:
        sys.stderr.write(f"[proxy] listening on http://{LISTEN_HOST}:{LISTEN_PORT}/proxy\n")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
