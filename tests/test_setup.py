from __future__ import annotations

import json
import urllib.error

import pytest

from bugpilot.cli import main
from bugpilot.core.config import load_config
from bugpilot.core.jira import JiraValidationResult, validate_credentials
from bugpilot.core.setup import run_setup
from bugpilot.core.user_config import (
    UserConfig,
    load_user_config,
    save_user_config,
    user_config_path,
)


@pytest.fixture(autouse=True)
def clear_jira_env(monkeypatch):
    for name in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN"):
        monkeypatch.delenv(name, raising=False)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# --- user_config ------------------------------------------------------------


def test_save_and_load_round_trip():
    path = save_user_config("dev@example.com", "tok-123")
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert 'jira_email = "dev@example.com"' in text
    assert 'jira_token = "tok-123"' in text

    cfg = load_user_config()
    assert cfg.jira_email == "dev@example.com"
    assert cfg.jira_token == "tok-123"


def test_load_missing_config_returns_empty():
    assert load_user_config() == UserConfig()


def test_toml_round_trips_special_characters():
    save_user_config('a"b', "c\\d")
    cfg = load_user_config()
    assert cfg.jira_email == 'a"b'
    assert cfg.jira_token == "c\\d"


# --- validate_credentials ---------------------------------------------------


def test_validate_credentials_ok(monkeypatch):
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _FakeResponse({"emailAddress": "e@x.com", "displayName": "Dev"}),
    )
    result = validate_credentials("https://x.atlassian.net", "e@x.com", "tok")
    assert result.ok
    assert result.account_email == "e@x.com"
    assert result.display_name == "Dev"


def test_validate_credentials_auth_failure(monkeypatch):
    def raise_http(request, timeout):
        raise urllib.error.HTTPError("url", 401, "Unauthorized", None, None)

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", raise_http)
    result = validate_credentials("https://x", "e", "bad")
    assert not result.ok
    assert result.error_type == "auth_or_permission"
    assert result.error_message


def test_validate_credentials_network_error(monkeypatch):
    def raise_url(request, timeout):
        raise urllib.error.URLError("host down")

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", raise_url)
    result = validate_credentials("https://x", "e", "t")
    assert not result.ok
    assert result.error_type == "network_error"


# --- load_config integration ------------------------------------------------


def test_load_config_reads_the_site_from_the_config_file(tmp_path):
    save_user_config("e@x.com", "tok", "https://acme.example.com")
    cfg = load_config(tmp_path)
    assert cfg.jira_base_url == "https://acme.example.com"
    assert cfg.jira_email == "e@x.com"
    assert cfg.jira_token == "tok"
    assert cfg.has_jira_credentials


def test_an_unconfigured_install_has_no_jira_site_at_all(tmp_path):
    """No built-in tenant, and none invented.

    There used to be a hard-coded company site here, which in a package anyone
    can install means disclosing an internal hostname and aiming a stranger's
    first run at somebody else's Jira. Absent must read as "not configured".
    """
    save_user_config("e@x.com", "tok")
    cfg = load_config(tmp_path)
    assert cfg.jira_base_url is None
    # An email and a token alone are not a configured Jira: `has_jira_credentials`
    # requires the site, so the CLI reports itself unconfigured rather than
    # aiming at a guess.
    assert not cfg.has_jira_credentials


def test_env_overrides_user_config(monkeypatch, tmp_path):
    save_user_config("file@x.com", "filetok")
    monkeypatch.setenv("JIRA_EMAIL", "env@x.com")
    monkeypatch.setenv("JIRA_TOKEN", "envtok")
    monkeypatch.setenv("JIRA_BASE_URL", "https://custom.example.com")
    cfg = load_config(tmp_path)
    assert cfg.jira_email == "env@x.com"
    assert cfg.jira_token == "envtok"
    assert cfg.jira_base_url == "https://custom.example.com"


# --- run_setup flow ---------------------------------------------------------


def _all_tools_present(monkeypatch):
    monkeypatch.setattr("bugpilot.core.git_ops.command_available", lambda command: True)


def test_run_setup_success_saves_config(monkeypatch):
    _all_tools_present(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.validate_credentials",
        lambda base_url, email, token, timeout=30: JiraValidationResult(ok=True, account_email=email),
    )
    # Token is shown by default, so both email and token come from `prompt`.
    answers = iter(["https://acme.example.com", "dev@example.com", "tok-123"])
    out = []

    rc = run_setup(prompt=lambda p: next(answers), out=out.append)

    text = "\n".join(out)
    assert rc == 0
    assert "BugPilot Setup" in text
    assert "Jira URL" in text
    assert "Login successful" in text
    assert "Setup completed!" in text
    # The one fictional key the whole codebase uses. It was a real colleague's
    # ticket until this package became publishable.
    assert "bugpilot JR-12345" in text

    cfg = load_user_config()
    assert cfg.jira_email == "dev@example.com"
    assert cfg.jira_token == "tok-123"


def test_run_setup_hidden_token_uses_secret_reader(monkeypatch):
    _all_tools_present(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.validate_credentials",
        lambda *a, **k: JiraValidationResult(ok=True),
    )
    out = []
    # With hide_token=True the token is read from prompt_secret; the site and
    # the email still come from `prompt`.
    iter_answers = iter(["https://acme.example.com", "e@x.com"])
    rc = run_setup(
        prompt=lambda p: next(iter_answers),
        prompt_secret=lambda p: "hidden-tok",
        out=out.append,
        hide_token=True,
    )
    assert rc == 0
    assert "input is hidden" in "\n".join(out)
    assert load_user_config().jira_token == "hidden-tok"


def test_run_setup_auth_failure_does_not_save(monkeypatch):
    _all_tools_present(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.validate_credentials",
        lambda *a, **k: JiraValidationResult(ok=False, error_type="auth_or_permission", error_message="x"),
    )
    answers = iter(["https://acme.example.com", "e@x.com", "bad"])
    out = []

    rc = run_setup(prompt=lambda p: next(answers), out=out.append)

    text = "\n".join(out)
    assert rc == 1
    assert "Authentication failed." in text
    assert "bugpilot setup" in text
    # Bad credentials are never persisted.
    assert not user_config_path().exists()
    assert load_user_config() == UserConfig()


def test_run_setup_warns_when_copilot_missing(monkeypatch):
    availability = {"git": True, "rg": True, "copilot": False}
    monkeypatch.setattr("bugpilot.core.git_ops.command_available", lambda command: availability.get(command, False))
    monkeypatch.setattr(
        "bugpilot.core.jira.validate_credentials",
        lambda *a, **k: JiraValidationResult(ok=True),
    )
    answers = iter(["https://acme.example.com", "e@x.com", "t"])
    out = []

    rc = run_setup(prompt=lambda p: next(answers), out=out.append)

    text = "\n".join(out)
    assert rc == 0
    assert "GitHub Copilot CLI not found" in text
    assert "✓ Git" in text
    assert "✓ ripgrep" in text


def test_run_setup_aborts_when_email_abandoned(monkeypatch):
    _all_tools_present(monkeypatch)

    def eof(_prompt):
        raise EOFError

    out = []
    rc = run_setup(prompt=eof, prompt_secret=lambda p: "t", out=out.append)
    assert rc == 1
    assert not user_config_path().exists()


# --- CLI wiring -------------------------------------------------------------


def test_setup_subcommand_dispatches(monkeypatch):
    captured = {}

    def spy(hide_token=False):
        captured["hide_token"] = hide_token
        return 0

    monkeypatch.setattr("bugpilot.core.setup.run_setup", spy)
    assert main(["setup"]) == 0
    assert captured["hide_token"] is False


def test_setup_hide_token_flag(monkeypatch):
    captured = {}

    def spy(hide_token=False):
        captured["hide_token"] = hide_token
        return 0

    monkeypatch.setattr("bugpilot.core.setup.run_setup", spy)
    assert main(["setup", "--hide-token"]) == 0
    assert captured["hide_token"] is True


def test_setup_stores_the_site_it_was_given(monkeypatch):
    """The whole point of asking: the answer has to survive the process."""
    monkeypatch.setattr(
        "bugpilot.core.setup.jira.validate_credentials",
        lambda *_args, **_kwargs: JiraValidationResult(ok=True),
    )
    answers = iter(["https://acme.example.com/", "dev@example.com", "tok"])
    rc = run_setup(prompt=lambda _p: next(answers), out=lambda _line: None)

    assert rc == 0
    # Trailing slash trimmed: every call site builds f"{base_url}/rest/api/3/…".
    assert load_user_config().jira_base_url == "https://acme.example.com"


def test_setup_rejects_a_site_with_no_scheme(monkeypatch):
    """A value without https:// produces a request to a relative path.

    The error would surface three layers away, in urllib, long after the typo.
    """
    monkeypatch.setattr(
        "bugpilot.core.setup.jira.validate_credentials",
        lambda *_args, **_kwargs: JiraValidationResult(ok=True),
    )
    out: list[str] = []
    answers = iter(["acme.example.com", "https://acme.example.com", "dev@example.com", "tok"])
    rc = run_setup(prompt=lambda _p: next(answers), out=out.append)

    assert rc == 0
    assert "does not look like a URL" in "\n".join(out)
    assert load_user_config().jira_base_url == "https://acme.example.com"


def test_setup_keeps_the_site_already_configured(monkeypatch):
    """Enter means "leave it alone" — this command is also how a token is rotated."""
    save_user_config("old@example.com", "oldtok", "https://kept.example.com")
    monkeypatch.setattr(
        "bugpilot.core.setup.jira.validate_credentials",
        lambda *_args, **_kwargs: JiraValidationResult(ok=True),
    )
    answers = iter(["", "new@example.com", "newtok"])
    rc = run_setup(prompt=lambda _p: next(answers), out=lambda _line: None)

    assert rc == 0
    cfg = load_user_config()
    assert cfg.jira_base_url == "https://kept.example.com"
    assert cfg.jira_email == "new@example.com"
