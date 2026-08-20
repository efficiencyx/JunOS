#!/usr/bin/env python3
# every local file the webapp points at has to exist AND be tracked by git.
# there is no bundler here, so a renamed module is not a build error, it is a
# 404 at runtime and a white screen. and webapp/assets is gitignored, so a file
# that works on the maintainer's box can be missing from a fresh clone: "exists
# on disk" is not the question, "is in the repo" is.
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEBAPP = ROOT / "webapp"

tracked = set(
    subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
)

HTML_REF = re.compile(r'(?:src|href)\s*=\s*"([^"]+)"')
# the lookbehind keeps string literals out of it: get('from') === 'wardrobe'
# otherwise reads as an import of 'wardrobe'. the hyphen is in there for the
# same reason, class names like .wd-looks-import sit right next to a quote in
# the html templates and every one of them looked like a bare import.
JS_IMPORT = re.compile(r"""(?<![-'"\w$])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]""")

problems = []


def resolve(base: Path, ref: str):
    ref = ref.split("?")[0].split("#")[0]
    if not ref or ref.startswith(("http://", "https://", "data:", "blob:", "mailto:", "//")):
        return None
    target = (WEBAPP / ref.lstrip("/")) if ref.startswith("/") else (base / ref)
    try:
        return target.resolve().relative_to(ROOT)
    except ValueError:
        problems.append(f"{base}: {ref} points outside the repo")
        return None


def check(source: Path, ref: str):
    rel = resolve(source.parent, ref)
    if rel is None:
        return
    where = source.relative_to(ROOT)
    if not (ROOT / rel).is_file():
        problems.append(f"{where}: {ref} does not exist")
    elif str(rel) not in tracked:
        problems.append(f"{where}: {ref} exists but is not tracked by git")


for html in sorted(WEBAPP.glob("*.html")):
    for ref in HTML_REF.findall(html.read_text(encoding="utf-8")):
        check(html, ref)

for js in sorted(WEBAPP.rglob("*.js")):
    if "vendor" in js.parts:
        continue
    for ref in JS_IMPORT.findall(js.read_text(encoding="utf-8")):
        # bare specifiers would need a bundler or an import map, and this repo
        # has neither, so every one of them is already a mistake.
        if not ref.startswith((".", "/")):
            problems.append(f"{js.relative_to(ROOT)}: bare import specifier {ref!r}, "
                            "nothing here resolves those")
            continue
        check(js, ref)

if problems:
    for p in problems:
        print(p)
    print(f"check-refs: {len(problems)} broken reference(s)")
    sys.exit(1)
print("check-refs: ok")
