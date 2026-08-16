#!/bin/sh
# boots the webapp the way a bare metal install does (php -S in front of
# tools/php-router.php) and runs api-checks.sh at it. no docker, no nginx, no
# model backend. everything here has to pass with ollama DOWN, which is the
# point: auth, the router's 404 rules, the CSRF and Host gates and the
# migration chain all sit below the LLM and break quietly.
set -eu

cd "$(dirname "$0")/../.." || exit 1

php -m | grep -qx pdo_sqlite || {
	echo "smoke-api: php has no pdo_sqlite, every endpoint is a 500 without it" >&2
	exit 1
}

PORT=${SMOKE_PORT:-8129}
BASE="http://127.0.0.1:$PORT"
work=$(mktemp -d)
export work
srv=""

cleanup() {
	[ -n "$srv" ] && kill "$srv" 2>/dev/null
	rm -rf "$work"
}
trap cleanup EXIT INT TERM

OMEGA_STATE_DIR="$work/state" \
OMEGA_ALLOWED_HOSTS='localhost,127.0.0.1' \
OMEGA_REGISTRATION_KEY='' \
OMEGA_DEV_KEY='ci-dev-key' \
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
# nginx answers a bad Host with 444 (no response at all), the router answers
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
	# start_session stores sha256(cookie), never the cookie. a row holding the
	# cookie verbatim means migration 014's hashing got dropped somewhere, and
	# then whoever walks off with omega.sqlite can log in as you.
	cookie=$(awk '/omega_session/ {print $7}' "$work/cookies.txt")
	if [ -n "$cookie" ] && [ "$(sqlite3 "$db" "SELECT COUNT(*) FROM sessions WHERE token = '$cookie'")" = "0" ]; then
		pass 'sessions store the hash, not the cookie'
	else
		fail 'the session cookie is sitting in the sessions table verbatim'
	fi
fi

echo "php log"
if grep -Ei 'PHP (Warning|Notice|Fatal|Parse|Deprecated)' "$work/server.log"; then
	fail 'php complained during the run (above)'
else
	pass 'no php warnings'
fi

echo
[ "$fails" -eq 0 ] || { echo 'smoke-api: FAILED'; exit 1; }
echo 'smoke-api: ok'
