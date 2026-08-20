#!/bin/sh
# the cheap invariants nothing else notices: dead knobs in .env.example, the
# migration numbering the schema_version table depends on, and game assets or
# secrets sneaking into a commit. no services, no network, runs in a second.
set -eu

cd "$(dirname "$0")/../.." || exit 1

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }

echo "env knobs"
# a knob in .env.example that nothing reads is worse than no knob: somebody
# sets it, nothing happens, and they go looking for the bug in the wrong file.
dead=""
for v in $(grep -oE '^#?[[:space:]]*[A-Z][A-Z0-9_]+=' .env.example | tr -d '#= \t' | sort -u); do
	grep -rqE "\b$v\b" docker-compose*.yml start.sh start.ps1 install.sh install.ps1 \
		docker/ tts/ webapp/api/ tools/ 2>/dev/null || dead="$dead $v"
done
if [ -n "$dead" ]; then
	fail "nothing reads these .env.example knobs:$dead"
else
	pass 'every .env.example knob is read somewhere'
fi

echo "migrations"
# _lib.php picks migrations with glob + sort and compares the leading number
# against MAX(v) in schema_version. a duplicate number means one of the two
# never runs on an existing database, and a file that forgets its own INSERT
# gets re-run on every single request.
prev=""
for f in webapp/api/migrations/*.sql; do
	base=$(basename "$f")
	n=$(printf '%s' "$base" | sed -n 's/^\([0-9][0-9][0-9]\)_.*\.sql$/\1/p')
	if [ -z "$n" ]; then
		fail "$base is not NNN_name.sql, _lib.php will skip it"
		continue
	fi
	if [ "$n" = "$prev" ]; then fail "two migrations numbered $n"; fi
	prev=$n
	v=$(printf '%s' "$n" | sed 's/^0*//')
	grep -q "INSERT INTO schema_version" "$f" || fail "$base never writes to schema_version, it will re-run forever"
	grep -qE "INSERT INTO schema_version[^;]*\b$v\b" "$f" || fail "$base does not record version $v"
done
if [ "$fails" -eq 0 ]; then pass 'migration numbering is sane'; fi

echo "nothing that must not be in the repo"
# the extractor is personal-use only per the agreement with the game dev (see
# the NOTICE in LICENSE). ripped assets must never end up in a commit.
leaked=$(git ls-files 'webapp/assets/*' '*.moc3' '*.model3.json' '*.motion3.json' '*.cmo3' '*.bank' '*.unity3d' || true)
if [ -n "$leaked" ]; then
	printf '%s\n' "$leaked" | sed 's/^/       /'
	fail 'game assets are tracked'
else
	pass 'no game assets tracked'
fi
secrets=$(git ls-files '.env' '.env.local' '*.pem' '*.key' '*.keystore' '*.jks' || true)
if [ -n "$secrets" ]; then
	printf '%s\n' "$secrets" | sed 's/^/       /'
	fail 'secrets are tracked'
else
	pass 'no keys or .env tracked'
fi

echo
if [ "$fails" -gt 0 ]; then
	echo "check-consistency: $fails problem(s)"
	exit 1
fi
echo 'check-consistency: ok'
