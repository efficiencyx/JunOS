"""
Local TTS sidecar for Jun OS. Wraps Kokoro-82M behind a small FastAPI server
on :8001. The webapp's js/tts.js posts a sentence at a time to /tts and plays
the returned WAV through an AudioContext.

Needs espeak-ng on the system (Kokoro's fallback G2P) and the deps in
requirements.txt. Then: python server.py
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

SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_heart"

# Kokoro-82M's EN voices. Not all are equally trained but all of them load;
# /voices feeds this list to the frontend dropdown.
VOICES = [
    "af_heart", "af_bella", "af_aoede", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "af_alloy", "af_jessica",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]

_pipeline = None

def get_pipeline():
    # Loaded lazily so import-time failures (missing espeak-ng etc.) surface clearly.
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        log.info("loading Kokoro pipeline (lang_code='a' / American English)...")
        _pipeline = KPipeline(lang_code="a")
        log.info("Kokoro ready.")
    return _pipeline


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
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.on_event("startup")
def prewarm():
    # Synthesize one tiny utterance up front so the first real request doesn't
    # eat the cold-start cost of loading the pipeline + default voice.
    try:
        for _gs, _ps, _audio in get_pipeline()("Hi.", voice=DEFAULT_VOICE, speed=1.0):
            pass
        log.info("pre-warm done (voice=%s)", DEFAULT_VOICE)
    except Exception:
        log.exception("pre-warm failed (non-fatal)")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/voices")
def voices():
    return {"voices": VOICES, "default": DEFAULT_VOICE}


@app.post("/tts")
def tts(req: TTSReq):
    if not req.text:
        return Response(status_code=204)

    voice = req.voice if req.voice in VOICES else DEFAULT_VOICE

    chunks = []
    for _gs, _ps, audio in get_pipeline()(req.text, voice=voice, speed=req.speed):
        if audio is None:
            continue
        if hasattr(audio, "detach"):
            audio = audio.detach().cpu().numpy()
        chunks.append(np.asarray(audio, dtype=np.float32))

    if not chunks:
        return Response(status_code=204)

    audio = np.concatenate(chunks)

    # Kokoro occasionally returns samples above 1.0; pull the peak back down so
    # the WAV doesn't clip.
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "8001"))
    uvicorn.run(app, host=host, port=port, log_level="info")
