"""Project settings: the Verification Policy and branch naming.

One file, ``<repo>/.bugpilot/project_settings.json``, read the same way by the
CLI, the MCP prepare tools and the extension (through ``bugpilot
project-settings``). These tests hold the defaults, the file's rules, what
``task.md`` says, the branch names a template gives — deterministic, safe, never
a new branch per preparation — and the CLI / core / MCP parity.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.git_ops import branch_name, branch_template_problem, render_branch_template
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import InvestigationRequest
from bugpilot.core.project_settings import (
    ProjectSettings,
    ProjectSettingsError,
    VerificationPolicy,
    load_project_settings,
    save_project_settings,
    settings_from_mapping,
    verification_policy_section,
)
from bugpilot.core.prompts import generate_task

DEFAULT_LINES = (
    "- Run the tests relevant to the changed behavior.",
    "- Run the repository's existing static checks (linters, type checks, compiler warnings) when they are available.",
    "- The repository's full test suite is not required.",
    "- Report the relevant verification you did not run, and why.",
)


def _repo(root: Path) -> Path:
    root.mkdir(parents=True)
    (root / "pyproject.toml").write_text("[project]\nname = \"inventory\"\nversion = \"1.0\"\n", encoding="utf-8")
    (root / "inventory").mkdir()
    (root / "inventory" / "app.py").write_text("def save(record):\n    return record['id']\n", encoding="utf-8")
    return root


def _settings(root: Path, data: object) -> None:
    (root / ".bugpilot").mkdir(exist_ok=True)
    (root / ".bugpilot" / "project_settings.json").write_text(json.dumps(data), encoding="utf-8")


def _prepare(root: Path, monkeypatch, capsys, *extra: str) -> tuple[str, dict]:
    monkeypatch.chdir(root)
    assert main(["bug", "--description", "Saving a record crashes", "--prepare-only", "--json", *extra]) == 0
    payload = json.loads(capsys.readouterr().out)
    return (root / payload["agent_task"]).read_text(encoding="utf-8"), payload


def _section(task: str, heading: str) -> str:
    start = task.index(heading)
    return task[start: task.index("\n## ", start + 1)]


# --- Verification Policy ----------------------------------------------------------------


def test_no_file_means_the_defaults_and_says_so(tmp_path, monkeypatch, capsys):
    task, payload = _prepare(_repo(tmp_path / "r"), monkeypatch, capsys)
    section = _section(task, "## Verification Policy")
    assert "Source: BugPilot defaults (no project settings saved)." in section
    for line in DEFAULT_LINES:
        assert line in section
    assert payload["warnings"] == []
    assert load_project_settings(tmp_path / "r") == (ProjectSettings(), [])


def test_every_switch_says_what_it_means_and_nothing_invents_a_command():
    on = verification_policy_section(VerificationPolicy(True, True, True, True), saved=True)
    off = verification_policy_section(VerificationPolicy(False, False, False, False), saved=True)
    assert "- Run the repository's full test suite before reporting, if it can run in this environment." in on
    assert "- Running tests for the changed behavior is not required by this project." in off
    assert "- Static checks are not required by this project." in off
    assert "- Listing verification you did not run is optional; never claim a check ran unless it did." in off
    for text in (on, off):
        assert "Source: repository configuration (project settings)." in text
        assert "do not invent commands the repository gives no evidence of" in text
        # No command of anyone's: the repository's own, or its instructions, name them.
        assert not re.search(r"pytest|npm|ctest|make |gradle|cargo|tox", text)
        # The investigation-only boundary, and the Fix Mode boundary.
        assert "in an investigation-only pass you record the verification you would run instead" in text
        assert "the AI Fix Mode decides how this attempt verifies within it" in text


def test_the_policy_sits_with_the_project_layer_and_does_not_repeat_the_fix_mode(tmp_path, monkeypatch, capsys, isolate_bugpilot_config):
    (isolate_bugpilot_config / "instructions.md").write_text("Be brief.\n", encoding="utf-8")
    root = _repo(tmp_path / "r")
    (root / ".bugpilot").mkdir()
    (root / ".bugpilot" / "instructions.md").write_text("Run module tests with the repo script.\n", encoding="utf-8")
    task, _ = _prepare(root, monkeypatch, capsys)
    order = [task.index(h) for h in (
        "## Repository Context", "## Project / Team Instructions", "## Verification Policy",
        "## User Instructions", "## Branch Instructions", "## AI Fix Mode", "## BugPilot Rule Precedence",
    )]
    assert order == sorted(order)
    assert task.count("## Verification Policy") == 1
    # The Fix Mode keeps its own Verification section; the policy is not a copy of it.
    fix_mode = _section(task, "## AI Fix Mode")
    assert "### Verification" in task[task.index("## AI Fix Mode"):]
    assert "Report the relevant verification you did not run" not in fix_mode


def test_a_saved_policy_reaches_the_task(tmp_path, monkeypatch, capsys):
    root = _repo(tmp_path / "r")
    _settings(root, {"verification": {"full_suite": True, "static_checks": False}})
    task, payload = _prepare(root, monkeypatch, capsys)
    section = _section(task, "## Verification Policy")
    assert "Source: repository configuration (project settings)." in section
    assert "- Run the repository's full test suite before reporting, if it can run in this environment." in section
    assert "- Static checks are not required by this project." in section
    assert payload["warnings"] == []


def test_a_file_that_cannot_be_used_is_the_defaults_with_a_warning(tmp_path, monkeypatch, capsys):
    root = _repo(tmp_path / "r")
    (root / ".bugpilot").mkdir()
    (root / ".bugpilot" / "project_settings.json").write_text("{not json", encoding="utf-8")
    task, payload = _prepare(root, monkeypatch, capsys)
    assert "Source: BugPilot defaults (no project settings saved)." in task
    assert any("project_settings.json could not be read" in w and "Using the defaults." in w for w in payload["warnings"])


def test_a_bad_value_is_its_default_and_said(tmp_path):
    settings, warnings = settings_from_mapping(
        {"verification": {"full_suite": "yes", "colour": True}, "branch_naming": {"template": "../{issue}"}, "extra": 1},
        strict=False,
    )
    assert settings == ProjectSettings()
    assert warnings == [
        ".bugpilot/project_settings.json has unknown key(s) extra; they were ignored.",
        "verification.full_suite must be true or false; the default (false) was used.",
        "verification has unknown switch(es) colour; they were ignored.",
        "A branch naming template cannot contain '..' or '//'; the default branch name is used.",
    ]
    with pytest.raises(ProjectSettingsError, match="must be true or false"):
        settings_from_mapping({"verification": {"full_suite": 1}}, strict=True)


def _symlink(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=target.is_dir())
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"cannot create a symbolic link here: {exc}")


def _junction(link: Path, target: Path) -> None:
    if sys.platform != "win32":
        pytest.skip("directory junctions are a Windows feature")
    import _winapi

    _winapi.CreateJunction(str(target), str(link))


@pytest.mark.parametrize("make_link", [_symlink, _junction], ids=["symlink", "junction"])
def test_a_linked_config_folder_is_neither_read_nor_written(tmp_path, make_link):
    root = _repo(tmp_path / "r")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "project_settings.json").write_text(json.dumps({"verification": {"full_suite": True}}), encoding="utf-8")
    make_link(root / ".bugpilot", elsewhere)

    settings, warnings = load_project_settings(root)
    assert settings == ProjectSettings()
    assert warnings and warnings[0].startswith(".bugpilot is a symbolic link or junction")
    with pytest.raises(ProjectSettingsError, match="symbolic link or junction"):
        save_project_settings(root, ProjectSettings(branch_template="fix/{issue}"))
    assert json.loads((elsewhere / "project_settings.json").read_text(encoding="utf-8")) == {"verification": {"full_suite": True}}


# --- the CLI ------------------------------------------------------------------------------


def test_show_and_set_through_the_cli(tmp_path, monkeypatch, capsys):
    root = _repo(tmp_path / "r")
    monkeypatch.chdir(root)
    assert main(["project-settings", "--json"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["saved"] is False
    assert shown["settings"] == shown["defaults"] == ProjectSettings().to_dict()
    assert shown["default_branch_template"] == "feature/{issue}-{slug}"
    assert shown["path"] == ".bugpilot/project_settings.json"

    payload = tmp_path / "s.json"
    payload.write_text(json.dumps({"verification": {"full_suite": True}, "branch_naming": {"template": "bugfix/{issue}-{slug}"}}), encoding="utf-8")
    assert main(["project-settings", "set", "--from-file", str(payload), "--json"]) == 0
    saved = json.loads(capsys.readouterr().out)
    assert saved["saved"] is True
    assert saved["settings"]["verification"]["full_suite"] is True
    assert saved["settings"]["branch_naming"]["template"] == "bugfix/{issue}-{slug}"
    on_disk = json.loads((root / ".bugpilot" / "project_settings.json").read_text(encoding="utf-8"))
    assert on_disk == saved["settings"]


def test_set_refuses_an_unsafe_template_and_keeps_the_file(tmp_path, monkeypatch, capsys):
    root = _repo(tmp_path / "r")
    _settings(root, {"branch_naming": {"template": "fix/{issue}"}})
    monkeypatch.chdir(root)
    for template in ("../{issue}", "fix", "x/{user}/{issue}", "-{issue}", "a b/{issue}", "x/{issue}.lock", "fix/{slug}", "refs/heads/{issue}"):
        payload = tmp_path / "bad.json"
        payload.write_text(json.dumps({"branch_naming": {"template": template}}), encoding="utf-8")
        assert main(["project-settings", "set", "--from-file", str(payload), "--json"]) == 1, template
        failed = json.loads(capsys.readouterr().out)
        assert failed["error"]["code"] == "INVALID_INPUT"
        assert "default branch name is used" not in failed["error"]["message"]
    assert json.loads((root / ".bugpilot" / "project_settings.json").read_text(encoding="utf-8")) == {"branch_naming": {"template": "fix/{issue}"}}


# --- branch naming --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("template", "key", "title", "expected"),
    [
        ("bugfix/{issue}-{slug}", "JR-12345", "Saving crashes the app", "bugfix/JR-12345-saving-crashes-the-app"),
        ("fix/{issue}", "JR-12345", "Anything", "fix/JR-12345"),
        ("users/dev/{issue}", "JR-12345", "Saving crashes", "users/dev/JR-12345"),
        ("fix/{issue}-{slug}", "JR-12345", "", "fix/JR-12345"),
        ("team.a/{issue}_{slug}", "JR-1", "Ünïcode tïtle!", "team.a/JR-1_n-code-t-tle"),
    ],
)
def test_a_template_names_the_branch(template, key, title, expected):
    assert render_branch_template(template, key, title) == expected
    assert branch_name(key, title, template) == expected


def test_a_hand_written_bug_gets_the_same_name_every_time():
    # Its id changes on every run; its name may not.
    first = branch_name("local_20261008010101", "Saving crashes", "fix/{issue}-{slug}")
    again = branch_name("local_20261008020202", "Saving crashes", "fix/{issue}-{slug}")
    assert first == again
    assert re.fullmatch(r"fix/bug-[0-9a-f]{8}-saving-crashes", first)


def test_no_template_is_the_default_name_unchanged():
    for template in (None, ""):
        assert branch_name("JR-12345", "Saving crashes", template) == "feature/JR-12345-saving-crashes"
        assert branch_name("local_1", "Saving crashes", template) == "feature/saving-crashes"


def test_a_template_never_gives_a_protected_or_malformed_name():
    # `{issue}` is required, so only a key that is itself a protected name
    # could render one; it falls back to the default name instead.
    assert render_branch_template("{issue}", "HEAD", "t") is None
    assert render_branch_template("{issue}", "main", "t") is None
    assert branch_name("HEAD", "t", "{issue}") == "feature/HEAD-t"
    for template in ("fix", "../{issue}", "a//{issue}", "/{issue}", "{issue}/", "x/{issue}.lock", "x/{user}/{issue}", "x/@{issue}",
                     "refs/heads/{issue}", "REFS/{issue}"):
        assert branch_template_problem(template) is not None, template
        assert render_branch_template(template, "JR-1", "t") is None, template


def test_per_issue_records_the_templated_branch_and_a_later_template_does_not_rename_it(tmp_path, monkeypatch, capsys):
    root = _repo(tmp_path / "r")
    _settings(root, {"branch_naming": {"template": "bugfix/{issue}-{slug}"}})
    monkeypatch.chdir(root)
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--branch-policy", "per-issue"]) == 0
    capsys.readouterr()
    guidance = json.loads((root / ".ai" / "JR-12345" / "issue.json").read_text(encoding="utf-8"))["guidance"]
    first = guidance["branch_name"]
    assert first.startswith("bugfix/JR-12345-")
    task = (root / ".ai" / "JR-12345" / "task.md").read_text(encoding="utf-8")
    assert f"- Branch name: `{first}`" in task

    # A new template, and another preparation: the work item keeps its branch.
    _settings(root, {"branch_naming": {"template": "fix/{issue}"}})
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--resume"]) == 0
    workflow.copilot_task_step(root, "JR-12345")
    task = (root / ".ai" / "JR-12345" / "task.md").read_text(encoding="utf-8")
    assert f"- Branch name: `{first}`" in task
    assert "fix/JR-12345`" not in task
    # Preparing again never calls for a new branch.
    assert "does not call for a new branch" in task


def test_the_current_policy_suggests_the_templated_name(tmp_path, monkeypatch, capsys):
    root = _repo(tmp_path / "r")
    _settings(root, {"branch_naming": {"template": "fix/{issue}"}})
    monkeypatch.chdir(root)
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock"]) == 0
    task = (root / ".ai" / "JR-12345" / "task.md").read_text(encoding="utf-8")
    assert "`fix/JR-12345`" in task
    assert "feature/JR-12345" not in task
    guidance = json.loads((root / ".ai" / "JR-12345" / "issue.json").read_text(encoding="utf-8"))["guidance"]
    assert "branch_name" not in guidance


# --- parity ------------------------------------------------------------------------------------


def test_the_cli_the_core_entry_point_and_mcp_write_the_same_policy_and_branch(tmp_path, monkeypatch, capsys):
    settings = {"verification": {"full_suite": True}, "branch_naming": {"template": "bugfix/{issue}-{slug}"}}
    cli_root = _repo(tmp_path / "cli")
    _settings(cli_root, settings)
    cli_task, _ = _prepare(cli_root, monkeypatch, capsys)

    core_root = _repo(tmp_path / "core")
    _settings(core_root, settings)
    spec = bug_spec_from_description("Saving a record crashes", repo_root=core_root)
    workflow.run_investigation(core_root, InvestigationRequest(spec=spec))
    core_task = (core_root / ".ai" / spec.work_item_id / "task.md").read_text(encoding="utf-8")

    assert _section(cli_task, "## Verification Policy") == _section(core_task, "## Verification Policy")
    assert re.search(r"`bugfix/bug-[0-9a-f]{8}-saving-a-record-crashes`", cli_task)
    assert _section(cli_task, "## Branch Instructions") == _section(core_task, "## Branch Instructions")

    pytest.importorskip("mcp")
    from bugpilot import mcp_server

    mcp_root = _repo(tmp_path / "mcp")
    _settings(mcp_root, settings)
    result = mcp_server._run("prepare", mcp_root, InvestigationRequest(spec=bug_spec_from_description("Saving a record crashes", repo_root=mcp_root)))
    mcp_task = (mcp_root / ".ai" / result.issue_key / "task.md").read_text(encoding="utf-8")
    assert _section(mcp_task, "## Verification Policy") == _section(cli_task, "## Verification Policy")
    assert _section(mcp_task, "## Branch Instructions") == _section(cli_task, "## Branch Instructions")


def test_generate_task_without_settings_writes_the_defaults():
    task = generate_task("JR-1", "Saving crashes")
    section = _section(task, "## Verification Policy")
    for line in DEFAULT_LINES:
        assert line in section


def test_change_scope_is_not_a_setting():
    """Deliberately not a setting: every Fix Mode already sets how broad a change may be."""
    assert "change_scope" not in ProjectSettings().to_dict()
    assert "## Change Scope" not in generate_task("JR-1", "Saving crashes")


def test_a_file_with_a_bom_is_read_like_any_other(tmp_path, monkeypatch, capsys):
    """PowerShell 5's `Set-Content -Encoding UTF8` writes a BOM; it is not an error."""
    root = _repo(tmp_path / "repo")
    (root / ".bugpilot").mkdir()
    data = {"verification": {"full_suite": True}, "branch_naming": {"template": "bugfix/{issue}-{slug}"}}
    (root / ".bugpilot" / "project_settings.json").write_bytes(b"\xef\xbb\xbf" + json.dumps(data).encode("utf-8"))
    settings, warnings = load_project_settings(root)
    assert warnings == []
    assert settings.verification.full_suite is True and settings.branch_template == "bugfix/{issue}-{slug}"

    source = tmp_path / "with-bom.json"
    source.write_bytes(b"\xef\xbb\xbf" + json.dumps({"verification": {"static_checks": False}}).encode("utf-8"))
    monkeypatch.chdir(root)
    assert main(["project-settings", "set", "--from-file", str(source), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["settings"]["verification"]["static_checks"] is False


def test_a_deeply_nested_file_is_the_defaults_not_a_crash(tmp_path, monkeypatch, capsys):
    """Under the size cap, but deep enough that json raises RecursionError."""
    root = _repo(tmp_path / "repo")
    (root / ".bugpilot").mkdir()
    nested = "[" * 30_000 + "]" * 30_000  # 60 KB: under the 64 KB cap
    (root / ".bugpilot" / "project_settings.json").write_text(nested, encoding="utf-8")
    settings, warnings = load_project_settings(root)
    assert settings == ProjectSettings()
    assert any("nested too deeply" in w and "Using the defaults." in w for w in warnings)

    source = tmp_path / "nested.json"
    source.write_text(nested, encoding="utf-8")
    monkeypatch.chdir(root)
    assert main(["project-settings", "set", "--from-file", str(source), "--json"]) == 1
    assert "nested too deeply" in json.loads(capsys.readouterr().out)["error"]["message"]


# --- {issue} is required -----------------------------------------------------------------


@pytest.mark.parametrize("template", ["{slug}", "fix/{slug}", "{slug}-fix", "users/dev/{slug}", "team/{slug}/wip"])
def test_a_template_without_issue_is_refused(template):
    """`{slug}` alone named two issues the same branch; it is refused with the reason."""
    problem = branch_template_problem(template)
    assert problem is not None and "{issue}" in problem
    assert render_branch_template(template, "JR-1", "Crash on save") is None
    # And never used: the default name instead.
    assert branch_name("JR-1", "Crash on save", template) == "feature/JR-1-crash-on-save"


def test_identical_titles_give_different_branches():
    for template in ("{issue}", "bugfix/{issue}-{slug}", "fix/{slug}-{issue}"):
        first = render_branch_template(template, "JR-1", "Crash on save")
        second = render_branch_template(template, "JR-2", "Crash on save")
        assert first and second and first != second, template


def test_non_latin_titles_give_different_branches():
    # Their slug is empty, so `{issue}` is all that tells them apart — for Jira
    # keys, and for hand-written bugs (whose `{issue}` hashes the title).
    titles = ("三维视图切换图层后崩溃", "保存崩溃")
    jira = {render_branch_template("bugfix/{issue}-{slug}", key, title) for key, title in zip(("JR-1", "JR-2"), titles)}
    assert jira == {"bugfix/JR-1", "bugfix/JR-2"}
    local = {render_branch_template("bugfix/{issue}-{slug}", f"local_2026100801010{i}", title) for i, title in enumerate(titles)}
    assert len(local) == 2 and all(name and name.startswith("bugfix/bug-") for name in local)


def test_a_saved_template_without_issue_is_not_used_and_a_recorded_branch_is_kept(tmp_path, monkeypatch, capsys):
    """A file saved by an older version with `{slug}` alone: the default name, with a warning —
    and a work item that already recorded its branch keeps it, whatever the template says."""
    root = _repo(tmp_path / "r")
    _settings(root, {"branch_naming": {"template": "bugfix/{issue}-{slug}"}})
    monkeypatch.chdir(root)
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--branch-policy", "per-issue"]) == 0
    capsys.readouterr()
    recorded = json.loads((root / ".ai" / "JR-12345" / "issue.json").read_text(encoding="utf-8"))["guidance"]["branch_name"]
    assert recorded.startswith("bugfix/JR-12345-")

    # The file as an earlier version could have saved it: not used, and said.
    _settings(root, {"branch_naming": {"template": "fix/{slug}"}})
    settings, warnings = load_project_settings(root)
    assert settings.branch_template == ""
    assert any("{issue}" in w for w in warnings)

    # Preparing again keeps the recorded branch: nothing is renamed.
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--resume"]) == 0
    workflow.copilot_task_step(root, "JR-12345")
    task = (root / ".ai" / "JR-12345" / "task.md").read_text(encoding="utf-8")
    assert f"- Branch name: `{recorded}`" in task
    assert "`fix/" not in _section(task, "## Branch Instructions")


def test_a_long_name_shortens_the_slug_never_the_issue():
    """Release-freeze review: cutting the finished name at 120 characters cut the
    key — two issues with one long title shared a branch, ending in a shorter key."""
    template = "bugfix/platform-services-backend-team/{slug}-{issue}"
    title = ("Saving a record with a very long title that keeps going and going until it is far longer "
             "than any branch should be with an empty filter")
    first = render_branch_template(template, "JR-12345", title)
    second = render_branch_template(template, "JR-99999", title)
    assert first and second and first != second
    assert first.endswith("-JR-12345") and second.endswith("-JR-99999")
    assert len(first) <= 120 and len(second) <= 120
    # Words come off the slug's end; the slug's start is kept.
    assert "/saving-a-record-with" in first


def test_a_title_cannot_make_a_name_that_names_a_ref():
    """`{slug}/{issue}` passes the template check; the title "Refs" would render refs/JR-1."""
    assert render_branch_template("{slug}/{issue}", "JR-1", "Refs") is None
    assert branch_name("JR-1", "Refs", "{slug}/{issue}") == "feature/JR-1-refs"
    assert render_branch_template("{slug}/{issue}", "JR-1", "Crash on save") == "crash-on-save/JR-1"
