#!/bin/sh
# boots the webapp the way a bare metal install does (php -S in
# front of tools/php-router.php) and runs api-checks.sh at it. no
# docker, no nginx. api-checks.sh has to pass with the model
# backend DOWN, which is the point: auth, the router's 404 rules,
# the CSRF and Host gates and the migration chain all sit below
# the LLM and break quietly.
#
# the chat section at the bottom is the one place chat.php runs
# in CI. it talks to fake-ollama.py, which streams a canned reply
# and dumps every request it gets, so what's checked is the
# plumbing around the model: prompt order, the tool round trip,
# the SSE frames, mood_shift stripping, what hits the db.
set -eu

cd "$(dirname "$0")/../.." || exit 1

php -m | grep -qx pdo_sqlite || {
	echo "smoke-api: php has no pdo_sqlite, every endpoint is a 500 without it" >&2
	exit 1
}

PORT=${SMOKE_PORT:-8129}
OLLAMA_PORT=$((PORT + 1))
BASE="http://127.0.0.1:$PORT"
work=$(mktemp -d)
export work
srv=""
fake=""

cleanup() {
	[ -n "$srv" ] && kill "$srv" 2>/dev/null
	[ -n "$fake" ] && kill "$fake" 2>/dev/null
	rm -rf "$work"
}
trap cleanup EXIT INT TERM

# lore_corpus.txt is gitignored, a fresh checkout has none and
# lore_retrieve() quietly returns nothing. build it so the world
# facts block actually shows up in the prompt below. the public
# tree ships no lore_dataset.jsonl at all, there the lore check
# is skipped instead of failing the whole run.
HAVE_LORE=0
if [ -f tools/lore_dataset.jsonl ]; then
	php tools/build_lore_index.php >/dev/null
	HAVE_LORE=1
fi
export HAVE_LORE

FAKE_OLLAMA_LOG="$work/ollama-requests.jsonl" python3 .github/scripts/fake-ollama.py "$OLLAMA_PORT" &
fake=$!

OMEGA_STATE_DIR="$work/state" \
OMEGA_ALLOWED_HOSTS='localhost,127.0.0.1' \
OMEGA_REGISTRATION_KEY='' \
OMEGA_DEV_KEY='ci-dev-key' \
OLLAMA_URL="http://127.0.0.1:$OLLAMA_PORT" \
OLLAMA_MODELS_TO_PULL=fake-jun \
	php -S "127.0.0.1:$PORT" -t webapp tools/php-router.php >"$work/server.log" 2>&1 &
srv=$!

i=0
while [ $i -lt 50 ]; do
	curl -sS -o /dev/null "$BASE/" 2>/dev/null && break
	kill -0 "$srv" 2>/dev/null || { echo "server died:"; cat "$work/server.log"; exit 1; }
	i=$((i + 1))
	sleep 0.2
done

fails=0
sh .github/scripts/api-checks.sh "$BASE" || fails=1

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=1; }

echo "router only"
# nginx answers a bad Host with 444 (no response at all), the
# router answers
# 421. same intent, different shape, so it lives here and not in api-checks.
check_status() {
	got=$(curl -sS -o /dev/null -w '%{http_code}' "$@" || echo 000)
	printf '%s' "$got"
}
if [ "$(check_status -H 'Host: evil.example' "$BASE/api/auth.php?action=signup_info")" = "421" ]; then
	pass 'a Host outside the allowlist gets 421'
else
	fail 'a Host outside the allowlist was served'
fi
if [ "$(check_status -X POST "$BASE/js/app.js")" = "405" ]; then
	pass 'POST to a static file is refused'
else
	fail 'POST to a static file was accepted'
fi

echo "schema"
db="$work/state/omega.sqlite"
if [ ! -f "$db" ]; then
	fail 'no sqlite database at all'
elif ! command -v sqlite3 >/dev/null; then
	pass 'the database exists (no sqlite3 cli here, skipping the schema checks)'
else
	pass 'the database got created'
	applied=$(sqlite3 "$db" 'SELECT MAX(v) FROM schema_version')
	latest=$(ls webapp/api/migrations/*.sql | sed 's#.*/##; s/_.*//; s/^0*//' | sort -n | tail -1)
	if [ "$applied" = "$latest" ]; then
		pass "migrations ran up to $applied"
	else
		fail "schema_version is $applied but the newest migration is $latest"
	fi
	# start_session stores sha256(cookie), never the cookie. a row
	# holding the cookie verbatim means migration 014's hashing got
	# dropped somewhere, and then whoever walks off with omega.sqlite
	# can log in as you.
	cookie=$(awk '/omega_session/ {print $7}' "$work/cookies.txt")
	if [ -n "$cookie" ] && [ "$(sqlite3 "$db" "SELECT COUNT(*) FROM sessions WHERE token = '$cookie'")" = "0" ]; then
		pass 'sessions store the hash, not the cookie'
	else
		fail 'the session cookie is sitting in the sessions table verbatim'
	fi
fi

echo "chat"
cookies="$work/cookies.txt"
sse() { curl -sS -N -b "$cookies" -X POST -H "Origin: $BASE" -H 'Content-Type: application/json' --data "$1" "$BASE/api/chat.php"; }
convo=$(curl -sS -b "$cookies" -X POST -H "Origin: $BASE" "$BASE/api/conversations.php?action=create" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
[ -n "$convo" ] || fail 'could not create a conversation for the chat turn'

sse '{"messages":"nope","conversation_id":1}' >"$work/sse"
if grep -q '"error":"invalid_request"' "$work/sse"; then
	pass 'a malformed turn is refused over SSE'
else
	fail 'a malformed turn was not refused'
fi
sse "{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"conversation_id\":999999}" >"$work/sse"
if grep -q '"error":"forbidden"' "$work/sse"; then
	pass 'a conversation that is not yours is refused'
else
	fail 'a foreign conversation id was served'
fi

# the question is a lore row verbatim, so lore_retrieve() has
# something to score above LORE_FLOOR.
question='What year is the game set in?'
sse "{\"messages\":[{\"role\":\"user\",\"content\":\"$question\"}],\"conversation_id\":$convo}" >"$work/sse"
if grep -q 'data: \[DONE\]' "$work/sse"; then pass 'the stream ends with [DONE]'; else fail 'no [DONE] frame'; fi
if grep -q '"token":"' "$work/sse"; then pass 'tokens came through as SSE'; else fail 'no token frames'; fi
if grep -q '"tool_status":{"name":"list_recent_chats","state":"done"' "$work/sse"; then
	pass 'the tool round trip ran'
else
	fail 'list_recent_chats never completed'
fi
if grep -q '"stats":{' "$work/sse"; then pass 'stats frame'; else fail 'no stats frame'; fi
if grep -q '"error"' "$work/sse"; then fail 'the turn reported an error (below)'; grep '"error"' "$work/sse"; else pass 'no error frame'; fi

# two /api/chat calls for the turn (tool round, then the reply)
# plus one non streaming title call. the prompt checks read the
# reply round, the last streaming request.
python3 - "$work/ollama-requests.jsonl" "$question" <<'PY' || fail 'prompt assembly (above)'
import json, os, pathlib, sys
reqs = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text().splitlines()]
question = sys.argv[2]
streams = [r for r in reqs if r.get('stream', True)]
assert len(streams) == 2, f'expected 2 streaming rounds, got {len(streams)}'
assert len(reqs) - len(streams) == 1, 'expected exactly one title call'
req = streams[-1]
msgs = req['messages']
assert msgs[0]['role'] == 'system', 'system turn is not first'
# the KV cache lives or dies on this: the system turn has to be
# the same bytes on every request, tool round included.
assert msgs[0] == streams[0]['messages'][0], 'the system turn changed between rounds, the KV cache is gone'
assert '<!--' not in msgs[0]['content'], 'the tool gate markers were sent to the model'
assert msgs[-1]['role'] == 'tool', 'the reply round did not carry the tool result'
user = [m for m in msgs if m['role'] == 'user'][-1]['content']
marker = '\n\n# Live context for THIS reply'
assert user.startswith(question + marker), 'his words must come first, then the live context'
if os.environ['HAVE_LORE'] == '1':
    assert '## World facts (canon)' in user, 'lore never made it into the live context'
assert user.rstrip('>').rsplit('<think:', 1)[-1] in ('low', 'med', 'high') and user.endswith('>'), 'the <think:LEVEL> budget token is not the last thing in the user turn'
lore = 'lore attached' if os.environ['HAVE_LORE'] == '1' else 'lore skipped (no dataset)'
print(f'  ok   system prefix is byte-identical, question before live context, {lore}, budget token last')
PY

curl -sS -b "$cookies" "$BASE/api/conversations.php?action=messages&id=$convo" >"$work/body"
if grep -q 'mood_shift' "$work/body"; then
	fail 'the mood_shift tag was stored with the message'
else
	pass 'mood_shift stripped before storage'
fi
if grep -q '\[A:smile\]' "$work/body"; then pass 'action tags are stored verbatim'; else fail 'the [A:smile] tag went missing'; fi
curl -sS -b "$cookies" "$BASE/api/relationship.php" >"$work/body"
# api-checks left the gauges at 99/99/0, the fake shifts them by -3/-1/+2
if grep -q '"affection":96' "$work/body" && grep -q '"trust":98' "$work/body" && grep -q '"tension":2' "$work/body"; then
	pass 'mood_shift deltas applied to the gauges'
else
	fail "gauges did not move by the deltas: $(cat "$work/body")"
fi
curl -sS -b "$cookies" "$BASE/api/conversations.php?action=list" >"$work/body"
if grep -q '"title":"Fake Title"' "$work/body"; then pass 'the title came from the model'; else fail 'no generated title'; fi

echo "php log"
if grep -Ei 'PHP (Warning|Notice|Fatal|Parse|Deprecated)' "$work/server.log"; then
	fail 'php complained during the run (above)'
else
	pass 'no php warnings'
fi

echo
[ "$fails" -eq 0 ] || { echo 'smoke-api: FAILED'; exit 1; }
echo 'smoke-api: ok'
