"""`bugpilot issue-details`: two strings, and nothing written.

The editor's hint improver needs an issue's title and description before a run
has happened. `fetch` already reads Jira, but it writes `.ai/<issue>/` because a
run needs those artifacts — and creating a work item as a side effect of
improving a sentence would be a surprise the developer did not ask for.

So this command exists to be the read-only half: the same Jira client, the same
parser, no filesystem. These tests hold that boundary.
"""

from __future__ import annotations

import json

import pytest

from bugpilot.cli import main
from bugpilot.core.jira import JiraFetchError, JiraFetchResult


@pytest.fixture
def jira(monkeypatch):
    """A Jira that answers, without a network or credentials."""

    def fake(repo_root, issue_key, allow_mock=False):
        return JiraFetchResult(
            issue_key=issue_key,
            source="jira",
            success=True,
            error_type=None,
            error_message=None,
            data={
                "key": issue_key,
                "fields": {
                    "summary": "Statistics crash on an empty volume",
                    "description": "Opening a volume with no traces crashes the panel.",
                },
            },
        )

    monkeypatch.setattr("bugpilot.cli.fetch_issue", fake)


def test_it_reports_the_title_and_description(tmp_path, monkeypatch, capsys, jira):
    monkeypatch.chdir(tmp_path)

    assert main(["issue-details", "JR-1", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is True
    assert payload["work_item_id"] == "JR-1"
    assert payload["title"] == "Statistics crash on an empty volume"
    assert "no traces" in payload["description"]


def test_it_writes_nothing(tmp_path, monkeypatch, capsys, jira):
    """The whole reason this is not `fetch`."""
    monkeypatch.chdir(tmp_path)

    assert main(["issue-details", "JR-1", "--json"]) == 0
    capsys.readouterr()

    assert not (tmp_path / ".ai").exists(), "reading an issue created a work item"
    assert list(tmp_path.iterdir()) == []


def test_the_human_form_reads_as_an_issue(tmp_path, monkeypatch, capsys, jira):
    monkeypatch.chdir(tmp_path)

    assert main(["issue-details", "JR-1"]) == 0
    out = capsys.readouterr().out

    assert out.startswith("JR-1: Statistics crash on an empty volume")
    assert "no traces" in out
    assert "{" not in out


def test_a_jira_failure_is_a_clean_envelope(tmp_path, monkeypatch, capsys):
    """The editor falls back to hint-only on this, so it must not be a crash."""
    monkeypatch.chdir(tmp_path)
    failure = JiraFetchResult(
        issue_key="JR-1",
        source="jira",
        success=False,
        error_type="network_error",
        error_message="Jira network error.",
        data={},
    )

    def fake(repo_root, issue_key, allow_mock=False):
        raise JiraFetchError(failure)

    monkeypatch.setattr("bugpilot.cli.fetch_issue", fake)

    assert main(["issue-details", "JR-1", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is False
    assert payload["error"]["code"]
    assert "Traceback" not in payload["error"]["message"]


def test_a_hand_written_work_item_is_refused(tmp_path, monkeypatch, capsys):
    """There is no Jira issue behind one, so there is nothing to read."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only", "--json"])
    work_item = json.loads(capsys.readouterr().out)["work_item_id"]

    assert main(["issue-details", work_item, "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is False


def test_mock_data_is_opt_in_here_too(tmp_path, monkeypatch, capsys):
    """The same rule as every other Jira command: real data unless asked."""
    monkeypatch.chdir(tmp_path)

    assert main(["issue-details", "JR-1", "--allow-mock", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is True
    assert payload["jira_source"] == "mock"
    assert payload["title"]
