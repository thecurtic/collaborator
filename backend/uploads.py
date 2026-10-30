"""Uploads streamed to disk: a large recording or video is never held in
memory whole. The bytes go to a temporary file beside their final home
(same filesystem, so moving it there is a rename) and are hashed on the way,
since stored files are named by their sha256."""

import hashlib
import os
import tempfile
from typing import Tuple

_CHUNK = 1024 * 1024


async def receive(upload, directory: str, max_mb: float) -> Tuple[str, str, int]:
    """(temp path, sha256, size) of an UploadFile written into `directory`.
    Raises ValueError when it's empty or over `max_mb` (nothing is left
    behind). The caller moves the temp file into place or removes it."""
    os.makedirs(directory, exist_ok=True)
    limit = max_mb * 1024 * 1024
    digest = hashlib.sha256()
    size = 0
    fd, tmp = tempfile.mkstemp(prefix=".upload-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await upload.read(_CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise ValueError(f"files are limited to {max_mb:g} MB")
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise ValueError("empty file")
    except BaseException:
        discard(tmp)
        raise
    return tmp, digest.hexdigest(), size


def place(tmp: str, path: str) -> None:
    """Move a received file to `path`, or drop it when identical bytes are
    already there."""
    if os.path.exists(path):
        discard(tmp)
    else:
        os.replace(tmp, path)


def discard(tmp: str) -> None:
    try:
        os.remove(tmp)
    except OSError:
        pass
