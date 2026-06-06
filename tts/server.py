"""
Local TTS sidecar for Jun OS. A small FastAPI server on :8001 that fronts two
swappable engines, picked per-request by the `engine` field:

  - kokoro    — Kokoro-82M (default). Needs espeak-ng on the system.
  - pockettts — kyutai-labs pocket-tts (100M, CPU, English + 5 langs).

The webapp's js/tts.js posts a sentence at a time to /tts and plays the returned
WAV through an AudioContext. /voices exposes both engines' voice lists so the UI
can offer an engine + voice picker. Run: python server.py
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

_pipeline = None       # Kokoro KPipeline
_pocket_model = None   # pocket-tts TTSModel
_pocket_states = {}    # voice name -> precomputed voice state (load is non-trivial)


def get_pipeline():
    # Loaded lazily so import-time failures (missing espeak-ng etc.) surface clearly.
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        log.info("loading Kokoro pipeline (lang_code='a' / American English)...")
        _pipeline = KPipeline(lang_code="a")
        log.info("Kokoro ready.")
    return _pipeline


def get_pocket_model():
    # load_model() is relatively slow and downloads weights into HF_HOME on first
    # call, so we keep it lazy — the engine is only paid for if actually selected.
    global _pocket_model
    if _pocket_model is None:
        from pocket_tts import TTSModel
        log.info("loading pocket-tts model...")
        _pocket_model = TTSModel.load_model()
        log.info("pocket-tts ready (sample_rate=%s).", _pocket_model.sample_rate)
    return _pocket_model


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
    # Anything that slips through becomes a generic 500 — no tracebacks to clients.
    log.exception("unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse({"error": "synthesis_failed"}, status_code=500)


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
    return {"ok": True}


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


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "8001"))
    uvicorn.run(app, host=host, port=port, log_level="info")
