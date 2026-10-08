"""`bugpilot jira-site`: the one Jira site the CLI and the extension share (pre-release Batch 3).

The extension's Jira Setup saves the site here — not in SecretStorage, where
only the email and token belong — so the CLI and the panel can never point at
two different sites. `JIRA_BASE_URL` still wins, for both.
"""

from __future__ import annotations

import io
import json
import sys

import pytest

from bugpilot.cli import main
from bugpilot.core.config import load_config
from bugpilot.core.user_config import load_user_config, save_jira_site, save_user_config, user_config_path


def _show(capsys) -> dict:
    assert main(["jira-site", "--json"]) == 0
    return json.loads(capsys.readouterr().out)


def _set(monkeypatch, capsys, site: str) -> tuple[int, dict]:
    monkeypatch.setattr(sys, "stdin", io.StringIO(site + "\n"))
    code = main(["jira-site", "set", "--stdin", "--json"])
    return code, json.loads(capsys.readouterr().out)


def test_nothing_configured_says_so(capsys, monkeypatch):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    shown = _show(capsys)
    assert shown["site"] is None and shown["source"] is None


def test_set_saves_the_normalized_site_and_keeps_the_email_and_token(capsys, monkeypatch, tmp_path):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.chdir(tmp_path)
    save_user_config("dev@example.com", "kept-token", "https://old.example.com")

    code, saved = _set(monkeypatch, capsys, "  https://your-company.atlassian.net/  ")
    assert code == 0
    assert saved["site"] == "https://your-company.atlassian.net"
    assert saved["source"] == "user configuration"
    user = load_user_config()
    assert user.jira_base_url == "https://your-company.atlassian.net"
    assert (user.jira_email, user.jira_token) == ("dev@example.com", "kept-token")
    assert load_config(tmp_path).jira_base_url == "https://your-company.atlassian.net"


@pytest.mark.parametrize(
    ("site", "reason"),
    [
        ("http://your-company.atlassian.net", "must start with https://"),
        ("https://dev:secret@jira.example.test", "user name or password"),
        ("https://your-company.atlassian.net?x=1", "query or fragment"),
        ("your-company.atlassian.net", "must start with https://"),
        ("", "No Jira site is configured"),
    ],
)
def test_set_refuses_an_unsafe_site_and_writes_nothing(capsys, monkeypatch, site, reason):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    code, failed = _set(monkeypatch, capsys, site)
    assert code == 1
    assert failed["error"]["code"] == "INVALID_INPUT"
    assert reason in failed["error"]["message"]
    assert "secret" not in failed["error"]["message"]
    assert not user_config_path().exists()


def test_the_environment_wins_and_a_saved_site_says_so(capsys, monkeypatch):
    monkeypatch.setenv("JIRA_BASE_URL", "https://env.example.com/")
    shown = _show(capsys)
    assert shown == {**shown, "site": "https://env.example.com", "source": "environment"}

    code, saved = _set(monkeypatch, capsys, "https://your-company.atlassian.net")
    assert code == 0
    assert saved["site"] == "https://env.example.com"
    assert saved["warnings"] == ["JIRA_BASE_URL is set in the environment, and BugPilot uses it instead of the saved site."]
    assert load_user_config().jira_base_url == "https://your-company.atlassian.net"


def test_an_unusable_configured_site_is_not_echoed(capsys, monkeypatch):
    monkeypatch.setenv("JIRA_BASE_URL", "https://dev:hunter2@env.example.com")
    shown = _show(capsys)
    assert shown["site"] is None
    assert shown["source"] == "environment"
    assert "user name or password" in shown["problem"]
    assert "hunter2" not in json.dumps(shown)


def test_save_jira_site_creates_the_file_when_there_is_none():
    save_jira_site("https://your-company.atlassian.net")
    assert load_user_config().jira_base_url == "https://your-company.atlassian.net"
    assert load_user_config().jira_token is None


@pytest.mark.parametrize("site", ["https://[your-company].atlassian.net", "https://[::1", "https://a]b.com"])
def test_a_bracketed_host_is_refused_as_a_site_not_a_crash(site, capsys, monkeypatch):
    """`urlsplit` raises a bare ValueError for these; every caller handles only JiraSiteError (Batch 4)."""
    from bugpilot.core.jira import JiraSiteError, normalize_jira_site

    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    with pytest.raises(JiraSiteError, match="invalid host name"):
        normalize_jira_site(site)
    code, refused = _set(monkeypatch, capsys, site)
    assert code == 1 and "invalid host name" in refused["error"]["message"]
    assert site not in refused["error"]["message"]
