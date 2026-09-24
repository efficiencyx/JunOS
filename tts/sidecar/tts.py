import logging
import threading
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

from . import state
from .audio import to_wav
from .config import (DEFAULT_ENGINE, KOKORO_DEFAULT, KOKORO_SAMPLE_RATE, KOKORO_VOICES, POCKET_DEFAULT,
                     POCKET_DEFAULT_LANG, POCKET_LANG_IDS, POCKET_LANGUAGES, POCKET_VOICES, TTS_ENGINES,
                     TTS_MAX_QUEUE, TTS_QUEUE_WAIT_S)
from .devices import get_device

log = logging.getLogger("tts")
router = APIRouter()

# serialises the pocket loads so a /warm preload and a synth at
# the same time can't both pull a checkpoint. held for the whole
# multi second load, so the second caller just waits and reuses
# the result instead of redoing all of it.
_pocket_load_lock = threading.Lock()
_tts_waiting = 0


def get_pipeline():
    # loaded late so a failure at import (missing espeak-ng,
    # whatever) is clear
    if state.pipeline is None:
        from kokoro import KPipeline
        device = get_device()
        log.info("loading Kokoro pipeline (lang_code='a' / American English) on %s...", device)
        state.pipeline = KPipeline(lang_code="a", device=device)
        log.info("Kokoro ready.")
    return state.pipeline


def get_pocket_model(language=POCKET_DEFAULT_LANG):
    # weights only land in HF_HOME once somebody picks pocket-tts.
    # one checkpoint at a time, so a language change reloads it and
    # throws away the per-language voice states.
    with _pocket_load_lock:
        if state.pocket_model is not None and state.pocket_lang != language:
            state.pocket_model = None
            state.pocket_states = {}
            state.free_torch()
        if state.pocket_model is None:
            import inspect
            from pocket_tts import TTSModel
            device = get_device()
            # not every pocket-tts release takes a `device` kwarg.
            # so pass it only when the signature actually has one,
            # otherwise load first and .to(device) after.
            device_via_kwarg = "device" in inspect.signature(TTSModel.load_model).parameters
            kwargs = {"language": language}
            if device_via_kwarg:
                kwargs["device"] = device
            log.info("loading pocket-tts model (%s) on %s...", language, device)
            state.pocket_model = TTSModel.load_model(**kwargs)
            state.pocket_lang = language
            if not device_via_kwarg and device != "cpu" and hasattr(state.pocket_model, "to"):
                try:
                    state.pocket_model.to(device)
                except Exception:
                    log.warning("pocket-tts: could not move model to %s; using its default device", device)
            log.info("pocket-tts ready (lang=%s sample_rate=%s).", language, state.pocket_model.sample_rate)
    return state.pocket_model


def pocket_state(model, voice):
    prompt = state.pocket_states.get(voice)
    if prompt is None:
        prompt = model.get_state_for_audio_prompt(voice)
        state.pocket_states[voice] = prompt
    return prompt


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


@router.get("/voices")
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
    if state.tts_slots.acquire(blocking=False):
        return True
    with state.lock:
        if _tts_waiting >= TTS_MAX_QUEUE:
            return False
        _tts_waiting += 1
    try:
        return state.tts_slots.acquire(timeout=TTS_QUEUE_WAIT_S)
    finally:
        with state.lock:
            _tts_waiting -= 1


@router.post("/tts")
def tts(req: TTSReq):
    if not req.text:
        return Response(status_code=204)

    engine = req.engine if req.engine in TTS_ENGINES else DEFAULT_ENGINE
    if not _acquire_tts_slot():
        return _tts_busy()
    try:
        state.begin_use(engine)
        try:
            if engine == "pockettts":
                result = synth_pocket(req.text, req.voice, req.lang)
            else:
                result = synth_kokoro(req.text, req.voice, req.speed)
        finally:
            state.end_use()
    finally:
        state.tts_slots.release()

    if result is None:
        return Response(status_code=204)

    audio, sample_rate = result
    return Response(
        content=to_wav(audio, sample_rate),
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/warm")
def warm(req: WarmReq):
    # the client warms pocket-tts language weights and voice state
    # while Jun is still writing, so the multi second reload is
    # done before /tts asks. a language change is still a full
    # reload. Kokoro has no language checkpoints, nothing to warm.
    if req.engine != "pockettts":
        return {"ok": True, "warmed": None}
    language = req.lang if req.lang in POCKET_LANG_IDS else POCKET_DEFAULT_LANG
    voice = req.voice if req.voice in POCKET_VOICES else POCKET_DEFAULT
    if not _acquire_tts_slot():
        return _tts_busy()
    try:
        state.begin_use("pockettts")
        try:
            model = get_pocket_model(language)
            pocket_state(model, voice)
        finally:
            state.end_use()
    finally:
        state.tts_slots.release()
    return {"ok": True, "warmed": language}
