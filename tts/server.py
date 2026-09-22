"""
local audio sidecar on :8001. /tts takes one sentence at a time
from js/voice/tts.js and sends back a WAV for its AudioContext.

`engine` picks kokoro (Kokoro-82M, the default, needs
espeak-ng) or pockettts (kyutai-labs pocket-tts, 100M, CPU,
English + 5 languages). /voices lists voices and pocket-tts
languages for the picker. js/voice/voice.js sends a raw WAV
to /stt and faster-whisper transcribes it.

the karaoke half. /separate splits backing and guide vocals
with htdemucs, /transcribe_timed gets whisper to time the words.
Docker runs this half in docker/karaoke.Dockerfile with
SIDECAR_ROLE=karaoke, so it can have GPU torch while voice stays
on CPU. each image only has its own deps and the *_available()
probes turn a missing one into a 503. bare metal runs one
process for both roles.

PHP reaches the `tts` compose service through TTS_URL.
KOKORO_URL still works for older .env files.

the code lives in sidecar/, one module per job. this file only
puts the app together, so every launcher keeps running it the
same way.
Run: python server.py
"""

import logging
import os
import threading

from fastapi import FastAPI

from sidecar import gate, karaoke, state, stt, tts
from sidecar.config import KOKORO_DEFAULT, SIDECAR_ALLOWED_HOSTS, SIDECAR_ROLE, SIDECAR_SECRET, TTS_IDLE_UNLOAD_S
from sidecar.devices import get_sep_device

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("tts")

app = FastAPI()
gate.install(app)
for module in (tts, stt, karaoke):
    app.include_router(module.router)


@app.on_event("startup")
def prewarm():
    # say one tiny thing with Kokoro up front so the first real
    # request doesn't eat the cost of the pipeline plus the default
    # voice starting cold. pocket-tts just warms up on its own first
    # request instead.
    if not SIDECAR_SECRET:
        log.warning("SIDECAR_SECRET is empty, only the Host allowlist (%s) stands "
                    "between this port and anyone who can reach it",
                    ",".join(sorted(SIDECAR_ALLOWED_HOSTS)))
    if SIDECAR_ROLE != "karaoke":
        try:
            for _gs, _ps, _audio in tts.get_pipeline()("Hi.", voice=KOKORO_DEFAULT, speed=1.0):
                pass
            log.info("pre-warm done (engine=kokoro voice=%s)", KOKORO_DEFAULT)
        except Exception:
            log.exception("pre-warm failed (non-fatal)")

    # start the idle clock here, so the time prewarm took doesn't
    # count against it
    state.reset_idle_clock()
    # always, no condition. the reaper also clears out expired
    # separation tokens, and those need cleaning even when idle
    # unloading is off.
    threading.Thread(target=state.reaper, name="tts-reaper", daemon=True).start()
    log.info("sidecar role: %s", SIDECAR_ROLE)
    if TTS_IDLE_UNLOAD_S > 0:
        log.info("model reaper on: idle unload after %.0fs", TTS_IDLE_UNLOAD_S)


@app.get("/health")
def health():
    # `stt` lets the webapp hide the mic button when this build has
    # no whisper, instead of face planting on the first thing you
    # say. it reports whether we can import it, not whether the
    # model is loaded, that happens late.
    return {"ok": True, "role": SIDECAR_ROLE, "stt": stt.stt_available(),
            "sep": karaoke.sep_available(), "device": get_sep_device()}


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "8001"))
    uvicorn.run(app, host=host, port=port, log_level="info")
