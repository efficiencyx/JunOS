#!/usr/bin/env python3
"""Extract the game's authored dialogue for the V5 style corpus.

Pulls Jun's canonical lines (and the rest of the scripted dialogue) out of the
Unity build so the V5 dataset generator can match her real cadence, and so a
curated subset can seed verbatim training rows. Personal-use only per the NOTICE
in LICENSE - the outputs are gitignored; do not republish game text.

The game is an IL2CPP build with no MonoBehaviour type metadata in the assets,
so localization tables (I2 Localization LanguageSourceAsset, one per language
per category: Story_en, Dialogue_en, ...) can't be read field-by-field. Instead
we scan the raw serialized bytes for Unity-serialized strings (int32 length +
UTF-8, 4-byte aligned), which recovers every line in narrative order. Scripted
speech is speaker-tagged inline ("Bot:" is Jun, "You:" is Anon, plus NPCs).

Usage:
  python3 tools/extract_game_text.py [--game DIR] [--out DIR]

Requires: UnityPy  (pip install UnityPy)
"""

import argparse
import glob
import json
import os
import re
import struct
import sys

import UnityPy

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME_MARKER = "My Dystopian Robot Girlfriend_Data"
DEFAULT_OUT = os.path.join(REPO, "tools", "dataset_v5")

# The English source assets worth pulling out, the I2 per language tables.
LOCALIZATION = ("Story", "Dialogue", "Comments", "Blog", "Emails",
                "Common", "Other", "Polyglot")
LOC_RE = re.compile(r"^(%s)_en$" % "|".join(LOCALIZATION))

# Jun and NPC TextAssets that are real text on their own, not ASCII art.
TEXT_ASSETS = ("PositiveComments", "NegativeComments", "MainNews", "SideNews",
               "OpinionNews", "Donations")

SPEAKER_RE = re.compile(r"^([A-Z][A-Za-z0-9'. ]{0,24}): ?(.*)$")
JUN_TAG = "Bot"          # the game's internal speaker id for Jun
ANON_TAG = "You"
GAME_MARKUP = re.compile(r"\{\{[^}]*\}\}")   # {{wi}}, {{wc}}, {{punch=...}}, ...


def find_game_dir(explicit):
    if explicit:
        return explicit
    home = os.path.expanduser("~")
    roots = [os.getcwd(), REPO, home]
    roots += [os.path.join(home, d) for d in ("Downloads", "Documents", "Desktop", "games")]
    if sys.platform == "win32":
        roots += ["%s:\\" % chr(c) for c in range(ord("C"), ord("H"))]
    seen = set()
    for r in roots:
        r = os.path.abspath(r)
        if r in seen or not os.path.isdir(r):
            continue
        seen.add(r)
        for pat in (os.path.join(r, "*"), os.path.join(r, "*", "*")):
            for cand in glob.glob(pat):
                if os.path.isdir(os.path.join(cand, GAME_MARKER)):
                    return cand
    sys.exit("no game install found; pass --game DIR (looked for %r)" % GAME_MARKER)


def containers(data_dir):
    for n in ("resources.assets", "sharedassets0.assets", "level0",
              "globalgamemanagers.assets"):
        p = os.path.join(data_dir, n)
        if os.path.exists(p):
            yield p
    bundles = os.path.join(data_dir, "StreamingAssets", "aa", "StandaloneWindows64")
    for p in sorted(glob.glob(os.path.join(bundles, "*.bundle"))):
        yield p


def mb_name(raw):
    """m_Name of a MonoBehaviour from raw bytes: the header (GameObject PPtr +
    enabled + script PPtr) is 28 bytes, then a length-prefixed string."""
    if len(raw) < 32:
        return ""
    n = struct.unpack_from("<I", raw, 28)[0]
    if n <= 0 or 32 + n > len(raw):
        return ""
    try:
        return raw[32:32 + n].decode("utf-8")
    except UnicodeDecodeError:
        return ""


def scan_strings(raw, minlen=1, maxlen=20000):
    """Unity-serialized strings (int32 len + utf8, 4-aligned) in file order."""
    out, i, n = [], 0, len(raw)
    while i + 4 <= n:
        ln = struct.unpack_from("<i", raw, i)[0]
        if minlen <= ln <= maxlen and i + 4 + ln <= n:
            chunk = raw[i + 4:i + 4 + ln]
            try:
                s = chunk.decode("utf-8")
            except UnicodeDecodeError:
                i += 1
                continue
            if s.isprintable() or any(c in s for c in "\n\t"):
                out.append(s)
                i += 4 + ((ln + 3) & ~3)
                continue
        i += 1
    return out


def clean(text):
    text = GAME_MARKUP.sub("", text)
    text = text.replace("\\n", "\n")
    return re.sub(r"[ \t]+", " ", text).strip()


def main():
    ap = argparse.ArgumentParser(description="Extract game dialogue for the V5 style corpus")
    ap.add_argument("--game", default=None, help="game install dir (default: auto-detect)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output dir (default: tools/dataset_v5)")
    args = ap.parse_args()

    game = find_game_dir(args.game)
    data = os.path.join(game, GAME_MARKER)
    raw_out = os.path.join(args.out, "raw_game_text")
    os.makedirs(raw_out, exist_ok=True)
    print("game:", game)

    # asset name -> ordered list of strings
    tables = {}
    for p in containers(data):
        try:
            env = UnityPy.load(p)
        except Exception as e:
            print("  LOAD FAIL", os.path.basename(p), e)
            continue
        for o in env.objects:
            try:
                if o.type.name == "MonoBehaviour":
                    raw = bytes(o.get_raw_data())
                    name = mb_name(raw)
                    if LOC_RE.match(name):
                        tables[name] = scan_strings(raw)
                elif o.type.name == "TextAsset":
                    d = o.read()
                    if d.m_Name in TEXT_ASSETS:
                        s = d.m_Script
                        b = s.encode("utf-8", "surrogatepass") if isinstance(s, str) else bytes(s)
                        tables[d.m_Name] = b.decode("utf-8", "replace").splitlines()
            except Exception:
                pass

    for name, lines in sorted(tables.items()):
        with open(os.path.join(raw_out, name + ".txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    print("dumped %d raw tables -> %s" % (len(tables), raw_out))

    # Every line of dialogue that says who is speaking, across all the tables.
    dialogue, jun, speakers = [], [], {}
    for name, lines in tables.items():
        # One stored string can hold several speaker lines at once, split by a
        # newline or by the game's own '|' marker.
        idx = 0
        for element in lines:
            for line in re.split(r"[\n|]", element):
                idx += 1
                m = SPEAKER_RE.match(line.strip())
                if not m:
                    continue
                speaker, said = m.group(1).strip(), m.group(2)
                said_clean = clean(said)
                if not said_clean:
                    continue
                speakers[speaker] = speakers.get(speaker, 0) + 1
                dialogue.append({"speaker": speaker, "text": said_clean,
                                 "source": name, "idx": idx})
                if speaker == JUN_TAG:
                    jun.append({"text": said_clean, "raw": said.strip(),
                                "source": name, "chars": len(said_clean)})

    with open(os.path.join(args.out, "dialogue_all.jsonl"), "w", encoding="utf-8") as f:
        for row in dialogue:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    # Everything Jun says, duplicates dropped, original order kept.
    seen, uniq = set(), []
    for row in jun:
        if row["text"] in seen:
            continue
        seen.add(row["text"])
        uniq.append(row)
    with open(os.path.join(args.out, "jun_style_corpus.jsonl"), "w", encoding="utf-8") as f:
        for row in uniq:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print("\ndialogue lines: %d across %d speakers" % (len(dialogue), len(speakers)))
    top = sorted(speakers.items(), key=lambda x: -x[1])[:12]
    print("  " + ", ".join("%s:%d" % (s, c) for s, c in top))
    print("Jun (Bot:) lines: %d total, %d unique -> jun_style_corpus.jsonl" % (len(jun), len(uniq)))
    if uniq:
        import statistics
        med = statistics.median(r["chars"] for r in uniq)
        print("  median length: %d chars" % med)


if __name__ == "__main__":
    main()
