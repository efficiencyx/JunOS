#!/usr/bin/env python3
# every locale in webapp/i18n/ carries exactly the keys the webapp asks for.
# missing = english leaks through, stale = a translation nobody ever sees
import json
import re
import sys
from pathlib import Path

WEBAPP = Path(__file__).resolve().parents[2] / "webapp"
LOCALES = WEBAPP / "i18n"

HTML_KEY = re.compile(r'data-i18n(?:-html|-placeholder|-title|-aria-label)?="([^"]+)"')
JS_CALL = re.compile(r"""(?<![\w$.])t\(\s*(['"`])([\w.-]+)\1\s*(?:,\s*(['"`])((?:\\.|(?!\3).)*)\3)?""", re.S)
JS_DYNAMIC = re.compile(r"""(?<![\w$.])t\(\s*(?!['"`)])""")
PHP_CALL = re.compile(r"""(?<![\w$>:])tr\(\s*'([\w.-]+)'\s*,\s*'((?:\\.|[^'\\])*)'""", re.S)
PHP_DYNAMIC = re.compile(r"""(?<![\w$>:])tr\(\s*(?!')""")
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def skipped(path: Path) -> bool:
    return "vendor" in path.parts or "landing" in path.parts or path.name.startswith("showcase")


used = {}
problems = []

for html in sorted(WEBAPP.glob("*.html")):
    if skipped(html):
        continue
    for key in HTML_KEY.findall(html.read_text(encoding="utf-8")):
        used.setdefault(key, None)

for js in sorted(WEBAPP.joinpath("js").rglob("*.js")):
    if skipped(js) or js.name == "i18n.js":
        continue
    src = js.read_text(encoding="utf-8")
    for m in JS_CALL.finditer(src):
        used.setdefault(m[2], set(PLACEHOLDER.findall(m[4] or "")))
    for m in JS_DYNAMIC.finditer(src):
        line = src.count("\n", 0, m.start()) + 1
        problems.append(f"{js.relative_to(WEBAPP)}:{line}: t() key is not a string literal, this check can't see it")

for php in sorted(WEBAPP.joinpath("api").rglob("*.php")):
    if php.name == "i18n.php":
        continue
    src = php.read_text(encoding="utf-8")
    for m in PHP_CALL.finditer(src):
        used.setdefault(m[1], set(PLACEHOLDER.findall(m[2])))
    for m in PHP_DYNAMIC.finditer(src):
        line = src.count("\n", 0, m.start()) + 1
        problems.append(f"{php.relative_to(WEBAPP)}:{line}: tr() key is not a string literal, this check can't see it")

files = sorted(LOCALES.glob("*.json"))
if not files:
    problems.append("no locale files under webapp/i18n/")

for path in files:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        problems.append(f"{path.name}: not valid JSON ({e})")
        continue
    for key in sorted(used.keys() - data.keys()):
        problems.append(f"{path.name}: missing {key}")
    for key in sorted(data.keys() - used.keys()):
        problems.append(f"{path.name}: {key} is not used anywhere")
    for key, value in data.items():
        if not isinstance(value, str):
            problems.append(f"{path.name}: {key} is not a string")
        elif used.get(key) is not None and set(PLACEHOLDER.findall(value)) != used[key]:
            problems.append(f"{path.name}: {key} placeholders {sorted(PLACEHOLDER.findall(value))} "
                            f"don't match the english {sorted(used[key])}")

if problems:
    for p in problems:
        print(p)
    print(f"check-i18n: {len(problems)} problem(s)")
    sys.exit(1)
print(f"check-i18n: ok - {len(used)} keys, {len(files)} locales")
