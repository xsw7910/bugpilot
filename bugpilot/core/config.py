"""Configuration helpers."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from .user_config import load_user_config


WORKFLOW_STEPS = [
    "doctor",
    "fetch",
    "parse",
    "keywords",
    "memory_search",
    "code_search",
    "git_context",
    "context",
    "prompt",
    "agent_instructions",
    "memory_add",
    "agent_fix",
    # What `summarize-results` did: the Result Overview was rendered (`pass`) or
    # could not be (`fail`). A command having run, never a verdict on the fix.
    # `manual_validation` and `final_review_prompt` were listed here too, and
    # marked `pass` by printing a checklist and a prompt — read back by
    # `status` as a validation and a review that never happened. Neither is a
    # workflow step, so neither is recorded (§37.70).
    "result_summary",
    "memory_update",
    "delivery_check",
    "commit_plan",
    "push_plan",
    "notify",
    "jira_comment_draft",
    "jira_comment",
    "retry_prompt",
    "manual_result",
]


@dataclass(frozen=True)
class AppConfig:
    repo_root: Path
    jira_base_url: str | None
    jira_email: str | None
    jira_token: str | None
    copilot_command: str
    claude_command: str
    claude_args: str
    copilot_args: str

    @property
    def has_jira_credentials(self) -> bool:
        return bool(self.jira_base_url and self.jira_email and self.jira_token)


@dataclass(frozen=True)
class EmailConfig:
    """SMTP configuration for outbound notification email.

    Credentials are read from the environment only. bugpilot never hardcodes or
    persists SMTP secrets; use a secrets manager to inject them at runtime.
    """

    host: str | None
    port: int
    username: str | None
    password: str | None
    use_ssl: bool
    use_starttls: bool
    sender: str | None
    recipients: tuple[str, ...]

    @property
    def is_configured(self) -> bool:
        # Enough to send: a server, a sender, and at least one recipient.
        return bool(self.host and self.sender and self.recipients)

    @property
    def uses_auth(self) -> bool:
        return bool(self.username)

    def missing_fields(self) -> list[str]:
        missing: list[str] = []
        if not self.host:
            missing.append("SMTP_HOST")
        if not self.sender:
            missing.append("BUGPILOT_EMAIL_FROM")
        if not self.recipients:
            missing.append("BUGPILOT_EMAIL_TO")
        if self.username and not self.password:
            missing.append("SMTP_PASSWORD")
        return missing


@dataclass(frozen=True)
class GraphConfig:
    """Microsoft Graph (client-credentials) settings for sending mail over HTTPS.

    This is the transport of choice when the tenant disables SMTP client
    authentication. All values come from the environment; the client secret is
    never hardcoded, logged, or persisted by bugpilot.
    """

    tenant_id: str | None
    client_id: str | None
    client_secret: str | None

    @property
    def is_configured(self) -> bool:
        return bool(self.tenant_id and self.client_id and self.client_secret)

    def missing_fields(self) -> list[str]:
        missing: list[str] = []
        if not self.tenant_id:
            missing.append("GRAPH_TENANT_ID")
        if not self.client_id:
            missing.append("GRAPH_CLIENT_ID")
        if not self.client_secret:
            missing.append("GRAPH_CLIENT_SECRET")
        return missing


def load_config(repo_root: Path) -> AppConfig:
    # Precedence for every Jira setting: environment variables first (power
    # users / CI), then the `bugpilot setup` config file
    # (~/.bugpilot/config/config.toml, or BUGPILOT_HOME/config/config.toml).
    # The site is one of them now — there is no
    # built-in default, so an unconfigured install reports itself as such
    # instead of aiming at whichever tenant happened to be hard-coded.
    user = load_user_config()
    return AppConfig(
        repo_root=repo_root,
        jira_base_url=_clean_env("JIRA_BASE_URL") or user.jira_base_url,
        jira_email=_clean_env("JIRA_EMAIL") or user.jira_email,
        jira_token=_clean_env("JIRA_TOKEN") or user.jira_token,
        copilot_command=os.getenv("BUGPILOT_COPILOT_COMMAND", "copilot"),
        claude_command=os.getenv("BUGPILOT_CLAUDE_COMMAND", "claude"),
        # Interactive by default, but auto-accept file edits so the agent is not
        # blocked on every edit. For a fully unattended run (also skipping shell
        # prompts for git / bugpilot), set BUGPILOT_CLAUDE_ARGS to include
        # --dangerously-skip-permissions.
        claude_args=os.getenv("BUGPILOT_CLAUDE_ARGS", "--permission-mode acceptEdits"),
        copilot_args=os.getenv("BUGPILOT_COPILOT_ARGS", ""),
    )


def load_email_config() -> EmailConfig:
    return EmailConfig(
        host=_clean_env("SMTP_HOST"),
        port=_env_int("SMTP_PORT", 587),
        username=_clean_env("SMTP_USERNAME"),
        password=os.getenv("SMTP_PASSWORD") or None,
        use_ssl=_env_bool("SMTP_USE_SSL", False),
        use_starttls=_env_bool("SMTP_USE_STARTTLS", True),
        sender=_clean_env("BUGPILOT_EMAIL_FROM"),
        recipients=_parse_recipients(os.getenv("BUGPILOT_EMAIL_TO")),
    )


def load_graph_config() -> GraphConfig:
    return GraphConfig(
        tenant_id=_clean_env("GRAPH_TENANT_ID"),
        client_id=_clean_env("GRAPH_CLIENT_ID"),
        client_secret=os.getenv("GRAPH_CLIENT_SECRET") or None,
    )


def _clean_env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _env_int(name: str, default: int) -> int:
    raw = _clean_env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = _clean_env(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _parse_recipients(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return ()
    parts = [item.strip() for item in raw.replace(";", ",").split(",")]
    return tuple(item for item in parts if item)


def data_dir(repo_root: Path) -> Path:
    """The repository's folder in BugPilot's data folder: ``<data folder>/repositories/<repository id>``.

    0.1.7: every work item and bug memory file is below it, never in the
    repository. The base the safe readers (``safe_paths.read_generated_file``)
    judge each component below. Resolves; checks and creates nothing.
    """
    from . import storage

    return Path(storage.repository_storage(repo_root).diagnostics()["repository_dir"])


def readable_data_dir(repo_root: Path) -> Path:
    """:func:`data_dir` as the base of a read, checked by storage as every read of the namespace is (§8.3).

    Refused — ``UnsafePathError`` (storage's ``StorageError``) — when the data
    folder and the repository are not kept apart or the data folder is in a Git
    working tree, a link or junction is on the way to the namespace, or its
    identity record names another repository or cannot be read as one. The safe
    readers then check every component below it. Creates nothing. A data
    folder that cannot be examined right now is ``StorageAccessError``, in
    storage's sentence, as for every other storage failure (C-1, F2-S).
    """
    from . import storage
    from .errors import StorageAccessError

    found = storage.repository_storage(repo_root).check()
    if found.state == "unavailable":
        raise StorageAccessError(str(found.problem))
    if found.state == "refused":
        raise storage.StorageError(str(found.problem))
    return data_dir(repo_root)


def issue_dir(repo_root: Path, issue_key: str) -> Path:
    """``<data_dir>/work/<issue_key>``: where a work item's files are read from. Writers use :func:`writable_issue_dir`."""
    return data_dir(repo_root) / "work" / issue_key


def writable_issue_dir(repo_root: Path, issue_key: str, *, create: bool = True) -> Path:
    """``work/<issue_key>/`` in the repository's namespace, checked by storage before anything is written into it.

    The id is validated — it becomes a path segment — and every component from
    the data folder down is checked: a link or junction on the way raises
    ``UnsafePathError`` (storage's ``StorageError``) and nothing is written, as
    does a data folder inside the repository or a namespace whose identity
    record names another repository. ``create=True`` makes the namespace ready
    (``0700``, its record) first. With ``create=False`` a missing folder is
    returned for the caller to report, and nothing is created; a link at
    ``work`` or ``work/<id>`` is then refused in the write refusal's own words,
    as a run's first check has refused it since O-1, before storage checks the rest.
    """
    from . import storage
    from .identity import validate_work_item_id
    from .repository_settings import guarded
    from .safe_paths import UnsafePathError, writable_dir

    namespace = storage.repository_storage(repo_root)
    if not create:
        try:
            validate_work_item_id(issue_key)
        except ValueError as exc:
            raise UnsafePathError(str(exc)) from exc
        writable_dir(data_dir(repo_root), ("work", issue_key), create=False, boundary=storage.DATA_ROOT_BOUNDARY)
    return guarded(
        "prepare" if create else "read",
        lambda: shown(data_dir(repo_root) / "work"),
        lambda: namespace.work_item_dir(issue_key, create=create),
    )


def writable_attachments_dir(repo_root: Path, issue_key: str) -> Path:
    """``work/<issue_key>/attachments/``, made ready by storage: ``0700``, every component checked before and after,
    compared with the canonical path (plan §8.3). For ``copy_attachments`` in a run."""
    from . import storage
    from .repository_settings import guarded

    namespace = storage.repository_storage(repo_root)
    return guarded(
        "prepare",
        lambda: shown(data_dir(repo_root) / "work" / issue_key),
        lambda: namespace.attachments_dir(issue_key, create=True),
    )


def check_work_folder_private(repo_root: Path, issue_key: str) -> None:
    """Refuse (``UnsafePathError``) unless ``work/<issue_key>/`` and every folder above it, up to the data
    folder, is private: before an agent is given that folder (0.1.7, S-2). Storage's own check; creates nothing."""
    from . import storage

    storage.repository_storage(repo_root).check_private_for_agent(issue_key)


def memory_dir(repo_root: Path) -> Path:
    """``<data_dir>/memory``: the repository's bug memory, one ``<id>.md`` per work item."""
    return data_dir(repo_root) / "memory"


def writable_memory_file(repo_root: Path, issue_key: str, *, create: bool = True) -> Path:
    """``memory/<issue_key>.md`` in the repository's namespace, checked like :func:`writable_issue_dir`."""
    from . import storage
    from .repository_settings import guarded

    namespace = storage.repository_storage(repo_root)
    return guarded(
        "prepare" if create else "read",
        lambda: shown(memory_dir(repo_root)),
        lambda: namespace.memory_file(issue_key, create=create),
    )


def shown(path: Path) -> str:
    """A path in BugPilot's data folder as messages and logs name it: ``~/.bugpilot/…`` (never the user's folder)."""
    from .storage import display_path

    return display_path(path)


def shown_work(repo_root: Path, issue_key: str, name: str = "") -> str:
    """A work item's folder, with a trailing ``/``, or one file in it, as messages name them."""
    folder = issue_dir(repo_root, issue_key)
    return shown(folder / name) if name else shown(folder) + "/"


def shown_memory(repo_root: Path, issue_key: str) -> str:
    """A work item's bug memory file, as messages name it."""
    return shown(memory_dir(repo_root) / f"{issue_key}.md")


#: What an agent instruction cannot hold: it would end the inline code it is
#: written in, or the line (plan §9.8.1).
_UNRENDERABLE = re.compile("[`\x00-\x1f\x7f-\x9f  ]")


def prompt_path(path: Path) -> str:
    """``path`` as agent instructions name it: absolute, with forward slashes on every system.

    The agent's working directory stays the repository, so a work item's files
    are named absolutely. A path that cannot be written into a Markdown
    instruction as it is — a backtick, a control character, a line or
    paragraph separator — is refused (``UnsafePathError``), never altered;
    set ``BUGPILOT_HOME`` to a plain folder to use BugPilot there.
    """
    from .safe_paths import UnsafePathError

    text = str(path).replace("\\", "/")
    if _UNRENDERABLE.search(text):
        raise UnsafePathError(
            "BugPilot cannot name its work folder in an agent's instructions: the path to BugPilot's data folder "
            "holds a backtick or a control character. Set BUGPILOT_HOME to a plain absolute path. Nothing was written."
        )
    return text
