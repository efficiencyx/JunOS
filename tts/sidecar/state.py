import gc
import logging
import os
import shutil
import threading
import time

from .config import ALL_ENGINES, DEFAULT_ENGINE, REAP_INTERVAL_S, SEP_TTL_S, TTS_IDLE_UNLOAD_S

log = logging.getLogger("tts")

# every model handle lives here and ONLY unload() below empties
# them. the loaders in tts.py and karaoke.py fill them in. whisper
# isn't here, it never gets unloaded.
pipeline = None
pocket_model = None
pocket_lang = None
pocket_states = {}
separator = None

# lock covers everything in this module. the reaper unloads only
# at inflight == 0. Never while a synth has the model.
lock = threading.RLock()
inflight = 0
active_engine = DEFAULT_ENGINE
last_used = time.monotonic()
sep_tokens = {}
stt_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("STT_MAX_CONCURRENT", "1"))))
sep_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("SEP_MAX_CONCURRENT", "1"))))
# without a cap every /tts request gets a thread and they all run
# the model at once. js/voice/tts.js keeps 3 in flight per reply,
# so 2 running plus a short wait line covers one user, and a
# second user's burst gets a 429 instead of an unbounded pile.
tts_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("TTS_MAX_CONCURRENT", "2"))))


def loaded_engines():
    live = []
    if pipeline is not None: live.append("kokoro")
    if pocket_model is not None: live.append("pockettts")
    if separator is not None: live.append("demucs")
    return live


def free_torch():
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def unload(names):
    # caller holds lock. drops the model refs, then gc and
    # empty_cache hand the VRAM back.
    global pipeline, pocket_model, pocket_lang, pocket_states, separator
    freed = []
    for name in names:
        if name == "kokoro" and pipeline is not None:
            pipeline = None; freed.append(name)
        elif name == "pockettts" and pocket_model is not None:
            pocket_model = None; pocket_lang = None; pocket_states = {}; freed.append(name)
        elif name == "demucs" and separator is not None:
            separator = None; freed.append(name)
    if freed:
        free_torch()
        log.info("unloaded engine(s): %s", ", ".join(freed))


def begin_use(engine):
    global active_engine, last_used, inflight
    with lock:
        # only reclaim on a real switch with nothing running. chunks
        # in the middle of a reply on the same engine must not unload.
        if inflight == 0 and engine != active_engine:
            unload([e for e in ALL_ENGINES if e != engine])
        active_engine = engine
        last_used = time.monotonic()
        inflight += 1


def end_use():
    global inflight, last_used
    with lock:
        inflight = max(0, inflight - 1)
        last_used = time.monotonic()


def reset_idle_clock():
    global last_used
    last_used = time.monotonic()


def sweep_sep_tokens():
    now = time.monotonic()
    with lock:
        dead = [sep_tokens.pop(t)["dir"] for t, info in list(sep_tokens.items())
                if now - info["created_at"] >= SEP_TTL_S]
    for d in dead:
        shutil.rmtree(d, ignore_errors=True)


def reaper():
    while True:
        time.sleep(REAP_INTERVAL_S)
        sweep_sep_tokens()
        if TTS_IDLE_UNLOAD_S <= 0:
            continue
        with lock:
            if inflight == 0 and loaded_engines() and \
                    (time.monotonic() - last_used) >= TTS_IDLE_UNLOAD_S:
                unload(list(ALL_ENGINES))
