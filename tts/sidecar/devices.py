import logging
import os

log = logging.getLogger("tts")

_device = None


def get_device():
    # TTS_DEVICE: cpu | cuda | auto. auto is the default. it takes
    # CUDA when the torch wheel has it, ROCm included since that
    # shows up as torch.cuda too. the voice image ships CPU torch
    # anyway, only karaoke gets GPU torch, from the nvidia and amd
    # compose overlays. a custom voice build can override
    # TTS_TORCH_INDEX.
    global _device
    if _device is None:
        choice = os.environ.get("TTS_DEVICE", "auto").strip().lower()
        if choice in ("cpu", "cuda"):
            _device = choice
        else:
            # torch.cuda.is_available() is NOT enough on ROCm. it
            # happily says True on cards whose gfx arch has no
            # kernels shipped, which is most consumer RDNA without
            # HSA_OVERRIDE_GFX_VERSION. then the first real kernel
            # dies with "HIP error: invalid device function". so we
            # run a tiny matmul and let "auto" fall back to cpu
            # instead of nuking every request.
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
    # SEP_DEVICE: cpu | cuda | auto. this one stays dumb, unlike
    # get_device(). a separation job is one big call, so a bad GPU
    # just falls back per job in _apply_demucs and we don't need to
    # probe anything here.
    choice = os.environ.get("SEP_DEVICE", "auto").strip().lower()
    if choice in ("cpu", "cuda"):
        return choice
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"
