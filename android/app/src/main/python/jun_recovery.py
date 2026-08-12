import traceback

from recover_assets import Recovery


STAGES = (
    ("model", "Recovering Live2D model", "recover_moc3"),
    ("atlases", "Recovering base textures", "recover_atlases"),
    ("variants", "Recovering wardrobe variants", "recover_variants"),
    ("logos", "Recovering clothing logos", "recover_logos"),
    ("limbs", "Recovering limb variants", "recover_limbs"),
    ("hair", "Recovering hair variants", "recover_hair_strands"),
    ("items", "Building wardrobe catalog", "recover_item_catalog"),
)


def recover(game_root, output_dir, callback):
    try:
        worker = Recovery(str(game_root), str(output_dir), 2048)
        total = len(STAGES)
        for index, (_, message, method) in enumerate(STAGES):
            callback.onProgress(index, total, message)
            getattr(worker, method)()
        callback.onProgress(total, total, "Validating recovered assets")
        return {"failures": list(worker.failures)}
    except SystemExit as error:
        raise RuntimeError(str(error)) from error
    except Exception as error:
        traceback.print_exc()
        raise RuntimeError(f"asset recovery failed: {error}") from error
