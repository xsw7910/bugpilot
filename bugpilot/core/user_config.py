"""User-level BugPilot configuration, in ``config/`` of BugPilot's data folder.

This is distinct from :mod:`bugpilot.core.config`, which reads process environment
variables. ``bugpilot setup`` writes a small ``config.toml`` here so a first-time
user does not have to export ``JIRA_*`` variables by hand. Environment variables
still win over this file (see :func:`bugpilot.core.config.load_config`).

The Jira site URL (``jira_base_url``), ``jira_email`` and (for now) ``jira_token``
are stored. Token persistence goes through :class:`TokenStore`
so it can later be swapped for the Windows Credential Manager without touching the
rest of the code.

Since 0.1.6 (plan §14.3, Batch 2B-2) the file is ``~/.bugpilot/config/config.toml``,
or ``config/config.toml`` under ``BUGPILOT_HOME``, read and written only through
:mod:`bugpilot.core.storage`'s checked methods: a data folder inside a Git working
tree, or a link on the way, is refused, and credentials are written only where
they are proven private. The 0.1.5 file at the top of the data folder is never
read, moved or deleted; ``bugpilot setup`` writes the new one. ``BUGPILOT_CONFIG_DIR``
is no longer read (US-D3): only whether it is set is looked at, for one warning.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from . import storage
from .errors import StorageAccessError
from .repository_settings import FileReadError, guarded
from .safe_paths import UnsafePathError, decode_text, is_link_or_junction

# There is deliberately no default Jira site.
#
# There used to be one — a single hard-coded tenant, used
# wherever JIRA_BASE_URL was unset. That is exactly wrong for a package anyone
# can install: it discloses an internal hostname, and it points every stranger's
# first run at somebody else's Jira. The URL is now the developer's, from the
# environment or from `bugpilot setup`, and its absence is reported as
# "not configured" rather than guessed at.

#: Retired in 0.1.6 (US-D3): ``BUGPILOT_HOME`` names the whole data folder. Only its presence is looked at.
CONFIG_DIR_ENV = "BUGPILOT_CONFIG_DIR"
#: What the CLI says, once, in text mode, when :data:`CONFIG_DIR_ENV` is set (owner decision Q-4).
CONFIG_DIR_WARNING = "BUGPILOT_CONFIG_DIR is no longer used; set BUGPILOT_HOME to choose BugPilot's data folder"


@dataclass(frozen=True)
class UserConfig:
    jira_email: str | None = None
    jira_token: str | None = None
    jira_base_url: str | None = None


def user_config_dir() -> Path:
    """The user configuration folder, ``config/`` in BugPilot's data folder (``~/.bugpilot/config`` by default).

    Where it is, for messages and tests: computed, never checked, read or
    created. Every read and write goes through storage's checked methods.
    """
    return Path(storage.global_storage().diagnostics()["config_dir"])


def user_config_path() -> Path:
    """Where ``config.toml`` is; computed, as :func:`user_config_dir` is."""
    return user_config_dir() / storage.CREDENTIALS_NAME


def config_dir_variable_is_set() -> bool:
    """Whether the retired :data:`CONFIG_DIR_ENV` is in the environment, whatever it holds. Its value is never read."""
    return CONFIG_DIR_ENV in os.environ


#: What reading a folder at ``config.toml``'s name raised before Option C, by its class (the one part a
#: message shows): Windows refuses to open a folder as a file; POSIX opens it and cannot read it.
_FOLDER_AT_NAME = PermissionError if os.name == "nt" else IsADirectoryError


# --- token storage seam -----------------------------------------------------


class TokenStore(ABC):
    """Where the Jira API token lives.

    The default keeps the token inline in ``config.toml``. A future
    ``CredentialManagerTokenStore`` can implement the same two methods to move
    the token into the Windows Credential Manager without changing callers.
    """

    @abstractmethod
    def load(self, config_data: dict[str, str]) -> str | None:
        """Return the token, given the already-parsed config table."""

    @abstractmethod
    def save(self, config_data: dict[str, str], token: str | None) -> None:
        """Persist the token. May mutate ``config_data`` (the file table)."""


class FileTokenStore(TokenStore):
    """Stores the token inline in ``config.toml`` (current default)."""

    def load(self, config_data: dict[str, str]) -> str | None:
        token = config_data.get("jira_token")
        return token or None

    def save(self, config_data: dict[str, str], token: str | None) -> None:
        if token:
            config_data["jira_token"] = token
        else:
            config_data.pop("jira_token", None)


def _token_store() -> TokenStore:
    # Future: return a Windows Credential Manager store on win32 once implemented.
    return FileTokenStore()


# --- load / save ------------------------------------------------------------


def load_user_config() -> UserConfig:
    data = _read_config()
    email = data.get("jira_email") or None
    token = _token_store().load(data)
    base_url = data.get("jira_base_url") or None
    return UserConfig(jira_email=email, jira_token=token, jira_base_url=base_url)


def _read_config() -> dict[str, str]:
    """The file's table, or an empty one when there is no file.

    Storage reads the file without following a link (Option C, M2): a data
    folder in a Git working tree, or a link on the way or at the file, is
    refused (``StorageError``). A file that is not there is "not configured";
    one that cannot be read, a folder on the way that cannot be, or a folder
    at the file's name is a :class:`~bugpilot.core.errors.StorageAccessError`,
    never its system error's text.
    """
    shown = shown_config_path()
    try:
        found = guarded("read", lambda: shown, storage.global_storage().read_config)
    except FileReadError as error:
        raise StorageAccessError.during("read", shown, error.error) from None
    if found.state == "absent":
        return {}
    if found.state == "not_a_file":
        raise StorageAccessError.during("read", shown, _FOLDER_AT_NAME()) from None
    # errors="replace": this file is hand-editable, it is read by *every* command
    # through load_config, and a decode error here would take down
    # `bugpilot doctor` — the one command whose job is to explain what is wrong.
    return _parse_toml(decode_text(found.data, "utf-8", errors="replace"))


def save_user_config(
    jira_email: str,
    jira_token: str | None,
    jira_base_url: str | None = None,
) -> Path:
    """Write the Jira site and email (and, via the token store, the token).

    The site is written now that there is no built-in one; ``setup`` asks for it.
    Returns the path.
    """
    data: dict[str, str] = {"jira_email": jira_email}
    if jira_base_url:
        data["jira_base_url"] = jira_base_url
    _token_store().save(data, jira_token)
    return _write_config(data)


def save_jira_site(jira_base_url: str) -> Path:
    """Write only the Jira site, keeping whatever email and token the file holds.

    For the VS Code extension's Jira Setup, which keeps
    the email and token in VS Code's SecretStorage but the site here, where the
    CLI reads it too: one site for both, not two that can disagree. The caller
    validates the site (``jira.normalize_jira_site``).
    """
    # Refused before it is read, not only before it is written: nothing behind a link — a FIFO
    # would block the read — is opened at all (0.1.5, O4).
    _refuse_link_at(user_config_path())
    data = _read_config()
    data["jira_base_url"] = jira_base_url
    return _write_config(data)


def _write_config(data: dict[str, str]) -> Path:
    """The file that may hold the Jira token, written owner-only from its first moment (0.1.5, S2, B5, O4).

    Only through storage's ``write_config_file()`` (G-3): the data folder,
    ``config/`` and the file are proven private first, the atomic writer
    creates the temp file new and owner-only (0600 on POSIX) before the token
    is written into it, then renames it into place, and the file is checked
    again after. A place that cannot be proven private is refused, and nothing
    ever changes a permission.

    A link or junction at the file's own path is refused first, in this
    module's words, as for every file BugPilot writes whole; the token never
    follows it. Nothing of the file's content is in any message.
    """
    _refuse_link_at(user_config_path())
    try:
        return storage.global_storage().write_config_file(_dump_toml(data))
    except OSError as error:
        raise StorageAccessError.during("write", shown_config_path(), error) from None


def _refuse_link_at(path: Path) -> None:
    """O4: a symbolic link or junction at the credentials file's own path, refused in one sentence."""
    if is_link_or_junction(path):
        raise UnsafePathError(
            f"BugPilot cannot write {shown_config_path()}: it is a symbolic link or junction, and the file "
            "that holds the Jira token is written only as a real file. Nothing was written."
        )


def shown_config_path() -> str:
    """The credentials file as messages name it (US-D22): ``~/.bugpilot/config/config.toml`` or ``BUGPILOT_HOME/…``."""
    return storage.display_path(user_config_path())


# --- minimal flat-TOML reader/writer ----------------------------------------
# BugPilot has no third-party dependencies and targets Python 3.10 (no stdlib
# tomllib), and this file is always a flat table of string keys that we alone
# write. A small, well-scoped reader/writer keeps that contract without adding a
# dependency. It is not a general TOML implementation.

_ESCAPES = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_UNESCAPES = {"\\\\": "\\", '\\"': '"', "\\n": "\n", "\\r": "\r", "\\t": "\t"}


def _dump_toml(data: dict[str, str]) -> str:
    lines = []
    for key, value in data.items():
        lines.append(f'{key} = "{_escape(value)}"')
    return "\n".join(lines) + "\n"


def _parse_toml(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = _unescape(value[1:-1])
        if key:
            result[key] = value
    return result


def _escape(value: str) -> str:
    out = []
    for ch in value:
        out.append(_ESCAPES.get(ch, ch))
    return "".join(out)


def _unescape(value: str) -> str:
    out = []
    i = 0
    while i < len(value):
        pair = value[i:i + 2]
        if pair in _UNESCAPES:
            out.append(_UNESCAPES[pair])
            i += 2
        else:
            out.append(value[i])
            i += 1
    return "".join(out)
