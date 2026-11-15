import traceback

from recover_assets import Recovery


STAGES = (
    ("model", "recover_moc3"),
    ("atlases", "recover_atlases"),
    ("variants", "recover_variants"),
    ("logos", "recover_logos"),
    ("limbs", "recover_limbs"),
    ("hair", "recover_hair_strands"),
    ("decals", "recover_decals"),
    ("items", "recover_item_catalog"),
)


def recover(game_root, output_dir, callback):
    try:
        worker = Recovery(str(game_root), str(output_dir), 2048)
        total = len(STAGES)
        for index, (stage, method) in enumerate(STAGES):
            callback.onProgress(index, total, stage)
            getattr(worker, method)()
        callback.onProgress(total, total, "validate")
        return {"failures": list(worker.failures)}
    except SystemExit as error:
        raise RuntimeError(str(error)) from error
    except Exception as error:
        traceback.print_exc()
        raise RuntimeError(f"asset recovery failed: {error}") from error
