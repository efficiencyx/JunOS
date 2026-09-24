#!/usr/bin/env python3
# a stand in for ollama, just enough of /api for chat.php to run
# a full turn: tags, ps, show, generate (the evict call) and chat.
# CI has no GPU and the fine-tune is a 3GB download, so this is
# the only way the streaming pipeline runs at all before a push.
#
# the reply is canned and the same every time. what's under test
# is chat.php around it: prompt assembly, the tool round trip, the
# SSE framing (the event stream php sends the browser), the
# mood_shift bookkeeping and what lands in the db. every
# /api/chat request body gets appended to FAKE_OLLAMA_LOG as one
# json line so the driver can read back exactly what php sent.
#
# usage: fake-ollama.py PORT
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = 'fake-jun'
LOG = os.environ.get('FAKE_OLLAMA_LOG', '')

# the memory_write and mood_shift tags sit at the end like she
# writes them. the chunks split tags in half ON PURPOSE, php has
# to glue the stream back together before anything downstream
# sees it. memory_write names its category FIRST and carries a
# comma in the note, the shape that used to get misparsed.
REPLY_CHUNKS = ['hey. [A:sm', 'ile] there you are.', '\n[A:memory_write|category=likes', '|memory=green tea, lots]',
                '\n[A:mood_shift|affection=-3', '|trust=-1|tension=+2]']

STATS = {'eval_count': 12, 'eval_duration': 400_000_000, 'prompt_eval_count': 300,
         'prompt_eval_duration': 100_000_000, 'total_duration': 600_000_000, 'load_duration': 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            return json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            return {}

    def do_GET(self):
        if self.path == '/api/tags':
            return self._json({'models': [{'name': MODEL, 'model': MODEL, 'size': 1}]})
        if self.path == '/api/ps':
            return self._json({'models': []})
        self._json({'error': 'not found'}, 404)

    def do_POST(self):
        body = self._body()
        if self.path == '/api/show':
            return self._json({'capabilities': ['completion', 'tools']})
        if self.path == '/api/generate':
            return self._json({'model': MODEL, 'done': True})
        if self.path != '/api/chat':
            return self._json({'error': 'not found'}, 404)

        if LOG:
            with open(LOG, 'a') as f:
                f.write(json.dumps(body) + '\n')

        msgs = body.get('messages') or []
        if not body.get('stream', True):
            # the title call. no system prompt, stream off, one shot.
            return self._json({'model': MODEL, 'message': {'role': 'assistant', 'content': 'Fake Title'},
                               'done': True, 'done_reason': 'stop', **STATS})

        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()

        def line(obj):
            self.wfile.write((json.dumps(obj) + '\n').encode())
            self.wfile.flush()

        # first round with tools on the table: ask for one. php runs
        # it and comes back with a role=tool message, THEN we talk.
        if body.get('tools') and not any(m.get('role') == 'tool' for m in msgs):
            line({'model': MODEL, 'message': {'role': 'assistant', 'content': '', 'tool_calls': [
                {'function': {'name': 'list_recent_chats', 'arguments': {}}}]},
                'done': True, 'done_reason': 'stop', **STATS})
            return
        for chunk in REPLY_CHUNKS:
            line({'model': MODEL, 'message': {'role': 'assistant', 'content': chunk}, 'done': False})
        line({'model': MODEL, 'message': {'role': 'assistant', 'content': ''},
              'done': True, 'done_reason': 'stop', **STATS})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
