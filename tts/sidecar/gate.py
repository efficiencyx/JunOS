import hmac
import logging

from fastapi import Request
from fastapi.responses import JSONResponse

from .config import JSON_PATHS, RAW_AUDIO_PATHS, SIDECAR_ALLOWED_HOSTS, SIDECAR_SECRET

log = logging.getLogger("tts")


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
        if path in RAW_AUDIO_PATHS and not (ct.startswith("audio/") or ct == "application/octet-stream"):
            return "unsupported_media_type"
        if path in JSON_PATHS and ct != "application/json":
            return "unsupported_media_type"
    return None


def install(app):
    @app.middleware("http")
    async def gate(request: Request, call_next):
        # runs before any handler reads the body, so a rejected request
        # costs a header parse and nothing else
        why = _gate(request)
        if why is not None:
            log.warning("refused %s %s: %s", request.method, request.url.path, why)
            status = 415 if why == "unsupported_media_type" else 403
            return JSONResponse({"error": why}, status_code=status)
        return await call_next(request)

    @app.exception_handler(Exception)
    async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
        # anything left becomes a plain 500. never leak a traceback.
        log.exception("unhandled exception on %s %s", request.method, request.url.path)
        path = request.url.path
        if path in ("/stt", "/transcribe_timed"):
            err = "transcription_failed"
        elif path.startswith("/separate"):
            err = "separation_failed"
        else:
            err = "synthesis_failed"
        return JSONResponse({"error": err}, status_code=500)
