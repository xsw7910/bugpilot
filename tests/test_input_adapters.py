"""Tests for the Jira and manual input adapters and the on-disk BugSpec."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from bugpilot.core.input_adapters import (
    bug_spec_from_description,
    bug_spec_from_jira,
    bug_spec_path,
    derive_title,
    load_bug_spec,
    save_bug_spec,
    spec_from_dict,
    spec_to_dict,
)
from bugpilot.core.models import BugSpec

MOMENT = datetime(2026, 9, 1, 9, 41, 33, tzinfo=timezone.utc)


# --- Jira adapter -----------------------------------------------------------


def test_jira_spec_sets_source_ref_to_the_issue_key():
    spec = bug_spec_from_jira(
        {
            "issue_key": "JR-23477",
            "summary": "Amplitude Spectrum min/max not converted to dB",
            "description": "Steps to reproduce...",
        }
    )
    assert spec.work_item_id == "JR-23477"
    assert spec.source_ref == "JR-23477"
    assert spec.source == "jira"
    assert spec.can_write_back


def test_jira_spec_without_a_key_is_rejected():
    with pytest.raises(ValueError, match="no issue key"):
        bug_spec_from_jira({"summary": "no key here"})


def test_jira_spec_rejects_a_key_that_is_not_a_safe_directory_name():
    """A malformed key must not become a directory under .ai/."""
    with pytest.raises(ValueError):
        bug_spec_from_jira({"issue_key": "../escape", "summary": "s"})


def test_jira_spec_tolerates_missing_summary_and_description():
    spec = bug_spec_from_jira({"issue_key": "JR-1"})
    assert spec.title == ""
    assert spec.description == ""


# --- manual adapter ---------------------------------------------------------


def test_manual_spec_gets_a_local_id_and_no_source_ref():
    spec = bug_spec_from_description("3D view crashes after changing horizon", now=MOMENT)
    assert spec.work_item_id == "local_20260901094133"
    assert spec.source == "manual"
    assert spec.source_ref is None
    assert not spec.can_write_back


def test_manual_spec_derives_a_title_from_the_first_line():
    spec = bug_spec_from_description(
        "3D view crashes after changing horizon\n\nFull steps below...", now=MOMENT
    )
    assert spec.title == "3D view crashes after changing horizon"
    assert spec.description.startswith("3D view crashes")


def test_manual_spec_prefers_an_explicit_title():
    spec = bug_spec_from_description("body text", title="Explicit title", now=MOMENT)
    assert spec.title == "Explicit title"


def test_manual_spec_requires_a_description():
    with pytest.raises(ValueError, match="needs a description"):
        bug_spec_from_description("   \n\n  ")


def test_manual_spec_keeps_non_ascii_titles_intact():
    """A Chinese title survives: this is why the local id carries no slug."""
    spec = bug_spec_from_description("三维视图切换层位后崩溃", now=MOMENT)
    assert spec.title == "三维视图切换层位后崩溃"
    assert spec.work_item_id == "local_20260901094133"


@pytest.mark.parametrize(
    "description, expected",
    [
        ("# Crash on open\n\nbody", "Crash on open"),
        ("- crash when saving", "crash when saving"),
        ("\n\n  indented first line  \nsecond", "indented first line"),
        ("", "Untitled bug"),
        ("###   \n\nreal line", "real line"),
    ],
)
def test_derive_title_strips_markdown_markers(description, expected):
    assert derive_title(description) == expected


def test_derive_title_truncates_a_long_line():
    title = derive_title("x" * 400)
    assert len(title) == 120
    assert title.endswith("…")


# --- persistence ------------------------------------------------------------


def test_save_and_load_round_trip(tmp_path):
    spec = bug_spec_from_description("三维视图切换层位后崩溃", now=MOMENT)
    path = save_bug_spec(tmp_path, spec)

    assert path == bug_spec_path(tmp_path, spec.work_item_id)
    assert load_bug_spec(tmp_path, spec.work_item_id) == spec


def test_saved_spec_is_readable_utf8_json(tmp_path):
    """Written for humans too — it sits beside the other .ai artifacts."""
    spec = bug_spec_from_description("三维视图切换层位后崩溃", now=MOMENT)
    path = save_bug_spec(tmp_path, spec)
    raw = path.read_text(encoding="utf-8")

    assert "三维视图切换层位后崩溃" in raw  # not \uXXXX escaped
    assert json.loads(raw)["source"] == "manual"


def test_load_returns_none_when_absent(tmp_path):
    assert load_bug_spec(tmp_path, "JR-12345") is None


def test_load_returns_none_on_corrupt_json(tmp_path):
    """One unreadable directory must not break a listing of all of them."""
    spec = bug_spec_from_jira({"issue_key": "JR-1", "summary": "s", "description": "d"})
    path = save_bug_spec(tmp_path, spec)
    path.write_text("{not json", encoding="utf-8")

    assert load_bug_spec(tmp_path, "JR-1") is None


def test_load_returns_none_when_the_id_is_missing_from_the_file(tmp_path):
    spec = bug_spec_from_jira({"issue_key": "JR-1", "summary": "s", "description": "d"})
    path = save_bug_spec(tmp_path, spec)
    path.write_text(json.dumps({"source": "jira"}), encoding="utf-8")

    assert load_bug_spec(tmp_path, "JR-1") is None


def test_dict_round_trip_preserves_the_jira_write_back_gate():
    spec = BugSpec(
        work_item_id="JR-9",
        source="jira",
        title="t",
        description="d",
        source_ref="JR-9",
    )
    assert spec_from_dict(spec_to_dict(spec)) == spec


def test_empty_source_ref_deserializes_to_none():
    """Falsy refs must not become the string "None" and unlock a Jira write."""
    restored = spec_from_dict(
        {"work_item_id": "local_1", "source": "manual", "title": "t", "source_ref": ""}
    )
    assert restored is not None
    assert restored.source_ref is None
    assert not restored.can_write_back


# --- review follow-ups ------------------------------------------------------


def test_jira_spec_rejects_a_local_id():
    """A local id must never become a Jira write-back target."""
    with pytest.raises(ValueError, match="not a Jira issue key"):
        bug_spec_from_jira({"issue_key": "local_20260901094133", "summary": "s"})


def test_colliding_local_ids_get_distinct_directories(tmp_path):
    """Same-second bugs must not share a directory: a fresh run wipes it."""
    first = bug_spec_from_description("first bug", now=MOMENT, repo_root=tmp_path)
    save_bug_spec(tmp_path, first)
    second = bug_spec_from_description("second bug", now=MOMENT, repo_root=tmp_path)

    assert first.work_item_id == "local_20260901094133"
    assert second.work_item_id == "local_20260901094133_2"
    assert load_bug_spec(tmp_path, first.work_item_id).description == "first bug"


def test_id_collision_check_is_opt_in(tmp_path):
    """Without repo_root the id stays deterministic, which tests rely on."""
    first = bug_spec_from_description("first", now=MOMENT)
    second = bug_spec_from_description("second", now=MOMENT)
    assert first.work_item_id == second.work_item_id


def test_load_returns_none_on_non_utf8_file(tmp_path):
    spec = bug_spec_from_description("body", now=MOMENT)
    path = save_bug_spec(tmp_path, spec)
    path.write_bytes(b'{"work_item_id": "\xff\xfe bad bytes"}')

    assert load_bug_spec(tmp_path, spec.work_item_id) is None
