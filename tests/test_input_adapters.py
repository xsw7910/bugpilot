"""Tests for the manual input adapter. The persisted issue is test_issue_artifact.py."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from bugpilot.core.config import issue_dir
from bugpilot.core.input_adapters import bug_spec_from_description, derive_title

MOMENT = datetime(2026, 9, 1, 9, 41, 33, tzinfo=timezone.utc)


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


# --- review follow-ups ------------------------------------------------------


def test_colliding_local_ids_get_distinct_directories(tmp_path):
    """Same-second bugs must not share a directory: a fresh run wipes it."""
    first = bug_spec_from_description("first bug", now=MOMENT, repo_root=tmp_path)
    issue_dir(tmp_path, first.work_item_id).mkdir(parents=True)
    second = bug_spec_from_description("second bug", now=MOMENT, repo_root=tmp_path)

    assert first.work_item_id == "local_20260901094133"
    assert second.work_item_id == "local_20260901094133_2"


def test_id_collision_check_is_opt_in(tmp_path):
    """Without repo_root the id stays deterministic, which tests rely on."""
    first = bug_spec_from_description("first", now=MOMENT)
    second = bug_spec_from_description("second", now=MOMENT)
    assert first.work_item_id == second.work_item_id
