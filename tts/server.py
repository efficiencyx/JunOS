"""
local audio sidecar on :8001. /tts takes one sentence at a time
from js/tts.js and returns a WAV for its AudioContext.

`engine` picks kokoro (Kokoro-82M, the default, needs
espeak-ng) or pockettts (kyutai-labs pocket-tts, 100M, CPU,
English + 5 languages). /voices lists voices and pocket-tts
languages for the picker. js/voice.js sends a raw WAV to /stt,
where faster-whisper transcribes it.

/separate uses htdemucs to split backing and guide vocals.
/transcribe_timed uses whisper to time the words. Docker runs
this half in docker/karaoke.Dockerfile with
SIDECAR_ROLE=karaoke, so it can use GPU torch while voice stays
on CPU. each image has only its own deps. _available() probes
make missing ones return 503. bare metal runs one process for
both roles.

PHP uses TTS_URL to reach the `tts` compose service.
KOKORO_URL still works for older .env files.
Run: python server.py
"""

import gc
import hmac
import io
import json
import logging
import os
import secrets
import shutil
import tempfile
import threading
import time
from typing import Annotated

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, StringConstraints

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tts")

KOKORO_SAMPLE_RATE = 24000
KOKORO_DEFAULT = "af_heart"

# Kokoro-82M's EN voices. some are trained way better than
# others, all load fine.
KOKORO_VOICES = [
    "af_heart", "af_bella", "af_aoede", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "af_alloy", "af_jessica",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
]

# pocket-tts voice names pick timbre, not language. each has an
# embedding for every POCKET_LANGUAGES entry. giovanni, lola,
# juergen, rafael and estelle retain their non-English speakers'
# accents.
POCKET_DEFAULT = "eve"
POCKET_VOICES = [
    "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette",
    "eponine", "eve", "fantine", "george", "jane", "jean", "javert", "marius",
    "mary", "michael", "paul", "peter_yearsley", "stuart_bell", "vera",
    "giovanni", "lola", "juergen", "rafael", "estelle",
]

# language selects weights via load_model(language=...). offer
# upstream configs only. french, spanish and german _24l builds
# have 24 layers. id selects the model, label is UI text.
POCKET_DEFAULT_LANG = "english"
POCKET_LANGUAGES = [
    {"id": "english", "label": "English"},
    {"id": "french_24l", "label": "French"},
    {"id": "german_24l", "label": "German"},
    {"id": "italian", "label": "Italian"},
    {"id": "portuguese", "label": "Portuguese"},
    {"id": "spanish_24l", "label": "Spanish"},
]
POCKET_LANG_IDS = frozenset(lang["id"] for lang in POCKET_LANGUAGES)

DEFAULT_ENGINE = "kokoro"
TTS_ENGINES = ("kokoro", "pockettts")

# tts | karaoke. this ONLY changes the pre-warm at startup and
# what /health says. every route is mounted in both roles and
# 503s when the thing it needs isn't there.
SIDECAR_ROLE = os.environ.get("SIDECAR_ROLE", "tts").strip().lower()

# "demucs" is a FAKE engine. it's not a TTS voice, but shoving it
# in the same lifecycle lets a separation job kick the TTS
# engines out while it runs, and vice versa, and it holds
# _inflight so the reaper can't yank a model out from under a
# running job.
_ALL_ENGINES = TTS_ENGINES + ("demucs",)

# keep one TTS engine loaded. switching drops the others. idle
# unloading uses this timeout, 0 disables it. cold reloads from
# HF_HOME take a few seconds.
TTS_IDLE_UNLOAD_S = float(os.environ.get("TTS_IDLE_UNLOAD_S", "180"))
_REAP_INTERVAL_S = 20.0

# cap on the /stt request body. 16kHz mono PCM16 is ~32KB/s so
# 4MB is roughly 2min of audio. one of a whole chain of caps,
# api/stt.php lists them all.
STT_MAX_BYTES = 4 * 1024 * 1024
STT_MAX_DURATION_S = float(os.environ.get("STT_MAX_DURATION_S", "120"))

# empty string means detect it per utterance, which costs another
# decode pass and is shaky under ~2s of audio. so just name the
# language when you know it. must agree with STT_MODEL,
# docker/tts.Dockerfile explains the pairing.
STT_LANG = (os.environ.get("STT_LANG", "").strip().lower() or None)

# karaoke sends WHOLE SONGS, not utterances, so it gets its own
# much bigger cap. the stems we split out sit in a temp dir per
# token and go away once both have been fetched, or after this
# TTL when a client just never comes back.
SEP_MAX_BYTES = 50 * 1024 * 1024
SEP_TTL_S = 15 * 60
# how many split songs sit on disk waiting to be fetched. each is
# two full-length wavs (~100MB a song), and /tmp is a 1g tmpfs in
# compose. past this the oldest one goes.
SEP_MAX_JOBS = max(1, int(os.environ.get("SEP_MAX_JOBS", "4")))
SEP_MAX_DURATION_S = float(os.environ.get("SEP_MAX_DURATION_S", "900"))

_pipeline = None
_pocket_model = None
_pocket_lang = None
_pocket_states = {}
# serialises the pocket loads so a /warm preload and a synth at
# the same time can't both pull a checkpoint. held for the whole
# multi second load, so the second caller just waits and reuses
# the result instead of redoing all of it.
_pocket_load_lock = threading.Lock()

# _lock covers these globals too. the reaper unloads ONLY at
# _inflight == 0. Never while a synth has the model.
_lock = threading.RLock()
_inflight = 0
_active_engine = DEFAULT_ENGINE
_last_used = time.monotonic()
_whisper = None
_stt_ok = None
_device = None
_separator = None
_sep_ok = None
_sep_tokens = {}
_stt_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("STT_MAX_CONCURRENT", "1"))))
_sep_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("SEP_MAX_CONCURRENT", "1"))))
# /tts used to have no cap at all, every request got a thread and
# they all ran the model at once. js/tts.js keeps 3 in flight per
# reply, so 2 running plus a short wait line covers one user and
# a second user's burst gets a 429 instead of an unbounded pile.
_tts_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("TTS_MAX_CONCURRENT", "2"))))
TTS_MAX_QUEUE = max(0, int(os.environ.get("TTS_MAX_QUEUE", "8")))
TTS_QUEUE_WAIT_S = float(os.environ.get("TTS_QUEUE_WAIT_S", "30"))
_tts_waiting = 0

# only PHP talks to this thing. the browser never does, it goes
# through api/tts.php and friends, which hold the session check
# and the rate limiter. so a request straight from a browser
# (Origin or Sec-Fetch-Site set) is wrong by definition and gets
# a 403 whatever else it carries. SIDECAR_SECRET is the shared
# header PHP sends, start.sh/start.ps1/colab mint one. empty
# means an old .env or a hand-rolled compose, we log it once and
# fall back to the Host allowlist alone.
SIDECAR_SECRET = os.environ.get("SIDECAR_SECRET", "").strip()
SIDECAR_ALLOWED_HOSTS = {
    h.strip().lower() for h in os.environ.get(
        "SIDECAR_ALLOWED_HOSTS", "localhost,127.0.0.1,::1,tts,karaoke").split(",")
    if h.strip()}
# what each POST route takes in its body. anything else is a 415
# before the body gets read.
_RAW_AUDIO_PATHS = {"/stt", "/separate", "/transcribe_timed"}
_JSON_PATHS = {"/tts", "/warm", "/separate/stem"}
JSON_MAX_BYTES = 16 * 1024


class AudioDurationExceeded(Exception):
    pass


def get_device():
    # TTS_DEVICE: cpu | cuda | auto. auto is the runtime default.
    # it takes CUDA when the wheel has it, including ROCm through
    # torch.cuda. the voice image ships CPU torch. only karaoke
    # gets GPU torch from the nvidia and amd compose overlays.
    # a custom voice build can override TTS_TORCH_INDEX.
    global _device
    if _device is None:
        choice = os.environ.get("TTS_DEVICE", "auto").strip().lower()
        if choice in ("cpu", "cuda"):
            _device = choice
        else:
            # torch.cuda.is_available() is NOT enough on ROCm. it happily says
            # True on cards whose gfx arch has no kernels shipped, which is
            # most consumer RDNA without HSA_OVERRIDE_GFX_VERSION, and then the
            # first real kernel dies with "HIP error: invalid device function".
            # so we run a tiny matmul and let "auto" fall back to cpu instead
            # of nuking every request.
            try:
                import torch
                if torch.cuda.is_available():
                    t = torch.ones(8, 8, device="cuda")
                    (t @ t).sum().item()
                    _device = "cuda"
                else:
                    _device = "cpu"
            except Exception as e:
                log.warning("GPU unusable (%s); falling back to CPU. On AMD consumer "
                            "cards, try setting HSA_OVERRIDE_GFX_VERSION (e.g. 10.3.0 "
                            "for RDNA2, 11.0.0 for RDNA3).", e)
                _device = "cpu"
        log.info("TTS device: %s (TTS_DEVICE=%s)", _device, choice)
    return _device


def get_sep_device():
    # SEP_DEVICE: cpu | cuda | auto. this one stays dumb, unlike
    # get_device(). a separation job is ONE big call, so a bad GPU
    # just falls back per job in _apply_demucs and we don't need to
    # probe anything here.
    choice = os.environ.get("SEP_DEVICE", "auto").strip().lower()
    if choice in ("cpu", "cuda"):
        return choice
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def get_pipeline():
    # loaded late so a failure at import (missing espeak-ng,
    # whatever) is clear
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        device = get_device()
        log.info("loading Kokoro pipeline (lang_code='a' / American English) on %s...", device)
        _pipeline = KPipeline(lang_code="a", device=device)
        log.info("Kokoro ready.")
    return _pipeline


def get_pocket_model(language=POCKET_DEFAULT_LANG):
    # load weights into HF_HOME only when selected. changing language
    # reloads the single checkpoint and clears its per-language voice
    # states.
    global _pocket_model, _pocket_lang, _pocket_states
    with _pocket_load_lock:
        if _pocket_model is not None and _pocket_lang != language:
            _pocket_model = None
            _pocket_states = {}
            _free_torch()
        if _pocket_model is None:
            import inspect
            from pocket_tts import TTSModel
            device = get_device()
            # not every pocket-tts release takes a `device` kwarg, so only
            # pass it when the signature actually has one, otherwise load
            # first and then .to(device).
            device_via_kwarg = "device" in inspect.signature(TTSModel.load_model).parameters
            kwargs = {"language": language}
            if device_via_kwarg:
                kwargs["device"] = device
            log.info("loading pocket-tts model (%s) on %s...", language, device)
            _pocket_model = TTSModel.load_model(**kwargs)
            _pocket_lang = language
            if not device_via_kwarg and device != "cpu" and hasattr(_pocket_model, "to"):
                try:
                    _pocket_model.to(device)
                except Exception:
                    log.warning("pocket-tts: could not move model to %s; using its default device", device)
            log.info("pocket-tts ready (lang=%s sample_rate=%s).", language, _pocket_model.sample_rate)
    return _pocket_model


def _stt_available():
    global _stt_ok
    if _stt_ok is None:
        try:
            import faster_whisper  # noqa: F401
            _stt_ok = True
        except Exception:
            log.warning("faster-whisper not installed; /stt disabled")
            _stt_ok = False
    return _stt_ok


def get_whisper():
    # load whisper into HF_HOME on first use, not prewarm(), to avoid
    # the boot healthcheck deadline. first transcription costs ~1-2s.
    # CTranslate2 (whisper's runtime) and torch each default to one
    # thread per core. cap cpu_threads here and torch via
    # OMP_NUM_THREADS in tts.Dockerfile to avoid oversubscription.
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        model = os.environ.get("STT_MODEL", "base")
        compute = os.environ.get("STT_COMPUTE", "int8")
        threads = int(os.environ.get("OMP_NUM_THREADS", "4"))
        # STT_DEVICE, NOT TTS_DEVICE. whisper runs on CTranslate2, so the
        # device that suits Kokoro does not carry over.
        # docker/tts.Dockerfile has the cuDNN/ROCm reasons it defaults to
        # cpu.
        device = os.environ.get("STT_DEVICE", "cpu").strip().lower()
        if device not in ("cpu", "cuda"):
            device = "cpu"
        if device == "cpu" and compute not in ("int8", "float32"):
            log.info("STT: compute_type=%s unsupported on CPU, using int8", compute)
            compute = "int8"
        if model.endswith(".en") and STT_LANG not in (None, "en"):
            # guard against silent garbage. an English only model asked for
            # another language doesn't error, it just writes nonsense.
            log.warning("STT: model %s is English-only but STT_LANG=%s; "
                        "use a multilingual model (e.g. %s) or set STT_LANG=en",
                        model, STT_LANG, model[:-3])
        log.info("loading faster-whisper (%s, %s, lang=%s) on %s...",
                 model, compute, STT_LANG or "auto", device)
        _whisper = WhisperModel(model, device=device, compute_type=compute,
                                cpu_threads=threads, num_workers=1)
        log.info("faster-whisper ready.")
    return _whisper


def _sep_available():
    global _sep_ok
    if _sep_ok is None:
        try:
            import demucs  # noqa: F401
            _sep_ok = True
        except Exception:
            log.warning("demucs not installed; /separate disabled")
            _sep_ok = False
    return _sep_ok


def get_separator():
    # late, like the TTS engines. the htdemucs weights (~80MB) land
    # in HF_HOME on the first call. the model then moves onto
    # whatever device _apply_demucs picks for that job.
    global _separator
    if _separator is None:
        from demucs.pretrained import get_model
        device = get_sep_device()
        log.info("loading Demucs (htdemucs) on %s...", device)
        _separator = get_model("htdemucs")
        _separator.to(device)
        _separator.eval()
        log.info("Demucs ready (sources=%s, sr=%s).", _separator.sources, _separator.samplerate)
    return _separator


def pocket_state(model, voice):
    state = _pocket_states.get(voice)
    if state is None:
        state = model.get_state_for_audio_prompt(voice)
        _pocket_states[voice] = state
    return state


def _loaded_engines():
    live = []
    if _pipeline is not None: live.append("kokoro")
    if _pocket_model is not None: live.append("pockettts")
    if _separator is not None: live.append("demucs")
    return live


def _free_torch():
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _unload(names):
    # caller holds _lock. drops the model refs, then gc and
    # empty_cache hand the VRAM back.
    global _pipeline, _pocket_model, _pocket_lang, _pocket_states, _separator
    freed = []
    for name in names:
        if name == "kokoro" and _pipeline is not None:
            _pipeline = None; freed.append(name)
        elif name == "pockettts" and _pocket_model is not None:
            _pocket_model = None; _pocket_lang = None; _pocket_states = {}; freed.append(name)
        elif name == "demucs" and _separator is not None:
            _separator = None; freed.append(name)
    if freed:
        _free_torch()
        log.info("unloaded engine(s): %s", ", ".join(freed))


def _begin_use(engine):
    global _active_engine, _last_used, _inflight
    with _lock:
        # only reclaim on a REAL switch with nothing running. chunks in the
        # middle of a reply on the same engine must not trigger an unload.
        if _inflight == 0 and engine != _active_engine:
            _unload([e for e in _ALL_ENGINES if e != engine])
        _active_engine = engine
        _last_used = time.monotonic()
        _inflight += 1


def _end_use():
    global _inflight, _last_used
    with _lock:
        _inflight = max(0, _inflight - 1)
        _last_used = time.monotonic()


def _sweep_sep_tokens():
    now = time.monotonic()
    with _lock:
        dead = [_sep_tokens.pop(t)["dir"] for t, info in list(_sep_tokens.items())
                if now - info["created_at"] >= SEP_TTL_S]
    for d in dead:
        shutil.rmtree(d, ignore_errors=True)


def _reaper():
    while True:
        time.sleep(_REAP_INTERVAL_S)
        _sweep_sep_tokens()
        if TTS_IDLE_UNLOAD_S <= 0:
            continue
        with _lock:
            if _inflight == 0 and _loaded_engines() and \
                    (time.monotonic() - _last_used) >= TTS_IDLE_UNLOAD_S:
                _unload(list(_ALL_ENGINES))


app = FastAPI()


class BodyTooLarge(Exception):
    pass


# counts while the bytes come in, so a 2GB upload stops at the
# cap instead of sitting in RAM first and getting measured after.
async def read_body(request, limit):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise BodyTooLarge
    chunks = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise BodyTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


def _host_name(value):
    host = value.strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _gate(request):
    if request.url.path == "/health":
        return None
    if "origin" in request.headers or "sec-fetch-site" in request.headers:
        return "browser_not_allowed"
    if _host_name(request.headers.get("host", "")) not in SIDECAR_ALLOWED_HOSTS:
        return "bad_host"
    if SIDECAR_SECRET and not hmac.compare_digest(
            request.headers.get("x-sidecar-secret", ""), SIDECAR_SECRET):
        return "bad_secret"
    if request.method == "POST":
        ct = request.headers.get("content-type", "").split(";")[0].strip().lower()
        path = request.url.path
        if path in _RAW_AUDIO_PATHS and not (ct.startswith("audio/") or ct == "application/octet-stream"):
            return "unsupported_media_type"
        if path in _JSON_PATHS and ct != "application/json":
            return "unsupported_media_type"
    return None


@app.middleware("http")
async def gate(request: Request, call_next):
    # runs BEFORE any handler reads the body, so a rejected request
    # costs a header parse and nothing else
    why = _gate(request)
    if why is not None:
        log.warning("refused %s %s: %s", request.method, request.url.path, why)
        status = 415 if why == "unsupported_media_type" else 403
        return JSONResponse({"error": why}, status_code=status)
    return await call_next(request)


@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
    # anything left becomes a plain 500. NEVER leak a traceback.
    log.exception("unhandled exception on %s %s", request.method, request.url.path)
    path = request.url.path
    if path in ("/stt", "/transcribe_timed"):
        err = "transcription_failed"
    elif path.startswith("/separate"):
        err = "separation_failed"
    else:
        err = "synthesis_failed"
    return JSONResponse({"error": err}, status_code=500)


class TTSReq(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    voice: str = KOKORO_DEFAULT
    # speed only does anything on Kokoro, pocket-tts generate_audio
    # has no rate
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    engine: str = DEFAULT_ENGINE
    # pocket-tts only. Kokoro ignores it, it speaks american english
    # and that's that.
    lang: str = POCKET_DEFAULT_LANG


class WarmReq(BaseModel):
    lang: str = POCKET_DEFAULT_LANG
    voice: str = POCKET_DEFAULT
    engine: str = "pockettts"


@app.on_event("startup")
def prewarm():
    # say one tiny thing with Kokoro up front so the first real
    # request doesn't eat the cost of the pipeline plus the default
    # voice starting cold. pocket-tts just warms up on its own first
    # request instead.
    global _last_used
    if not SIDECAR_SECRET:
        log.warning("SIDECAR_SECRET is empty, only the Host allowlist (%s) stands "
                    "between this port and anyone who can reach it",
                    ",".join(sorted(SIDECAR_ALLOWED_HOSTS)))
    if SIDECAR_ROLE != "karaoke":
        try:
            for _gs, _ps, _audio in get_pipeline()("Hi.", voice=KOKORO_DEFAULT, speed=1.0):
                pass
            log.info("pre-warm done (engine=kokoro voice=%s)", KOKORO_DEFAULT)
        except Exception:
            log.exception("pre-warm failed (non-fatal)")

    # start the idle clock NOW, so the time prewarm took doesn't
    # count against it
    _last_used = time.monotonic()
    # ALWAYS, no condition. the reaper also clears out expired
    # separation tokens, and those need cleaning even when idle
    # unloading is off.
    threading.Thread(target=_reaper, name="tts-reaper", daemon=True).start()
    log.info("sidecar role: %s", SIDECAR_ROLE)
    if TTS_IDLE_UNLOAD_S > 0:
        log.info("model reaper on: idle unload after %.0fs", TTS_IDLE_UNLOAD_S)


@app.get("/health")
def health():
    # `stt` lets the webapp hide the mic button when this build has
    # no whisper, instead of face planting on the first thing you
    # say. it reports whether we can IMPORT it, NOT whether the model
    # is loaded, that happens late.
    return {"ok": True, "role": SIDECAR_ROLE, "stt": _stt_available(),
            "sep": _sep_available(), "device": get_sep_device()}


@app.get("/voices")
def voices():
    return {
        "engines": {
            "kokoro": {"voices": KOKORO_VOICES, "default": KOKORO_DEFAULT},
            "pockettts": {
                "voices": POCKET_VOICES,
                "default": POCKET_DEFAULT,
                "languages": POCKET_LANGUAGES,
                "default_language": POCKET_DEFAULT_LANG,
            },
        },
        "default_engine": DEFAULT_ENGINE,
    }


def to_wav(audio, sample_rate):
    # some engines hand back samples over 1.0 now and then, so pull
    # the peak back down or the WAV clips. then write a 16-bit PCM
    # WAV into a buffer.
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak

    buf = io.BytesIO()
    channels = 1 if audio.ndim == 1 else audio.shape[1]
    # AI Act art. 50(2) wants generated audio machine-readably
    # marked. libsndfile only emits the LIST/INFO chunk if the
    # strings are set before any samples are written, so this can't
    # use the plain sf.write() one-liner.
    with sf.SoundFile(buf, "w", samplerate=sample_rate, channels=channels,
                      format="WAV", subtype="PCM_16") as f:
        f.title = "AI-generated speech"
        f.software = "Jun OS text-to-speech"
        f.comment = "Artificially generated audio. Synthetic speech produced by a text-to-speech model; not a recording of a real person."
        f.write(audio)
    buf.seek(0)
    return buf.read()


def synth_kokoro(text, voice, speed):
    voice = voice if voice in KOKORO_VOICES else KOKORO_DEFAULT
    chunks = []
    for _gs, _ps, audio in get_pipeline()(text, voice=voice, speed=speed):
        if audio is None:
            continue
        if hasattr(audio, "detach"):
            audio = audio.detach().cpu().numpy()
        chunks.append(np.asarray(audio, dtype=np.float32))
    if not chunks:
        return None
    return np.concatenate(chunks), KOKORO_SAMPLE_RATE


def synth_pocket(text, voice, language):
    voice = voice if voice in POCKET_VOICES else POCKET_DEFAULT
    language = language if language in POCKET_LANG_IDS else POCKET_DEFAULT_LANG
    model = get_pocket_model(language)
    audio = model.generate_audio(pocket_state(model, voice), text)
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    audio = np.asarray(audio, dtype=np.float32)
    if not audio.size:
        return None
    return audio, model.sample_rate


def _tts_busy():
    return JSONResponse({"error": "tts_busy"}, status_code=429, headers={"Retry-After": "2"})


def _acquire_tts_slot():
    global _tts_waiting
    if _tts_slots.acquire(blocking=False):
        return True
    with _lock:
        if _tts_waiting >= TTS_MAX_QUEUE:
            return False
        _tts_waiting += 1
    try:
        return _tts_slots.acquire(timeout=TTS_QUEUE_WAIT_S)
    finally:
        with _lock:
            _tts_waiting -= 1


@app.post("/tts")
def tts(req: TTSReq):
    if not req.text:
        return Response(status_code=204)

    engine = req.engine if req.engine in TTS_ENGINES else DEFAULT_ENGINE
    if not _acquire_tts_slot():
        return _tts_busy()
    try:
        _begin_use(engine)
        try:
            if engine == "pockettts":
                result = synth_pocket(req.text, req.voice, req.lang)
            else:
                result = synth_kokoro(req.text, req.voice, req.speed)
        finally:
            _end_use()
    finally:
        _tts_slots.release()

    if result is None:
        return Response(status_code=204)

    audio, sample_rate = result
    return Response(
        content=to_wav(audio, sample_rate),
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/warm")
def warm(req: WarmReq):
    # the client warms pocket-tts language weights and voice state
    # while Jun writes, hiding the multi-second reload before /tts.
    # changing language still reloads fully. Kokoro has no language
    # checkpoints to warm.
    if req.engine != "pockettts":
        return {"ok": True, "warmed": None}
    language = req.lang if req.lang in POCKET_LANG_IDS else POCKET_DEFAULT_LANG
    voice = req.voice if req.voice in POCKET_VOICES else POCKET_DEFAULT
    if not _acquire_tts_slot():
        return _tts_busy()
    try:
        _begin_use("pockettts")
        try:
            model = get_pocket_model(language)
            pocket_state(model, voice)
        finally:
            _end_use()
    finally:
        _tts_slots.release()
    return {"ok": True, "warmed": language}


@app.post("/stt")
async def stt(request: Request):
    # js/voice.js posts raw 16kHz mono PCM16 WAV, so no
    # python-multipart is needed. PyAV bundles ffmpeg libraries and
    # accepts other audio containers too, without an ffmpeg binary.
    if not _stt_available():
        return JSONResponse({"error": "stt_unavailable"}, status_code=503)

    try:
        body = await read_body(request, STT_MAX_BYTES)
    except BodyTooLarge:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"text": ""})
    # decode + whisper are seconds of blocking work. on the event
    # loop thread that stalls /health and every other request for
    # the whole time, so it goes to the threadpool.
    return await run_in_threadpool(_stt_sync, body)


def _stt_sync(body):
    if not _stt_slots.acquire(blocking=False):
        return JSONResponse({"error": "stt_busy"}, status_code=429, headers={"Retry-After": "2"})
    try:
        try:
            audio = _decode_audio(body, 16000, 1, STT_MAX_DURATION_S)[0]
        except AudioDurationExceeded:
            return JSONResponse({"error": "audio_too_long"}, status_code=413)
        except Exception as e:
            log.info("stt: invalid audio: %s", e)
            return JSONResponse({"error": "invalid_audio"}, status_code=400)

        # beam_size=1 (greedy) is ~30% faster with little accuracy loss
        # on short utterances. condition_on_previous_text=False prevents
        # repetition across independent turns. vad_filter trims the 300ms
        # pre-roll and 700ms end-of-turn silence.
        segments, _info = get_whisper().transcribe(
            audio,
            language=STT_LANG,
            beam_size=1,
            condition_on_previous_text=False,
            vad_filter=True,
        )
        # transcribe() hands back a lazy generator, the work happens on
        # iteration
        text = " ".join(seg.text.strip() for seg in segments).strip()
    finally:
        _stt_slots.release()
    # NOT the text. this log outlives a factory reset and what she
    # heard is nobody's business. STT_LOG_TRANSCRIPTS=1 for a
    # debugging session, then turn it back off.
    if os.environ.get("STT_LOG_TRANSCRIPTS") == "1":
        log.info("stt: %d bytes -> %r", len(body), text)
    else:
        log.info("stt: %d bytes -> %d chars", len(body), len(text))
    return JSONResponse({"text": text})


def _decode_audio(body, target_sr, target_channels, max_duration_s):
    # same PyAV /stt uses. its wheel bundles ffmpeg's libs so any
    # container it can open works and no ffmpeg binary is needed.
    # planar float output lands as (channels, samples), and the
    # resampler up/down-mixes to target_channels, so a mono upload
    # becomes the stereo demucs wants for free.
    import av
    layout = "stereo" if target_channels == 2 else "mono"
    resampler = av.audio.resampler.AudioResampler(format="fltp", layout=layout, rate=target_sr)
    container = av.open(io.BytesIO(body))
    chunks = []
    samples = 0
    max_samples = int(target_sr * max_duration_s)
    try:
        for frame in container.decode(audio=0):
            for rf in _resample(resampler, frame):
                samples += rf.samples
                if samples > max_samples:
                    raise AudioDurationExceeded
                chunks.append(rf.to_ndarray())
    finally:
        container.close()
    for rf in _resample(resampler, None):
        samples += rf.samples
        if samples > max_samples:
            raise AudioDurationExceeded
        chunks.append(rf.to_ndarray())
    if not chunks:
        return np.zeros((target_channels, 0), dtype=np.float32)
    return np.concatenate(chunks, axis=1).astype(np.float32)


def _resample(resampler, frame):
    out = resampler.resample(frame)
    if out is None:
        return []
    return out if isinstance(out, list) else [out]


def _apply_demucs(model, wav):
    import torch
    from demucs.apply import apply_model
    # demucs is trained on per-mix normalized input. skip this and
    # the separation is audibly worse. denormalize the sources with
    # the same stats afterwards.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    mix = ((wav - mean) / std)[None]

    def run(dev):
        model.to(dev)
        with torch.no_grad():
            return apply_model(model, mix.to(dev), device=dev, progress=False)[0].to("cpu")

    device = get_sep_device()
    try:
        out = run(device)
    except RuntimeError as e:
        # GPU is best effort. CUDA OOM or bad kernels get one CPU
        # retry, the whole song doesn't die for that shit.
        if device != "cpu":
            log.warning("demucs on %s failed (%s); retrying on CPU", device, e)
            _free_torch()
            out = run("cpu")
        else:
            raise
    return out * std + mean


def _whisper_words(audio):
    segments, _info = get_whisper().transcribe(
        audio, language=STT_LANG, word_timestamps=True,
        vad_filter=False, condition_on_previous_text=False)
    text_parts, words = [], []
    for seg in segments:
        text_parts.append(seg.text.strip())
        for w in (seg.words or []):
            words.append({"word": w.word.strip(), "start": w.start, "end": w.end})
    return " ".join(t for t in text_parts if t).strip(), words


@app.post("/separate")
async def separate(request: Request):
    if not _sep_available():
        return JSONResponse({"error": "sep_unavailable"}, status_code=503)

    try:
        body = await read_body(request, SEP_MAX_BYTES)
    except BodyTooLarge:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"error": "empty_audio"}, status_code=400)
    return await run_in_threadpool(_separate_sync, body)


def _separate_sync(body):
    if not _sep_slots.acquire(blocking=False):
        return JSONResponse({"error": "sep_busy"}, status_code=429, headers={"Retry-After": "5"})
    # everything past the acquire lives in the try. one slot, so a
    # throw between acquire and try (torch missing, _begin_use
    # blowing up) leaks it and separation answers 429 until the
    # container restarts.
    try:
        import torch
        _begin_use("demucs")
        try:
            model = get_separator()
            sr = model.samplerate
            try:
                wav = _decode_audio(body, sr, model.audio_channels, SEP_MAX_DURATION_S)
            except AudioDurationExceeded:
                return JSONResponse({"error": "audio_too_long"}, status_code=413)
            except Exception as e:
                log.info("separate: invalid audio: %s", e)
                return JSONResponse({"error": "invalid_audio"}, status_code=400)
            if wav.shape[1] == 0:
                return JSONResponse({"error": "empty_audio"}, status_code=400)
            duration = wav.shape[1] / float(sr)

            sources = _apply_demucs(model, torch.from_numpy(wav))
            vi = model.sources.index("vocals")
            vocals = sources[vi]
            # htdemucs has no 2-stem head, so the backing track is just the sum
            # of every non-vocal source (drums + bass + other)
            instrumental = sum(sources[i] for i in range(len(model.sources)) if i != vi)

            token = secrets.token_hex(16)
            d = tempfile.mkdtemp(prefix="sep-")
            sf.write(os.path.join(d, "instrumental.wav"), instrumental.T.numpy(), sr, subtype="PCM_16")
            sf.write(os.path.join(d, "vocals_guide.wav"), vocals.T.numpy(), sr, subtype="PCM_16")
            with _lock:
                _sep_tokens[token] = {"dir": d, "created_at": time.monotonic(), "fetched": set()}
                evicted = []
                while len(_sep_tokens) > SEP_MAX_JOBS:
                    oldest = min(_sep_tokens, key=lambda t: _sep_tokens[t]["created_at"])
                    evicted.append(_sep_tokens.pop(oldest)["dir"])
            for old in evicted:
                shutil.rmtree(old, ignore_errors=True)

            lyrics = []
            if _stt_available():
                _, lyrics = _whisper_words(io.BytesIO(to_wav(vocals.mean(0).numpy(), sr)))
        finally:
            _end_use()
    finally:
        _sep_slots.release()

    log.info("separate: %d bytes dur=%.1fs words=%d", len(body), duration, len(lyrics))
    return JSONResponse({"token": token, "duration": duration, "lyrics": lyrics})


@app.post("/separate/stem")
async def separate_stem(request: Request):
    try:
        body = json.loads(await read_body(request, JSON_MAX_BYTES))
    except BodyTooLarge:
        return JSONResponse({"error": "request_too_large"}, status_code=413)
    except Exception:
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    token = body.get("token") if isinstance(body, dict) else None
    which = body.get("which") if isinstance(body, dict) else None
    if not isinstance(token, str) or not isinstance(which, str):
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    fname = {"instrumental": "instrumental.wav", "guide": "vocals_guide.wav"}.get(which)
    if fname is None:
        return JSONResponse({"error": "unknown_stem"}, status_code=404)
    with _lock:
        info = _sep_tokens.get(token)
    if info is None:
        return JSONResponse({"error": "unknown_token"}, status_code=404)
    path = os.path.join(info["dir"], fname)
    if not os.path.exists(path):
        return JSONResponse({"error": "unknown_stem"}, status_code=404)
    with open(path, "rb") as f:
        data = await run_in_threadpool(f.read)
    with _lock:
        info["fetched"].add(which)
        done = {"instrumental", "guide"} <= info["fetched"]
        if done:
            _sep_tokens.pop(token, None)
    if done:
        shutil.rmtree(info["dir"], ignore_errors=True)
    return Response(content=data, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.post("/transcribe_timed")
async def transcribe_timed(request: Request):
    if not _stt_available():
        return JSONResponse({"error": "stt_unavailable"}, status_code=503)

    try:
        body = await read_body(request, SEP_MAX_BYTES)
    except BodyTooLarge:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"text": "", "words": []})
    return await run_in_threadpool(_transcribe_timed_sync, body)


def _transcribe_timed_sync(body):
    if not _stt_slots.acquire(blocking=False):
        return JSONResponse({"error": "stt_busy"}, status_code=429, headers={"Retry-After": "2"})
    try:
        _begin_use("demucs")
        try:
            try:
                audio = _decode_audio(body, 16000, 1, SEP_MAX_DURATION_S)[0]
            except AudioDurationExceeded:
                return JSONResponse({"error": "audio_too_long"}, status_code=413)
            except Exception as e:
                log.info("transcribe_timed: invalid audio: %s", e)
                return JSONResponse({"error": "invalid_audio"}, status_code=400)
            text, words = _whisper_words(audio)
        finally:
            _end_use()
    finally:
        _stt_slots.release()
    log.info("transcribe_timed: %d bytes -> %d words", len(body), len(words))
    return JSONResponse({"text": text, "words": words})


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "8001"))
    uvicorn.run(app, host=host, port=port, log_level="info")
