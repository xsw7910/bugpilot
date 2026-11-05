"""Repository settings: where a repository's own BugPilot settings live, and the one way to reach them.

0.1.6 (plan §14.3, Batch 2B-3a). A repository's settings are the developer's own
for that repository, kept in its namespace in BugPilot's data folder, never in
the repository::

    <data folder>/repositories/<repository id>/settings/instructions.md          Project Instructions
    <data folder>/repositories/<repository id>/settings/project_settings.json    project settings
    <data folder>/repositories/<repository id>/settings/repository_profile.json  the Repository Profile
    <data folder>/repositories/<repository id>/settings/fix_modes/<id>.json      project Fix Modes

They are not shared through the repository (US-D9). The 0.1.5 ``.bugpilot/``
folder is never read, copied or deleted. The namespace is the repository's
path's (§7.2): a different repository later created at exactly the same path
inherits it (T-15, an accepted limitation; nothing here can tell).

Every consumer reaches storage through this module, so one error rule holds for
all of them (F2-S, owner decision B-2):

- **A policy refusal stays a refusal.** A data folder inside the repository or
  a Git working tree, a link or a non-folder on the way, a record that names
  another repository or cannot be read as one: storage's ``StorageError``,
  unchanged, which every entry point reports as ``INVALID_INPUT``.
- **Unavailability is carried as** :class:`~bugpilot.core.errors.StorageAccessError`:
  a ``storage.StorageUnavailable`` (a record that cannot be read just now) and
  an ``OSError`` from a storage call or a settings file's own write. One
  sentence in display form; each command reports it with the code it gave the
  same failure in 0.1.5 (M-1).
- **A file that cannot be read is the reader's to report** (Option C, M2): a
  :class:`FileReadError`, an ``OSError`` at the file itself, passes through
  unchanged, so each reader keeps its own handling of an unreadable file (a
  warning, the defaults), while a folder on the way that cannot be read is
  still a ``StorageAccessError``.
- **Nothing else is caught** here: no ``ValueError``, no other ``StorageError``,
  no ``Exception``.

The reads go through storage's readers, which follow no link
(:meth:`~bugpilot.core.storage.RepositoryStorage.read_settings` and the Fix Mode
readers): a consumer gets a file's bytes, never a path to open. A read creates
nothing. A write makes the namespace ready first (``ensure()``: its folder and
identity record), then writes the file inside it.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from . import storage
from .artifact_io import atomic_write_text
from .errors import StorageAccessError

FIX_MODES_DIR_NAME = "fix_modes"

#: A file a read reached but could not open or read (storage's ``StorageFileReadError``), for the readers that
#: may not import storage themselves.
FileReadError = storage.StorageFileReadError

_T = TypeVar("_T")


def guarded(action: str, shown: Callable[[], str], call: Callable[[], _T]) -> _T:
    """``call()``, with storage unavailability carried as one sentence (F2-S); every other error unchanged.

    ``shown`` names the place, in display form, for an ``OSError`` that has no
    sentence of its own; it is called only then.
    """
    try:
        return call()
    except storage.StorageUnavailable as error:
        raise StorageAccessError(str(error)) from None
    except (StorageAccessError, FileReadError):
        raise  # already one sentence; or the file itself, which its reader reports
    except OSError as error:
        raise StorageAccessError.during(action, shown(), error) from None


def _namespace(repo_root: Path) -> storage.RepositoryStorage:
    """The repository's namespace: its identity resolved, nothing examined or created."""
    return storage.repository_storage(repo_root)


def _settings_dir(namespace: storage.RepositoryStorage) -> Path:
    return Path(namespace.diagnostics()["repository_dir"]) / "settings"


def shown_path(repo_root: Path, name: str) -> str:
    """A settings file as messages name it: ``~/.bugpilot/repositories/<id>/settings/<name>`` (US-D22)."""
    return storage.display_path(_settings_dir(_namespace(repo_root)) / name)


def settings_file(repo_root: Path, name: storage.SettingsName, *, create: bool) -> Path:
    """``settings/<name>``, checked by storage; ``create=True`` makes the namespace ready to write it."""
    namespace = _namespace(repo_root)
    return guarded(
        "prepare" if create else "read",
        lambda: storage.display_path(_settings_dir(namespace)),
        lambda: namespace.settings_file(name, create=create),
    )


def fix_modes_dir(repo_root: Path, *, create: bool) -> Path:
    """``settings/fix_modes``: the repository's project Fix Modes, checked by storage."""
    namespace = _namespace(repo_root)
    return guarded(
        "prepare" if create else "read",
        lambda: storage.display_path(_settings_dir(namespace) / FIX_MODES_DIR_NAME),
        lambda: namespace.fix_modes_dir(create=create),
    )


def read_settings(repo_root: Path, name: storage.SettingsName, *, limit: int) -> storage.SettingsContent:
    """``settings/<name>``, read without following a link (storage's held read; Option C, M2). Creates nothing.

    :func:`settings_file`'s checks and words. A folder on the way that cannot be read is a
    ``StorageAccessError``, worded as :func:`settings_file` words it; the file's own failure is a
    :class:`FileReadError` for the caller to report.
    """
    namespace = _namespace(repo_root)
    return guarded(
        "read",
        lambda: storage.display_path(_settings_dir(namespace)),
        lambda: namespace.read_settings(name, limit=limit),
    )


def fix_mode_names(repo_root: Path) -> list[str]:
    """The ``.json`` names in the project Fix Mode folder, sorted, listed without following a link."""
    namespace = _namespace(repo_root)
    return guarded(
        "read",
        lambda: storage.display_path(_settings_dir(namespace) / FIX_MODES_DIR_NAME),
        namespace.fix_mode_names,
    )


def read_fix_mode(repo_root: Path, file_name: str, *, limit: int | None) -> storage.SettingsContent:
    """One project Fix Mode file, read without following a link; a link there is the state ``link``."""
    namespace = _namespace(repo_root)
    return guarded(
        "read",
        lambda: storage.display_path(_settings_dir(namespace) / FIX_MODES_DIR_NAME),
        lambda: namespace.read_fix_mode(file_name, limit=limit),
    )


def require_readable(repo_root: Path, *names: storage.SettingsName) -> None:
    """The checks a read of each named file makes, before a command writes anything else (R-PRE).

    A command that writes elsewhere and then reads these files must meet a
    refusal first, so that its sentence ("Nothing was read or written") stays
    true. Creates nothing.
    """
    for name in names:
        settings_file(repo_root, name, create=False)


def write_text(repo_root: Path, name: storage.SettingsName, text: str) -> Path:
    """Write one settings file atomically, after the namespace is ready. A link there is refused."""
    path = settings_file(repo_root, name, create=True)
    guarded("write", lambda: storage.display_path(path), lambda: atomic_write_text(path, text))
    return path


def remove_file(repo_root: Path, name: storage.SettingsName) -> bool:
    """Delete ``settings/<name>``; ``False`` when nothing is there (E-5). Creates nothing.

    Located as a read locates it (``settings_file(create=False)``), so a refusal propagates as storage's
    ``StorageError`` and unavailability as ``StorageAccessError``. ``unlink`` never follows a link, and an
    ``OSError`` is one sentence naming the display path, never an absolute one. Only ``settings/<name>``: never a
    folder, and never anything in the repository. The callers keep their own wording and their "is not a regular
    file" check; nothing else is caught here.
    """
    path = settings_file(repo_root, name, create=False)
    if not os.path.lexists(path):
        return False

    def unlink() -> bool:
        os.unlink(path)
        return True

    return guarded("remove", lambda: storage.display_path(path), unlink)
