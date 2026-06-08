#!/usr/bin/env python3
"""Build a chat SFT dataset (JSONL) from line-aligned question and answer files.

Each non-empty line in the questions file is one user turn (Anon -> Jun); the
line at the same position in the answers file is Jun's reply. An answer line may
carry an optional concise thinking trace, written before the reply and separated
by the sentinel ``||THINK||``::

    He's stressed about rent. Reassure, then a practical idea.||THINK||[ACTION:...] reply

Lines without the sentinel are treated as reply-only (no thinking).

Output is one JSON object per line::

    {"messages":[{"role":"user","content":...},
                 {"role":"assistant","thinking":...,"content":...}]}

(the ``thinking`` key is omitted when absent). Pass --system to prepend a shared
system turn to every example.

Usage:
    python build_dataset.py --questions q.txt --answers a.txt --out data.jsonl
    python build_dataset.py --questions q2.txt --answers a2.txt --out data.jsonl --append
"""
import argparse
import json
import sys

THINK_SEP = "||THINK||"


def read_lines(path):
    with open(path, encoding="utf-8") as f:
        return [ln.rstrip("\n") for ln in f if ln.strip() != ""]


def build(q_path, a_path, system=None):
    questions = read_lines(q_path)
    answers = read_lines(a_path)
    if len(questions) != len(answers):
        sys.exit(f"line count mismatch: {len(questions)} questions vs {len(answers)} answers")

    rows, n_think = [], 0
    for q, a in zip(questions, answers):
        assistant = {"role": "assistant"}
        if THINK_SEP in a:
            think, _, reply = a.partition(THINK_SEP)
            if think.strip():
                assistant["thinking"] = think.strip()
                n_think += 1
            a = reply
        assistant["content"] = a.strip()

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": q.strip()})
        messages.append(assistant)
        rows.append({"messages": messages})
    return rows, n_think


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--questions", required=True, help="path to the questions file (one per line)")
    ap.add_argument("--answers", required=True, help="path to the line-aligned answers file")
    ap.add_argument("--out", required=True, help="output JSONL path")
    ap.add_argument("--system", help="optional path to a system prompt to prepend to each example")
    ap.add_argument("--append", action="store_true", help="append to --out instead of overwriting")
    args = ap.parse_args()

    system = None
    if args.system:
        with open(args.system, encoding="utf-8") as f:
            system = f.read().strip()

    rows, n_think = build(args.questions, args.answers, system)

    with open(args.out, "a" if args.append else "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    verb = "appended" if args.append else "wrote"
    print(f"{verb} {len(rows)} rows -> {args.out} ({n_think} with thinking)")


if __name__ == "__main__":
    main()
