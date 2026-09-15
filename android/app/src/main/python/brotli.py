# UnityPy imports brotli at module level but only calls it for
# WebGL-style bundles, this game ships LZ4/LZMA. the only android
# wheel chaquopy has is 1.1.0 (CVE-2025-6176), so the package is
# stubbed out like the texture codecs next to it.
def __getattr__(name):
    raise RuntimeError(
        f"brotli.{name} is unavailable on Android; this game's bundles are LZ4/LZMA, not brotli"
    )
