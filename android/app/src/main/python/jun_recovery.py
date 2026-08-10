import os
import shutil
import tarfile
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


def extract_voice(archives, output_dir):
    root = os.path.realpath(output_dir)
    os.makedirs(root, exist_ok=True)
    count = 0
    expanded = 0
    for archive in archives:
        with tarfile.open(str(archive), "r:bz2") as source:
            for member in source:
                if not member.isfile() and not member.isdir():
                    raise RuntimeError("voice archive contains an unsupported entry")
                target = os.path.realpath(os.path.join(root, member.name))
                if target != root and not target.startswith(root + os.sep):
                    raise RuntimeError("voice archive contains an unsafe path")
                count += 1
                expanded += max(0, member.size)
                if count > 20000 or expanded > 2 * 1024 * 1024 * 1024:
                    raise RuntimeError("voice archive exceeds the extraction limit")
                if member.isdir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                stream = source.extractfile(member)
                if stream is None:
                    raise RuntimeError("voice archive entry could not be read")
                with stream, open(target, "wb") as destination:
                    shutil.copyfileobj(stream, destination, 1024 * 1024)
