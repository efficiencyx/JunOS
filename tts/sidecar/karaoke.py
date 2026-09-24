import io
import json
import logging
import os
import secrets
import shutil
import tempfile
import time

import soundfile as sf
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import state
from .audio import AudioDurationExceeded, decode_audio, to_wav
from .config import JSON_MAX_BYTES, SEP_MAX_BYTES, SEP_MAX_DURATION_S, SEP_MAX_JOBS, STT_LANG
from .devices import get_sep_device
from .gate import BodyTooLarge, read_body
from .stt import get_whisper, stt_available

log = logging.getLogger("tts")
router = APIRouter()

_sep_ok = None


def sep_available():
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
    if state.separator is None:
        from demucs.pretrained import get_model
        device = get_sep_device()
        log.info("loading Demucs (htdemucs) on %s...", device)
        state.separator = get_model("htdemucs")
        state.separator.to(device)
        state.separator.eval()
        log.info("Demucs ready (sources=%s, sr=%s).", state.separator.sources, state.separator.samplerate)
    return state.separator


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
            state.free_torch()
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


@router.post("/separate")
async def separate(request: Request):
    if not sep_available():
        return JSONResponse({"error": "sep_unavailable"}, status_code=503)

    try:
        body = await read_body(request, SEP_MAX_BYTES)
    except BodyTooLarge:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"error": "empty_audio"}, status_code=400)
    return await run_in_threadpool(_separate_sync, body)


def _separate_sync(body):
    if not state.sep_slots.acquire(blocking=False):
        return JSONResponse({"error": "sep_busy"}, status_code=429, headers={"Retry-After": "5"})
    # everything past the acquire lives in the try. one slot, so a
    # throw between acquire and try (torch missing, begin_use
    # blowing up) leaks it and separation answers 429 until the
    # container restarts.
    try:
        import torch
        state.begin_use("demucs")
        try:
            model = get_separator()
            sr = model.samplerate
            try:
                wav = decode_audio(body, sr, model.audio_channels, SEP_MAX_DURATION_S)
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
            with state.lock:
                state.sep_tokens[token] = {"dir": d, "created_at": time.monotonic(), "fetched": set()}
                evicted = []
                while len(state.sep_tokens) > SEP_MAX_JOBS:
                    oldest = min(state.sep_tokens, key=lambda t: state.sep_tokens[t]["created_at"])
                    evicted.append(state.sep_tokens.pop(oldest)["dir"])
            for old in evicted:
                shutil.rmtree(old, ignore_errors=True)

            lyrics = []
            if stt_available():
                _, lyrics = _whisper_words(io.BytesIO(to_wav(vocals.mean(0).numpy(), sr)))
        finally:
            state.end_use()
    finally:
        state.sep_slots.release()

    log.info("separate: %d bytes dur=%.1fs words=%d", len(body), duration, len(lyrics))
    return JSONResponse({"token": token, "duration": duration, "lyrics": lyrics})


@router.post("/separate/stem")
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
    with state.lock:
        info = state.sep_tokens.get(token)
    if info is None:
        return JSONResponse({"error": "unknown_token"}, status_code=404)
    path = os.path.join(info["dir"], fname)
    if not os.path.exists(path):
        return JSONResponse({"error": "unknown_stem"}, status_code=404)
    with open(path, "rb") as f:
        data = await run_in_threadpool(f.read)
    with state.lock:
        info["fetched"].add(which)
        done = {"instrumental", "guide"} <= info["fetched"]
        if done:
            state.sep_tokens.pop(token, None)
    if done:
        shutil.rmtree(info["dir"], ignore_errors=True)
    return Response(content=data, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.post("/transcribe_timed")
async def transcribe_timed(request: Request):
    if not stt_available():
        return JSONResponse({"error": "stt_unavailable"}, status_code=503)

    try:
        body = await read_body(request, SEP_MAX_BYTES)
    except BodyTooLarge:
        return JSONResponse({"error": "audio_too_large"}, status_code=413)
    if not body:
        return JSONResponse({"text": "", "words": []})
    return await run_in_threadpool(_transcribe_timed_sync, body)


def _transcribe_timed_sync(body):
    if not state.stt_slots.acquire(blocking=False):
        return JSONResponse({"error": "stt_busy"}, status_code=429, headers={"Retry-After": "2"})
    try:
        state.begin_use("demucs")
        try:
            try:
                audio = decode_audio(body, 16000, 1, SEP_MAX_DURATION_S)[0]
            except AudioDurationExceeded:
                return JSONResponse({"error": "audio_too_long"}, status_code=413)
            except Exception as e:
                log.info("transcribe_timed: invalid audio: %s", e)
                return JSONResponse({"error": "invalid_audio"}, status_code=400)
            text, words = _whisper_words(audio)
        finally:
            state.end_use()
    finally:
        state.stt_slots.release()
    log.info("transcribe_timed: %d bytes -> %d words", len(body), len(words))
    return JSONResponse({"text": text, "words": words})
