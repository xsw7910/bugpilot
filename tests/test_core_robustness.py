"""Findings from the review of the pre-adapter core.

These are the parts nothing had reviewed: the modules that existed before the
three entry points, now reached by all three. Each test here corresponds to a
defect found by that review, and most of them were found by asking a real tool
(ripgrep, git) rather than by reading the code.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

from bugpilot.core import search, workflow
from bugpilot.core.git_ops import artifacts_ignored
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import InvestigationOptions, InvestigationPlan, InvestigationRequest
from bugpilot.core.workflow import MAX_SUPPLIED_KEYWORDS, _atomic_write_text, run_investigation


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


# --- the status file is read from other processes ---------------------------


def test_status_is_written_atomically(tmp_path, monkeypatch):
    """The extension restores its checklist from this file while a run writes it.

    A torn read parses as nothing, which the panel shows as "no progress" for a
    run that is going fine. `_atomic_write_text` existed for this and had zero
    callers.
    """
    seen: list[tuple[str, str]] = []
    real_replace = os.replace

    def watched(source, target):
        seen.append((os.path.basename(str(source)), os.path.basename(str(target))))
        return real_replace(source, target)

    monkeypatch.setattr(workflow.os, "replace", watched)
    workflow._write_status(tmp_path, "JR-1", {"doctor": "pass"}, [])

    status = tmp_path / ".ai" / "JR-1" / "workflow_status.json"
    assert json.loads(status.read_text(encoding="utf-8"))["steps"]["doctor"] == "pass"
    assert seen, "the status file was written in place, not renamed into place"
    assert seen[-1][1] == "workflow_status.json"
    # No debris: a leftover .tmp<pid> file in .ai/ shows up in the artifact tree.
    assert [path.name for path in status.parent.glob("*.tmp*")] == []


def test_a_locked_target_falls_back_instead_of_failing_the_step(tmp_path, monkeypatch):
    """Windows refuses to rename onto a file another process has open.

    Its readers are exactly that. A raised exception would cost the whole step,
    while writing in place costs at most one stale read — so the fallback is the
    cheaper failure.
    """
    calls = {"count": 0}

    def always_locked(source, target):
        calls["count"] += 1
        raise PermissionError("being used by another process")

    monkeypatch.setattr(workflow.os, "replace", always_locked)
    monkeypatch.setattr(workflow.time, "sleep", lambda _seconds: None)

    target = tmp_path / "workflow_status.json"
    _atomic_write_text(target, '{"ok": true}\n')

    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    assert calls["count"] > 1, "it gave up without retrying"
    assert list(tmp_path.glob("*.tmp*")) == [], "the temp file was left behind"


# --- ripgrep reads a leading dash as a flag --------------------------------


def test_a_keyword_starting_with_a_dash_is_searched_not_eaten(tmp_path, monkeypatch):
    """`rg: unrecognized flag -W` — verified against the real ripgrep.

    Compiler flags, CLI options and switch names are exactly the terms a bug
    report is about, and the phase 5 fix to the argparse layer is what lets one
    reach this far.
    """
    captured: list[list[str]] = []

    class Result:
        returncode = 1
        stdout = ""
        stderr = ""

    def fake_run(args, **kwargs):
        captured.append(args)
        return Result()

    monkeypatch.setattr(search.subprocess, "run", fake_run)
    search._rg_keyword(tmp_path, "-Wall", "high_value", [])

    args = captured[0]
    assert "--" in args, "without `--` ripgrep reads the keyword as a flag"
    assert args[args.index("--") + 1] == "-Wall"
    # And the path still comes last, or rg searches nothing.
    assert args[-1] == "."


@pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")
def test_the_real_ripgrep_accepts_the_form_we_build(tmp_path):
    """The proof that matters: run the actual binary, not a stub of it."""
    # .cpp, because INCLUDE_GLOBS is the legacy C++/Qt set and .c is not in it.
    (tmp_path / "flags.cpp").write_text("// built with -Wall here\n", encoding="utf-8")
    warnings: list[str] = []
    matches = search._rg_keyword(tmp_path, "-Wall", "high_value", warnings)

    assert warnings == [], warnings
    assert [match.keyword for match in matches] == ["-Wall"]
    assert "flags.cpp" in matches[0].file


# --- supplied keywords are unbounded work ----------------------------------


def test_supplied_keywords_are_capped_and_the_rest_recorded(tmp_path, monkeypatch):
    """Each keyword is one ripgrep run with its own 20 second timeout.

    A pasted list of sixty would spend twenty minutes searching and then be
    abandoned by the caller's own timeout — and every entry point now lets a
    person type that list by hand.
    """
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    monkeypatch.setattr(workflow, "_parsed_issue", lambda *_args: {"combined_text": "crash on save"})

    supplied = [f"word{index}" for index in range(MAX_SUPPLIED_KEYWORDS + 12)]
    workflow.keywords_step(
        tmp_path, "JR-1", workflow.InvestigationOptions(keywords=supplied)
    )

    keywords = json.loads((target / "extracted_keywords.json").read_text(encoding="utf-8"))
    high = keywords["high_value_keywords"]
    assert len([word for word in high if word.startswith("word")]) == MAX_SUPPLIED_KEYWORDS
    # Dropped, not discarded: the developer can see what was left out.
    assert keywords["dropped_supplied_keywords"] == supplied[MAX_SUPPLIED_KEYWORDS:]
    assert "dropped" in (target / "execution.log").read_text(encoding="utf-8")


# --- files a human edits -----------------------------------------------------


def test_a_hint_file_in_another_encoding_does_not_abort_the_run(tmp_path):
    """developer_hint.md is edited by hand; editors save cp1252 and GB2312.

    Two of the three reads of this file already used errors="replace"; the third
    — the one every resumed run does — would have thrown UnicodeDecodeError and
    taken the run with it. So this drives the real function rather than
    re-testing Python's own decoder.
    """
    spec = bug_spec_from_description("crash on save", repo_root=tmp_path)
    target = tmp_path / ".ai" / spec.work_item_id
    target.mkdir(parents=True, exist_ok=True)
    # "修在 parser 里" as GB2312 bytes: not decodable as UTF-8.
    (target / "developer_hint.md").write_bytes("修在 parser 里".encode("gb2312"))
    with pytest.raises(UnicodeDecodeError):
        (target / "developer_hint.md").read_text(encoding="utf-8")

    request = InvestigationRequest(
        spec=spec,
        options=InvestigationOptions(),
        # Trimmed so the test exercises the hint read without a full search.
        plan=InvestigationPlan(code_search=False, git_history=False, similar_fixes=False),
    )
    # fresh=False is the path that reads a hint left by a previous run.
    result = run_investigation(tmp_path, request, fresh=False)
    assert result.generated_files, "the run produced nothing"


def test_a_hand_edited_config_does_not_break_every_command(tmp_path, monkeypatch):
    """~/.bugpilot/config.toml is read by every command through load_config.

    A decode error there would take down `bugpilot doctor` — the one command
    whose job is to explain what is wrong.
    """
    from bugpilot.core import user_config

    path = tmp_path / "config.toml"
    path.write_bytes('jira_email = "m\xfcller@example.com"\n'.encode("cp1252"))
    monkeypatch.setattr(user_config, "user_config_path", lambda: path)

    loaded = user_config.load_user_config()
    assert loaded.jira_email and "ller@example.com" in loaded.jira_email


# --- .ai/ in someone else's repository -------------------------------------


def test_artifacts_ignored_answers_before_the_directories_exist(tmp_path):
    """The advice is worth giving *before* the first run, which is the case that
    broke both earlier attempts at this check.

    `.gitignore` patterns ending in `/` only match a path git knows is a
    directory, so asking about `.ai` answered "not ignored" until `.ai` existed.
    """
    _git(tmp_path, "init", "-q")
    assert artifacts_ignored(tmp_path) is False

    (tmp_path / ".gitignore").write_text(".ai/\n.ai_memory/\n", encoding="utf-8")
    assert artifacts_ignored(tmp_path) is True, "neither directory exists yet, and that is the point"

    # Half-configured is not configured: .ai_memory would still be committed.
    (tmp_path / ".gitignore").write_text(".ai/\n", encoding="utf-8")
    assert artifacts_ignored(tmp_path) is False


def test_artifacts_ignored_is_unknown_outside_a_checkout(tmp_path):
    """None, not False: there is nothing to advise about without git."""
    assert artifacts_ignored(tmp_path) is None


def test_doctor_reports_it(tmp_path, monkeypatch):
    """So the extension and `doctor` both surface it without a second mechanism."""
    from bugpilot.core.doctor import collect_doctor_report

    _git(tmp_path, "init", "-q")
    monkeypatch.chdir(tmp_path)
    assert collect_doctor_report(tmp_path)["ai_artifacts_ignored"] is False


# --- a test file is a lead, not an implementation ---------------------------


def test_a_test_path_cannot_claim_high_confidence(tmp_path):
    """Found on real data, twice over.

    A test fixture quoting a Jira issue's own prose produced an *exact phrase
    match* — the strongest per-file signal there is — and that single file
    flipped the whole search from low to high confidence, which re-inflated the
    context score to the 90/100 the previous fix existed to prevent.

    A matching test is a genuinely good lead: it may be the test for the broken
    behaviour. It is just not the file that tells a reader the implementation
    was located. Test names and comments routinely quote ticket text, so this
    is not a quirk of testing bugpilot on itself.
    """
    from bugpilot.core.search import FileScore, _assign_confidence, _is_test_path

    assert _is_test_path("tests/test_context_signals.py")
    assert _is_test_path("src/tests/helper.cpp")
    assert _is_test_path("app/widget_test.py")
    assert not _is_test_path("src/context.py")
    # "latest" contains "test" and must not be mistaken for one.
    assert not _is_test_path("lib/latest/thing.cpp")

    fixture = FileScore(file="tests/test_context_signals.py", score=37)
    fixture.keyword_quality_counts["high"] = 1
    fixture.reasons.append("exact phrase match")
    _assign_confidence(fixture)
    assert fixture.confidence == "medium", "an exact phrase hit in a test is still only a lead"
    assert any("lead rather than an implementation" in reason for reason in fixture.reasons)


def test_the_same_signal_in_application_source_is_still_high(tmp_path):
    """The cap is about test paths, not about weakening the phrase signal."""
    from bugpilot.core.search import FileScore, _assign_confidence

    real = FileScore(file="src/well_tie/quality.cpp", score=37)
    real.keyword_quality_counts["high"] = 1
    real.reasons.append("exact phrase match")
    _assign_confidence(real)
    assert real.confidence == "high"
