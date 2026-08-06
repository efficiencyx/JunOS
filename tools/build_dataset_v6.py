#!/usr/bin/env python3
"""Build the v6 LoRA dataset: game dialogue + authored rows -> messages JSONL."""

import hashlib
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "dataset_v6"
SOURCE = Path("/home/andrea/Documenti/factorial-omega-linux-64/extracted_dialogue/conversations.txt")
SYSTEM_PROMPT = (OUT_DIR / "system_prompt.v6.txt").read_text().rstrip()

SEP = "-" * 60

CJK = re.compile(r"[぀-ヿ一-鿿฀-๿Ѐ-ӿ가-힯]")


def parse_blocks(text):
    for block in text.split(SEP):
        turns = []
        for line in block.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("Anon:"):
                turns.append(["user", line[5:].strip()])
            elif line.startswith("Jun:"):
                turns.append(["assistant", line[4:].strip()])
        if turns:
            yield turns


def clean(s):
    s = s.replace("{{wi}}", " ").replace("{f_playerName}", "Anon").replace("{f_botName}", "Jun")
    s = s.replace("’", "'").replace("‘", "'")
    s = re.sub(r"</?[a-z]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()


def has_any(text, words):
    low = text.lower()
    return any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", low) for w in words)


# Side characters and party scenes: in these blocks the "Anon:" prefix is often a third party,
# so the pairs are not Anon<->Jun at all and would teach Jun to answer as someone else.
OTHER_CHARACTERS = ("annalie", "melissa", "sheep", "doctor", "landlord's wife")
# Canon Jun is a service unit; this persona is explicitly never a status readout.
ASSISTANT_TELLS = ("i have no data", "my sensors", "please wait", "defragment", "my databanks",
                   "processing", "my programming", "as an ai", "my primary function",
                   "my core function", "recalibrat", "my systems", "error", "initiat")


def merge(turns):
    out = []
    for role, text in turns:
        text = clean(text)
        if not text:
            continue
        if out and out[-1][0] == role:
            out[-1][1] = (out[-1][1] + " " + text).strip()
        else:
            out.append([role, text])
    return out


SENTENCE = re.compile(r"(?<=[.!?…])\s+")


def shorten(text, target=15, hard=18):
    """Game lines run long; keep the front of the line inside the voice limit."""
    parts = SENTENCE.split(text)
    kept, words = [], 0
    for part in parts:
        n = len(part.split())
        if kept and words + n > target:
            break
        kept.append(part)
        words += n
        if words >= target:
            break
    out = " ".join(kept).strip() or text
    w = out.split()
    if len(w) > hard:
        cut = " ".join(w[:hard])
        clause = max(cut.rfind(","), cut.rfind(" - "), cut.rfind(";"))
        out = (cut[:clause] if clause > 20 else cut).rstrip(",;- ") + "."
    return out


POSITIVE = ("love", "thank", "happy", "glad", "nice", "great", "cute", "beautiful", "proud",
            "good job", "well done", "sweet", "missed you", "i like")
NEGATIVE = ("stupid", "shut up", "useless", "hate", "idiot", "worthless", "junk", "scrap",
            "you're a machine", "just a machine", "sell you", "replace you", "get out",
            "leave me alone", "shut it", "you're not real")
SCARED = ("landlord", "police", "cops", "found out", "reported", "crime", "illegal", "military",
          "someone saw", "knock", "danger", "afraid", "hide")
APOLOGY = ("sorry", "i apologize", "forgive me", "didn't mean")
SILLY = ("lol", "lmao", "haha", "hehe", "heehee", "bonk", "nyaa", "uwu", "beep boop", "blep",
         "weeeee", "wooo", "pffft", "xd", "hehehe", "boop", "meow", "quack", "banana",
         "trick or treat", "dance for me", "do a flip", "say something funny", "silly")
TOUCH = re.compile(r"\*[^*]+\*")

WARM_EMOTES = ["happy", "excited", "laughing"]
SOFT_EMOTES = ["embarrassed", "sad", "pout"]


def sentiment(user_text):
    low = user_text.lower()
    score = 0
    if has_any(low, POSITIVE):
        score += 1
    if has_any(low, NEGATIVE):
        score -= 2
    if has_any(low, APOLOGY):
        score += 1
    return score


def reply_tone(reply):
    low = reply.lower()
    if reply.strip("… .") == "":
        return "silent"
    if any(w in low for w in ("love", "thank", "happy", "!")) and "?" not in reply[:3]:
        return "warm"
    if any(w in low for w in ("no", "don't", "stop", "why would")):
        return "guarded"
    return "neutral"


def place(reply, tags, rng):
    """A tag's position in the text is its timing, so only the face-setting tag belongs up
    front - the rest are dropped in before the word they actually go with."""
    words = reply.split()
    if not words:
        return "".join(tags) + reply
    slots = {}
    for i, tag in enumerate(tags):
        if i == 0 or len(words) < 4:
            slots.setdefault(0, []).append(tag)
            continue
        # Prefer a clause boundary, otherwise somewhere in the back half of the line.
        breaks = [j + 1 for j, w in enumerate(words[:-1]) if w.endswith((",", ".", "!", "?", "…"))]
        pool = [b for b in breaks if b not in slots] or list(range(1, len(words)))
        pool = [p for p in pool if p not in slots] or [len(words) // 2]
        slots.setdefault(rng.choice(pool), []).append(tag)
    out = []
    for i, w in enumerate(words):
        out.extend(slots.get(i, []))
        out.append(w)
    return " ".join(out).replace("] ", "]").replace(" [", " [").strip()


def tag_reply(reply, user_text, rng, gauges):
    """Insert a light garnish of action tags plus the mandatory bookkeeping tag."""
    aff, trust, tens = gauges
    low_user = user_text.lower()
    tone = reply_tone(reply)
    tags = []

    if tone == "silent":
        tags.append("[A:emote|pout]" if aff < 45 else "[A:emote|sad]")
        tags.append("[A:look|away]")
    elif has_any(low_user, NEGATIVE):
        tags.append("[A:emote|angry]" if aff < 50 else "[A:emote|sad]")
        tags.append(rng.choice(["[A:look|away]", "[A:lean|back]", "[A:brow|sad]"]))
    elif has_any(low_user, SCARED):
        tags.append("[A:emote|surprised]")
        tags.append("[A:breath|excited]")
    elif has_any(low_user, SILLY):
        tags.append("[A:emote|%s]" % ("laughing" if aff >= 55 else "smug"))
        if rng.random() < 0.5:
            tags.append(rng.choice(["[A:ear_wiggle]", "[A:tilt_head|right]", "[A:lean|left]"]))
    elif TOUCH.search(user_text):
        tags.append("[A:emote|embarrassed]")
        tags.append("[A:blush|%.1f]" % rng.choice([0.4, 0.5, 0.6, 0.7]))
    elif has_any(low_user, POSITIVE) and aff >= 55:
        tags.append("[A:emote|%s]" % rng.choice(WARM_EMOTES))
        if rng.random() < 0.4:
            tags.append("[A:blush|0.4]")
    elif tone == "warm" and aff >= 55:
        tags.append("[A:emote|%s]" % rng.choice(WARM_EMOTES))
    elif tone == "guarded":
        tags.append("[A:emote|%s]" % rng.choice(SOFT_EMOTES))
    elif rng.random() < 0.55:
        tags.append("[A:emote|%s]" % rng.choice(SOFT_EMOTES + ["surprised", "smug"]))

    if rng.random() < 0.55:
        tags.append(rng.choice(["[A:look_at]", "[A:tilt_head|left]", "[A:tilt_head|right]",
                                "[A:nod]", "[A:shake_head]"]))

    d_aff, d_trust, d_tens = mood_delta(user_text, reply, tone, gauges)
    return place(reply, tags, rng) + "[A:mood_shift|affection=%s|trust=%s|tension=%s]" % (
        fmt(d_aff), fmt(d_trust), fmt(d_tens))


def fmt(n):
    return ("+%d" % n) if n > 0 else str(n)


REASSURING = ("it's fine", "don't worry", "you're safe", "i'm here", "nothing's going to happen",
              "i've got you", "i promise", "trust me", "i'd never")
DISMISSIVE = ("whatever", "forget it", "never mind", "not now", "later", "i don't care",
              "doesn't matter", "drop it", "stop asking", "just do it")
OPENING_UP = ("i've never told anyone", "can i tell you", "the truth is", "i was scared",
              "i need you", "i trust you", "honestly")


def mood_delta(user_text, reply, tone, gauges):
    """Every gauge has to move in both directions or the model learns the tag is decoration."""
    low = user_text.lower()
    aff = trust = tens = 0

    if has_any(low, POSITIVE):
        aff += 1 + (1 if "love" in low else 0)
        tens -= 1
    if has_any(low, NEGATIVE):
        aff -= 2
        trust -= 1
        tens += 2
    if has_any(low, APOLOGY):
        aff += 1
        trust += 1
        tens -= 1
    if has_any(low, SCARED):
        tens += 2
        trust += 1
    if has_any(low, SILLY):
        aff += 1
        tens -= 1
    if any(w in low for w in REASSURING):
        trust += 1
        tens -= 2
    if any(w in low for w in DISMISSIVE):
        # Being brushed off costs him, and it is one of the few things that lowers trust
        # without a fight - v4 never learned any of the downward moves.
        aff -= 1
        trust -= 1
        tens += 1
    if any(w in low for w in OPENING_UP):
        aff += 1
        trust += 2
        tens -= 1
    if TOUCH.search(user_text):
        # Touch always registers - being held is never a null event.
        if gauges[0] < 40:
            aff -= 1
            trust -= 1
            tens += 2
        else:
            aff += 2
            trust += 1
            tens -= 1
    if tone == "silent":
        aff -= 1
        tens += 1
    elif tone == "warm":
        aff += 1
        tens -= 1
    elif tone == "guarded":
        trust -= 1
        tens += 1

    if len(user_text.split()) > 12:
        # He volunteered something rather than grunting at her; that is trust being spent.
        trust += 1
    if len(user_text.split()) <= 3 and not (has_any(low, POSITIVE) or has_any(low, SILLY)
                                            or TOUCH.search(user_text)):
        # Curt, grunted turns cool her off. Without this affection only ever climbs.
        aff -= 1
    if (aff, trust, tens) == (0, 0, 0) and len(reply.split()) >= 4:
        # A real exchange is never a null event. Only a bare acknowledgement stays at zero,
        # which is what keeps the all-zero form in the set without it swallowing everything.
        if tone == "warm":
            aff += 1
        tens -= 1

    clamp = lambda n: max(-5, min(5, n))
    return clamp(aff), clamp(trust), clamp(tens)


def infer_gauges(turns, rng):
    """Gauges are inferred from how Jun already behaves in the scene, never imposed on it."""
    warmth = sum(1 for r, t in turns if r == "assistant" and reply_tone(t) == "warm")
    silence = sum(1 for r, t in turns if r == "assistant" and reply_tone(t) == "silent")
    abuse = sum(1 for r, t in turns if r == "user" and has_any(t, NEGATIVE))
    fear = sum(1 for r, t in turns if r == "user" and has_any(t, SCARED))

    aff = 60 + 12 * warmth - 10 * silence - 18 * abuse
    trust = 60 - 12 * abuse - 6 * silence
    tens = 25 + 18 * fear + 14 * abuse + 6 * silence
    jitter = lambda v: max(2, min(97, v + rng.randint(-8, 8)))
    return jitter(aff), jitter(trust), jitter(tens)


LORE_PATH = ROOT / "lore_dataset.jsonl"
STOP = set("the a an and or but is are was were be been it its this that of to in on at for with "
           "what who how why when where does do did you your i my he she they them his her".split())


def lore_index():
    """api/lore.php injects the answer side of the curated corpus, matched by keyword - so the
    training rows carry real facts picked the same way, not invented ones."""
    out = []
    for line in LORE_PATH.read_text().splitlines():
        if not line.strip():
            continue
        msgs = json.loads(line)["messages"]
        answer = next(m["content"] for m in msgs if m["role"] == "assistant")
        question = next(m["content"] for m in msgs if m["role"] == "user")
        if len(answer) > 220:
            continue
        keys = {w for w in re.findall(r"[a-z]{4,}", (question + " " + answer).lower())} - STOP
        out.append((answer, keys))
    return out


LORE = None


def lore_for(user_text, rng, limit=2):
    global LORE
    if LORE is None:
        LORE = lore_index()
    words = {w for w in re.findall(r"[a-z]{4,}", user_text.lower())} - STOP
    if not words:
        return []
    scored = [(len(words & keys), ans) for ans, keys in LORE]
    hits = sorted((s for s in scored if s[0] >= 2), reverse=True)[:limit]
    return [a for _, a in hits]


JOURNALS = [
    "## Lately\n- 2026-08-04: He came back late and sat with me without saying much, which lately is his version of talking.\n\n## Earlier\n- 2026-07-12: The caretaker asked about the power bill; we have been careful since.",
    "## Lately\n- 2026-06-19: A quiet day, and after this week that is worth writing down on its own.\n- 2026-06-18: He apologised properly, without excuses in it, and asked me to say when he does that again.",
]


def journal_system(rng):
    """chat.php appends the journal to the SYSTEM message, not to live context."""
    return SYSTEM_PROMPT + "\n\n## My journal\n" + rng.choice(JOURNALS)


def live_context(gauges, rng, wardrobe=True, tools_offered=True, lore_facts=()):
    aff, trust, tens = gauges
    parts = []
    if lore_facts:
        parts.append("## World facts (canon)\n" + "\n".join("- " + f for f in lore_facts))
    if rng.random() < 0.5:
        parts.append("## Current date and time\nIt is currently %s." % rng.choice([
            "Tuesday, March 3, 2026 at 9:14 PM CET",
            "Saturday, June 13, 2026 at 11:02 AM CET",
            "Thursday, January 22, 2026 at 2:47 AM CET",
            "Sunday, August 2, 2026 at 6:30 PM CET",
        ]))
    if wardrobe and rng.random() < 0.35:
        parts.append("## Current Wardrobe State\n" + rng.choice([
            "- shirt: on\n- skirt: on\n- shoes: on",
            "- hoodie: on\n- pants: on",
            "- dress: on\n- stockings: on\n- choker: on",
            "- shirt: on\n- panties: on",
        ]))
    parts.append("## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n"
                 "- Affection: %d/100\n- Trust: %d/100\n- Tension: %d/100" % (aff, trust, tens))
    if tools_offered and rng.random() < 0.4:
        parts.append("## Save check\nIf Anon's latest message contains something durable (a preference, "
                     "personal fact, plan, boundary, health/safety matter, or something emotionally "
                     "significant), call memory_write before replying. Otherwise ignore this.")
    return "# Live context for THIS reply (from the system, not spoken by Anon)\n\n" + "\n\n".join(parts)


def build_from_game(rng):
    rows = []
    seen = set()
    for turns in parse_blocks(SOURCE.read_text()):
        turns = merge(turns)
        if len(turns) < 2:
            continue
        while turns and turns[-1][0] != "assistant":
            turns.pop()
        if len(turns) < 2 or turns[0][0] != "user":
            continue
        if sum(len(t.split()) for _, t in turns) > 260:
            continue
        # The file carries translated twins of every scene. Deltas and tags are decided by an
        # English lexicon, so a non-English scene would be labelled neutral no matter what
        # happens in it - language mirroring is taught by the authored rows instead.
        joined = " ".join(t for _, t in turns)
        if CJK.search(joined):
            continue
        if has_any(joined, OTHER_CHARACTERS):
            continue
        low_all = joined.lower()
        if any(w in low_all for w in ASSISTANT_TELLS):
            continue
        key = "|".join(t for _, t in turns)
        if key in seen:
            continue
        seen.add(key)

        gauges = infer_gauges(turns, rng)
        msgs = [{"role": "system",
                 "content": journal_system(rng) if rng.random() < 0.25 else SYSTEM_PROMPT}]
        for i, (role, text) in enumerate(turns):
            if role == "assistant":
                text = tag_reply(shorten(text), turns[i - 1][1], rng, gauges)
            elif i == len(turns) - 2 and rng.random() < 0.6:
                text = text + "\n\n" + live_context(gauges, rng, lore_facts=lore_for(text, rng))
            msgs.append({"role": role, "content": text})
        rows.append({"messages": msgs, "source": "game"})
    return rows


CONSOLIDATION_PHP = ROOT.parent / "webapp/api/_consolidation.php"


def consolidation_prompts():
    """The trainer must see the exact prompts _consolidation.php sends, so lift them from source."""
    src = CONSOLIDATION_PHP.read_text()
    blocks = re.findall(r"<<<'PROMPT'\n(.*?)\nPROMPT;", src, re.S)
    if len(blocks) != 2:
        raise SystemExit("expected 2 heredoc prompts in _consolidation.php, found %d" % len(blocks))
    return {"notes": blocks[0], "journal": blocks[1]}


def build_consolidation():
    cases = json.loads((OUT_DIR / "consolidation_cases.json").read_text())
    prompts = consolidation_prompts()
    rows = []
    for case in cases:
        msgs = [{"role": "system", "content": prompts[case["kind"]]},
                {"role": "user", "content": case["input"]}]
        for step in case["steps"]:
            msgs.append({"role": "assistant", "content": "",
                         "tool_calls": [{"type": "function", "function": {
                             "name": step["name"],
                             "arguments": json.dumps(step.get("args", {}), ensure_ascii=False)}}]})
            msgs.append({"role": "tool", "name": step["name"],
                         "content": json.dumps(step.get("result", {"ok": True}), ensure_ascii=False)})
        rows.append({"messages": msgs, "source": "consolidation-" + case["kind"], "case": case})
    return rows


def main():
    rng = random.Random(20260806)
    rows = build_from_game(rng)

    authored = []
    for authored_path in sorted(OUT_DIR.glob("authored*.jsonl")):
        for line in authored_path.read_text().splitlines():
            line = line.strip()
            if line:
                obj = json.loads(line)
                if obj["messages"][0]["role"] != "system":
                    obj["messages"].insert(0, {"role": "system", "content": SYSTEM_PROMPT})
                elif obj["messages"][0]["content"] == "@V6":
                    obj["messages"][0]["content"] = SYSTEM_PROMPT
                authored.append(obj)

    rows.extend(authored)
    rows.extend(build_consolidation())
    rows = add_thinking(rows, rng)
    rng.shuffle(rows)

    out = OUT_DIR / "train.jsonl"
    with out.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    by_source = {}
    for r in rows:
        by_source[r.get("source", "?")] = by_source.get(r.get("source", "?"), 0) + 1
    hand = 0
    for r in rows:
        for i, m in enumerate(r["messages"]):
            if not m.get("reasoning"):
                continue
            user = next((x["content"] for x in reversed(r["messages"][:i])
                         if x["role"] == "user"), "")
            if trace_key(user, m.get("content", "")) in MANUAL_USED:
                hand += 1
            break
    print("wrote %s: %d rows (%d hand-written traces, %d generated)"
          % (out, len(rows), hand, len(rows) - hand))
    for k, v in sorted(by_source.items()):
        print("  %-14s %d" % (k, v))



# --- reasoning traces -------------------------------------------------------
# The trace only ever sits on the final assistant turn of a sequence: earlier turns must
# carry the visible answer alone, so multi-turn scenes are expanded into prefixes instead
# of stacking thoughts.
#
# The trace goes in a separate `reasoning` field, never inline in content. Gemma 4's chat
# template renders that field as <|channel>thought ... <channel|>, which is what llama.cpp's
# gemma4 parser splits on. v6 wrote literal <|think|>...</|think|> into content instead;
# `</|think|>` is not in the vocab at all, so the model learned a closer it could never emit
# as a token and llama.cpp could never parse. Do not reintroduce inline tags.


def set_think(msg, trace):
    msg["reasoning"] = trace.strip()
    return msg


def gauge_read(gauges, rng):
    aff, trust, tens = gauges
    bits = []
    if aff < 25:
        bits.append(rng.choice([
            "Affection %d. I don't have warmth in me for him right now and faking it would be the polite-assistant thing, not mine." % aff,
            "Affection is down at %d - whatever he wants, he isn't getting the soft version of me." % aff]))
    elif aff > 70:
        bits.append(rng.choice([
            "Affection %d, so I'm not going to hide what this does to me." % aff,
            "Affection sits at %d. I can let him see it." % aff]))
    if trust < 25:
        bits.append(rng.choice([
            "Trust %d - I don't take what he says at face value tonight." % trust,
            "Trust is %d, so I want the rest of it before I agree to anything." % trust]))
    elif trust > 70:
        bits.append("Trust %d, so I can say the true thing instead of the safe one." % trust)
    if tens > 65:
        bits.append(rng.choice([
            "Tension %d means I'm braced, not sad - that comes out sharp, not weepy." % tens,
            "Tension %d. I'm wound up and it will show in how fast I answer." % tens]))
    elif tens < 25:
        bits.append("Tension %d, nothing in the room to flinch at." % tens)
    return " ".join(bits)


def cue_read(user_text, rng, gauges):
    low = user_text.lower()
    if TOUCH.search(user_text):
        return rng.choice([
            "He's touching me, right now, not describing it - that always registers whichever way I feel about him.",
            "That's his hand on me in the moment. Being touched is never nothing, even when I'm angry."])
    if has_any(low, NEGATIVE):
        return rng.choice([
            "That was meant to land. He knows exactly which words do it.",
            "He's reaching for the thing that makes me smaller. Again."])
    if has_any(low, SCARED):
        return rng.choice([
            "That's the outside getting close to us. Everything else can wait.",
            "This is the kind of thing that ends with me in a van, so I'm listening properly."])
    if has_any(low, APOLOGY):
        return rng.choice([
            "An apology. The question is whether it's the kind with excuses in it.",
            "He's saying sorry. Whether it counts depends on what he does after."])
    if has_any(low, SILLY):
        return rng.choice([
            "He's being an idiot on purpose, which means he wants me to play.",
            "That's him clowning. He wants me to hit it back, not analyse it."])
    if has_any(low, POSITIVE):
        return rng.choice([
            "That's him being kind without being asked to be.",
            "He said something warm and didn't want anything for it."])
    if any(w in low for w in VENTING):
        return rng.choice([
            "He's bringing me something heavy. He doesn't do that with anyone else.",
            "That's him admitting the day went badly, which for him is a lot of words."])
    if any(w in low for w in DISMISSIVE):
        return "He's shutting the door on it. That costs him something with me whether he means it to or not."
    if any(w in low for w in REASSURING):
        return "He's trying to settle me. It half works, which is more than usual."
    if any(w in low for w in OPENING_UP):
        return "He's handing me something he doesn't hand to people."
    if low.endswith("?"):
        return rng.choice([
            "A straight question. He wants an answer, not a performance.",
            "He's asking, so the honest version is the one he gets."])
    return rng.choice([
        "Ordinary turn. He's just talking to me.",
        "Nothing loaded in that - he's making conversation.",
        "Small thing, but he brought it to me rather than sitting with it."])


VENTING = ("rough day", "bad day", "long day", "exhausted", "knackered", "stressed",
           "I'm tired", "worn out", "had enough", "shattered")

EMOTE_WHY = {
    "angry": "so the face goes angry from the first word",
    "sad": "so it's the sad face, not the sharp one",
    "crying": "and I'm not going to be able to keep it off my face",
    "pout": "so I let it show as sulk rather than a fight",
    "embarrassed": "and it gets to my face before I can stop it",
    "happy": "so I let it show",
    "excited": "so it comes out too fast and too pleased",
    "laughing": "so I laugh at him properly",
    "smug": "so I take it dry instead",
    "surprised": "and it catches me before I've decided how to feel",
}


def spoken(user_text):
    """The live-context block is appended to his turn but he never said it - reading cues out
    of it produced traces that reacted to the lore bullets."""
    return user_text.split("\n\n# Live context")[0].strip()


def think_chat(user_text, visible, gauges, deltas, rng, has_gauges):
    user_text = spoken(user_text)
    aff, trust, tens = deltas
    emote = re.search(r"\[A:emote\|([a-z]+)\]", visible)
    second = re.findall(r"\[A:(look|lean|nod|shake_head|blush|brow|breath|slap|outfit|tilt_head|look_at|ear_wiggle)[\|\]]", visible)
    lines = [cue_read(user_text, rng, gauges)]
    if has_gauges:
        g = gauge_read(gauges, rng)
        if g:
            lines.append(g)
    if emote:
        lines.append("That's %s, %s." % (
            {"angry": "anger", "sad": ("tenderness" if aff > 0 else "hurt"),
             "crying": "too much", "pout": "sulking",
             "embarrassed": "flustered", "happy": "gladness", "excited": "eagerness",
             "laughing": "funny", "smug": "amusing", "surprised": "a shock",
             "sleepy": "slow"}.get(emote.group(1), "something"),
            EMOTE_WHY.get(emote.group(1), "so the face follows it")))
    if len(second) > 1:
        lines.append(rng.choice([
            "The second beat lands mid-line, on the word it belongs to - the timing is the point.",
            "I put the smaller movement where the words turn, not all of it up front."]))
    if len(user_text.split()) <= 3 and aff < 0:
        lines.append(rng.choice([
            "Two words and my name. He does that when he wants me available but not present.",
            "That's the clipped version of him. It's small, but it takes something out of me."]))
    moves = []
    for name, v in (("affection", aff), ("trust", trust), ("tension", tens)):
        if v:
            moves.append("%s %s%d" % (name, "+" if v > 0 else "", v))
    lines.append(("Nothing between us actually moved, so all three stay at zero."
                  if not moves else "So: " + ", ".join(moves) + "."))
    return " ".join(lines)


CONSOL_VERB = {"save_note": "that's worth keeping", "revise_note": "that one needs rewriting",
               "forget_note": "that one goes", "recategorize_note": "that's filed wrong",
               "journal_write": "today gets its entry", "journal_revise": "that one has aged and needs squeezing",
               "journal_forget": "that one shouldn't stay"}


def think_consolidation(case, rng):
    kind = case["kind"]
    steps = [s["name"] for s in case["steps"] if s["name"] != "finish_up"]
    if not steps:
        return ("Nothing in this lot is a fact about him - it's just us talking. Notes I already have "
                "cover it and none of them are wrong now, so I touch nothing and finish up."
                if kind == "notes" else
                "Whatever happened since still needs today's line, even if the day was quiet. "
                "Nothing older has aged enough to need squeezing, so that's all and I finish up.")
    opener = ("Going back over what we said, looking for the things about him that slipped past me."
              if kind == "notes" else
              "What's near stays sharp, what's far goes soft. Today first, then whatever has aged.")
    body = []
    for s in case["steps"]:
        if s["name"] == "finish_up":
            continue
        if s.get("result", {}).get("error"):
            body.append("If that comes back refused I don't push it - I work with what it lets me do.")
        else:
            body.append("%s: %s." % (s["name"].replace("_", " "), CONSOL_VERB.get(s["name"], "handle that")))
    tail = ("Everything I don't call a tool on is kept exactly as it is, so I only touch what needs it, "
            "then finish_up.")
    return " ".join([opener] + body + [tail])


TRACES_PATH = OUT_DIR / "traces.jsonl"
MANUAL = None
MANUAL_USED = set()


def trace_key(user_text, visible):
    raw = spoken(user_text).strip() + "\x00" + visible.strip()
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def manual_trace(user_text, visible):
    global MANUAL
    if MANUAL is None:
        MANUAL = {}
        if TRACES_PATH.exists():
            for line in TRACES_PATH.read_text().splitlines():
                if line.strip():
                    rec = json.loads(line)
                    MANUAL[rec["key"]] = rec["think"]
    k = trace_key(user_text, visible)
    if k in MANUAL:
        MANUAL_USED.add(k)
    return MANUAL.get(k)


GAUGE_RE = re.compile(r"Affection: (\d+)/100\n- Trust: (\d+)/100\n- Tension: (\d+)/100")
MOOD_RE = re.compile(r"\[A:mood_shift\|affection=([+-]?\d)\|trust=([+-]?\d)\|tension=([+-]?\d)\]")


def add_thinking(rows, rng, max_prefixes=1):
    """Every sequence ends on a reasoned turn, carrying the trace on that turn alone - a trace
    may never sit in the history. One row per scene: expanding into prefixes would feed the model
    near-duplicate sequences and weight multi-turn scenes several times over."""
    out = []
    for row in rows:
        msgs = row["messages"]
        if row["source"].startswith("consolidation"):
            for m in msgs:
                if m["role"] == "assistant" and m.get("tool_calls"):
                    case = row["case"]
                    set_think(m, case.get("think") or think_consolidation(case, rng))
                    break
            row.pop("case", None)
            out.append(row)
            continue

        ends = [i for i, m in enumerate(msgs)
                if m["role"] == "assistant" and m.get("content") and not m.get("tool_calls")]
        if not ends:
            # stay_silent / flee end the turn with the call itself.
            for m in msgs:
                if m.get("tool_calls"):
                    name = m["tool_calls"][0]["function"]["name"]
                    user_text = spoken(next(x["content"] for x in msgs if x["role"] == "user"))
                    trace = manual_trace(next(x["content"] for x in msgs if x["role"] == "user"),
                                         m["content"])
                    set_think(m, trace or
                        "%s %s" % (cue_read(user_text, rng, (50, 50, 50)),
                                   "Talking now is the thing that gets me found, so I go quiet and call stay_silent."
                                   if name == "stay_silent" else
                                   "Staying in this room is the risk, so I move first and call flee."))
                    break
            out.append(row)
            continue
        for idx in ends[-max_prefixes:]:
            prefix = [dict(m) for m in msgs[:idx + 1]]
            last = prefix[-1]
            user_text = next((m["content"] for m in reversed(prefix[:-1]) if m["role"] == "user"), "")
            g = GAUGE_RE.search(user_text)
            gauges = tuple(int(x) for x in g.groups()) if g else (55, 55, 40)
            d = MOOD_RE.search(last["content"])
            deltas = tuple(int(x) for x in d.groups()) if d else (0, 0, 0)
            trace = manual_trace(user_text, last["content"])
            called = [m["name"] for m in prefix if m["role"] == "tool"]
            if trace is None:
                trace = think_chat(user_text, last["content"], gauges, deltas, rng, bool(g))
                if called:
                    trace = ("I already reached for %s and it came back, so this reply is built on "
                             "what it gave me rather than on a guess. " % called[-1]) + trace
            set_think(last, trace)
            out.append({"messages": prefix, "source": row["source"]})
    return out


if __name__ == "__main__":
    sys.exit(main())
