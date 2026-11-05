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

The files land in ``attachments/`` in the work item's folder in BugPilot's data
folder, inside the folder the agent is already pointed at.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence

from .safe_paths import (
    DATA_FOLDER_BOUNDARY,
    UnsafePathError,
    generated_file_exists,
    generated_file_names,
    generated_folder_exists,
    refuse_link,
    writable_dir,
)

ATTACHMENTS_DIR = "attachments"

# Per file. A crash dump or a video of the repro is not an attachment, it is a
# download — and copying one into the work item's folder bloats BugPilot's data
# folder.
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

# Past this it is a directory, not a set of attachments, and an agent handed
# thirty files reads none of them properly.
MAX_ATTACHMENTS = 10

# A description says why a file matters — a sentence or two — and is not a
# second bug description. Longer text is cut, not refused: the file is still
# worth attaching.
MAX_ATTACHMENT_NOTE_CHARS = 500


@dataclass
class AttachmentResult:
    """What was copied, and what was not and why."""

    # Names inside `attachments/`, in the order they were given.
    copied: list[str] = field(default_factory=list)
    # ``(what the developer asked for, why it did not make it)``.
    skipped: list[tuple[str, str]] = field(default_factory=list)
    # The developer's description of a copied file, by its name in
    # `attachments/`. Only files that arrived and were described appear here.
    notes: dict[str, str] = field(default_factory=dict)

    @property
    def relative_paths(self) -> list[str]:
        return [f"{ATTACHMENTS_DIR}/{name}" for name in self.copied]


def normalize_attachment_note(text: str | None) -> str:
    """A description as the task file carries it: one line, bounded.

    One line because it sits under a heading in ``task.md``: a pasted newline
    followed by ``##`` must not become a section of its own.
    """
    if not text:
        return ""
    return " ".join(text.split())[:MAX_ATTACHMENT_NOTE_CHARS].rstrip()


def copy_attachments(
    target: Path,
    paths: Sequence[str],
    descriptions: Sequence[str] | None = None,
    *,
    folder: Callable[[], Path] | None = None,
) -> AttachmentResult:
    """Copy each path into ``target/attachments/``.

    ``descriptions`` pairs with ``paths`` by position — the Nth describes the
    Nth file; a blank one, or none, means no description. A description follows
    its file to the name it was copied under, and is dropped with a file that
    did not make it.

    ``folder`` makes ``attachments/`` ready and returns it: in a run, storage's
    own creator (``0700``, every component checked before and after, compared
    with the canonical path; plan §8.3). Without it the folder is made the same
    way under ``target``. It is made once, before the first file that is
    copied, so a run whose files are all skipped leaves no empty folder.

    Never raises for a bad input: a missing or oversized file costs itself and
    nothing else, because losing a whole investigation over one unreadable
    screenshot would be the wrong trade. The caller surfaces ``skipped``.
    """
    result = AttachmentResult()
    if not paths:
        return result

    ready = folder or (lambda: writable_dir(target, (ATTACHMENTS_DIR,), mode=0o700, boundary=DATA_FOLDER_BOUNDARY))
    directory: Path | None = None
    used: set[str] = set()
    described = list(descriptions or [])

    for index, raw in enumerate(paths):
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
            # Never into, or through, a link: the folder (made ready and checked once) and
            # the file are checked before the copy, which would follow either.
            if directory is None:
                directory = ready()
            # copyfile, not copy2: the metadata of the developer's original is
            # theirs, and a copied mtime makes the artifact look older than the
            # run that produced it.
            shutil.copyfile(source, refuse_link(directory / name, boundary=DATA_FOLDER_BOUNDARY))
        except OSError as exc:
            result.skipped.append((raw, f"could not be copied: {exc.strerror or exc}"))
            continue

        used.add(name.lower())
        result.copied.append(name)
        note = normalize_attachment_note(described[index] if index < len(described) else None)
        if note:
            result.notes[name] = note

    return result


def merge_attachment_notes(previous: Mapping[str, str], result: AttachmentResult) -> dict[str, str]:
    """The descriptions a work item carries after this run.

    A file this run copied carries this run's description, or none — the
    developer may have cleared it. A file from an earlier run that this one did
    not re-copy keeps the description it had, because it is still on disk and
    the task file still names it.
    """
    merged = dict(previous)
    for name in result.copied:
        if name in result.notes:
            merged[name] = result.notes[name]
        else:
            merged.pop(name, None)
    return merged


#: Control characters, line and paragraph separators and bidirectional controls:
#: never part of an attachment's name as the task names it.
_UNSAFE_IN_NAME = re.compile("[\x00-\x1f\x7f-\x9f  ‪-‮⁦-⁩]")


def _unique_name(name: str, used: set[str]) -> str:
    """A file name that does not collide with one already copied.

    Two attachments chosen from different directories can share a basename, and
    the second silently overwriting the first is the kind of loss nobody
    notices until the agent quotes the wrong log. Compared case-insensitively,
    because the artifact directory may live on Windows.
    """
    # `Path.name` cannot contain a separator, so this cannot escape the
    # directory; the fallback only matters for a pathological empty name.
    # The name is also a heading in task.md: a line break or a control
    # character in it (possible outside Windows) could start a line of its own.
    candidate = _UNSAFE_IN_NAME.sub("_", name) or "attachment"
    if candidate.lower() not in used:
        return candidate

    stem = Path(candidate).stem
    suffix = Path(candidate).suffix
    for index in range(2, MAX_ATTACHMENTS + 2):
        attempt = f"{stem}-{index}{suffix}"
        if attempt.lower() not in used:
            return attempt
    return f"{stem}-{len(used) + 1}{suffix}"


def is_plain_attachment_name(name: str) -> bool:
    """A single file name: no separator, no drive, not ``.``/``..``, nothing that leaves the folder."""
    return (
        bool(name)
        and name not in {".", ".."}
        and "/" not in name
        and "\\" not in name
        and ":" not in name
        and Path(name).name == name
    )


def remove_attachments(target: Path, names: Sequence[str]) -> list[str]:
    """Delete these files from ``target/attachments/``, and nothing else; return what went.

    Only ever called with names BugPilot itself recorded as copied — never with
    whatever happens to be in the folder — and each one is refused unless it is
    a plain file name naming a regular file (or a link, which is removed and not
    followed) directly inside that folder, and the folder is inside ``target``.
    A name that fails any check is skipped, not "cleaned": it is not ours to
    guess about.
    """
    directory = target / ATTACHMENTS_DIR
    try:
        if not directory.is_dir() or directory.resolve().parent != target.resolve():
            return []
    except OSError:
        return []
    removed: list[str] = []
    for name in names:
        if not is_plain_attachment_name(name):
            continue
        candidate = directory / name
        try:
            if candidate.is_symlink() or candidate.is_file():
                candidate.unlink()
                removed.append(name)
        except OSError:
            # Locked or already gone: the record no longer names it either way.
            continue
    return removed


def listed_attachments(target: Path, recorded: Sequence[str] | None) -> list[str]:
    """The attachments a task file names: the recorded selection, else the folder.

    A work item prepared by the extension records which files it currently
    has (``guidance.attachment_files``); then only those are named — and only
    the ones still on disk. One prepared before the record existed, or only
    ever by an additive CLI run, falls back to reading the folder as before.

    Never through a link (O-1): a link or junction at the attachments folder,
    or on the way to it, is refused; a recorded name that is a link, a junction
    or anything but a regular file is not named, whatever it points at, as a
    name that is not a file never was.
    """
    if recorded is None:
        return attachment_names(target)
    base, directory = _repository_of(target), target / ATTACHMENTS_DIR
    if not generated_folder_exists(base, directory):
        return []
    named = [name for name in recorded if is_plain_attachment_name(name) and _regular_file(base, directory / name)]
    generated_folder_exists(base, directory)  # again: a folder made a link since the first look is refused
    return named


def attachment_names(target: Path) -> list[str]:
    """What is in the attachments directory now, sorted.

    Read from disk rather than remembered, so a `--resume` run lists what a
    previous run copied. Only regular files, and never through a link (O-1): a
    link or junction at the folder, or on the way to it, is refused; an entry
    that is a link, a junction or anything but a regular file is not listed,
    whatever it points at and whether that exists.
    """
    names = generated_file_names(_repository_of(target), target / ATTACHMENTS_DIR)
    return [] if names is None else sorted(names)


def _repository_of(target: Path) -> Path:
    """The repository's folder in BugPilot's data folder, which ``target`` (``work/<id>``) is two levels below."""
    return target.parent.parent


def _regular_file(base: Path, path: Path) -> bool:
    """Whether ``path`` is a regular file as it stands; a link, a junction or anything else is not, and says nothing."""
    try:
        return generated_file_exists(base, path)
    except UnsafePathError:
        return False
