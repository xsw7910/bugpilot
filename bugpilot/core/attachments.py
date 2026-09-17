"""Files a developer hands to the agent alongside the prepared package.

A crash log, a screenshot of the broken dialog, a config that reproduces it —
things that are not in the repository and not in the Jira description, and that
often decide whether a diagnosis is right.

Two rules shape this module, and both come from the same principle the rest of
the pipeline follows: **the agent must never be told about something it cannot
read.**

 1. An attachment that could not be copied is not listed in the task file. It
    is reported back instead, so the developer learns it did not make it rather
    than believing the agent saw it.
 2. Copying is byte-for-byte and makes no encoding assumption. A PNG is a PNG;
    a log written by a Windows tool in cp1252 stays exactly as it was.

The files land in ``.ai/<work_item>/attachments/``, inside the directory the
agent is already pointed at, so nothing has to be given a path outside it.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

ATTACHMENTS_DIR = "attachments"

# Per file. A crash dump or a video of the repro is not an attachment, it is a
# download — and copying one into `.ai/` bloats the repository the artifacts
# directory lives in.
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

# Past this it is a directory, not a set of attachments, and an agent handed
# thirty files reads none of them properly.
MAX_ATTACHMENTS = 10


@dataclass
class AttachmentResult:
    """What was copied, and what was not and why."""

    # Names inside `attachments/`, in the order they were given.
    copied: list[str] = field(default_factory=list)
    # ``(what the developer asked for, why it did not make it)``.
    skipped: list[tuple[str, str]] = field(default_factory=list)

    @property
    def relative_paths(self) -> list[str]:
        return [f"{ATTACHMENTS_DIR}/{name}" for name in self.copied]


def copy_attachments(target: Path, paths: Sequence[str]) -> AttachmentResult:
    """Copy each path into ``target/attachments/``.

    Never raises for a bad input: a missing or oversized file costs itself and
    nothing else, because losing a whole investigation over one unreadable
    screenshot would be the wrong trade. The caller surfaces ``skipped``.
    """
    result = AttachmentResult()
    if not paths:
        return result

    directory = target / ATTACHMENTS_DIR
    used: set[str] = set()

    for raw in paths:
        if len(result.copied) >= MAX_ATTACHMENTS:
            result.skipped.append((raw, f"more than {MAX_ATTACHMENTS} attachments"))
            continue

        source = Path(raw).expanduser()
        try:
            if not source.is_file():
                result.skipped.append((raw, "not a file"))
                continue
            size = source.stat().st_size
        except OSError as exc:
            result.skipped.append((raw, f"could not be read: {exc.strerror or exc}"))
            continue

        if size > MAX_ATTACHMENT_BYTES:
            megabytes = MAX_ATTACHMENT_BYTES // (1024 * 1024)
            result.skipped.append((raw, f"larger than {megabytes} MB"))
            continue

        name = _unique_name(source.name, used)
        try:
            directory.mkdir(parents=True, exist_ok=True)
            # copyfile, not copy2: the metadata of the developer's original is
            # theirs, and a copied mtime makes the artifact look older than the
            # run that produced it.
            shutil.copyfile(source, directory / name)
        except OSError as exc:
            result.skipped.append((raw, f"could not be copied: {exc.strerror or exc}"))
            continue

        used.add(name.lower())
        result.copied.append(name)

    return result


def _unique_name(name: str, used: set[str]) -> str:
    """A file name that does not collide with one already copied.

    Two attachments chosen from different directories can share a basename, and
    the second silently overwriting the first is the kind of loss nobody
    notices until the agent quotes the wrong log. Compared case-insensitively,
    because the artifact directory may live on Windows.
    """
    # `Path.name` cannot contain a separator, so this cannot escape the
    # directory; the fallback only matters for a pathological empty name.
    candidate = name or "attachment"
    if candidate.lower() not in used:
        return candidate

    stem = Path(candidate).stem
    suffix = Path(candidate).suffix
    for index in range(2, MAX_ATTACHMENTS + 2):
        attempt = f"{stem}-{index}{suffix}"
        if attempt.lower() not in used:
            return attempt
    return f"{stem}-{len(used) + 1}{suffix}"


def attachment_names(target: Path) -> list[str]:
    """What is in the attachments directory now, sorted.

    Read from disk rather than remembered, so a `--resume` run lists what a
    previous run copied.
    """
    directory = target / ATTACHMENTS_DIR
    if not directory.is_dir():
        return []
    return sorted(path.name for path in directory.iterdir() if path.is_file())
