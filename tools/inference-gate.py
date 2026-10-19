#!/usr/bin/env python3
# the lock in front of a model server that's reachable from the
# internet. colab.ipynb runs this in "inference only" mode: ollama
# or vllm stays on 127.0.0.1, cloudflared exposes THIS, and the
# Jun on your PC sends the token as OLLAMA_API_KEY / VLLM_API_KEY.
# ollama has no auth of its own at all. so without this, anyone who
# finds the trycloudflare URL gets a free GPU and /api/delete.
#
#   JUN_GATE_TOKEN=... python3 inference-gate.py 127.0.0.1:8003 http://127.0.0.1:11434
#
# token comes from the env, not argv, argv shows up in `ps` for
# every other process on the box. stdlib only ON PURPOSE, kaggle
# and colab both have a python and that's all we want to count on.

import hmac
import http.client
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# the reads chat needs and nothing that writes to the model store.
# /api/pull, /api/create, /api/delete, /api/push, /api/copy and
# /api/blobs stay out. the notebook already pulled what she needs
ALLOWED = {
    ("GET", "/api/tags"), ("GET", "/api/ps"), ("GET", "/api/version"),
    ("POST", "/api/show"), ("POST", "/api/chat"), ("POST", "/api/generate"),
    ("GET", "/v1/models"), ("POST", "/v1/chat/completions"), ("GET", "/health"),
}

# a voice turn ships the whole wav as base64 inside the json. 32 MiB
# is minutes of 16 kHz audio, way past STT_MAX_DURATION_S anyway
MAX_BODY = 32 * 1024 * 1024

SKIP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
                "proxy-authorization", "proxy-authenticate", "content-length", "server", "date"}


class Gate(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    token = b""
    upstream = urllib.parse.urlsplit("http://127.0.0.1:11434")

    def log_message(self, fmt, *args):
        # no paths or headers in the log. the 401s are the only thing
        # worth seeing and they're counted by status alone
        sys.stderr.write("%s %s\n" % (self.command, args[1] if len(args) > 1 else ""))

    def deny(self, status, msg):
        body = ('{"error":"%s"}' % msg).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        got = self.headers.get("Authorization", "")
        if not got.startswith("Bearer "):
            return False
        return hmac.compare_digest(got[7:].strip().encode(), self.token)

    def relay(self):
        path = urllib.parse.urlsplit(self.path).path
        if not self.authorized():
            return self.deny(401, "unauthorized")
        if (self.command, path) not in ALLOWED:
            return self.deny(404, "not_found")

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self.deny(413, "too_large")
        body = self.rfile.read(length) if length else None

        conn = http.client.HTTPConnection(self.upstream.hostname, self.upstream.port, timeout=900)
        try:
            conn.request(self.command, self.path, body=body,
                         headers={"Content-Type": self.headers.get("Content-Type", "application/json")})
            res = conn.getresponse()
        except OSError:
            conn.close()
            return self.deny(502, "upstream_unavailable")

        self.send_response(res.status)
        for k, v in res.getheaders():
            if k.lower() not in SKIP_HEADERS:
                self.send_header(k, v)
        # no-transform or cloudflare gzips the ndjson and sits on it
        # until the reply is done. she'd still answer, just all at
        # once at the end, which kills the whole mid-sentence thing
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            while True:
                chunk = res.read1(65536)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()

    do_GET = relay
    do_POST = relay


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: JUN_GATE_TOKEN=... inference-gate.py HOST:PORT UPSTREAM_URL")
    token = os.environ.get("JUN_GATE_TOKEN", "")
    if len(token) < 32:
        sys.exit("JUN_GATE_TOKEN missing or shorter than 32 chars")
    Gate.token = token.encode()
    Gate.upstream = urllib.parse.urlsplit(sys.argv[2])
    host, _, port = sys.argv[1].rpartition(":")
    ThreadingHTTPServer((host, int(port)), Gate).serve_forever()


if __name__ == "__main__":
    main()
