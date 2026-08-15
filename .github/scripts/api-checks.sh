#!/bin/sh
# the HTTP assertions, pointed at whatever is already serving the app.
# smoke-api.sh runs them against a bare `php -S` (the bare metal install),
# smoke-stack.sh runs the same list against the real nginx + php-fpm compose
# stack. same expectations both times, on purpose: the router and the nginx
# config duplicate every 404 rule and they drift the moment nobody looks.
#
# usage: api-checks.sh http://127.0.0.1:8129
# expects $work to be a writable scratch dir, or makes its own.
set -eu

BASE=${1:?usage: api-checks.sh BASE_URL}
ORIGIN=$BASE
work=${work:-$(mktemp -d)}
cookies="$work/cookies.txt"
rm -f "$cookies"
# the stack driver reuses a compose volume across runs, so the account has to
# be new every time or signup answers 409 and everything below it unravels.
email="smoke-$(date +%s)-$$@example.com"
password=hunter2hunter2

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }

check() {
	name=$1
	want=$2
	shift 2
	# curl already prints 000 through -w when it cannot connect, so no ||
	# fallback here, that would concatenate onto the code it just printed.
	got=$(curl -sS -o "$work/body" -w '%{http_code}' "$@" || true)
	if [ "$got" = "$want" ]; then
		pass "$name ($got)"
	else
		fail "$name: wanted $want, got $got"
		sed -n 1,5p "$work/body" 2>/dev/null | sed 's/^/       /'
	fi
}

body_has() {
	if grep -q "$2" "$work/body" 2>/dev/null; then
		pass "$1"
	else
		fail "$1: response missing '$2'"
		sed -n 1,5p "$work/body" 2>/dev/null | sed 's/^/       /'
	fi
}

# same request, two front ends that refuse it differently. all we assert is
# that the answer is not a 2xx.
refused() {
	name=$1
	shift
	got=$(curl -sS -o /dev/null -w '%{http_code}' "$@" || true)
	case $got in
	2*) fail "$name: served it ($got)" ;;
	*)  pass "$name ($got)" ;;
	esac
}

json() { printf 'Content-Type: application/json'; }

echo "routing"
check 'GET / serves the app'            200 "$BASE/"
body_has 'index.html looks like the app' '<html'
check 'GET a module'                    200 "$BASE/js/app.js"
check 'unknown path 404s'               404 "$BASE/nope.html"
# the three that a plain docroot would hand straight out.
check 'system_prompt.txt is not public' 404 "$BASE/system_prompt.txt"
check 'migrations are not public'       404 "$BASE/api/migrations/001_init.sql"
check 'cli worker is not reachable'     404 "$BASE/api/consolidation-worker.php"
check 'dotfiles are not public'         404 "$BASE/.env"
# nginx rejects the traversal itself with 400, the php router normalizes and
# 404s. either is a refusal, the point is nobody gets composer.json.
refused 'traversal out of the docroot' --path-as-is "$BASE/../composer.json"

echo "headers"
curl -sS -D "$work/head" -o /dev/null "$BASE/" || true
for h in 'X-Content-Type-Options: nosniff' 'X-Frame-Options: DENY' 'Content-Security-Policy:' 'Referrer-Policy:' 'Permissions-Policy:'; do
	if grep -qi "^$h" "$work/head"; then pass "$h"; else fail "missing header: $h"; fi
done
if grep -qi '^X-Powered-By' "$work/head"; then fail 'X-Powered-By leaked'; else pass 'no X-Powered-By'; fi

echo "auth"
check 'signup_info'                     200 "$BASE/api/auth.php?action=signup_info"
check 'me without a session'            401 "$BASE/api/auth.php?action=me"
check 'signup needs a content type'     415 -X POST -H "Origin: $ORIGIN" \
	--data '{}' "$BASE/api/auth.php?action=signup"
check 'signup needs adult consent'      400 -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data "{\"email\":\"$email\",\"password\":\"$password\"}" "$BASE/api/auth.php?action=signup"
check 'signup rejects a short password' 400 -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data "{\"email\":\"$email\",\"password\":\"short\",\"adult_consent\":true}" "$BASE/api/auth.php?action=signup"
check 'signup rejects a bad email'      400 -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data '{"email":"nope","password":"hunter2hunter2","adult_consent":true}' "$BASE/api/auth.php?action=signup"
check 'signup'                          200 -c "$cookies" -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data "{\"email\":\"$email\",\"password\":\"$password\",\"adult_consent\":true}" "$BASE/api/auth.php?action=signup"
check 'the same email twice'            409 -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data "{\"email\":\"$email\",\"password\":\"$password\",\"adult_consent\":true}" "$BASE/api/auth.php?action=signup"
check 'me with the session cookie'      200 -b "$cookies" "$BASE/api/auth.php?action=me"
body_has 'me returns the account' "$email"
check 'me with a made up cookie'        401 -H 'Cookie: omega_session=deadbeef' "$BASE/api/auth.php?action=me"
check 'login with the wrong password'   401 -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data "{\"email\":\"$email\",\"password\":\"wrongwrongwrong\"}" "$BASE/api/auth.php?action=login"
check 'login'                           200 -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data "{\"email\":\"$email\",\"password\":\"$password\"}" "$BASE/api/auth.php?action=login"
check 'promote with a wrong admin key'  403 -b "$cookies" -X POST -H "Origin: $ORIGIN" -H "$(json)" \
	--data '{"key":"not-the-key"}' "$BASE/api/auth.php?action=promote"

echo "csrf"
# a page served on another 127.0.0.1 port is same-SITE with us, so the session
# cookie rides along on whatever it forges. Origin / Sec-Fetch-Site is the only
# thing between that page and the account.
check 'POST from a foreign origin'      403 -b "$cookies" -X POST -H 'Origin: http://127.0.0.1:9999' \
	-H "$(json)" --data '{}' "$BASE/api/prefs.php"
check 'POST claiming cross-site'        403 -b "$cookies" -X POST -H 'Sec-Fetch-Site: cross-site' \
	-H "$(json)" --data '{}' "$BASE/api/prefs.php"
check 'POST with no origin at all'      403 -b "$cookies" -X POST \
	-H "$(json)" --data '{}' "$BASE/api/prefs.php"

echo "endpoints"
check 'prefs needs a session'           401 "$BASE/api/prefs.php"
check 'prefs starts empty'              200 -b "$cookies" "$BASE/api/prefs.php"
check 'prefs write'                     200 -b "$cookies" -X PUT -H "Origin: $ORIGIN" \
	-H "$(json)" --data '{"ttsVoice":"smoke"}' "$BASE/api/prefs.php"
check 'prefs read back'                 200 -b "$cookies" "$BASE/api/prefs.php"
body_has 'prefs round trip' 'smoke'
check 'conversations list'              200 -b "$cookies" "$BASE/api/conversations.php?action=list"
check 'unknown conversation action'     400 -b "$cookies" "$BASE/api/conversations.php?action=nope"
check 'conversation create'             200 -b "$cookies" -X POST -H "Origin: $ORIGIN" \
	"$BASE/api/conversations.php?action=create"
convo=$(sed -n 's/.*"id":\([0-9]*\).*/\1/p' "$work/body")
check 'messages of a new conversation'  200 -b "$cookies" "$BASE/api/conversations.php?action=messages&id=${convo:-1}"
# there is no second account here, so an id that cannot exist stands in for
# somebody else's conversation.
check 'messages of a foreign id'        404 -b "$cookies" "$BASE/api/conversations.php?action=messages&id=999999"
check 'relationship gauges'             200 -b "$cookies" "$BASE/api/relationship.php"
check 'relationship is admin only'      403 -b "$cookies" -X PUT -H "Origin: $ORIGIN" \
	-H "$(json)" --data '{"affection":99,"trust":99,"tension":0}' "$BASE/api/relationship.php"
check 'wardrobe'                        200 -b "$cookies" "$BASE/api/wardrobe.php"
check 'memory notes'                    200 -b "$cookies" "$BASE/api/memory.php"
check 'stats is admin only'             403 -b "$cookies" "$BASE/api/stats.php"

echo
if [ "$fails" -gt 0 ]; then
	echo "api-checks: $fails check(s) failed against $BASE"
	exit 1
fi
echo "api-checks: all checks passed against $BASE"
