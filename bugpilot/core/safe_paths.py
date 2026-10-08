"""Link-safe paths for the things BugPilot deletes.

BugPilot deletes only what it generated, inside the repository it was run in:
``.ai/<work item>/`` and, when asked, ``.ai_memory/bugs/<work item>.md``. A
symbolic link or a Windows junction anywhere on that path would turn "delete
this work item's folder" into "delete whatever the link points at", so every
destructive path is checked here, component by component, before anything is
removed.

``Path.resolve()`` cannot answer the question on its own, and that is exactly
how ``clean`` once escaped: resolving both the boundary and the target follows
the same link, the two agree, and the containment check passes while the
deletion lands outside the repository. The check is therefore made on each
component *as it is* (``lstat``, never followed), and then the resolved target
is compared with the path it should be.

What counts as a link, stated precisely: a symbolic link on any platform; on
Windows, any reparse point whose tag is a *name surrogate* — a symbolic link, a
directory junction, or anything else that stands in for another path. Reparse
points that hold their own data (cloud-file placeholders, deduplicated files)
are not links and are deleted normally.
"""

from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path
from typing import Sequence

# IsReparseTagNameSurrogate(): bit 29 of a reparse tag marks a tag that names
# another file or directory — junctions and symbolic links among them.
_NAME_SURROGATE_BIT = 0x20000000
_FILE_ATTRIBUTE_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class UnsafePathError(ValueError):
    """A deletion refused before anything was deleted.

    A ``ValueError`` so every entry point that already reports a bad argument
    as one sentence (``ERROR: …`` in a terminal, ``INVALID_INPUT`` in JSON)
    reports this the same way, never as a traceback.
    """


def is_link_or_junction(path: Path) -> bool:
    """Whether ``path`` itself is a link that sends reads and writes elsewhere.

    Asked of the path as it stands, never followed. A path that does not exist
    is not a link.
    """
    try:
        info = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    if getattr(info, "st_file_attributes", 0) & _FILE_ATTRIBUTE_REPARSE_POINT:
        tag = getattr(info, "st_reparse_tag", 0)
        # An unknown tag is treated as a link: refusing a deletion costs the
        # developer one manual step, following one can cost them anything.
        if tag == 0 or tag & _NAME_SURROGATE_BIT:
            return True
    # Belt and braces where the interpreter knows about junctions (3.12+).
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction()) if callable(is_junction) else False


def owned_path(repo_root: Path, parts: Sequence[str]) -> Path:
    """``repo_root / parts``, checked to be a BugPilot-owned path safe to delete.

    Raises :class:`UnsafePathError` when any component below the repository
    root — ``.ai``, ``.ai/<id>``, … — is a link or junction, or when the target
    resolves anywhere other than where it should be. The repository root itself
    may sit behind a link: that is where the developer chose to work.
    """
    if not parts or any(part in ("", ".", "..") or "/" in part or "\\" in part for part in parts):
        raise UnsafePathError(f"Refusing to delete an invalid generated path: {'/'.join(parts)!r}.")
    display = "/".join(parts)
    current = repo_root
    for index, part in enumerate(parts):
        current = current / part
        if is_link_or_junction(current):
            link = "/".join(parts[: index + 1])
            raise UnsafePathError(
                f"Refusing to delete {display}: {link} is a symbolic link or junction. "
                "BugPilot deletes only real directories it generated inside this repository, "
                "and never through a link. Nothing was deleted."
            )
    target = repo_root.joinpath(*parts)
    if os.path.lexists(target):
        expected = repo_root.resolve().joinpath(*parts)
        if os.path.normcase(str(target.resolve())) != os.path.normcase(str(expected)):
            raise UnsafePathError(
                f"Refusing to delete {display}: it resolves outside this repository's generated "
                "files. Nothing was deleted."
            )
    return target


def remove_owned_path(path: Path) -> bool:
    """Delete a path :func:`owned_path` returned. True if anything was there.

    Links *inside* the tree are removed as links, never followed: ``rmtree``
    unlinks a symbolic link and, on Windows, removes a junction without
    touching what it points at.
    """
    if not os.path.lexists(path):
        return False
    if path.is_dir() and not is_link_or_junction(path):
        shutil.rmtree(path)
    else:
        path.unlink()
    return True
