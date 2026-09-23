import logging
import os

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import state
from .audio import AudioDurationExceeded, decode_audio
from .config import STT_LANG, STT_MAX_BYTES, STT_MAX_DURATION_S
from .gate import BodyTooLarge, read_body

log = logging.getLogger("tts")
router = APIRouter()

_whisper = None
_stt_ok = None


def stt_available():
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


@router.post("/stt")
async def stt(request: Request):
    # js/voice/voice.js posts raw 16kHz mono PCM16 WAV, so no
    # python-multipart is needed. PyAV bundles ffmpeg libraries and
    # accepts other audio containers too, without an ffmpeg binary.
    if not stt_available():
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
    if not state.stt_slots.acquire(blocking=False):
        return JSONResponse({"error": "stt_busy"}, status_code=429, headers={"Retry-After": "2"})
    try:
        try:
            audio = decode_audio(body, 16000, 1, STT_MAX_DURATION_S)[0]
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
        state.stt_slots.release()
    # NOT the text. this log outlives a factory reset and what she
    # heard is nobody's business. STT_LOG_TRANSCRIPTS=1 for a
    # debugging session, then turn it back off.
    if os.environ.get("STT_LOG_TRANSCRIPTS") == "1":
        log.info("stt: %d bytes -> %r", len(body), text)
    else:
        log.info("stt: %d bytes -> %d chars", len(body), len(text))
    return JSONResponse({"text": text})
