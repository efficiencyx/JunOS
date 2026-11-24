#!/usr/bin/env python3
# a stand in for ollama that answers the guided memory pass's
# one-question calls, picked by what each prompt asks. it's dumb
# on purpose: what's under test is the PHP around her, the guards,
# the writes, the watermarks and the feed, not her judgment.
#
# usage: fake-pass-ollama.py PORT
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def answer(task):
    if 'List what Anon said about himself' in task:
        return {'facts': ['Anon works night shifts at the Lidl warehouse.', 'Anon has a grey cat called Miso.',
                          'Anon works the night shift at the Lidl warehouse.']}
    if 'grounded:' in task:
        return {'grounded': 'yes', 'fixed': '', 'lasting': 'yes', 'category': 'work' if 'Lidl' in task else 'family'}
    if 'relation:' in task:
        return {'relation': 'new', 'ids': []}
    if 'Is each of these in the chat' in task:
        return {'answer': 'yes'}
    if 'Anon thinks this note is wrong' in task:
        return {'answer': 'no' if 'yacht' in task else 'yes'}
    if 'is my note wrong' in task or 'is it over' in task or 'Now that it' in task:
        return {'answer': 'no'}
    if "Write today's entry" in task:
        return 'Anon told me about the warehouse and Miso knocked a glass over. I laughed.'
    if 'Find every sentence' in task:
        return {'wrong': []}
    if 'Is one of my notes about the very same thing' in task:
        return {'id': 'none'}
    return {'text': ''}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({'models': [{'name': 'fake-jun', 'model': 'fake-jun', 'size': 1}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        task = req.get('messages', [{}])[-1].get('content', '')
        out = answer(task)
        text = out if isinstance(out, str) else json.dumps(out)
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        for i in range(0, len(text), 20):
            self.wfile.write((json.dumps({'message': {'role': 'assistant', 'content': text[i:i + 20]}, 'done': False}) + '\n').encode())
        self.wfile.write((json.dumps({'message': {'role': 'assistant', 'content': ''}, 'done': True, 'done_reason': 'stop',
                                      'eval_count': 30, 'eval_duration': 300_000_000, 'prompt_eval_count': 200,
                                      'prompt_eval_duration': 100_000_000}) + '\n').encode())


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
