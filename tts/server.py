"""
Local audio sidecar for Jun OS. A small FastAPI server on :8001 serving both
directions of the voice loop.

Out (/tts) - two swappable engines, picked per-request by the `engine` field:

  - kokoro    - Kokoro-82M (default). Needs espeak-ng on the system.
  - pockettts - kyutai-labs pocket-tts (100M, CPU, English + 5 langs).

In (/stt) - faster-whisper transcribes a WAV posted as a raw body.

The webapp's js/tts.js posts a sentence at a time to /tts and plays the returned
WAV through an AudioContext; js/voice.js posts captured utterances to /stt.
/voices exposes both engines' voice lists so the UI can offer an engine + voice
picker. Run: python server.py

(The service is still named "kokoro" in docker-compose and KOKORO_URL - it
predates both the pocket-tts engine and STT. Renaming it is churn, not a fix.)
"""

import io
import logging
import os
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

# Kokoro-82M's EN voices. Not all are equally trained but all of them load.
KOKORO_VOICES = [
    "af_heart", "af_bella", "af_aoede", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "af_alloy", "af_jessica",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]

# pocket-tts built-in voice prompts (bare names). English defaults; the tail of
# the list is other languages (giovanni=it, lola=es, juergen=de, rafael=pt, estelle=fr).
POCKET_DEFAULT = "eve"
POCKET_VOICES = [
    "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette",
    "eponine", "eve", "fantine", "george", "jane", "jean", "javert", "marius",
    "mary", "michael", "paul", "peter_yearsley", "stuart_bell", "vera",
    "giovanni", "lola", "juergen", "rafael", "estelle",
]

DEFAULT_ENGINE = "kokoro"

# Cap on the /stt request body. 16kHz mono PCM16 is ~32KB/s, so 4MB is ~2min of
# audio - far past js/voice.js's 30s max-utterance guard. Kept in step with
# nginx's `client_max_body_size 4m` and PHP's post_max_size on /api/stt.php.
STT_MAX_BYTES = 4 * 1024 * 1024

# STT language. Must match STT_MODEL: the ".en" whisper builds are English-only,
# so a non-"en" value here needs a multilingual model too (base / small / etc,
# no ".en" suffix). Empty string = auto-detect per utterance, which costs an
# extra decode pass and is unreliable on utterances under ~2s - prefer naming the
# language when you know it. See docker/kokoro.Dockerfile for the pairing.
STT_LANG = (os.environ.get("STT_LANG", "en").strip().lower() or None)

_pipeline = None       # Kokoro KPipeline
_pocket_model = None   # pocket-tts TTSModel
_pocket_states = {}    # voice name -> precomputed voice state (load is non-trivial)
_whisper = None        # faster-whisper WhisperModel
_stt_ok = None         # faster-whisper importable? resolved once, reported by /health
_device = None         # resolved once: "cpu" or "cuda"


def get_device():
    # TTS_DEVICE picks where torch runs: cpu | cuda | auto (default). "auto" uses
    # CUDA when the wheel exposes it - this also covers ROCm builds, whose HIP
    # backend masquerades as torch.cuda. The image ships a CPU-only torch unless
    # the nvidia/amd compose overlay rebuilds it against a GPU wheel, so on a
    # plain build "auto" always resolves to cpu.
    global _device
    if _device is None:
        choice = os.environ.get("TTS_DEVICE", "auto").strip().lower()
        if choice in ("cpu", "cuda"):
            _device = choice
        else:
            try:
                import torch
                _device = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                _device = "cpu"
        log.info("TTS device: %s (TTS_DEVICE=%s)", _device, choice)
    return _device


def get_pipeline():
    # Loaded lazily so import-time failures (missing espeak-ng etc.) surface clearly.
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        device = get_device()
        log.info("loading Kokoro pipeline (lang_code='a' / American English) on %s...", device)
        _pipeline = KPipeline(lang_code="a", device=device)
        log.info("Kokoro ready.")
    return _pipeline


def get_pocket_model():
    # load_model() is relatively slow and downloads weights into HF_HOME on first
    # call, so we keep it lazy - the engine is only paid for if actually selected.
    global _pocket_model
    if _pocket_model is None:
        import inspect
        from pocket_tts import TTSModel
        device = get_device()
        # Not every pocket-tts release exposes a `device` kwarg; pass it only when
        # the signature accepts it, otherwise fall back to a post-load .to(device).
        kwargs = {}
        if "device" in inspect.signature(TTSModel.load_model).parameters:
            kwargs["device"] = device
        log.info("loading pocket-tts model on %s...", device)
        _pocket_model = TTSModel.load_model(**kwargs)
        if not kwargs and device != "cpu" and hasattr(_pocket_model, "to"):
            try:
                _pocket_model.to(device)
            except Exception:
                log.warning("pocket-tts: could not move model to %s; using its default device", device)
        log.info("pocket-tts ready (sample_rate=%s).", _pocket_model.sample_rate)
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
    # Lazy like the TTS engines: the model downloads into HF_HOME on first call,
    # and keeping it out of prewarm() means it can't push first boot past the
    # healthcheck. First transcription pays ~1-2s of load; every later one is warm.
    #
    # cpu_threads is pinned deliberately. CTranslate2 and torch each default to
    # spawning one intra-op thread per core, so an unpinned whisper transcribing
    # while Kokoro synthesizes oversubscribes every core on the box. OMP_NUM_THREADS
    # (set in kokoro.Dockerfile) bounds torch; this bounds CTranslate2.
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        model = os.environ.get("STT_MODEL", "base.en")
        compute = os.environ.get("STT_COMPUTE", "int8")
        threads = int(os.environ.get("OMP_NUM_THREADS", "4"))
        # STT_DEVICE, NOT TTS_DEVICE - and defaulting to cpu rather than auto.
        # Whisper runs on CTranslate2, a different runtime from torch, so the
        # device that's right for Kokoro isn't automatically right here:
        #   - CUDA CTranslate2 needs cuBLAS + cuDNN. The CUDA torch wheel the
        #     nvidia overlay installs doesn't reliably provide cuDNN, so
        #     inheriting TTS_DEVICE=cuda would fail at load with a missing-.so
        #     error on a stack that was working a moment ago.
        #   - CTranslate2 has no ROCm backend at all, so on the AMD overlay
        #     (where torch reports "cuda" via HIP) it can only run on CPU.
        # base.en on CPU is ~350-700ms for a short utterance, which is not the
        # bottleneck - Kokoro is. Opt in with STT_DEVICE=cuda if you have the
        # CUDA libs and want the ~250ms.
        device = os.environ.get("STT_DEVICE", "cpu").strip().lower()
        if device not in ("cpu", "cuda"):
            device = "cpu"
        if device == "cpu" and compute not in ("int8", "float32"):
            log.info("STT: compute_type=%s unsupported on CPU, using int8", compute)
            compute = "int8"
        if model.endswith(".en") and STT_LANG not in (None, "en"):
            # Silent-garbage guard: an English-only model asked for another
            # language doesn't error, it just transcribes nonsense.
            log.warning("STT: model %s is English-only but STT_LANG=%s; "
                        "use a multilingual model (e.g. %s) or set STT_LANG=en",
                        model, STT_LANG, model[:-3])
        log.info("loading faster-whisper (%s, %s, lang=%s) on %s...",
                 model, compute, STT_LANG or "auto", device)
        _whisper = WhisperModel(model, device=device, compute_type=compute,
                                cpu_threads=threads, num_workers=1)
        log.info("faster-whisper ready.")
    return _whisper


def pocket_state(voice):
    state = _pocket_states.get(voice)
    if state is None:
        state = get_pocket_model().get_state_for_audio_prompt(voice)
        _pocket_states[voice] = state
    return state


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("CORS_ORIGIN", "http://nginx")],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
    # Anything that slips through becomes a generic 500 - no tracebacks to clients.
    log.exception("unhandled exception on %s %s", request.method, request.url.path)
    err = "transcription_failed" if request.url.path == "/stt" else "synthesis_failed"
    return JSONResponse({"error": err}, status_code=500)


class TTSReq(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    voice: str = KOKORO_DEFAULT
    # speed only affects Kokoro; pocket-tts generate_audio has no rate control.
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    engine: str = DEFAULT_ENGINE


@app.on_event("startup")
def prewarm():
    # Synthesize one tiny Kokoro utterance up front so the first real request
    # doesn't eat the pipeline + default-voice cold start. pocket-tts warms
    # lazily on its first request instead.
    try:
        for _gs, _ps, _audio in get_pipeline()("Hi.", voice=KOKORO_DEFAULT, speed=1.0):
            pass
        log.info("pre-warm done (engine=kokoro voice=%s)", KOKORO_DEFAULT)
    except Exception:
        log.exception("pre-warm failed (non-fatal)")


@app.get("/health")
def health():
    # `stt` lets the webapp hide the mic button when this build has no whisper,
    # rather than failing on the first utterance. Reports whether the dep is
    # importable, not whether the model is loaded (it loads lazily).
    return {"ok": True, "stt": _stt_available()}


@app.get("/voices")
def voices():
    return {
        "engines": {
            "kokoro": {"voices": KOKORO_VOICES, "default": KOKORO_DEFAULT},
            "pockettts": {"voices": POCKET_VOICES, "default": POCKET_DEFAULT},
        },
        "default_engine": DEFAULT_ENGINE,
    }


def to_wav(audio, sample_rate):
    # Some engines occasionally return samples above 1.0; pull the peak back down
    # so the WAV doesn't clip. Then encode 16-bit PCM WAV into a byte buffer.
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak

    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
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


def synth_pocket(text, voice):
    voice = voice if voice in POCKET_VOICES else POCKET_DEFAULT
    model = get_pocket_model()
    audio = model.generate_audio(pocket_state(voice), text)
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

    if req.engine == "pockettts":
        result = synth_pocket(req.text, req.voice)
    else:
        result = synth_kokoro(req.text, req.voice, req.speed)

    if result is None:
        return Response(status_code=204)

    audio, sample_rate = result
    return Response(
        content=to_wav(audio, sample_rate),
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/stt")
async def stt(request: Request):
    # Body is a raw WAV (16kHz mono PCM16 from js/voice.js), not multipart - it's
    # one file with no metadata, so a raw body skips python-multipart entirely.
    #
    # faster-whisper decodes via PyAV, whose wheel bundles ffmpeg's libraries, so
    # no ffmpeg binary is needed in the image and any container PyAV can open
    # works here - not just the WAV the client actually sends.
    if not _stt_available():
        return JSONResponse({"error": "stt_unavailable"}, status_code=503)

    body = await request.body()
    if len(body) > STT_MAX_BYTES:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"text": ""})

    # beam_size=1 (greedy) is ~30% faster than the default beam search and the
    # accuracy cost is negligible on short conversational utterances.
    # condition_on_previous_text=False: each utterance is independent here, and
    # leaving it on is what makes whisper spiral into repetition loops.
    # vad_filter drops leading/trailing silence the client's 300ms pre-roll and
    # 700ms end-of-turn hangover necessarily include.
    segments, _info = get_whisper().transcribe(
        io.BytesIO(body),
        language=STT_LANG,
        beam_size=1,
        condition_on_previous_text=False,
        vad_filter=True,
    )
    # transcribe() returns a lazy generator; the work happens on iteration.
    text = " ".join(seg.text.strip() for seg in segments).strip()
    log.info("stt: %d bytes -> %r", len(body), text)
    return JSONResponse({"text": text})


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "8001"))
    uvicorn.run(app, host=host, port=port, log_level="info")
