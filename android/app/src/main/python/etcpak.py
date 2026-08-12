def __getattr__(name):
    raise RuntimeError(
        f"Unity texture encoder {name} is unavailable on Android; select the official Windows or Linux game ZIP"
    )
