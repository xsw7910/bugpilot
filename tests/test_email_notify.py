from __future__ import annotations

import email
import io
import json
import smtplib
import urllib.error

import pytest

from bugpilot.cli import main
from bugpilot.core.config import load_email_config, load_graph_config


@pytest.fixture(autouse=True)
def clear_email_env(monkeypatch):
    for name in (
        "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD",
        "SMTP_USE_SSL", "SMTP_USE_STARTTLS",
        "BUGPILOT_EMAIL_FROM", "BUGPILOT_EMAIL_TO",
        "GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET",
        "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


def _set_graph_env(monkeypatch):
    monkeypatch.setenv("GRAPH_TENANT_ID", "tenant-123")
    monkeypatch.setenv("GRAPH_CLIENT_ID", "client-123")
    monkeypatch.setenv("GRAPH_CLIENT_SECRET", "graph-secret-value")
    monkeypatch.setenv("BUGPILOT_EMAIL_FROM", "bugpilot@example.test")
    monkeypatch.setenv("BUGPILOT_EMAIL_TO", "dev@example.test")


def _install_fake_graph(monkeypatch):
    """Capture the token request and the sendMail request over a fake urlopen."""
    calls: list = []

    class _Resp:
        def __init__(self, body: bytes):
            self._body = body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return self._body

    def fake_urlopen(request, timeout=None):
        url = request.full_url
        calls.append({"url": url, "data": request.data, "headers": dict(request.header_items())})
        if "oauth2" in url:
            return _Resp(json.dumps({"access_token": "fake-token", "expires_in": 3599}).encode())
        return _Resp(b"")  # sendMail returns 202 with empty body

    monkeypatch.setattr("bugpilot.core.email_notify.urllib.request.urlopen", fake_urlopen)
    return calls


def _set_email_env(monkeypatch, *, auth=False):
    monkeypatch.setenv("SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("BUGPILOT_EMAIL_FROM", "bugpilot@example.test")
    monkeypatch.setenv("BUGPILOT_EMAIL_TO", "dev@example.test")
    if auth:
        monkeypatch.setenv("SMTP_USERNAME", "smtp-user")
        monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")


def _seed_result_artifacts(tmp_path, issue_key="JR-12345"):
    issue_dir = tmp_path / ".ai" / issue_key
    issue_dir.mkdir(parents=True, exist_ok=True)
    (issue_dir / "jira_summary.md").write_text(
        "# Jira Summary\n\n"
        "## Summary\n\nStale results after filter change\n\n"
        "## Description\n\nApplying a department filter leaves stale results visible.\n",
        encoding="utf-8",
    )
    (issue_dir / "result_summary.md").write_text(
        "# Result Summary\n\n"
        "## Issue\nJR-12345\n\n"
        "## Root Cause Summary\nStale React Query cache key\n\n"
        "## Fix Summary\nRebuild the query key from the active filter set\n\n"
        "## Test Summary\nFocused unit tests passed\n\n"
        "## Diff Summary\nsrc/EmployeeSearch.cpp changed\n\n"
        "## Review Notes\nLooks safe\n",
        encoding="utf-8",
    )
    return issue_dir


def _install_fake_smtp(monkeypatch):
    sent: list = []

    class _FakeSMTP:
        def __init__(self, host, port, timeout=None, context=None):
            self.host = host
            self.port = port
            self.started_tls = False
            self.logged_in = None

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self, context=None):
            self.started_tls = True

        def login(self, user, password):
            self.logged_in = (user, password)

        def send_message(self, message):
            sent.append(message)

    monkeypatch.setattr("bugpilot.core.email_notify.smtplib.SMTP", _FakeSMTP)
    monkeypatch.setattr("bugpilot.core.email_notify.smtplib.SMTP_SSL", _FakeSMTP)
    return sent


def test_email_draft_contains_the_four_requested_blocks(tmp_path, monkeypatch):
    monkeypatch.setenv("JIRA_BASE_URL", "https://jira.example.test")
    issue_dir = _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345"]) == 0
    draft = (issue_dir / "email_draft.md").read_text(encoding="utf-8")

    # Modified Jira item
    assert "JR-12345" in draft
    assert "Stale results after filter change" in draft
    assert "https://jira.example.test/browse/JR-12345" in draft
    # Original problem
    assert "Applying a department filter leaves stale results visible." in draft
    # Bug cause
    assert "Stale React Query cache key" in draft
    # Changes made
    assert "Rebuild the query key from the active filter set" in draft
    assert "src/EmployeeSearch.cpp changed" in draft


def test_notify_preview_does_not_send(tmp_path, monkeypatch, capsys):
    _set_email_env(monkeypatch)
    sent = _install_fake_smtp(monkeypatch)
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345"]) == 0
    output = capsys.readouterr().out

    assert sent == []
    assert "Preview only" in output
    assert "email_draft.md" in output


def test_notify_execute_sends_over_smtp(tmp_path, monkeypatch, capsys):
    _set_email_env(monkeypatch, auth=True)
    sent = _install_fake_smtp(monkeypatch)
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345", "--execute"]) == 0
    output = capsys.readouterr().out

    assert len(sent) == 1
    message = sent[0]
    assert message["To"] == "dev@example.test"
    assert "JR-12345" in message["Subject"]
    assert "Sent notification email via smtp to: dev@example.test" in output
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())
    assert status["steps"]["notify"] == "pass"


def test_notify_execute_without_config_skips_gracefully(tmp_path, monkeypatch, capsys):
    sent = _install_fake_smtp(monkeypatch)
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345", "--execute"]) == 0
    captured = capsys.readouterr()

    assert sent == []
    assert "email not sent" in captured.out
    assert "SMTP_HOST" in captured.err
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())
    assert status["steps"]["notify"] == "skipped"


def test_commit_plan_sends_email_at_commit_gate(tmp_path, monkeypatch, capsys):
    _set_email_env(monkeypatch)
    sent = _install_fake_smtp(monkeypatch)
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["commit-plan", "JR-12345"]) == 0
    output = capsys.readouterr().out

    assert (tmp_path / ".ai" / "JR-12345" / "commit_plan.md").is_file()
    assert len(sent) == 1
    assert "Sent notification email via smtp to: dev@example.test" in output


def test_commit_plan_no_email_flag_suppresses_send(tmp_path, monkeypatch, capsys):
    _set_email_env(monkeypatch)
    sent = _install_fake_smtp(monkeypatch)
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["commit-plan", "JR-12345", "--no-email"]) == 0
    output = capsys.readouterr().out

    assert sent == []
    assert "Sent notification email" not in output


def test_email_body_redacts_secret_like_values(tmp_path, monkeypatch):
    _seed_result_artifacts(tmp_path)
    issue_dir = tmp_path / ".ai" / "JR-12345"
    (issue_dir / "result_summary.md").write_text(
        "# Result Summary\n\n"
        "## Fix Summary\nSet api_key=SUPERSECRETVALUE in the client\n\n"
        "## Diff Summary\nchanged\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345"]) == 0
    draft = (issue_dir / "email_draft.md").read_text(encoding="utf-8")

    assert "SUPERSECRETVALUE" not in draft
    assert "<redacted>" in draft


def test_commit_gate_email_failure_is_non_fatal(tmp_path, monkeypatch, capsys):
    _set_email_env(monkeypatch)
    _seed_result_artifacts(tmp_path)

    class _FailingSMTP:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self, context=None):
            pass

        def send_message(self, message):
            raise smtplib.SMTPException("relay refused")

    monkeypatch.setattr("bugpilot.core.email_notify.smtplib.SMTP", _FailingSMTP)
    monkeypatch.chdir(tmp_path)

    # commit-plan must still succeed even if the notification email fails.
    assert main(["commit-plan", "JR-12345"]) == 0
    captured = capsys.readouterr()

    assert "Generated commit plan" in captured.out
    assert "commit-gate email not sent" in captured.err
    assert "SMTPException" in captured.err
    assert "smtp-secret" not in captured.err
    assert "smtp-secret" not in captured.out


def test_notify_execute_smtp_failure_returns_error(tmp_path, monkeypatch, capsys):
    _set_email_env(monkeypatch, auth=True)
    _seed_result_artifacts(tmp_path)

    class _FailingSMTP:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self, context=None):
            pass

        def login(self, user, password):
            pass

        def send_message(self, message):
            raise smtplib.SMTPException("relay refused")

    monkeypatch.setattr("bugpilot.core.email_notify.smtplib.SMTP", _FailingSMTP)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345", "--execute"]) == 1
    captured = capsys.readouterr()
    assert "SMTP send failed" in captured.err
    assert "smtp-secret" not in captured.err


def test_load_email_config_parses_recipients_and_flags(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("BUGPILOT_EMAIL_FROM", "bugpilot@example.test")
    monkeypatch.setenv("BUGPILOT_EMAIL_TO", "a@x.test, b@y.test; c@z.test")
    monkeypatch.setenv("SMTP_USE_STARTTLS", "false")
    monkeypatch.setenv("SMTP_USE_SSL", "true")

    config = load_email_config()

    assert config.recipients == ("a@x.test", "b@y.test", "c@z.test")
    assert config.use_starttls is False
    assert config.use_ssl is True
    assert config.is_configured is True


def test_email_config_reports_missing_fields(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "smtp.example.test")
    config = load_email_config()

    assert config.is_configured is False
    assert "BUGPILOT_EMAIL_FROM" in config.missing_fields()
    assert "BUGPILOT_EMAIL_TO" in config.missing_fields()


def test_notify_writes_portable_eml(tmp_path, monkeypatch):
    monkeypatch.setenv("BUGPILOT_EMAIL_FROM", "bugpilot@example.test")
    monkeypatch.setenv("BUGPILOT_EMAIL_TO", "dev@example.test")
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345"]) == 0
    eml_bytes = (tmp_path / ".ai" / "JR-12345" / "notification.eml").read_bytes()
    message = email.message_from_bytes(eml_bytes)

    assert message["To"] == "dev@example.test"
    assert "JR-12345" in message["Subject"]
    payload = message.get_payload()
    assert "Stale React Query cache key" in payload
    assert "Rebuild the query key from the active filter set" in payload


def test_notify_eml_written_even_without_any_transport(tmp_path, monkeypatch):
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345"]) == 0
    assert (tmp_path / ".ai" / "JR-12345" / "notification.eml").is_file()


def test_graph_transport_sends_over_https(tmp_path, monkeypatch, capsys):
    _set_graph_env(monkeypatch)
    calls = _install_fake_graph(monkeypatch)
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345", "--execute"]) == 0
    output = capsys.readouterr().out

    assert len(calls) == 2
    token_call, send_call = calls
    assert "oauth2" in token_call["url"] and "tenant-123" in token_call["url"]
    assert "graph.microsoft.com" in send_call["url"]
    assert "bugpilot@example.test/sendMail" in send_call["url"]
    payload = json.loads(send_call["data"].decode())
    assert payload["message"]["subject"].startswith("[bugpilot] JR-12345")
    assert payload["message"]["toRecipients"][0]["emailAddress"]["address"] == "dev@example.test"
    assert "Stale React Query cache key" in payload["message"]["body"]["content"]
    assert "Sent notification email via graph to: dev@example.test" in output
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())
    assert status["steps"]["notify"] == "pass"


def test_graph_preferred_over_smtp_when_both_configured(tmp_path, monkeypatch):
    _set_email_env(monkeypatch)          # SMTP present
    _set_graph_env(monkeypatch)          # Graph present too
    calls = _install_fake_graph(monkeypatch)
    smtp_sent = _install_fake_smtp(monkeypatch)
    _seed_result_artifacts(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["commit-plan", "JR-12345"]) == 0

    assert len(calls) == 2       # Graph was used
    assert smtp_sent == []       # SMTP was not touched


def test_graph_token_failure_is_reported_without_secret(tmp_path, monkeypatch, capsys):
    _set_graph_env(monkeypatch)
    _seed_result_artifacts(tmp_path)

    def failing_urlopen(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", hdrs=None, fp=io.BytesIO(b""))

    monkeypatch.setattr("bugpilot.core.email_notify.urllib.request.urlopen", failing_urlopen)
    monkeypatch.chdir(tmp_path)

    assert main(["notify", "JR-12345", "--execute"]) == 1
    captured = capsys.readouterr()
    assert "Graph token request failed: HTTP 401" in captured.err
    assert "graph-secret-value" not in captured.err
    assert "graph-secret-value" not in captured.out


def test_graph_config_missing_fields(monkeypatch):
    monkeypatch.setenv("GRAPH_TENANT_ID", "tenant-123")
    config = load_graph_config()

    assert config.is_configured is False
    assert "GRAPH_CLIENT_ID" in config.missing_fields()
    assert "GRAPH_CLIENT_SECRET" in config.missing_fields()
