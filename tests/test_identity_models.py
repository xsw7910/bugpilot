"""Tests for work item identity and the investigation request model."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from bugpilot.core.config import WORKFLOW_STEPS
from bugpilot.core.identity import (
    is_jira_issue_key,
    is_known_work_item_id,
    is_local_work_item_id,
    is_work_item_id,
    new_local_work_item_id,
    validate_work_item_id,
)
from bugpilot.core.models import (
    BugSpec,
    InvestigationOptions,
    InvestigationPlan,
    InvestigationRequest,
)


# --- identity ---------------------------------------------------------------


@pytest.mark.parametrize(
    "value, jira, work_item",
    [
        ("JR-12345", True, True),
        ("ABC1-7", True, True),
        ("local_20260901094133", False, True),
        # A local id must never read as a Jira key: the underscore sits where a
        # Jira key needs a dash, so the two can't be confused.
        ("local_1", False, True),
        ("jr-12345", False, True),  # lowercase is a fine directory, not a Jira key
        ("HR", False, False),  # bare word: no numeric suffix
        ("12345", False, False),  # must start with a letter
        ("", False, False),
    ],
)
def test_identity_predicates(value, jira, work_item):
    assert is_jira_issue_key(value) is jira
    assert is_work_item_id(value) is work_item


@pytest.mark.parametrize(
    "value",
    ["../JR-12345", "..\\JR-12345", "JR-12345/../../x", ".ai", "a.b-1", "JR-12345/x-1"],
)
def test_work_item_id_rejects_path_escapes(value):
    assert is_work_item_id(value) is False


@pytest.mark.parametrize("value", [" JR-12345", "JR-12345 ", "\tJR-12345"])
def test_work_item_id_does_not_strip(value):
    """Padding makes a different directory name, so it must not validate."""
    assert is_work_item_id(value) is False


def test_validate_work_item_id_raises_with_actionable_message():
    with pytest.raises(ValueError) as excinfo:
        validate_work_item_id("HR")
    message = str(excinfo.value)
    assert "JR-12345" in message
    assert "local_20260901094133" in message


def test_validate_work_item_id_accepts_both_kinds():
    validate_work_item_id("JR-12345")
    validate_work_item_id("local_20260901094133")


def test_new_local_work_item_id_is_a_work_item_but_not_a_jira_key():
    moment = datetime(2026, 9, 1, 9, 41, 33, tzinfo=timezone.utc)
    generated = new_local_work_item_id(moment)
    assert generated == "local_20260901094133"
    assert is_work_item_id(generated) is True
    assert is_jira_issue_key(generated) is False


# --- BugSpec ----------------------------------------------------------------


def test_bugspec_separates_work_item_id_from_source_ref():
    jira = BugSpec(
        work_item_id="JR-12345",
        source="jira",
        title="Crash",
        description="...",
        source_ref="JR-12345",
    )
    manual = BugSpec(
        work_item_id="local_20260901094133",
        source="manual",
        title="Crash",
        description="...",
    )
    assert jira.is_jira and jira.can_write_back
    assert not manual.is_jira
    assert not manual.can_write_back
    assert manual.source_ref is None


def test_bugspec_without_source_ref_cannot_write_back():
    """A Jira-sourced spec still needs a ref before anything posts to Jira."""
    spec = BugSpec(work_item_id="JR-1", source="jira", title="t", description="d")
    assert spec.is_jira
    assert not spec.can_write_back


# --- InvestigationPlan ------------------------------------------------------


def test_default_plan_resolves_the_full_prepare_pipeline():
    steps = InvestigationPlan().resolve_steps("jira")
    assert steps == [
        "doctor",
        "fetch",
        "parse",
        "keywords",
        "memory_search",
        "code_search",
        "git_context",
        "context",
        "prompt",
        "memory_add",
    ]


def test_resolved_steps_follow_canonical_order_not_flag_order():
    steps = InvestigationPlan().resolve_steps("jira")
    positions = [WORKFLOW_STEPS.index(step) for step in steps]
    assert positions == sorted(positions)


def test_keywords_runs_once_when_two_capabilities_need_it():
    steps = InvestigationPlan(
        issue_details=False, git_history=False, build_context=False
    ).resolve_steps("jira")
    assert steps.count("keywords") == 1
    assert "code_search" in steps and "memory_search" in steps


def test_prerequisites_are_pulled_in_even_when_their_capability_is_off():
    """similar_fixes alone still needs keywords, which needs a parsed issue.

    Running the prerequisite beats failing halfway: a caller toggles capabilities,
    not steps, so core has to supply whatever those capabilities read.
    """
    steps = InvestigationPlan(
        issue_details=False, code_search=False, git_history=False, build_context=False
    ).resolve_steps("jira")
    assert steps == ["doctor", "fetch", "parse", "keywords", "memory_search"]


def test_prerequisite_closure_is_transitive():
    """build_context alone reaches all the way back to fetch."""
    steps = InvestigationPlan(
        issue_details=False, code_search=False, git_history=False, similar_fixes=False
    ).resolve_steps("jira")
    assert steps == [
        "doctor",
        "fetch",
        "parse",
        "keywords",  # context_step reads extracted_keywords.json
        "context",
        "prompt",
        "memory_add",
    ]


def test_manual_closure_stops_before_fetch():
    steps = InvestigationPlan(
        issue_details=False, code_search=False, git_history=False, similar_fixes=False
    ).resolve_steps("manual")
    assert "fetch" not in steps
    assert steps[:3] == ["doctor", "parse", "keywords"]


def test_manual_source_drops_the_jira_fetch():
    steps = InvestigationPlan().resolve_steps("manual")
    assert "fetch" not in steps
    assert "parse" in steps


def test_doctor_always_runs_even_with_everything_disabled():
    plan = InvestigationPlan(
        issue_details=False,
        code_search=False,
        git_history=False,
        similar_fixes=False,
        build_context=False,
    )
    assert plan.resolve_steps("jira") == ["doctor"]


def test_skipped_steps_complement_resolved_steps():
    plan = InvestigationPlan(git_history=False, similar_fixes=False)
    resolved = set(plan.resolve_steps("jira"))
    skipped = plan.skipped_steps("jira")
    assert "git_context" in skipped
    assert "memory_search" in skipped
    assert not resolved & set(skipped)
    # keywords stays resolved because code_search still needs it
    assert "keywords" in resolved and "keywords" not in skipped


def test_skipped_steps_omit_fetch_for_manual_source():
    """`fetch` is inapplicable to manual input, not a skipped capability.

    Uses a plan where nothing pulls `fetch` back in as a prerequisite — with any
    content-reading capability enabled it would be resolved, not skipped.
    """
    plan = InvestigationPlan(
        issue_details=False, code_search=False, similar_fixes=False, build_context=False
    )
    assert "fetch" in plan.skipped_steps("jira")
    assert "fetch" not in plan.skipped_steps("manual")


def test_turning_off_issue_details_alone_does_not_skip_fetch():
    """Other capabilities need a parsed issue, so fetch is resolved, not skipped."""
    plan = InvestigationPlan(issue_details=False)
    assert "fetch" in plan.resolve_steps("jira")
    assert plan.skipped_steps("jira") == []


# --- InvestigationRequest ---------------------------------------------------


def test_request_delegates_to_spec_and_plan():
    request = InvestigationRequest(
        spec=BugSpec(
            work_item_id="local_20260901094133",
            source="manual",
            title="Crash",
            description="...",
        ),
        options=InvestigationOptions(hint="look at the reader", max_files=3),
        plan=InvestigationPlan(git_history=False),
    )
    assert request.work_item_id == "local_20260901094133"
    assert "fetch" not in request.resolved_steps()
    assert "git_context" in request.skipped_steps()
    assert request.options.max_files == 3
    assert request.options.max_search_lines == 300


def test_request_defaults_are_independent_between_instances():
    first = InvestigationRequest(
        spec=BugSpec(work_item_id="JR-1", source="jira", title="t", description="d")
    )
    second = InvestigationRequest(
        spec=BugSpec(work_item_id="JR-2", source="jira", title="t", description="d")
    )
    first.options.keywords.append("leak")
    assert second.options.keywords == []


# --- review follow-ups ------------------------------------------------------


@pytest.mark.parametrize("term", ["utf-8", "log4j-2", "python-3", "opengl-4", "qt-6"])
def test_ordinary_search_terms_are_not_work_item_lookups(term):
    """The regression this predicate exists to prevent.

    `is_work_item_id` accepts all of these — it is a directory-safety check that
    must admit any id we mint. Classifying user input with it turned a free-text
    memory search into a lookup for a work item that does not exist, and created
    a stray `.ai/<term>/` directory on the way.
    """
    assert is_work_item_id(term) is True
    assert is_known_work_item_id(term) is False


@pytest.mark.parametrize("value", ["JR-12345", "local_20260901094133", "local_20260901094133_2"])
def test_real_ids_are_recognized_as_work_item_lookups(value):
    assert is_known_work_item_id(value) is True


def test_local_predicate_requires_the_prefix():
    assert is_local_work_item_id("local_20260901094133") is True
    assert is_local_work_item_id("JR-12345") is False
    assert is_local_work_item_id("locally-1") is False
