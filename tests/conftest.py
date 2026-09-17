"""Shared pytest fixtures.

Isolates the user-level BugPilot config so tests never read or write the real
``~/.bugpilot/config.toml`` (which would make results depend on whether the
developer has run ``bugpilot setup``), and the Jira credentials with it.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolate_bugpilot_config(tmp_path_factory, monkeypatch):
    config_dir = tmp_path_factory.mktemp("bugpilot-home")
    monkeypatch.setenv("BUGPILOT_CONFIG_DIR", str(config_dir))
    return config_dir


@pytest.fixture(autouse=True)
def no_real_jira(monkeypatch):
    """No test talks to anybody's Jira.

    ``load_config`` falls back to ``JIRA_BASE_URL`` / ``JIRA_EMAIL`` /
    ``JIRA_TOKEN`` from the environment, which a developer who uses this tool
    has set — so the suite was quietly issuing HTTP requests to a real tenant
    and passing because the example key happened to be a real ticket there.
    Renaming the example to a project that does not exist is what surfaced it.

    Without credentials every fetch takes the ``missing_env`` path and returns
    the mock issue, which is what these tests mean by "a fetch". A test that
    wants credentials sets them itself; monkeypatch ordering lets it.
    """
    for name in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN"):
        monkeypatch.delenv(name, raising=False)
