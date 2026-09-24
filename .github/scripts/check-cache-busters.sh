#!/bin/sh
# every reference to one JS module has to carry the same ?v=
# number, across the whole webapp. two different modules on two
# different versions is normal, they're independent of each
# other. what this catches is ONE module referenced at two
# versions. the browser then fetches it twice and builds two
# separate copies of the module. stylesheets get the same
# treatment, a skewed one is just a wasted download.
#
# refs are keyed by basename, not by path, because resolving
# "../x.js" in awk is misery. that only works while every
# basename under webapp/ is unique, so that gets checked first.
set -eu

cd "$(dirname "$0")/../.." || exit 1

dupes=$(find webapp -path webapp/vendor -prune -o -type f \( -name '*.js' -o -name '*.css' \) -print \
	| sed 's#.*/##' | sort | uniq -d)
if [ -n "$dupes" ]; then
	echo "check-cache-busters: these basenames exist more than once under webapp/, the version check can't tell them apart:" >&2
	printf '    %s\n' $dupes >&2
	exit 1
fi

refs=$(grep -rnoE '[A-Za-z0-9_./-]+\.(js|css)\?v=[0-9]+' webapp \
	--include='*.html' --include='*.js' --include='*.css' --exclude-dir=vendor || true)

if [ -z "$refs" ]; then
	echo "check-cache-busters: no ?v= references found under webapp/ - the scan is broken" >&2
	exit 1
fi

# grep -rno prints file:line:match, and none of these paths
# contain a colon.
printf '%s\n' "$refs" | awk -F: '
{
	file = $1
	ref  = $3

	ver = ref
	sub(/^.*\?v=/, "", ver)

	mod = ref
	sub(/\?v=[0-9]+$/, "", mod)
	sub(/^.*\//, "", mod)

	if (!((mod SUBSEP ver) in known)) {
		known[mod SUBSEP ver] = 1
		versions[mod] = versions[mod] (nver[mod]++ ? " " : "") ver
	}
	if (!((mod SUBSEP ver SUBSEP file) in seen)) {
		seen[mod SUBSEP ver SUBSEP file] = 1
		where[mod SUBSEP ver] = where[mod SUBSEP ver] (nfile[mod SUBSEP ver]++ ? ", " : "") file
	}
	total++
}
END {
	bad = 0
	for (mod in nver) {
		if (nver[mod] < 2)
			continue
		bad++
		printf "%s: %d versions in use (%s)\n", mod, nver[mod], versions[mod]
		n = split(versions[mod], v, " ")
		for (i = 1; i <= n; i++)
			printf "    v=%s in %s\n", v[i], where[mod SUBSEP v[i]]
	}
	for (mod in nver)
		nmod++
	if (bad) {
		printf "check-cache-busters: %d module(s) referenced at more than one ?v=\n", bad
		exit 1
	}
	printf "check-cache-busters: ok - %d references, %d modules, no version skew\n", total, nmod
}
'
