def __getattr__(name):
    raise RuntimeError(f"FMOD audio codec {name} is unavailable on Android")
