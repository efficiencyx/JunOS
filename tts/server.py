"""
Local TTS sidecar for Omega Chat. Wraps Kokoro-82M behind a small FastAPI
server on :8001. The webapp's js/tts.js calls /tts with a sentence at a
time and plays the returned WAV through an AudioContext.

Requirements:
  - Python 3.10+
  - espeak-ng installed on the system (Kokoro uses it as a fallback G2P).
      Arch:    sudo pacman -S espeak-ng
      Debian:  sudo apt install espeak-ng
      macOS:   brew install espeak-ng
  - pip install -r requirements.txt

Run:
  python server.py
"""

import io
import logging
import os

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tts")

# Lazy-load Kokoro so --help / import errors surface clearly.
_pipeline = None

def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        log.info("loading Kokoro pipeline (lang_code='a' / American English)...")
        _pipeline = KPipeline(lang_code="a")
        log.info("Kokoro ready.")
    return _pipeline

# Voices shipped with Kokoro-82M (subset that covers EN; not all are equally
# trained, but they all load). The frontend uses /voices to populate a dropdown.
VOICES = [
    # American female
    "af_heart", "af_bella", "af_aoede", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "af_alloy",
    "af_jessica",
    # American male
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck",
    # British female
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    # British male
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]
DEFAULT_VOICE = "af_heart"
SAMPLE_RATE = 24000

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TTSReq(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/voices")
def voices():
    return {"voices": VOICES, "default": DEFAULT_VOICE}


@app.post("/tts")
def tts(req: TTSReq):
    text = (req.text or "").strip()
    if not text:
        return Response(status_code=204)

    voice = req.voice if req.voice in VOICES else DEFAULT_VOICE
    pipeline = get_pipeline()

    chunks = []
    try:
        for _gs, _ps, audio in pipeline(text, voice=voice, speed=req.speed):
            if audio is None:
                continue
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            chunks.append(np.asarray(audio, dtype=np.float32))
    except Exception as e:
        log.exception("synthesis failed")
        raise HTTPException(status_code=500, detail=str(e))

    if not chunks:
        return Response(status_code=204)

    audio = np.concatenate(chunks)
    # Light peak normalize to avoid clipping when Kokoro returns >1.0 samples.
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
