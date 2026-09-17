"""Configuration helpers."""

from __future__ import annotations

import os
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
    "result_summary",
    "manual_validation",
    "final_review_prompt",
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
    # (~/.bugpilot/config.toml). The site is one of them now — there is no
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


def issue_dir(repo_root: Path, issue_key: str) -> Path:
    return repo_root / ".ai" / issue_key


def memory_dir(repo_root: Path) -> Path:
    return repo_root / ".ai_memory" / "bugs"
