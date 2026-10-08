"""Jira fetch and parse helpers with controlled mock fallback."""

from __future__ import annotations

import base64
import json
import re
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .. import __version__
from .config import load_config
from .jira_adf import adf_to_markdown
from .jira_parse import extract_parsed_details

NORMALIZED_CORE_FIELDS = [
    "issue_key", "summary", "description_markdown", "issue_type", "status",
    "resolution", "priority", "labels", "components", "fix_versions",
    "affected_versions", "assignee", "reporter", "created", "updated",
    "project_key", "project_name",
]


@dataclass
class JiraFetchResult:
    issue_key: str
    source: str
    success: bool
    error_type: str | None
    error_message: str | None
    data: dict


@dataclass
class JiraCommentPostResult:
    issue_key: str
    posted: bool
    comment_id: str
    created: str
    updated: str
    self_url: str
    timestamp: str


@dataclass
class JiraValidationResult:
    ok: bool
    error_type: str | None = None
    error_message: str | None = None
    account_email: str | None = None
    display_name: str | None = None


class JiraFetchError(Exception):
    def __init__(self, result: JiraFetchResult):
        super().__init__(result.error_message or "Unexpected Jira error.")
        self.result = result


class JiraCommentPostError(Exception):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.error_type = error_type
        self.message = message


ERROR_MESSAGES = {
    # Names the two ways to configure Jira and nothing else: no value, no site
    # (pre-release Batch 4.1; it used to name only the environment variables).
    "missing_env": (
        "Jira is not configured: no Jira site, email and API token were found in the environment or in "
        "~/.bugpilot/config.toml. Run `bugpilot setup`, or set JIRA_BASE_URL, JIRA_EMAIL and JIRA_TOKEN."
    ),
    "invalid_site": (
        "The Jira site must be an https:// address with no user name, password, query or fragment, "
        "for example https://your-company.atlassian.net. Fix JIRA_BASE_URL or run: bugpilot setup"
    ),
    "redirect_refused": (
        "Jira redirected the request to a different site. BugPilot sends Jira credentials only to the "
        "configured site; check that JIRA_BASE_URL (or bugpilot setup) names the address Jira really uses."
    ),
    "auth_or_permission": "Jira authentication or permission failed. Check Jira credentials and project access.",
    "not_found": "Jira issue was not found or is not accessible. Check issue key and project permissions.",
    "rate_limited": "Jira rate limit reached. Retry later.",
    "timeout": "Jira request timed out. Check VPN, proxy, or network connection.",
    "network_error": "Jira network error. Check VPN, proxy, DNS, and Jira base URL.",
    "invalid_response": "Jira response could not be parsed. Check JIRA_BASE_URL and Jira API version.",
    "unknown_error": "Unexpected Jira error.",
}


COMMENT_SIGNAL_TERMS = ["crash", "error", "exception", "stack trace", "repro", "regression", "screenshot", "log"]
MAX_JIRA_COMMENT_LENGTH = 12000


# Sent to every Jira server this tool talks to, so it is a public identifier and
# it should say what is actually calling. It said `bugpilot-prototype/0.1` in
# three places, which named a version that had already moved on.
USER_AGENT = f"bugpilot/{__version__}"


# --- the Jira site, and the one way a request reaches it ---------------------
#
# Every request carries the developer's email and API token as HTTP Basic
# credentials, so two rules hold for all of them (pre-release Batch 2, B):
#
# - the site is https://, always. There is no switch that allows http://, for a
#   loopback host or anything else: a test fakes the transport instead;
# - a redirect never takes the credentials to another origin. urllib's default
#   handler copies `Authorization` onto every redirect, to any host; the handler
#   below follows a redirect only to the same scheme, host and effective port,
#   and refuses any other with its own error rather than retrying without them.

_HOST_LABEL = re.compile(r"(?!-)[a-z0-9_-]{1,63}(?<!-)")


class JiraSiteError(ValueError):
    """A Jira site URL BugPilot will not send credentials to. The message says why."""


class JiraRedirectRefused(Exception):
    """A Jira response redirected to another origin; the request was not repeated."""


def normalize_jira_site(raw: str | None) -> str:
    """The Jira site as every request uses it: ``https://host[:port][/path]``.

    Refused with :class:`JiraSiteError`: any scheme but https, a user name or
    password in the URL, a query or fragment, whitespace, backslashes or control
    characters, a missing or malformed host, a port outside 1-65535. A path is
    kept (a self-hosted Jira may live under one) without its trailing slash.
    """
    value = (raw or "").strip()
    if not value:
        raise JiraSiteError("No Jira site is configured.")
    if any(character.isspace() or ord(character) < 32 or character == "\\" for character in value):
        raise JiraSiteError("The Jira site contains spaces, backslashes or control characters.")
    try:
        parts = urlsplit(value)
    except ValueError as exc:
        # "Invalid IPv6 URL" for a bracket that is not an IPv6 literal, such as a
        # placeholder typed with its brackets. Every caller handles JiraSiteError.
        raise JiraSiteError("The Jira site has an invalid host name.") from exc
    if parts.scheme.lower() != "https":
        raise JiraSiteError("The Jira site must start with https://.")
    if "@" in parts.netloc:
        raise JiraSiteError("The Jira site must not contain a user name or password.")
    if parts.query or parts.fragment or value.endswith(("?", "#")):
        raise JiraSiteError("The Jira site must not contain a query or fragment.")
    try:
        port = parts.port
    except ValueError as exc:
        raise JiraSiteError("The Jira site has an invalid port.") from exc
    if port is not None and not 1 <= port <= 65535:
        raise JiraSiteError("The Jira site has an invalid port.")
    host = (parts.hostname or "").lower()
    if not host:
        raise JiraSiteError("The Jira site has no host name.")
    if parts.netloc.startswith("["):
        import ipaddress

        try:
            ipaddress.IPv6Address(host)
        except ValueError as exc:
            raise JiraSiteError("The Jira site has an invalid host name.") from exc
        netloc_host = f"[{host}]"
    else:
        if len(host) > 253 or not all(_HOST_LABEL.fullmatch(label) for label in host.split(".")):
            raise JiraSiteError("The Jira site has an invalid host name.")
        netloc_host = host
    netloc = netloc_host if port is None else f"{netloc_host}:{port}"
    return urlunsplit(("https", netloc, parts.path.rstrip("/"), "", ""))


def _origin(url: str) -> tuple[str, str, int | None]:
    """Scheme, host and effective port: what a redirect may not change."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    try:
        port = parts.port
    except ValueError:
        port = -1
    if port is None:
        port = {"https": 443, "http": 80}.get(scheme)
    return scheme, (parts.hostname or "").lower(), port


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only within the origin the credentials were meant for."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib's signature
        if _origin(newurl) != _origin(req.full_url):
            # The redirect's own response is not read, and its connection is
            # not left open behind the refusal.
            if fp is not None:
                fp.close()
            raise JiraRedirectRefused(
                f"Jira redirected from {_origin(req.full_url)[1]} to {_origin(newurl)[1] or 'another site'}."
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _build_opener(*handlers: urllib.request.BaseHandler) -> urllib.request.OpenerDirector:
    """The opener every Jira request goes through; extra handlers are for tests."""
    return urllib.request.build_opener(_SameOriginRedirectHandler, *handlers)


_OPENER = _build_opener()


def _open(request: urllib.request.Request, timeout: float):
    """The one transport for Jira: same-origin redirects only. Tests replace it."""
    return _OPENER.open(request, timeout=timeout)


def fetch_issue(repo_root: Path, issue_key: str, allow_mock: bool = True) -> JiraFetchResult:
    config = load_config(repo_root)
    if not config.has_jira_credentials:
        failure = _failure(issue_key, "missing_env")
        return _fallback_or_raise(failure, allow_mock)
    try:
        site = normalize_jira_site(config.jira_base_url)
    except JiraSiteError:
        return _fallback_or_raise(_failure(issue_key, "invalid_site"), allow_mock)

    url = f"{site}/rest/api/3/issue/{issue_key}?expand=renderedFields"
    token = base64.b64encode(f"{config.jira_email}:{config.jira_token}".encode()).decode()
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with _open(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict) or "fields" not in payload:
            failure = _failure(issue_key, "invalid_response")
            return _fallback_or_raise(failure, allow_mock)
        payload["source"] = "jira"
        payload["mock"] = False
        payload["bugpilot_fetch"] = {"mock": False, "source": "jira", "url": url}
        enrich_issue(payload)
        return JiraFetchResult(
            issue_key=issue_key,
            source="jira",
            success=True,
            error_type=None,
            error_message=None,
            data=payload,
        )
    except JiraRedirectRefused:
        return _fallback_or_raise(_failure(issue_key, "redirect_refused"), allow_mock)
    except urllib.error.HTTPError as exc:
        failure = _failure(issue_key, _http_error_type(exc.code))
        return _fallback_or_raise(failure, allow_mock)
    except TimeoutError:
        failure = _failure(issue_key, "timeout")
        return _fallback_or_raise(failure, allow_mock)
    except socket.timeout:
        failure = _failure(issue_key, "timeout")
        return _fallback_or_raise(failure, allow_mock)
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            failure = _failure(issue_key, "timeout")
        else:
            failure = _failure(issue_key, "network_error")
        return _fallback_or_raise(failure, allow_mock)
    except json.JSONDecodeError:
        failure = _failure(issue_key, "invalid_response")
        return _fallback_or_raise(failure, allow_mock)
    except Exception:
        failure = _failure(issue_key, "unknown_error")
        return _fallback_or_raise(failure, allow_mock)


def _basic_auth_header(email: str, token: str) -> str:
    return "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()


def validate_credentials(base_url: str, email: str, token: str, timeout: int = 30) -> JiraValidationResult:
    """Check a Jira email + API token against ``/rest/api/3/myself``.

    Does not read env or config; the caller passes the values to test. Returns a
    :class:`JiraValidationResult` with ``ok`` and, on failure, a classified
    ``error_type`` / ``error_message`` drawn from the shared ``ERROR_MESSAGES``.
    """
    try:
        site = normalize_jira_site(base_url)
    except JiraSiteError:
        return _validation_failure("invalid_site")
    url = f"{site}/rest/api/3/myself"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": _basic_auth_header(email, token),
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with _open(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            return _validation_failure("invalid_response")
        return JiraValidationResult(
            ok=True,
            account_email=payload.get("emailAddress"),
            display_name=payload.get("displayName"),
        )
    except JiraRedirectRefused:
        return _validation_failure("redirect_refused")
    except urllib.error.HTTPError as exc:
        return _validation_failure(_http_error_type(exc.code))
    except (TimeoutError, socket.timeout):
        return _validation_failure("timeout")
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            return _validation_failure("timeout")
        return _validation_failure("network_error")
    except json.JSONDecodeError:
        return _validation_failure("invalid_response")
    except Exception:
        return _validation_failure("unknown_error")


def _validation_failure(error_type: str) -> JiraValidationResult:
    return JiraValidationResult(
        ok=False,
        error_type=error_type,
        error_message=ERROR_MESSAGES.get(error_type, ERROR_MESSAGES["unknown_error"]),
    )


def post_jira_comment(repo_root: Path, issue_key: str, comment_text: str) -> JiraCommentPostResult:
    config = load_config(repo_root)
    if not config.has_jira_credentials:
        raise JiraCommentPostError("missing_env", ERROR_MESSAGES["missing_env"])

    prepared = prepare_jira_comment_text(comment_text)
    if not prepared:
        raise JiraCommentPostError("empty_comment", "Jira comment draft is empty.")

    try:
        site = normalize_jira_site(config.jira_base_url)
    except JiraSiteError as exc:
        raise JiraCommentPostError("invalid_site", ERROR_MESSAGES["invalid_site"]) from exc
    url = f"{site}/rest/api/3/issue/{issue_key}/comment"
    token = base64.b64encode(f"{config.jira_email}:{config.jira_token}".encode()).decode()
    body = json.dumps({"body": _markdown_to_adf(prepared)}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with _open(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except JiraRedirectRefused as exc:
        raise JiraCommentPostError("redirect_refused", ERROR_MESSAGES["redirect_refused"]) from exc
    except urllib.error.HTTPError as exc:
        error_type = _http_error_type(exc.code)
        raise JiraCommentPostError(error_type, ERROR_MESSAGES.get(error_type, ERROR_MESSAGES["unknown_error"])) from exc
    except TimeoutError as exc:
        raise JiraCommentPostError("timeout", ERROR_MESSAGES["timeout"]) from exc
    except socket.timeout as exc:
        raise JiraCommentPostError("timeout", ERROR_MESSAGES["timeout"]) from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise JiraCommentPostError("timeout", ERROR_MESSAGES["timeout"]) from exc
        raise JiraCommentPostError("network_error", ERROR_MESSAGES["network_error"]) from exc
    except json.JSONDecodeError as exc:
        raise JiraCommentPostError("invalid_response", ERROR_MESSAGES["invalid_response"]) from exc

    if not isinstance(payload, dict):
        raise JiraCommentPostError("invalid_response", ERROR_MESSAGES["invalid_response"])
    return JiraCommentPostResult(
        issue_key=issue_key,
        posted=True,
        comment_id=str(payload.get("id", "") or ""),
        created=str(payload.get("created", "") or ""),
        updated=str(payload.get("updated", "") or ""),
        self_url=_safe_url(payload.get("self")),
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


def prepare_jira_comment_text(comment_text: str) -> str:
    text = sanitize_comment_text(str(comment_text)).strip()
    if len(text) > MAX_JIRA_COMMENT_LENGTH:
        return text[:MAX_JIRA_COMMENT_LENGTH].rstrip() + "\n\n[truncated by bugpilot]"
    return text


def _markdown_to_adf(text: str) -> dict:
    """Render the small markdown subset bugpilot emits into Atlassian Document Format.

    Jira Cloud renders ADF, not markdown, so posting raw markdown shows literal
    `##` / `---` / `-`. This converts headings, horizontal rules, and bullet
    lists into real ADF nodes; everything else becomes a paragraph.
    """
    content: list[dict] = []
    bullets: list[str] = []

    def flush_bullets() -> None:
        if bullets:
            content.append({
                "type": "bulletList",
                "content": [
                    {"type": "listItem", "content": [_paragraph(item)]}
                    for item in bullets
                ],
            })
            bullets.clear()

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            flush_bullets()
            continue
        if len(line) >= 3 and set(line) <= {"-", "*", "_"}:  # horizontal rule
            flush_bullets()
            content.append({"type": "rule"})
            continue
        heading = re.match(r"^(#{1,6})\s+(.*\S)\s*$", line)
        if heading:
            flush_bullets()
            level = min(len(heading.group(1)) + 1, 6)  # '#' -> h2, '##' -> h3
            content.append({
                "type": "heading",
                "attrs": {"level": level},
                "content": [{"type": "text", "text": heading.group(2)}],
            })
            continue
        bullet = re.match(r"^[-*]\s+(.*\S)\s*$", line)
        if bullet:
            bullets.append(bullet.group(1))
            continue
        flush_bullets()
        content.append(_paragraph(line))
    flush_bullets()

    if not content:
        content.append(_paragraph(text.strip() or " "))
    return {"type": "doc", "version": 1, "content": content}


def _paragraph(text: str) -> dict:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def parse_issue(issue: dict) -> dict[str, object]:
    # Idempotent, so a payload enriched by fetch_issue is safe to hand in again.
    enrich_issue(issue)
    fields = issue.get("fields", {})
    description_text = adf_to_markdown(fields.get("description"))

    normalized = issue.get("bugpilot_normalized", {}) if isinstance(issue.get("bugpilot_normalized"), dict) else {}
    comment_details = normalized.get("comments", []) if isinstance(normalized.get("comments"), list) else []
    comments = [str(comment.get("body_markdown", "")) for comment in comment_details if isinstance(comment, dict)]
    attachments = normalized.get("attachments", []) if isinstance(normalized.get("attachments"), list) else []

    text = "\n".join(
        [
            str(fields.get("summary", "")),
            description_text,
            "\n".join(comments),
        ]
    ).strip()

    fix_versions = normalized.get("fix_versions", []) or []
    affected_versions = normalized.get("affected_versions", []) or []
    parsed_details = extract_parsed_details(
        description_text,
        comment_details,
        attachments,
        summary=str(fields.get("summary", "") or ""),
        fix_versions=fix_versions if isinstance(fix_versions, list) else [],
        affected_versions=affected_versions if isinstance(affected_versions, list) else [],
    )
    return {
        "issue_key": issue.get("key"),
        "summary": fields.get("summary", ""),
        "issue_type": _field_name(fields.get("issuetype")),
        "status": _field_name(fields.get("status")),
        # Kept because it is often the most decision-relevant fact about an
        # issue: a real run prepared a full fix package for one resolved
        # "Won't Do", and the resolution was reachable only from the summary
        # markdown, not from the parsed dict every consumer reads.
        "resolution": normalized.get("resolution") or _field_name(fields.get("resolution")),
        "priority": _field_name(fields.get("priority")),
        "labels": fields.get("labels", []) or [],
        "components": [component.get("name", "") for component in (fields.get("components", []) or []) if isinstance(component, dict)],
        "description": description_text,
        "comments": comments,
        "comment_details": comment_details,
        "comment_total": len(comment_details),
        "comment_signal_terms": _comment_signal_terms(comment_details),
        "latest_comment_timestamp": _latest_comment_timestamp(comment_details),
        "attachments": attachments,
        "attachment_kinds": _attachment_kinds(attachments),
        "combined_text": text,
        "is_mock": bool(issue.get("mock") or issue.get("bugpilot_fetch", {}).get("mock")),
        "reproduction_steps": parsed_details["reproduction_steps"],
        "actual_result": parsed_details["actual_result"],
        "expected_result": parsed_details["expected_result"],
        "environment": parsed_details["environment"],
        "error_messages": parsed_details["error_messages"],
        "stack_traces": parsed_details["stack_traces"],
        "log_signals": parsed_details["log_signals"],
        "regression_signals": parsed_details["regression_signals"],
        "missing_information": parsed_details["missing_information"],
    }


def enrich_issue(issue: dict) -> dict:
    """Attach the normalized view of a raw Jira issue, in place.

    The block this writes is a cache that is always recomputed: every reader
    calls this first, or is handed an issue that was enriched moments earlier.
    Which is why renaming the key from its pre-bugpilot spelling cost nothing —
    a stored copy of it has never been read back. Checked against five real
    work items and against the call sites, not assumed.
    """
    core = normalize_core_fields(issue)
    issue["bugpilot_normalized"] = {
        **core,
        "comments": normalize_comments(issue),
        "comment_count_total": _comment_count_total(issue),
        "attachments": normalize_attachments(issue),
        "attachment_count": _attachment_count(issue),
    }
    return issue


def normalize_core_fields(issue: dict) -> dict:
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    project = fields.get("project", {}) if isinstance(fields.get("project"), dict) else {}
    return {
        "issue_key": str(issue.get("key", "") or ""),
        "summary": str(fields.get("summary", "") or ""),
        "description_markdown": adf_to_markdown(fields.get("description")),
        "issue_type": _field_name(fields.get("issuetype")),
        "status": _field_name(fields.get("status")),
        "resolution": _field_name(fields.get("resolution")),
        "priority": _field_name(fields.get("priority")),
        "labels": _normalize_string_list(fields.get("labels")),
        "components": [c.get("name", "") for c in (fields.get("components") or []) if isinstance(c, dict)],
        "fix_versions": _normalize_version_list(fields.get("fixVersions")),
        "affected_versions": _normalize_version_list(fields.get("versions")),
        "assignee": _user_name(fields.get("assignee")),
        "reporter": _user_name(fields.get("reporter")),
        "created": str(fields.get("created", "") or ""),
        "updated": str(fields.get("updated", "") or ""),
        "project_key": str(project.get("key", "") or ""),
        "project_name": str(project.get("name", "") or ""),
    }


def normalize_comments(issue: dict) -> list[dict[str, str]]:
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    raw_comment = fields.get("comment")
    comment_field = raw_comment if isinstance(raw_comment, dict) else {}
    raw_comments = comment_field.get("comments", []) or []
    comments = []
    for comment in raw_comments:
        if not isinstance(comment, dict):
            continue
        author = comment.get("author", {}) if isinstance(comment.get("author"), dict) else {}
        body = adf_to_markdown(comment.get("body", "")) if comment.get("body") is not None else ""
        comments.append(
            {
                "author": str(author.get("displayName") or author.get("accountId") or ""),
                "created": str(comment.get("created", "") or ""),
                "updated": str(comment.get("updated", "") or ""),
                "body_markdown": body,
                "preview": _preview(body),
            }
        )
    return _ordered_comments(comments)


def normalize_attachments(issue: dict) -> list[dict[str, object]]:
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    raw_attachments = fields.get("attachment", []) or []
    attachments = []
    for attachment in raw_attachments:
        if not isinstance(attachment, dict):
            continue
        author = attachment.get("author", {}) if isinstance(attachment.get("author"), dict) else {}
        filename = str(attachment.get("filename", "") or "")
        mime_type = str(attachment.get("mimeType", "") or "")
        attachments.append(
            {
                "filename": filename,
                "mime_type": mime_type,
                "size": _safe_int(attachment.get("size")),
                "created": str(attachment.get("created", "") or ""),
                "author": str(author.get("displayName") or author.get("accountId") or ""),
                "content_url": _safe_url(attachment.get("content")),
                "thumbnail_url": _safe_url(attachment.get("thumbnail")),
                "kind": classify_attachment(filename, mime_type),
            }
        )
    return attachments


def classify_attachment(filename: str, mime_type: str = "") -> str:
    name = filename.lower()
    mime = mime_type.lower()
    suffix = Path(name).suffix
    # Priority is intentional: direct screenshots first, then log/crash name hints,
    # then repro/archive/document extension fallbacks.
    if suffix in {".png", ".jpg", ".jpeg"} or mime.startswith("image/"):
        return "screenshot"
    if suffix in {".log", ".txt"} or "log" in name:
        return "log"
    if suffix in {".dmp", ".dump", ".mdmp"} or "crash" in name:
        return "crash_dump"
    if suffix in {".zip", ".7z", ".tar", ".gz"} or "repro" in name:
        return "repro_project"
    if suffix in {".pdf", ".docx"}:
        return "document"
    return "unknown"


def jira_field_report_markdown(issue: dict) -> str:
    normalized = issue.get("bugpilot_normalized", {}) if isinstance(issue.get("bugpilot_normalized"), dict) else {}
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}

    populated = [f for f in NORMALIZED_CORE_FIELDS if normalized.get(f)]
    missing = [f for f in NORMALIZED_CORE_FIELDS if not normalized.get(f)]

    std_keys = sorted(k for k in fields if not k.startswith("customfield_") and k not in {"id", "self", "expand"})
    custom_keys = sorted(k for k in fields if k.startswith("customfield_"))
    interesting_custom = []
    for key in custom_keys[:20]:
        val = fields.get(key)
        if val is not None:
            preview = _safe_preview(val)
            interesting_custom.append(f"- `{key}`: {preview}")

    populated_lines = "\n".join(f"- {f}: present" for f in populated) or "None."
    missing_lines = "\n".join(f"- {f}: missing" for f in missing) or "None."
    std_keys_text = ", ".join(f"`{k}`" for k in std_keys) or "None."
    custom_text = "\n".join(interesting_custom) if interesting_custom else "None."

    return (
        "# Jira Field Report\n\n"
        "This report is for developer diagnostics only.\n"
        "It does not contain attachment content or credentials.\n\n"
        "## Populated Normalized Fields\n\n"
        f"{populated_lines}\n\n"
        "## Missing Normalized Fields\n\n"
        f"{missing_lines}\n\n"
        "## Comments\n\n"
        f"- Total comments: {normalized.get('comment_count_total', 0)}\n"
        f"- Normalized comments: {len(normalized.get('comments', []) or [])}\n\n"
        "## Attachments\n\n"
        f"- Total attachments: {normalized.get('attachment_count', 0)}\n"
        f"- Normalized attachments: {len(normalized.get('attachments', []) or [])}\n\n"
        "## Raw Jira Standard Field Keys\n\n"
        f"{std_keys_text}\n\n"
        "## Custom Fields (non-null, up to 20)\n\n"
        f"{custom_text}\n"
    )


def _field_name(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("name", "") or "")
    return ""


def _user_name(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("displayName") or value.get("accountId") or "")
    return ""


def _normalize_string_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v]
    return []


def _normalize_version_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    names: list[str] = []
    for v in value:
        if isinstance(v, dict):
            name = v.get("name") or v.get("id") or ""
            if name:
                names.append(str(name))
        elif v:
            names.append(str(v))
    return names


def _comment_count_total(issue: dict) -> int:
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    comment_raw = fields.get("comment")
    if isinstance(comment_raw, dict):
        total = comment_raw.get("total")
        if isinstance(total, int):
            return total
        return len(comment_raw.get("comments", []) or [])
    return 0


def _attachment_count(issue: dict) -> int:
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    raw = fields.get("attachment")
    return len(raw) if isinstance(raw, list) else 0


def _ordered_comments(comments: list[dict[str, str]]) -> list[dict[str, str]]:
    created = [comment.get("created", "") for comment in comments]
    if all(created) and created != sorted(created):
        return sorted(comments, key=lambda comment: comment.get("created", ""))
    return comments


def _comment_signal_terms(comments: list[object]) -> list[str]:
    text = "\n".join(
        str(comment.get("body_markdown", "")) for comment in comments if isinstance(comment, dict)
    ).lower()
    return [term for term in COMMENT_SIGNAL_TERMS if term in text]


def _latest_comment_timestamp(comments: list[object]) -> str:
    timestamps = [
        str(comment.get("created", ""))
        for comment in comments
        if isinstance(comment, dict) and comment.get("created")
    ]
    return max(timestamps) if timestamps else ""


def _attachment_kinds(attachments: list[object]) -> list[str]:
    kinds = sorted(
        {
            str(attachment.get("kind", "unknown"))
            for attachment in attachments
            if isinstance(attachment, dict)
        }
    )
    return kinds


def _preview(text: str, limit: int = 160) -> str:
    compact = " ".join(text.split())
    return compact[: limit - 3].rstrip() + "..." if len(compact) > limit else compact


def _safe_url(value: object) -> str:
    if not value:
        return ""
    parts = urlsplit(str(value))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _safe_int(value: object, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


_SENSITIVE_QUERY_RE = re.compile(
    r"(?i)([?&](?:token|access_token|refresh_token|password|passwd|secret|api_key|apikey|key)=)[^&\s#]*"
)
_SENSITIVE_KV_RE = re.compile(
    r"(?i)(?<![?&])\b(token|access_token|refresh_token|password|passwd|secret|api_key|apikey|key)"
    r"(\s*[=:]\s*)\S+"
)


def _redact_query_params(text: str) -> str:
    return _SENSITIVE_QUERY_RE.sub(r"\1<redacted>", text)


def _redact_kv(text: str) -> str:
    return _SENSITIVE_KV_RE.sub(r"\1\2<redacted>", text)


def _safe_preview(value: object, max_len: int = 80) -> str:
    """Return a sanitized, length-capped preview of a custom field value."""
    text = sanitize_comment_text(str(value).replace("\n", " ").replace("\r", " "))
    return text[:max_len]


def sanitize_comment_text(text: str) -> str:
    """Redact secret-like values before generated text is shared outside bugpilot."""
    text = _redact_query_params(str(text))
    return _redact_kv(text)


def _failure(issue_key: str, error_type: str) -> JiraFetchResult:
    return JiraFetchResult(
        issue_key=issue_key,
        source="jira",
        success=False,
        error_type=error_type,
        error_message=ERROR_MESSAGES.get(error_type, ERROR_MESSAGES["unknown_error"]),
        data={},
    )


def _fallback_or_raise(failure: JiraFetchResult, allow_mock: bool) -> JiraFetchResult:
    if not allow_mock:
        raise JiraFetchError(failure)
    mock = _mock_issue(failure.issue_key, failure.error_type or "unknown_error", failure.error_message or ERROR_MESSAGES["unknown_error"])
    return JiraFetchResult(
        issue_key=failure.issue_key,
        source="mock",
        success=True,
        error_type=failure.error_type,
        error_message=failure.error_message,
        data=mock,
    )


def _http_error_type(status_code: int) -> str:
    if status_code in {401, 403}:
        return "auth_or_permission"
    if status_code == 404:
        return "not_found"
    if status_code == 429:
        return "rate_limited"
    return "unknown_error"


def _mock_issue(issue_key: str, error_type: str, reason: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "key": issue_key,
        "source": "mock",
        "mock": True,
        "fallback_reason": reason,
        "fallback_error_type": error_type,
        "fields": {
            "summary": "Demo bug: employee search returns stale results after filter changes",
            "description": (
                "Mock/demo Jira content. Steps: open the HR employee search, "
                "apply a department filter, change the location filter, and observe stale "
                "results. Expected: results refresh for the new filter set. Actual: prior "
                "department results remain visible until page refresh."
            ),
            "issuetype": {"name": "Bug"},
            "status": {"name": "Open"},
            "priority": {"name": "Medium"},
            "comment": {
                "comments": [
                    {
                        "body": (
                            "Mock/demo note: suspected cache invalidation or query key issue "
                            "around employee search filters."
                        )
                    }
                ]
            },
        },
        "bugpilot_fetch": {
            "source": "mock",
            "mock": True,
            "fallback_reason": reason,
            "fallback_error_type": error_type,
            "generated_at": now,
        },
    }
