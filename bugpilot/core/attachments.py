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
from typing import Mapping, Sequence

ATTACHMENTS_DIR = "attachments"

# Per file. A crash dump or a video of the repro is not an attachment, it is a
# download — and copying one into `.ai/` bloats the repository the artifacts
# directory lives in.
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
    target: Path, paths: Sequence[str], descriptions: Sequence[str] | None = None
) -> AttachmentResult:
    """Copy each path into ``target/attachments/``.

    ``descriptions`` pairs with ``paths`` by position — the Nth describes the
    Nth file; a blank one, or none, means no description. A description follows
    its file to the name it was copied under, and is dropped with a file that
    did not make it.

    Never raises for a bad input: a missing or oversized file costs itself and
    nothing else, because losing a whole investigation over one unreadable
    screenshot would be the wrong trade. The caller surfaces ``skipped``.
    """
    result = AttachmentResult()
    if not paths:
        return result

    directory = target / ATTACHMENTS_DIR
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
    """
    if recorded is None:
        return attachment_names(target)
    directory = target / ATTACHMENTS_DIR
    return [name for name in recorded if is_plain_attachment_name(name) and (directory / name).is_file()]


def attachment_names(target: Path) -> list[str]:
    """What is in the attachments directory now, sorted.

    Read from disk rather than remembered, so a `--resume` run lists what a
    previous run copied.
    """
    directory = target / ATTACHMENTS_DIR
    if not directory.is_dir():
        return []
    return sorted(path.name for path in directory.iterdir() if path.is_file())
