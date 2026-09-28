#!/bin/sh
# the real thing: builds and runs the nginx + php-fpm compose
# stack and runs api-checks.sh through nginx over FastCGI.
# ollama, tts and karaoke stay down (ollama sits behind a compose
# profile, the other two are never started here), so nothing that
# needs the model is exercised. what this catches that
# smoke-api.sh cannot is the wiring: the fastcgi params, the
# SCRIPT_FILENAME rewrites, the cache headers, and whether nginx
# can reach php at all.
set -eu

cd "$(dirname "$0")/../.." || exit 1

BASE=${SMOKE_STACK_BASE:-https://127.0.0.1}
work=$(mktemp -d)
export work
# never the developer's own .env: a registration key or a stray
# DOMAIN in there turns half of these checks into a 403 and the
# failure looks like a bug in the app. .env.example plus the
# couple of values the checks depend on.
env_file="$work/env"
{
	cat .env.example
	printf '\nOMEGA_REGISTRATION_KEY=\nOMEGA_DEV_KEY=ci-dev-key\nDOMAIN=localhost\nBIND_ADDR=127.0.0.1\nTLS_MODE=off\n'
} >"$env_file"
# READ THIS BEFORE CHANGING ANY docker LINE IN THIS FILE.
#
# the compose project here is omega-ci. the developer's own stack
# is project omega, and its omega_state volume holds the
# accounts, the chats and the memory notes. there is no backup of
# that anywhere. a teardown aimed at the wrong project deletes
# all of it and the only symptom is a login screen that doesn't
# know you.
#
# so: this script never says `down -v`, never names a volume it
# did not create, and refuses to run while project omega has
# anything up. containers get torn down by project, volumes get
# removed one by one by name and only after the omega-ci_ prefix
# has been checked on each one.
PROJECT=omega-ci
case $PROJECT in
omega-ci) ;;
*)
	echo "smoke-stack: PROJECT is '$PROJECT', this script only ever drives omega-ci" >&2
	exit 1
	;;
esac
COMPOSE="docker compose -p $PROJECT --env-file $env_file -f docker-compose.yml"

# every volume this removes goes through here first. a name
# without the omega-ci_ prefix belongs to somebody else and is
# left alone, loudly.
drop_ci_volumes() {
	for v in $(docker volume ls -q --filter "name=^${PROJECT}_" 2>/dev/null || true); do
		case $v in
		"${PROJECT}_"*) docker volume rm -f "$v" >/dev/null 2>&1 || true ;;
		*) echo "smoke-stack: refusing to remove volume $v, not ours" >&2 ;;
		esac
	done
}

cleanup() {
	$COMPOSE logs --no-color --tail 100 >"$work/compose.log" 2>&1 || true
	# no -v here. ON PURPOSE. `down -v` takes whatever volumes the
	# project resolves to, and one typo in the project name is the
	# developer's whole database. the volumes go separately, by name,
	# through the prefix check.
	$COMPOSE down --remove-orphans >/dev/null 2>&1 || true
	docker rm -f "${PROJECT}-tls" >/dev/null 2>&1 || true
	drop_ci_volumes
	rm -rf "$work"
}
trap cleanup EXIT INT TERM

# the dev stack's nginx already owns 80/443, so this run would
# half-fail and the results would be about the wrong containers.
# tts and karaoke can stay up, they're not in our way and we
# never touch them.
running=$(docker compose -p omega -f docker-compose.yml ps -q nginx php 2>/dev/null || true)
if [ -n "$running" ]; then
	echo "smoke-stack: the omega nginx/php are already up and holding :80." >&2
	echo "smoke-stack: stop them first (docker compose stop nginx php). NOT 'down -v'." >&2
	exit 1
fi

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=1; }
status() { curl -sSk -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true; }


echo "boot"
# nginx depends_on php: service_healthy, so this brings up both
# and nothing else. --wait fails the command if either never
# reaches healthy.
$COMPOSE up -d --build --wait nginx
pass 'nginx and php came up healthy'

echo "checks through nginx"
sh .github/scripts/api-checks.sh "$BASE" || fails=1

echo "edge"
# nginx answers an unknown Host with 444, which is no response at
# all, so curl reports 000. php's own 421 never gets a chance and
# that is the intent.
if [ "$(status -H 'Host: evil.example' "$BASE/api/auth.php?action=signup_info")" = "000" ]; then
	pass 'an unknown Host gets dropped'
else
	fail 'an unknown Host was served'
fi
if [ "$(status "$BASE/health")" = "200" ]; then pass 'health'; else fail 'health'; fi
if [ "$(status "$BASE/tools/php-router.php")" = "404" ]; then
	pass 'php outside /api is not executed'
else
	fail 'a php file outside /api was reachable'
fi

hdr=$(curl -sSk -D - -o /dev/null "$BASE/")
if printf '%s' "$hdr" | grep -qi '^server: nginx/'; then
	fail 'the nginx version is in the Server header'
else
	pass 'no nginx version banner'
fi

echo "caching"
# index.html has to stay revalidated, otherwise the ?v= bumps
# underneath it get cached too and nobody ever sees a new build.
if curl -sSk -D - -o /dev/null "$BASE/index.html" | grep -qi 'cache-control:.*no-cache'; then
	pass 'index.html is no-cache'
else
	fail 'index.html lost its no-cache'
fi
if curl -sSk -D - -o /dev/null "$BASE/js/app.js" | grep -qi 'cache-control:.*immutable'; then
	pass 'modules are immutable'
else
	fail 'modules lost their immutable cache header'
fi

echo "plain http"
# :80 carries no app traffic at all, only /health for the
# healthcheck and a redirect. a login form served there would
# post the password in the clear.
if [ "$(status http://127.0.0.1/health)" = "200" ]; then pass 'health on :80'; else fail 'health on :80'; fi
loc=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' http://127.0.0.1/index.html?x=1 2>/dev/null || true)
if [ "$loc" = "301 https://127.0.0.1/index.html?x=1" ]; then
	pass ':80 redirects to https'
else
	fail ":80 answered '$loc' instead of a redirect to https"
fi
if [ "$(status -X POST http://127.0.0.1/api/auth.php?action=login)" = "301" ]; then
	pass 'the api is not served on :80'
else
	fail 'the api answered on plain http'
fi
img=$($COMPOSE images -q nginx)
san=$(docker run --rm --entrypoint sh -e OMEGA_EXTRA_HOSTS='192.168.1.42 jun.local' "$img" -c \
	'/docker-entrypoint.d/10-pick-config.sh >/dev/null && openssl x509 -noout -ext subjectAltName -in /etc/nginx/selfsigned/fullchain.pem' 2>/dev/null || true)
case $san in
*'IP Address:192.168.1.42'*'DNS:jun.local'* | *'DNS:jun.local'*'IP Address:192.168.1.42'*)
	pass 'the self-signed cert names the LAN hosts' ;;
*) fail "the self-signed cert is missing OMEGA_EXTRA_HOSTS: $san" ;;
esac

echo "tls bootstrap"
# a fresh prod install: TLS_MODE=on and an EMPTY letsencrypt
# volume. nginx used to refuse to start there (no cert yet), and
# certbot needs nginx up on :80 to get one. so: it has to boot on
# the placeholder, pass its healthcheck, serve the challenge, and
# swap to the real cert on its own once one shows up. no real ACME
# here, the "issued" cert is one we make ourselves.
tls_boot() {
	docker volume create "${PROJECT}_tls_le" >/dev/null
	docker volume create "${PROJECT}_tls_webroot" >/dev/null
	docker run -d --name "$TLS_CT" \
		--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add NET_BIND_SERVICE \
		--cap-add SETGID --cap-add SETUID --security-opt no-new-privileges:true \
		-e TLS_MODE=on -e DOMAIN=jun.test -e CERT_WATCH_INTERVAL=1 \
		-v "${PROJECT}_tls_le:/etc/letsencrypt:ro" -v "${PROJECT}_tls_webroot:/var/www/certbot:ro" \
		-p 127.0.0.1:18081:80 -p 127.0.0.1:18444:443 "$img" >/dev/null
}
served_cn() {
	curl -sk -v --resolve jun.test:18444:127.0.0.1 -o /dev/null https://jun.test:18444/health 2>&1 |
		sed -n 's/.*subject:.*CN *= *\([^,;]*\).*/\1/p' | head -n 1
}
TLS_CT="${PROJECT}-tls"
tls_boot
ok=''
for _ in $(seq 1 30); do
	if [ "$(status http://127.0.0.1:18081/health)" = "200" ]; then ok=1; break; fi
	sleep 1
done
if [ -n "$ok" ]; then pass 'TLS_MODE=on boots with no certificate and answers /health on :80'; else fail 'TLS_MODE=on without a certificate never came up'; fi
docker run --rm -v "${PROJECT}_tls_webroot:/w" --entrypoint sh "$img" -c \
	'mkdir -p /w/.well-known/acme-challenge && printf tok-ci > /w/.well-known/acme-challenge/probe'
if [ "$(curl -sS -H 'Host: jun.test' http://127.0.0.1:18081/.well-known/acme-challenge/probe 2>/dev/null)" = "tok-ci" ]; then
	pass 'the ACME challenge is served before any certificate exists'
else
	fail 'the ACME challenge is not reachable on :80'
fi
if [ "$(served_cn)" = "jun.test" ]; then pass 'the placeholder answers on :443'; else fail 'nothing usable on :443 before issuance'; fi
docker run --rm -v "${PROJECT}_tls_le:/le" --entrypoint sh "$img" -c \
	'mkdir -p /le/live/jun.test && openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=issued.jun.test -keyout /le/live/jun.test/privkey.pem -out /le/live/jun.test/fullchain.pem 2>/dev/null'
cn=''
for _ in $(seq 1 20); do
	cn=$(served_cn)
	[ "$cn" = "issued.jun.test" ] && break
	sleep 1
done
if [ "$cn" = "issued.jun.test" ]; then
	pass 'nginx picks up the issued certificate without a restart'
else
	fail "nginx still serves '$cn' after the certificate landed"
fi
docker rm -f "$TLS_CT" >/dev/null 2>&1 || true

echo "logs"
$COMPOSE logs --no-color php >"$work/php.log" 2>&1 || true
if grep -Ei 'PHP (Warning|Notice|Fatal|Parse) ' "$work/php.log"; then
	fail 'php complained during the run (above)'
else
	pass 'no php warnings'
fi

echo
[ "$fails" -eq 0 ] || { echo 'smoke-stack: FAILED'; exit 1; }
echo 'smoke-stack: ok'
