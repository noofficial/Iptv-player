#!/usr/bin/env python3
"""
Tiny CORS/mixed-content proxy for CableVision 2004.

Endpoints
---------

GET /proxy?url=<encoded>
    Forwards the request to <url>, streaming the body back with CORS
    headers. Forwards Range / If-* / User-Agent. Follows redirects,
    trusts any TLS cert on the upstream hop.

GET /rewrite?url=<encoded>
    Fetches <url> assuming it's an M3U / HLS playlist, and rewrites
    every stream URL inside it so subsequent requests come back
    through /proxy. Useful for pointing an external IPTV client
    (e.g. TiViMate) at this server so we can log its request headers.

Zero third-party deps — stdlib only.
"""

import http.server
import socketserver
import os
import ssl
import sys
import urllib.parse
import urllib.request

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8091
MAX_BODY_CHUNK = 64 * 1024
DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20"
UPSTREAM_TIMEOUT = 120

# Verbose logging of client request headers on /proxy hits. Handy for
# reverse-engineering what a real IPTV player is sending — set to "1"
# in the systemd unit's Environment= line to enable.
DEBUG_HEADERS = os.environ.get("PROXY_DEBUG_HEADERS", "0") == "1"

# Public URL prefix that /rewrite embeds in the rewritten playlist.
# Overridden by env in the systemd unit — default is fine for local
# testing since it's used only as a base for %-encoded stream URLs.
PUBLIC_PROXY_URL = os.environ.get(
    "PUBLIC_PROXY_URL", "https://iptv.silverbasin.vegas/proxy"
)

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


def wrap_proxy(original_url: str) -> str:
    """Wrap a stream URL so a client fetching it goes through /proxy."""
    return f"{PUBLIC_PROXY_URL}?url={urllib.parse.quote(original_url, safe='')}"


def rewrite_playlist(text: str, base_url: str) -> str:
    """Rewrite every non-comment URL line in an M3U/HLS playlist to
    point through PUBLIC_PROXY_URL. Relative URLs are resolved against
    base_url first."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            # M3U comments — including #EXT-X-KEY URI="..." — keep as-is.
            # (A stricter rewriter would also transform KEY URIs; not
            # needed for this diagnostic use case.)
            out.append(raw)
            continue
        absolute = urllib.parse.urljoin(base_url, line)
        out.append(wrap_proxy(absolute))
    return "\n".join(out) + "\n"


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
        self._dispatch(method="HEAD")

    def do_GET(self):
        self._dispatch(method="GET")

    def _dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/proxy":
            self._proxy(method, parsed)
        elif parsed.path == "/rewrite":
            self._rewrite(method, parsed)
        else:
            self.send_response(404); self._write_cors(); self.end_headers()

    # ---- /proxy -----------------------------------------------------
    def _proxy(self, method, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        target = qs.get("url", [None])[0]
        if not target or not target.startswith(("http://", "https://")):
            self.send_response(400); self._write_cors(); self.end_headers()
            self.wfile.write(b"missing or invalid url= parameter")
            return

        if DEBUG_HEADERS:
            self._log_client_headers(method, target)

        ua = qs.get("ua", [DEFAULT_UA])[0]
        headers = {"User-Agent": ua}
        for h in FORWARD_REQ_HEADERS:
            v = self.headers.get(h)
            if v:
                headers[h] = v

        req = urllib.request.Request(target, headers=headers, method=method)
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

    # ---- /rewrite ---------------------------------------------------
    def _rewrite(self, method, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        target = qs.get("url", [None])[0]
        if not target or not target.startswith(("http://", "https://")):
            self.send_response(400); self._write_cors(); self.end_headers()
            self.wfile.write(b"missing or invalid url= parameter")
            return

        headers = {"User-Agent": qs.get("ua", [DEFAULT_UA])[0]}
        for h in FORWARD_REQ_HEADERS:
            v = self.headers.get(h)
            if v:
                headers[h] = v

        req = urllib.request.Request(target, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(
                req, timeout=UPSTREAM_TIMEOUT, context=INSECURE_SSL_CTX
            ) as up:
                body = up.read()
        except Exception as e:
            self.send_response(502); self._write_cors(); self.end_headers()
            self.wfile.write(f"upstream error: {e}".encode("utf-8", "replace"))
            return

        try:
            text = body.decode("utf-8", errors="replace")
        except Exception:
            self.send_response(502); self._write_cors(); self.end_headers()
            self.wfile.write(b"upstream body not decodable as text")
            return

        rewritten = rewrite_playlist(text, base_url=target).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
        self.send_header("Content-Length", str(len(rewritten)))
        self._write_cors()
        if method == "HEAD":
            self.end_headers()
            return
        self.end_headers()
        self.wfile.write(rewritten)

    # ---- helpers ----------------------------------------------------
    def _log_client_headers(self, method, target):
        sys.stderr.write(f"[proxy] === {method} {target} ===\n")
        for k in sorted(self.headers.keys()):
            sys.stderr.write(f"[proxy]   {k}: {self.headers[k]}\n")


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    with ThreadingServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler) as httpd:
        sys.stderr.write(
            f"[proxy] listening on http://{LISTEN_HOST}:{LISTEN_PORT}/  "
            f"(endpoints: /proxy, /rewrite)  "
            f"debug_headers={DEBUG_HEADERS}  public={PUBLIC_PROXY_URL}\n"
        )
        httpd.serve_forever()


if __name__ == "__main__":
    main()
