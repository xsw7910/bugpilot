"""Jira credentials go only to an https:// site, and never follow a redirect elsewhere.

Every Jira request carries the developer's email and API
token as HTTP Basic credentials. urllib's default redirect handler copies the
`Authorization` header onto every redirect, to any host; and the site used to be
accepted as `http://`. These tests drive urllib's real redirect machinery through
a fake transport and record exactly which requests carried the credentials.
"""

from __future__ import annotations

import email.message
import io
import json
import urllib.request

import pytest

from bugpilot.cli import main
from bugpilot.core import errors, jira
from bugpilot.core.jira import (
    JiraRedirectRefused,
    JiraSiteError,
    fetch_issue,
    normalize_jira_site,
    post_jira_comment,
    validate_credentials,
)

TOKEN = "s3cret-api-token-value"


# --- the site ---------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, normalized",
    [
        ("https://example.atlassian.net", "https://example.atlassian.net"),
        ("  https://Jira.Example.com/  ", "https://jira.example.com"),
        ("https://jira.example.com:8443/jira/", "https://jira.example.com:8443/jira"),
        ("HTTPS://jira.example.com", "https://jira.example.com"),
        ("https://[2001:db8::1]:9443", "https://[2001:db8::1]:9443"),
        ("https://jira_internal.corp.example", "https://jira_internal.corp.example"),
    ],
)
def test_https_sites_are_accepted_and_normalized(raw, normalized):
    assert normalize_jira_site(raw) == normalized


@pytest.mark.parametrize(
    "raw",
    [
        "http://jira.example.com",
        "http://localhost:8080",
        "ftp://jira.example.com",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "jira.example.com",
        "https://user:pw@jira.example.com",
        "https://token@jira.example.com",
        "https://jira.example.com/?next=evil",
        "https://jira.example.com/#frag",
        "https://jira example.com",
        "https://jira.example.com\\evil",
        "https://jira.exa\tmple.com",
        "https://-bad-.example.com",
        "https://jira.example.com:99999",
        "https://jira.example.com:port",
        "https://",
        "",
        None,
    ],
)
def test_anything_else_is_refused(raw):
    with pytest.raises(JiraSiteError):
        normalize_jira_site(raw)


# --- the transport, with urllib's own redirect handling ------------------------


class _Response(io.BytesIO):
    def __init__(self, url: str, code: int, body: bytes = b"", location: str | None = None):
        super().__init__(body)
        self.url = url
        self.code = self.status = code
        self.msg = "OK" if code == 200 else "Found"
        self.headers = email.message.Message()
        if location is not None:
            self.headers["Location"] = location

    def info(self):
        return self.headers

    def geturl(self):
        return self.url


class _FakeServer(urllib.request.BaseHandler):
    """Answers every request from a script: url -> (code, location or body)."""

    handler_order = 100  # before urllib's real HTTP(S) handlers

    def __init__(self, routes: dict[str, tuple[int, object]]):
        self.routes = routes
        self.seen: list[tuple[str, str | None]] = []

    def _answer(self, req):
        headers = dict(req.header_items())
        self.seen.append((req.full_url, headers.get("Authorization")))
        code, payload = self.routes[req.full_url]
        if 300 <= code < 400:
            return _Response(req.full_url, code, location=str(payload))
        return _Response(req.full_url, code, body=json.dumps(payload).encode())

    https_open = _answer
    http_open = _answer


def _install(monkeypatch, routes):
    server = _FakeServer(routes)
    opener = jira._build_opener(server)
    monkeypatch.setattr(jira, "_open", lambda request, timeout: opener.open(request, timeout=timeout))
    return server


@pytest.fixture
def credentials(monkeypatch):
    monkeypatch.setenv("JIRA_BASE_URL", "https://jira.example.com")
    monkeypatch.setenv("JIRA_EMAIL", "dev@example.com")
    monkeypatch.setenv("JIRA_TOKEN", TOKEN)


ISSUE = {"key": "JR-12345", "fields": {"summary": "Search shows stale results", "description": None}}
ISSUE_URL = "https://jira.example.com/rest/api/3/issue/JR-12345?expand=renderedFields"


def test_a_direct_answer_carries_the_credentials_once(monkeypatch, tmp_path, credentials):
    server = _install(monkeypatch, {ISSUE_URL: (200, ISSUE)})

    result = fetch_issue(tmp_path, "JR-12345", allow_mock=False)

    assert result.success
    assert [url for url, _auth in server.seen] == [ISSUE_URL]
    assert server.seen[0][1].startswith("Basic ")


def test_a_same_origin_redirect_is_followed_with_the_credentials(monkeypatch, tmp_path, credentials):
    moved = "https://jira.example.com/jira/rest/api/3/issue/JR-12345"
    server = _install(monkeypatch, {ISSUE_URL: (302, moved), moved: (200, ISSUE)})

    assert fetch_issue(tmp_path, "JR-12345", allow_mock=False).success
    assert [url for url, _ in server.seen] == [ISSUE_URL, moved]
    assert all(auth and auth.startswith("Basic ") for _, auth in server.seen)


def test_a_same_origin_redirect_chain_is_followed(monkeypatch, tmp_path, credentials):
    hop1 = "https://jira.example.com/a"
    hop2 = "https://jira.example.com:443/b"
    server = _install(monkeypatch, {ISSUE_URL: (301, hop1), hop1: (307, hop2), hop2: (200, ISSUE)})

    assert fetch_issue(tmp_path, "JR-12345", allow_mock=False).success
    assert len(server.seen) == 3


@pytest.mark.parametrize(
    "elsewhere",
    [
        "https://evil.example.net/rest/api/3/issue/JR-12345",  # another host
        "https://jira.example.com.evil.net/x",  # a host that merely starts the same
        "https://jira.example.com:8443/x",  # another port
        "http://jira.example.com/x",  # a downgrade to http
    ],
)
def test_a_redirect_to_another_origin_is_refused_and_never_sent_there(monkeypatch, tmp_path, credentials, elsewhere):
    server = _install(monkeypatch, {ISSUE_URL: (302, elsewhere), elsewhere: (200, ISSUE)})

    result = fetch_issue(tmp_path, "JR-12345", allow_mock=True)

    # Not followed at all — not even without the credentials.
    assert [url for url, _ in server.seen] == [ISSUE_URL]
    assert result.success is False or result.source == "mock"
    assert result.error_type == "redirect_refused"
    assert errors.code_for_jira_error_type(result.error_type) == errors.JIRA_REDIRECT_REFUSED


def test_a_chain_that_leaves_the_origin_on_its_second_hop_is_refused(monkeypatch, tmp_path, credentials):
    hop1 = "https://jira.example.com/a"
    out = "https://evil.example.net/b"
    server = _install(monkeypatch, {ISSUE_URL: (302, hop1), hop1: (302, out), out: (200, ISSUE)})

    with pytest.raises(jira.JiraFetchError) as exc:
        fetch_issue(tmp_path, "JR-12345", allow_mock=False)

    assert exc.value.result.error_type == "redirect_refused"
    assert [url for url, _ in server.seen] == [ISSUE_URL, hop1]


def test_the_redirect_handler_alone_compares_scheme_host_and_effective_port():
    handler = jira._SameOriginRedirectHandler()
    request = urllib.request.Request("https://jira.example.com/rest", headers={"Authorization": "Basic x"})
    same = handler.redirect_request(request, None, 302, "Found", {}, "https://JIRA.example.com:443/other")
    assert same is not None and same.full_url == "https://JIRA.example.com:443/other"
    for elsewhere in ("http://jira.example.com/rest", "https://jira.example.com:444/rest", "https://other.example.com/rest"):
        with pytest.raises(JiraRedirectRefused):
            handler.redirect_request(request, None, 302, "Found", {}, elsewhere)


def test_an_http_site_is_never_contacted(monkeypatch, tmp_path, credentials, capsys):
    monkeypatch.setenv("JIRA_BASE_URL", "http://jira.example.com")
    server = _install(monkeypatch, {})

    result = fetch_issue(tmp_path, "JR-12345", allow_mock=True)
    assert result.error_type == "invalid_site" and result.source == "mock"
    assert server.seen == []

    monkeypatch.chdir(tmp_path)
    assert main(["fetch", "JR-12345", "--json"]) == 1
    failure = json.loads(capsys.readouterr().out)
    assert failure["error"]["code"] == errors.JIRA_INVALID_SITE
    assert server.seen == []


def test_validation_and_comment_posting_follow_the_same_rules(monkeypatch, tmp_path, credentials):
    server = _install(monkeypatch, {})
    assert validate_credentials("http://jira.example.com", "dev@example.com", TOKEN).error_type == "invalid_site"

    myself = "https://jira.example.com/rest/api/3/myself"
    _install(monkeypatch, {myself: (302, "https://evil.example.net/me")})
    assert validate_credentials("https://jira.example.com", "dev@example.com", TOKEN).error_type == "redirect_refused"

    comment_url = "https://jira.example.com/rest/api/3/issue/JR-12345/comment"
    _install(monkeypatch, {comment_url: (307, "https://evil.example.net/comment")})
    with pytest.raises(jira.JiraCommentPostError) as exc:
        post_jira_comment(tmp_path, "JR-12345", "Root cause: stale cache.")
    assert exc.value.error_type == "redirect_refused"

    monkeypatch.setenv("JIRA_BASE_URL", "http://jira.example.com")
    with pytest.raises(jira.JiraCommentPostError) as exc:
        post_jira_comment(tmp_path, "JR-12345", "Root cause: stale cache.")
    assert exc.value.error_type == "invalid_site"
    assert server.seen == []


def test_the_token_never_reaches_messages_artifacts_or_the_log(monkeypatch, tmp_path, credentials, capsys):
    """Every failure path is a fixed sentence; a run writes the issue, never the token."""
    for error_type, message in jira.ERROR_MESSAGES.items():
        assert TOKEN not in message, error_type
    _install(monkeypatch, {ISSUE_URL: (200, ISSUE)})
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--prepare-only"]) == 0
    captured = capsys.readouterr()
    assert TOKEN not in captured.out + captured.err
    for path in (tmp_path / ".ai").rglob("*"):
        if path.is_file():
            assert TOKEN not in path.read_text(encoding="utf-8", errors="replace"), path.name
            assert "Basic " not in path.read_text(encoding="utf-8", errors="replace"), path.name


def test_the_not_configured_message_names_setup_and_nothing_secret():
    """The message says how to configure Jira — `bugpilot setup`
    or the three variables — and carries no value: no site, no email, no token."""
    message = jira.ERROR_MESSAGES["missing_env"]
    assert "bugpilot setup" in message
    assert all(name in message for name in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN"))
    assert "https://" not in message and "@" not in message and "atlassian" not in message.lower()
