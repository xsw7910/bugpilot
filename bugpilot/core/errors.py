"""Stable error codes shared by every entry point.

The codes are the machine-facing half of a failure; the human message is the
other half and may be reworded freely. A VS Code extension branches on
``error.code`` and never parses the message — see ``docs/adapter_design.md``
section 5.1.

A code says *what went wrong*. The command being run is reported separately, so
the same JIRA_AUTH_FAILED covers a failed fetch and a failed comment post rather
than needing one code per operation.

Adding a code is a contract change: append, never rename or repurpose.
"""

from __future__ import annotations

# --- Jira -------------------------------------------------------------------

JIRA_NOT_CONFIGURED = "JIRA_NOT_CONFIGURED"
JIRA_AUTH_FAILED = "JIRA_AUTH_FAILED"
JIRA_ISSUE_NOT_FOUND = "JIRA_ISSUE_NOT_FOUND"
JIRA_RATE_LIMITED = "JIRA_RATE_LIMITED"
JIRA_TIMEOUT = "JIRA_TIMEOUT"
JIRA_NETWORK_ERROR = "JIRA_NETWORK_ERROR"
JIRA_INVALID_RESPONSE = "JIRA_INVALID_RESPONSE"
JIRA_ERROR = "JIRA_ERROR"

# --- source-mode gates (design section 5.1) ---------------------------------

# The command only makes sense for a Jira work item (fetch, jira-validate, parse).
JIRA_ONLY_COMMAND = "JIRA_ONLY_COMMAND"
# There is no external issue to write back to: a manual work item has no source_ref.
NO_JIRA_TARGET = "NO_JIRA_TARGET"

# --- local state ------------------------------------------------------------

WORK_ITEM_NOT_FOUND = "WORK_ITEM_NOT_FOUND"
ARTIFACT_NOT_FOUND = "ARTIFACT_NOT_FOUND"
MISSING_RESULTS = "MISSING_RESULTS"
INVALID_INPUT = "INVALID_INPUT"

# --- other ------------------------------------------------------------------

EMAIL_SEND_FAILED = "EMAIL_SEND_FAILED"
INTERNAL_ERROR = "INTERNAL_ERROR"

# jira.ERROR_MESSAGES keys -> codes. That vocabulary already exists and is
# stable, so the mapping is a rename rather than a second classification.
_JIRA_ERROR_TYPES: dict[str, str] = {
    "missing_env": JIRA_NOT_CONFIGURED,
    "auth_or_permission": JIRA_AUTH_FAILED,
    "not_found": JIRA_ISSUE_NOT_FOUND,
    "rate_limited": JIRA_RATE_LIMITED,
    "timeout": JIRA_TIMEOUT,
    "network_error": JIRA_NETWORK_ERROR,
    "invalid_response": JIRA_INVALID_RESPONSE,
    "unknown_error": JIRA_ERROR,
}


def code_for_jira_error_type(error_type: str | None) -> str:
    """Map a ``jira.ERROR_MESSAGES`` key to its stable code."""
    return _JIRA_ERROR_TYPES.get(error_type or "", JIRA_ERROR)


def error_code_for(exc: BaseException) -> str:
    """Classify an exception for the machine-facing envelope.

    Imports are local so this module stays a leaf: every adapter needs the code
    vocabulary, and a top-level import of ``jira`` would drag its network stack
    into anything that only wants to name a code.
    """
    from .email_notify import EmailSendError
    from .jira import JiraCommentPostError, JiraFetchError

    if isinstance(exc, JiraFetchError):
        return code_for_jira_error_type(getattr(exc.result, "error_type", None))
    if isinstance(exc, JiraCommentPostError):
        return code_for_jira_error_type(getattr(exc, "error_type", None))
    if isinstance(exc, EmailSendError):
        return EMAIL_SEND_FAILED
    if isinstance(exc, FileNotFoundError):
        return ARTIFACT_NOT_FOUND
    if isinstance(exc, ValueError):
        return INVALID_INPUT
    return INTERNAL_ERROR
