import os
import shutil
import tarfile


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
