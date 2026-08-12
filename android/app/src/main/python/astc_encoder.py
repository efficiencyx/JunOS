def __getattr__(name):
    raise RuntimeError(
        f"ASTC codec {name} is unavailable on Android; this game's textures are BC7/DXT5/RGBA32"
    )
