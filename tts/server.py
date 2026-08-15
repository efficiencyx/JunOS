"""
Local audio sidecar for Jun OS. A small FastAPI server on :8001 serving both
directions of the voice loop.

Out (/tts) - swappable engines, picked per-request by the `engine` field:

  - kokoro      - Kokoro-82M (default). Needs espeak-ng on the system.
  - pockettts   - kyutai-labs pocket-tts (100M, CPU, English + 5 langs).

In (/stt) - faster-whisper transcribes a WAV posted as a raw body.

Karaoke (/separate, /transcribe_timed) - htdemucs splits a song into a backing
track and a guide vocal, whisper times the words. Under Docker this half runs as
a second container off the same file (SIDECAR_ROLE=karaoke, docker/karaoke.
Dockerfile) so it can hold a GPU torch while the voice sidecar stays on CPU;
each image installs only its own deps, and the missing ones degrade to 503 via
the _available() probes. Bare-metal installs run one process for both roles.

The webapp's js/tts.js posts a sentence at a time to /tts and plays the returned
WAV through an AudioContext; js/voice.js posts captured utterances to /stt.
/voices exposes each engine's voice list (and, for pocket-tts, its selectable
languages) so the UI can offer an engine + voice + language picker. Run: python server.py

(PHP reaches this sidecar via TTS_URL - the compose service is `tts`. The
legacy KOKORO_URL name from older .env files is still honored as a fallback.)
"""

import gc
import io
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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tts")

KOKORO_SAMPLE_RATE = 24000
KOKORO_DEFAULT = "af_heart"

# Kokoro-82M's EN voices. some are trained way better than others, all load fine.
KOKORO_VOICES = [
    "af_heart", "af_bella", "af_aoede", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "af_alloy", "af_jessica",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
]

# the voice prompts pocket-tts ships, bare names. these are the timbre ONLY,
# language is a totally separate thing, see POCKET_LANGUAGES below. every voice
# has an embedding per language so any voice goes with any language. giovanni,
# lola, juergen, rafael and estelle were recorded by people who don't speak
# English and yeah, they keep that accent.
POCKET_DEFAULT = "eve"
POCKET_VOICES = [
    "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette",
    "eponine", "eve", "fantine", "george", "jane", "jean", "javert", "marius",
    "mary", "michael", "paul", "peter_yearsley", "stuart_bell", "vera",
    "giovanni", "lola", "juergen", "rafael", "estelle",
]

# pocket-tts bakes the language into the WEIGHTS. load_model(language=...) is a
# different checkpoint that actually speaks that language, and it points the
# ready made voices at that language's embeddings. we only offer the configs
# pocket blessed upstream. french, spanish and german come as bigger 24 layer
# builds, that's what the _24l ids are. `id` goes to load_model(), `label` is
# what you see in the UI.
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

# tts | karaoke. this ONLY changes the pre-warm at startup and what /health
# says. every route is mounted in both roles and 503s when the thing it needs
# isn't there.
SIDECAR_ROLE = os.environ.get("SIDECAR_ROLE", "tts").strip().lower()

# "demucs" is a FAKE engine. it's not a TTS voice, but shoving it in the same
# lifecycle lets a separation job kick the TTS engines out while it runs, and
# vice versa, and it holds _inflight so the reaper can't yank a model out from
# under a running job.
_ALL_ENGINES = TTS_ENGINES + ("demucs",)

# ONLY one TTS engine is ever picked at a time, so keeping more than one loaded
# just squats on VRAM and RAM for nothing. we drop the others the second a
# request asks for a different one, and a reaper frees the lot after this many
# idle seconds, 0 turns that off. reloading costs a few seconds off the cold
# weights in HF_HOME.
TTS_IDLE_UNLOAD_S = float(os.environ.get("TTS_IDLE_UNLOAD_S", "180"))
_REAP_INTERVAL_S = 20.0

# cap on the /stt request body. 16kHz mono PCM16 is ~32KB/s so 4MB is roughly
# 2min of audio. one of a whole chain of caps, api/stt.php lists them all.
STT_MAX_BYTES = 4 * 1024 * 1024

# empty string means detect it per utterance, which costs another decode pass
# and is shaky under ~2s of audio. so just name the language when you know it.
# must agree with STT_MODEL, docker/tts.Dockerfile explains the pairing.
STT_LANG = (os.environ.get("STT_LANG", "").strip().lower() or None)

# karaoke sends WHOLE SONGS, not utterances, so it gets its own much bigger
# cap. the stems we split out sit in a temp dir per token and go away once both
# have been fetched, or after this TTL when a client just never comes back.
SEP_MAX_BYTES = 50 * 1024 * 1024
SEP_TTL_S = 15 * 60

_pipeline = None
_pocket_model = None
_pocket_lang = None
_pocket_states = {}
# serialises the pocket loads so a /warm preload and a synth at the same time
# can't both pull a checkpoint. held for the whole multi second load, so the
# second caller just waits and reuses the result instead of redoing all of it.
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


def get_device():
    # TTS_DEVICE says where torch runs: cpu | cuda | auto. auto is the default.
    # "auto" takes CUDA when the wheel has it, and that covers ROCm too, its
    # HIP backend just pretends to be torch.cuda. the image ships a CPU only
    # torch unless the nvidia or amd compose overlay builds it against a GPU
    # wheel, so on a plain build "auto" always lands on cpu.
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
    # SEP_DEVICE: cpu | cuda | auto. this one stays dumb, unlike get_device().
    # a separation job is ONE big call, so a bad GPU just falls back per job in
    # _apply_demucs and we don't need to probe anything here.
    choice = os.environ.get("SEP_DEVICE", "auto").strip().lower()
    if choice in ("cpu", "cuda"):
        return choice
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def get_pipeline():
    # loaded late so a failure at import (missing espeak-ng, whatever) is clear
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        device = get_device()
        log.info("loading Kokoro pipeline (lang_code='a' / American English) on %s...", device)
        _pipeline = KPipeline(lang_code="a", device=device)
        log.info("Kokoro ready.")
    return _pipeline


def get_pocket_model(language=POCKET_DEFAULT_LANG):
    # load_model() is slow and drags weights into HF_HOME the first time, so we
    # leave it late and only pay for the engine if somebody actually picks it.
    # language is baked into the weights so changing it is a FULL reload. we
    # keep ONE loaded, same as the one engine at a time rule, and drop its per
    # language voice states with it.
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
    # late, like the TTS engines. the model lands in HF_HOME on the first call,
    # and keeping it out of prewarm() means it can't push first boot past the
    # healthcheck. first transcription pays ~1-2s, every one after that is warm.
    #
    # pin cpu_threads. CTranslate2 is faster-whisper's inference
    # runtime. CTranslate2 and torch BOTH grab one thread per core
    # by default. let them overlap and they ask for more cores
    # than exist. cool. cool cool cool. OMP_NUM_THREADS in
    # tts.Dockerfile holds torch down, this holds CTranslate2 down.
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        model = os.environ.get("STT_MODEL", "base")
        compute = os.environ.get("STT_COMPUTE", "int8")
        threads = int(os.environ.get("OMP_NUM_THREADS", "4"))
        # STT_DEVICE, NOT TTS_DEVICE. whisper runs on CTranslate2, so the device
        # that suits Kokoro does not carry over. docker/tts.Dockerfile has the
        # cuDNN/ROCm reasons it defaults to cpu.
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
    # late, like the TTS engines. the htdemucs weights (~80MB) land in HF_HOME
    # on the first call. the model then moves onto whatever device
    # _apply_demucs picks for that job.
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
    # caller holds _lock. drops the model refs, then gc and empty_cache hand
    # the VRAM back.
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("CORS_ORIGIN", "http://nginx")],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


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
    # speed only does anything on Kokoro, pocket-tts generate_audio has no rate
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    engine: str = DEFAULT_ENGINE
    # pocket-tts only. Kokoro ignores it, it speaks american english and that's that.
    lang: str = POCKET_DEFAULT_LANG


class WarmReq(BaseModel):
    lang: str = POCKET_DEFAULT_LANG
    voice: str = POCKET_DEFAULT
    engine: str = "pockettts"


@app.on_event("startup")
def prewarm():
    # say one tiny thing with Kokoro up front so the first real request doesn't
    # eat the cost of the pipeline plus the default voice starting cold.
    # pocket-tts just warms up on its own first request instead.
    global _last_used
    if SIDECAR_ROLE != "karaoke":
        try:
            for _gs, _ps, _audio in get_pipeline()("Hi.", voice=KOKORO_DEFAULT, speed=1.0):
                pass
            log.info("pre-warm done (engine=kokoro voice=%s)", KOKORO_DEFAULT)
        except Exception:
            log.exception("pre-warm failed (non-fatal)")

    # start the idle clock NOW, so the time prewarm took doesn't count against it
    _last_used = time.monotonic()
    # ALWAYS, no condition. the reaper also clears out expired separation
    # tokens, and those need cleaning even when idle unloading is off.
    threading.Thread(target=_reaper, name="tts-reaper", daemon=True).start()
    log.info("sidecar role: %s", SIDECAR_ROLE)
    if TTS_IDLE_UNLOAD_S > 0:
        log.info("model reaper on: idle unload after %.0fs", TTS_IDLE_UNLOAD_S)


@app.get("/health")
def health():
    # `stt` lets the webapp hide the mic button when this build has no whisper,
    # instead of face planting on the first thing you say. it reports whether
    # we can IMPORT it, NOT whether the model is loaded, that happens late.
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
    # some engines hand back samples over 1.0 now and then, so pull the peak
    # back down or the WAV clips. then write a 16-bit PCM WAV into a buffer.
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak

    buf = io.BytesIO()
    channels = 1 if audio.ndim == 1 else audio.shape[1]
    # AI Act art. 50(2) wants generated audio machine-readably marked. libsndfile
    # only emits the LIST/INFO chunk if the strings are set before any samples are
    # written, so this can't use the plain sf.write() one-liner.
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


@app.post("/tts")
def tts(req: TTSReq):
    if not req.text:
        return Response(status_code=204)

    engine = req.engine if req.engine in TTS_ENGINES else DEFAULT_ENGINE
    _begin_use(engine)
    try:
        if engine == "pockettts":
            result = synth_pocket(req.text, req.voice, req.lang)
        else:
            result = synth_kokoro(req.text, req.voice, req.speed)
    finally:
        _end_use()

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
    # load a pocket-tts language checkpoint early along with its
    # voice state, then a /tts request in that language skips the
    # multi second wait. the client fires this while Jun is still
    # writing, so the reload happens before speech starts. Kokoro
    # has no per language weights so warming it does nothing.
    # changing language here is a full reload, same as a synth, but
    # nobody's waiting on it.
    if req.engine != "pockettts":
        return {"ok": True, "warmed": None}
    language = req.lang if req.lang in POCKET_LANG_IDS else POCKET_DEFAULT_LANG
    voice = req.voice if req.voice in POCKET_VOICES else POCKET_DEFAULT
    _begin_use("pockettts")
    try:
        model = get_pocket_model(language)
        pocket_state(model, voice)
    finally:
        _end_use()
    return {"ok": True, "warmed": language}


@app.post("/stt")
async def stt(request: Request):
    # the body is a raw WAV, 16kHz mono PCM16 out of js/voice.js, NOT multipart.
    # it's one file with nothing else attached, so a raw body means we don't
    # need python-multipart at all. one less dep.
    #
    # faster-whisper decodes via PyAV, whose wheel bundles ffmpeg's libraries,
    # so no ffmpeg binary is needed in the image and any container PyAV can
    # open works here, not just the WAV the client actually sends.
    if not _stt_available():
        return JSONResponse({"error": "stt_unavailable"}, status_code=503)

    body = await request.body()
    if len(body) > STT_MAX_BYTES:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"text": ""})

    # beam_size=1 (greedy) is ~30% faster than the default beam search and the
    # accuracy hit on short conversational utterances is basically nothing.
    # condition_on_previous_text=False: each utterance is independent here, and
    # leaving it on is EXACTLY what makes whisper spiral into repetition loops.
    # vad_filter drops the leading/trailing silence that the client's 300ms
    # pre-roll and 700ms end-of-turn hangover necessarily include.
    segments, _info = get_whisper().transcribe(
        io.BytesIO(body),
        language=STT_LANG,
        beam_size=1,
        condition_on_previous_text=False,
        vad_filter=True,
    )
    # transcribe() hands back a lazy generator, the work happens on iteration
    text = " ".join(seg.text.strip() for seg in segments).strip()
    log.info("stt: %d bytes -> %r", len(body), text)
    return JSONResponse({"text": text})


def _decode_audio(body, target_sr, target_channels):
    # same PyAV /stt uses. its wheel bundles ffmpeg's libs so any container it
    # can open works and no ffmpeg binary is needed. planar float output lands
    # as (channels, samples), and the resampler up/down-mixes to
    # target_channels, so a mono upload becomes the stereo demucs wants for free.
    import av
    layout = "stereo" if target_channels == 2 else "mono"
    resampler = av.audio.resampler.AudioResampler(format="fltp", layout=layout, rate=target_sr)
    container = av.open(io.BytesIO(body))
    chunks = []
    try:
        for frame in container.decode(audio=0):
            for rf in _resample(resampler, frame):
                chunks.append(rf.to_ndarray())
    finally:
        container.close()
    for rf in _resample(resampler, None):
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
    # demucs is trained on per-mix normalized input. skip this and the
    # separation is audibly worse. denormalize the sources with the same stats
    # afterwards.
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

    body = await request.body()
    if len(body) > SEP_MAX_BYTES:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"error": "empty_audio"}, status_code=400)

    import torch
    _begin_use("demucs")
    try:
        model = get_separator()
        sr = model.samplerate
        wav = _decode_audio(body, sr, model.audio_channels)
        if wav.shape[1] == 0:
            return JSONResponse({"error": "empty_audio"}, status_code=400)
        duration = wav.shape[1] / float(sr)

        sources = _apply_demucs(model, torch.from_numpy(wav))
        vi = model.sources.index("vocals")
        vocals = sources[vi]
        # htdemucs has no 2-stem head, so the backing track is just the sum of
        # every non-vocal source (drums + bass + other)
        instrumental = sum(sources[i] for i in range(len(model.sources)) if i != vi)

        token = secrets.token_hex(16)
        d = tempfile.mkdtemp(prefix="sep-")
        sf.write(os.path.join(d, "instrumental.wav"), instrumental.T.numpy(), sr, subtype="PCM_16")
        sf.write(os.path.join(d, "vocals_guide.wav"), vocals.T.numpy(), sr, subtype="PCM_16")
        with _lock:
            _sep_tokens[token] = {"dir": d, "created_at": time.monotonic(), "fetched": set()}

        lyrics = []
        if _stt_available():
            _, lyrics = _whisper_words(io.BytesIO(to_wav(vocals.mean(0).numpy(), sr)))
    finally:
        _end_use()

    log.info("separate: %d bytes -> token=%s dur=%.1fs words=%d", len(body), token, duration, len(lyrics))
    return JSONResponse({"token": token, "duration": duration, "lyrics": lyrics})


@app.get("/separate/stem")
def separate_stem(token: str, which: str):
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
        data = f.read()
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

    body = await request.body()
    if len(body) > SEP_MAX_BYTES:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"text": "", "words": []})

    _begin_use("demucs")
    try:
        text, words = _whisper_words(io.BytesIO(body))
    finally:
        _end_use()
    log.info("transcribe_timed: %d bytes -> %d words", len(body), len(words))
    return JSONResponse({"text": text, "words": words})


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "8001"))
    uvicorn.run(app, host=host, port=port, log_level="info")
