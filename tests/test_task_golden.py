"""task.md as it is today, held still so every later change to it is a diff someone read.

The golden files under `tests/golden/task/` (`<case>.txt`) are `generate_task`'s output for the
matrix in `task_golden.py`. A change to task generation fails here first; after a
deliberate one, `python tests/task_golden.py --update` rewrites them, and the
review is the diff. `tests/baselines/0.1.3-batch0/task.json` is the measured
record from before 0.1.3 changed the task, kept for the before/after.
"""

from __future__ import annotations

import json
import re

import pytest

import task_golden
from task_golden import MATRIX, TaskCase, golden_path, measure, read_golden, render

BASELINE = task_golden.GOLDEN_DIR.parent.parent / "baselines" / "0.1.3-batch0"


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case.name)
def test_the_task_is_what_the_golden_file_says(case: TaskCase):
    assert golden_path(case).is_file(), f"no golden file for {case.name}: run python tests/task_golden.py --update"
    assert render(case) == read_golden(case), (
        f"task.md changed for {case.name}. If the change is intended, run "
        "`python tests/task_golden.py --update` and review the diff."
    )


def test_every_golden_file_belongs_to_a_case():
    names = {case.name for case in MATRIX}
    stale = sorted(path.name for path in task_golden.GOLDEN_DIR.glob("*") if path.stem not in names)
    assert stale == [], f"golden files with no case: {stale}"


def test_the_matrix_covers_every_input_that_changes_the_task():
    assert {case.fix_mode for case in MATRIX} == {"fix", "investigation"}
    assert {case.branch_policy for case in MATRIX} == {"current", "per-issue", "ask"}
    assert {case.source for case in MATRIX} == {"jira", "manual"}
    assert {case.jira_comment for case in MATRIX} == {True, False}
    assert {bool(case.attachments) for case in MATRIX} == {True, False}
    assert {bool(case.hint) for case in MATRIX} == {True, False}
    assert {case.configured for case in MATRIX} == {True, False}
    # The interactions a change is likeliest to break: an investigation with a
    # Jira comment, and with a branch policy that may create a branch.
    assert any(case.fix_mode == "investigation" and case.jira_comment for case in MATRIX)
    assert any(case.fix_mode == "investigation" and case.branch_policy != "current" for case in MATRIX)
    # A repository's AI Behavior additions alone and beside each layer they sit among (0.1.4).
    assert {case.ai_behavior for case in MATRIX} == {True, False}
    assert any(case.ai_behavior and case.configured for case in MATRIX)
    assert any(case.ai_behavior and case.verification_file for case in MATRIX)
    assert any(case.ai_behavior and case.fix_mode == "investigation" for case in MATRIX)
    assert len({case.name for case in MATRIX}) == len(MATRIX)


def test_the_matrix_is_rendered_from_inputs_resolved_like_a_run(user_config_folder, tmp_path):
    """Never the machine's own configuration: a developer's instructions must not reach a golden file."""
    from bugpilot.core.instructions import load_instructions

    (user_config_folder / "instructions.md").write_text("A private preference that must not leak.\n", encoding="utf-8")
    # Where a run on this machine reads them (0.1.6: BUGPILOT_HOME/config/), so the check below means something.
    assert "must not leak" in load_instructions(tmp_path).user.text
    case = next(case for case in MATRIX if case.name == "jira-fix-current")

    assert "must not leak" not in render(case)
    assert render(case) == read_golden(case)


def test_only_the_configured_case_carries_instructions_and_saved_settings():
    for case in MATRIX:
        text = read_golden(case)
        assert ("## User Instructions" in text) == case.configured, case.name
        assert ("## Project / Team Instructions" in text) == case.configured, case.name
        # A repository verification.md replaces the saved switches as the source (0.1.3).
        legacy = case.configured and not case.verification_file
        assert ("Source: repository configuration (project settings)." in text) == legacy, case.name
        assert ("Source: repository Verification Policy (.bugpilot/verification.md)." in text) == case.verification_file, case.name


def test_a_case_says_what_its_inputs_say():
    by_name = {case.name: read_golden(case) for case in MATRIX}
    assert "## Developer Hint" in by_name["jira-fix-current-attachments-hint"]
    assert "## Developer Hint" not in by_name["jira-fix-current"]
    assert "## Report Status to Jira (before commit)" in by_name["jira-fix-current-jira-comment"]
    assert "## Report Status to Jira\n" in by_name["jira-investigation-current-jira-comment"]
    assert "## Investigation Handoff" in by_name["jira-investigation-current"]
    assert "## Developer Attachments" in by_name["manual-fix-ask-attachments"]
    assert "bugfix/JR-12345-" in by_name["jira-fix-current-configured"]


def test_the_yardstick_counts_what_it_says():
    text = "## One\n\nDo not force push. Never force-push.\n\n## Two\n\nword word\n"
    measured = measure(text)

    assert measured["chars"] == len(text)
    assert measured["words"] == len(re.findall(r"\S+", text))
    assert measured["approx_tokens"] == round(len(text) / 4)
    assert measured["sections"] == ["One", "Two"]
    assert measured["rule_counts"]["force_push"] == 2


def test_every_rule_pattern_finds_its_rule_in_todays_task():
    """A pattern that matches nothing would record a zero that means nothing."""
    counts = measure(read_golden(MATRIX[0]))["rule_counts"]
    silent = [name for name, count in counts.items() if count == 0]
    assert silent == [], f"patterns that match nothing in today's task: {silent}"


# --- the baseline record (0.1.3-batch0) ---------------------------------------------------------


def _baseline_task() -> dict:
    return json.loads((BASELINE / "task.json").read_text(encoding="utf-8"))


def test_the_baseline_record_measured_the_matrix():
    record = _baseline_task()
    assert set(record["cases"]) <= {case.name for case in MATRIX}, "a recorded case was removed from the matrix"
    assert set(record["median"]) == {"chars", "words", "approx_tokens"}
    for name, values in record["cases"].items():
        assert values["approx_tokens"] == round(values["chars"] / 4), name


def test_the_baseline_record_still_agrees_with_any_golden_file_it_has_not_changed():
    """A recorded number is checked against the file it was taken from, while that file is unchanged."""
    record = _baseline_task()
    unchanged = 0
    for case in MATRIX:
        values = record["cases"].get(case.name)
        text = read_golden(case)
        if values is None or measure(text)["sha256"] != values["sha256"]:
            continue
        unchanged += 1
        assert {key: values[key] for key in measure(text)} == measure(text), case.name
    assert unchanged or record["cases"], "the record has no cases"


# --- one definition per rule, and the size it bought ------------------------------------------

COMMIT_OFFER = "Do you want me to commit and push this branch to origin?"


def _sections(text: str) -> dict[str, str]:
    return dict(task_golden.section_bodies(text))


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case.name)
def test_every_protected_rule_is_defined_once_in_its_own_section(case: TaskCase):
    """The full instruction is defined once (0.1.3, §42.4).

    Not "the words appear once": a short reference that does not restate the
    rule is allowed anywhere, and the patterns do not match it. Only the
    references `CANONICAL_RULES` names may match, and only there.
    """
    homes = task_golden.rule_homes(read_golden(case))
    for name, (home, _pattern, references) in task_golden.CANONICAL_RULES.items():
        found = homes[name]
        assert found.count(home) == 1, (case.name, name, found)
        strays = [section for section in found if section != home and section not in references]
        assert strays == [], (case.name, name, strays)
        assert all(found.count(reference) <= 1 for reference in references), (case.name, name, found)


def test_the_canonical_patterns_are_not_blind():
    """A rule restated anywhere else is caught: the checker is tested, not trusted."""
    text = read_golden(MATRIX[0]) + "\n## Somewhere Else\n\n- Never force push.\n- Do not create pull requests.\n"
    homes = task_golden.rule_homes(text)
    assert homes["force_push"].count("Somewhere Else") == 1
    assert homes["pr_creation"].count("Somewhere Else") == 1


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case.name)
def test_the_precedence_corrections_hold(case: TaskCase):
    """Deduplication must not move the precedence correction back (§42.2)."""
    text = read_golden(case)
    sections = _sections(text)
    safety = sections["BugPilot Safety Rules"]
    # Testing expectations are the Verification Policy's; only integrity is protected.
    assert "### Test and Check Integrity" in safety
    for expectation in ("focused tests", "Run the tests", "regression risk", "manual validation"):
        assert expectation not in safety, (case.name, expectation)
    assert "Verification Policy" in sections
    # The default way of working is AI Behavior, its own section, not a safety rule (0.1.4).
    behavior = sections["AI Behavior"]
    assert "guidance, not safety rules" in behavior
    assert "BugPilot Working Guidance" not in sections
    assert "Prefer small, targeted fixes" not in safety
    assert "any of these layers may refine it" in sections["BugPilot Rule Precedence"]
    # And agent-neutral.
    assert "Task tool" not in text and "Read, Grep, and Glob" not in text


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case.name)
def test_ai_behavior_is_one_section_in_the_project_layer_with_its_additions_contained(case: TaskCase):
    """Where Working Guidance was (0.1.4): once, after the Verification Policy, before the user's and the Fix Mode."""
    text = read_golden(case)
    headings = task_golden.sections(text)
    assert headings.count("AI Behavior") == 1 and "BugPilot Working Guidance" not in headings
    position = headings.index("AI Behavior")
    assert headings.index("BugPilot Safety Rules") < headings.index("Verification Policy") < position
    assert position < headings.index("AI Fix Mode") < headings.index("BugPilot Rule Precedence")
    if "User Instructions" in headings:
        assert headings.index("Project / Team Instructions") < position < headings.index("User Instructions")

    behavior = _sections(text)["AI Behavior"]
    assert "### Code Change Conventions" in behavior
    assert ("### Repository Additions" in behavior) == case.ai_behavior, case.name
    if case.ai_behavior:
        assert "Source: BugPilot defaults, with this repository's additions (.bugpilot/ai_behavior.md)." in behavior
        for heading in ("Code Change Conventions", "Evidence Standards", "Reporting Standards"):
            assert f"\n#### {heading}\n" in behavior, (case.name, heading)
    else:
        assert "Source: BugPilot defaults.\n" in behavior
    # Nothing BugPilot owns is restated there; the canonical homes check counts it too.
    homes = task_golden.rule_homes(text)
    assert [name for name, found in homes.items() if "AI Behavior" in found] == [], case.name
    assert task_golden.precedence_layers(text)[2] == "Project / team instructions"
    assert "Verification Policy and AI Behavior additions, take precedence over user instructions" in text


def test_a_project_may_still_say_tests_are_not_required():
    configured = read_golden(next(case for case in MATRIX if case.name == "jira-fix-current-configured"))
    policy = _sections(configured)["Verification Policy"]
    assert "Running tests for the changed behavior is not required by this project." in policy
    # Nothing BugPilot owns says otherwise.
    for heading in ("BugPilot Safety Rules", "BugPilot Evidence Rules", "BugPilot Delivery Safety", "Required Output Files"):
        assert "Run the tests" not in _sections(configured)[heading], heading


@pytest.mark.parametrize("case", [case for case in MATRIX if case.fix_mode == "investigation"], ids=lambda case: case.name)
def test_an_investigation_task_stays_an_investigation(case: TaskCase):
    text = read_golden(case)
    sections = _sections(text)
    handoff = sections["Investigation Handoff"]
    assert "Do not implement the proposed fix in this pass." in handoff
    assert "Do not offer to commit or push" in handoff
    assert "Do not describe the bug as fixed, resolved, or verified." in handoff
    assert "every rule in BugPilot Delivery Safety above still applies" in handoff
    assert "Optional Assisted Delivery" not in sections and COMMIT_OFFER not in text
    # The gate stays for the pass the developer may start from here.
    assert "Commit or push only after the developer explicitly approves it" in sections["BugPilot Delivery Safety"]
    output = sections["Required Output Files"]
    assert "Write one report: `" in output and "Do not write any section as though a fix exists." in output


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case.name)
def test_jira_writes_are_unambiguous_with_the_comment_on_or_off(case: TaskCase):
    text = read_golden(case)
    sections = _sections(text)
    assert "Never transition, assign, or change Jira fields." in sections["BugPilot Safety Rules"]
    status = [heading for heading in sections if heading.startswith("Report Status to Jira")]
    if case.jira_comment:
        assert len(status) == 1, case.name
        body = sections[status[0]]
        assert f"`bugpilot jira-comment {task_golden.JIRA_ID} --execute`" in body
        assert "Post exactly ONE comment." in body
        assert "the one Jira write the BugPilot Safety Rules allow" in body
    else:
        assert status == [] and "jira-comment-draft" not in text, case.name


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case.name)
def test_every_policy_keeps_main_master_and_detached_head_protected(case: TaskCase):
    sections = _sections(read_golden(case))
    branch = sections["Branch Instructions"]
    assert "- Never work directly on main/master." in branch
    assert "detached" in branch
    gate = sections["BugPilot Delivery Safety"]
    assert "verify the current branch is not `main` or `master` and HEAD is not detached" in gate
    assert "If either is true, do not commit and do not push" in gate


def test_the_median_task_is_at_least_a_fifth_smaller_than_the_baseline():
    """The deduplication target (§42.4), measured against the baseline record — never a later one."""
    import statistics

    before = _baseline_task()["median"]["approx_tokens"]
    after = statistics.median(measure(read_golden(case))["approx_tokens"] for case in MATRIX)
    assert (before - after) / before >= 0.20, (before, after)
