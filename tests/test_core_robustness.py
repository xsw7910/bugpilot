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
from pathlib import Path

import pytest

from bugpilot.core.config import data_dir, issue_dir, memory_dir
from bugpilot.core import search, workflow
from bugpilot.core.issue import IssueArtifact
from bugpilot.core import artifact_io
from bugpilot.core.artifact_io import atomic_write_text
from bugpilot.core.workflow import MAX_SUPPLIED_KEYWORDS


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


# --- the status file is read from other processes ---------------------------


def test_status_is_written_atomically(tmp_path, monkeypatch):
    """The extension restores its checklist from this file while a run writes it.

    A torn read parses as nothing, which the panel shows as "no progress" for a
    run that is going fine. `atomic_write_text` existed for this and had zero
    callers.
    """
    seen: list[tuple[str, str]] = []
    real_replace = os.replace

    def watched(source, target):
        seen.append((os.path.basename(str(source)), os.path.basename(str(target))))
        return real_replace(source, target)

    monkeypatch.setattr(artifact_io.os, "replace", watched)
    workflow._mark_step(tmp_path, "JR-1", "doctor", "pass")

    status = issue_dir(tmp_path, "JR-1") / "run.json"
    assert json.loads(status.read_text(encoding="utf-8"))["steps"]["doctor"] == "pass"
    assert seen, "the run state was written in place, not renamed into place"
    assert seen[-1][1] == "run.json"
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

    monkeypatch.setattr(artifact_io.os, "replace", always_locked)
    monkeypatch.setattr(artifact_io.time, "sleep", lambda _seconds: None)

    target = tmp_path / "run.json"
    atomic_write_text(target, '{"ok": true}\n')

    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    assert calls["count"] > 1, "it gave up without retrying"
    assert list(tmp_path.glob("*.tmp*")) == [], "the temp file was left behind"


def test_a_link_planted_at_a_temp_name_is_never_written_through(tmp_path):
    """The temp file is made new under an unpredictable name, so a link a repository
    commits at the name an older BugPilot used (`<name>.tmp<pid>`) is never followed."""
    outside = tmp_path / "outside.txt"
    outside.write_text("untouched", encoding="utf-8")
    work = tmp_path / "work"
    work.mkdir()
    planted = work / f"run.json.tmp{os.getpid()}"
    try:
        planted.symlink_to(outside)
    except OSError:
        pytest.skip("symbolic links need a privilege this account does not have")

    atomic_write_text(work / "run.json", '{"ok": true}\n')

    assert outside.read_text(encoding="utf-8") == "untouched"
    assert json.loads((work / "run.json").read_text(encoding="utf-8")) == {"ok": True}
    assert not (work / "run.json").is_symlink()
    assert sorted(path.name for path in work.iterdir()) == ["run.json", planted.name], "a temp file was left behind"


# --- the permissions of what BugPilot writes (L-3, 0.1.4 pre-commit hardening) ----------
#
# `mkstemp` makes the temp file owner-only (0600 on POSIX), and the rename gives the target the
# temp file's mode. The policy: a file BugPilot creates stays owner-only; a file it rewrites keeps
# the permission bits it had — never widened, never narrowed — set through the temp file's
# descriptor, never by path, so the planted-link protection above is untouched.


def _stat_with_mode(st_mode: int) -> os.stat_result:
    return os.stat_result((st_mode, 0, 0, 1, 0, 0, 0, 0, 0, 0))


def test_only_a_regular_targets_nine_permission_bits_are_carried_and_only_on_posix(monkeypatch):
    import stat

    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(artifact_io, "_POSIX", True)
    monkeypatch.setattr(artifact_io.os, "fchmod", lambda fd, mode: calls.append((fd, mode)), raising=False)
    for st_mode, expected in [
        (stat.S_IFREG | 0o644, [(7, 0o644)]),
        (stat.S_IFREG | 0o640, [(7, 0o640)]),
        (stat.S_IFREG | 0o600, [(7, 0o600)]),
        # setuid, setgid and sticky are never carried onto what BugPilot writes.
        (stat.S_IFREG | 0o4755, [(7, 0o755)]),
        (stat.S_IFREG | 0o2640, [(7, 0o640)]),
        (stat.S_IFREG | 0o1664, [(7, 0o664)]),
        # Not a regular file (a link, a folder): nothing carried; the write is refused elsewhere.
        (stat.S_IFLNK | 0o777, []),
        (stat.S_IFDIR | 0o755, []),
    ]:
        calls.clear()
        monkeypatch.setattr(artifact_io.os, "lstat", lambda path, st_mode=st_mode: _stat_with_mode(st_mode))
        artifact_io._keep_permissions(7, Path("target.json"))
        assert calls == expected, oct(st_mode)

    # A new file: nothing to carry, so mkstemp's owner-only mode stands.
    def missing(path):
        raise FileNotFoundError(path)

    calls.clear()
    monkeypatch.setattr(artifact_io.os, "lstat", missing)
    artifact_io._keep_permissions(7, Path("target.json"))
    assert calls == []

    # The bits cannot be set: the write goes on, owner-only.
    def refused(fd, mode):
        raise PermissionError("Operation not permitted")

    monkeypatch.setattr(artifact_io.os, "lstat", lambda path: _stat_with_mode(stat.S_IFREG | 0o644))
    monkeypatch.setattr(artifact_io.os, "fchmod", refused, raising=False)
    artifact_io._keep_permissions(7, Path("target.json"))

    # Windows: permission bits are not its model; nothing is read or set.
    def unexpected(*args, **kwargs):
        raise AssertionError("permissions touched on Windows")

    monkeypatch.setattr(artifact_io, "_POSIX", False)
    monkeypatch.setattr(artifact_io.os, "lstat", unexpected)
    monkeypatch.setattr(artifact_io.os, "fchmod", unexpected, raising=False)
    artifact_io._keep_permissions(7, Path("target.json"))


def test_a_rewrite_sets_the_targets_bits_on_the_temp_file_never_by_path(tmp_path, monkeypatch):
    """Through `atomic_write_text` itself: the bits go on the new file's descriptor before the
    rename, and nothing is ever chmod-ed by path (which would follow a link put there)."""
    import stat

    calls: list[tuple[int, int]] = []
    monkeypatch.setattr(artifact_io, "_POSIX", True)
    monkeypatch.setattr(artifact_io.os, "fchmod", lambda fd, mode: calls.append((fd, mode)), raising=False)

    def by_path(*args, **kwargs):
        raise AssertionError(f"chmod by path: {args}")

    monkeypatch.setattr(artifact_io.os, "chmod", by_path)
    work = tmp_path / "work"
    work.mkdir()
    atomic_write_text(work / "new.json", "{}\n")
    assert calls == [], "a new file was given another mode than owner-only"

    target = work / "run.json"
    target.write_text("old\n", encoding="utf-8")
    expected = stat.S_IMODE(os.lstat(target).st_mode) & 0o777
    atomic_write_text(target, '{"ok": true}\n')
    assert [mode for _fd, mode in calls] == [expected]
    assert isinstance(calls[0][0], int)
    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    assert sorted(path.name for path in work.iterdir()) == ["new.json", "run.json"], "a temp file was left behind"


@pytest.mark.skipif(os.name != "posix", reason="permission bits are POSIX's; on Windows chmod sets only the read-only flag")
def test_on_posix_a_new_file_is_owner_only_and_a_rewritten_one_keeps_its_mode(tmp_path):
    import stat

    created = tmp_path / "new.json"
    atomic_write_text(created, "{}\n")
    assert stat.S_IMODE(created.stat().st_mode) == 0o600
    for bits in (0o644, 0o640, 0o664, 0o600):
        target = tmp_path / f"kept-{bits:o}.json"
        target.write_text("old\n", encoding="utf-8")
        target.chmod(bits)
        atomic_write_text(target, "new\n")
        assert stat.S_IMODE(target.stat().st_mode) == bits, oct(bits)
        assert target.read_text(encoding="utf-8") == "new\n"


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
    search._run_rg(tmp_path, "-Wall", [])

    args = captured[0]
    assert "--" in args, "without `--` ripgrep reads the keyword as a flag"
    assert args[args.index("--") + 1] == "-Wall"
    # And the path still comes last, or rg searches nothing.
    assert args[-1] == "."


@pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")
def test_the_real_ripgrep_accepts_the_form_we_build(tmp_path):
    """The proof that matters: run the actual binary, not a stub of it."""
    # .c, which §33.2 made searchable: the include globs and the extractor's
    # notion of a code file now come from one list in `core/code_files.py`.
    (tmp_path / "flags.c").write_text("// built with -Wall here\n", encoding="utf-8")
    warnings: list[str] = []
    completed = search._run_rg(tmp_path, "-Wall", warnings)
    matches, _total = search._collect(completed.stdout, "-Wall", "high_value")

    assert warnings == [], warnings
    assert [match.keyword for match in matches] == ["-Wall"]
    assert "flags.c" in matches[0].file


# --- supplied keywords are unbounded work ----------------------------------


def test_supplied_keywords_are_capped_and_the_rest_recorded(tmp_path, monkeypatch, execution_trace):
    """Each keyword is one ripgrep run with its own 20 second timeout.

    A pasted list of sixty would spend twenty minutes searching and then be
    abandoned by the caller's own timeout — and every entry point now lets a
    person type that list by hand.
    """
    target = issue_dir(tmp_path, "JR-1")
    target.mkdir(parents=True)
    issue = IssueArtifact(id="JR-1", source="jira", title="crash on save")

    supplied = [f"word{index}" for index in range(MAX_SUPPLIED_KEYWORDS + 12)]
    keywords = workflow.keywords_step(
        tmp_path, "JR-1", workflow.InvestigationOptions(keywords=supplied), issue=issue
    )

    high = keywords["high_value_keywords"]
    assert len([word for word in high if word.startswith("word")]) == MAX_SUPPLIED_KEYWORDS
    # Dropped, not discarded: the developer can see what was left out.
    assert keywords["dropped_supplied_keywords"] == supplied[MAX_SUPPLIED_KEYWORDS:]
    assert "dropping" in execution_trace.text and supplied[-1] in execution_trace.text
    # Extraction is in-memory state: nothing is written for it.
    assert not (target / "extracted_keywords.json").exists()


# --- files a human edits -----------------------------------------------------


def test_a_hand_edited_config_does_not_break_every_command(user_config_folder):
    """config/config.toml in the data folder is read by every command through load_config.

    A decode error there would take down `bugpilot doctor` — the one command
    whose job is to explain what is wrong.
    """
    from bugpilot.core import user_config

    path = user_config_folder / "config.toml"
    path.write_bytes('jira_email = "m\xfcller@example.com"\n'.encode("cp1252"))

    loaded = user_config.load_user_config()
    assert loaded.jira_email and "ller@example.com" in loaded.jira_email


# --- where a repository's BugPilot files are (0.1.7) -------------------------


def test_doctor_says_where_the_files_are_and_asks_no_gitignore_question(tmp_path, monkeypatch):
    """0.1.7 writes nothing into the repository, so there is no `.ai/` rule for `.gitignore` to have.

    `doctor` reports where the repository's work items, memory and settings are
    instead — the folder the extension reads them from — and creates nothing.
    """
    import os

    from bugpilot.core.doctor import collect_doctor_report
    from bugpilot.core.storage import repository_storage

    _git(tmp_path, "init", "-q")
    monkeypatch.chdir(tmp_path)
    report = collect_doctor_report(tmp_path)
    assert "ai_artifacts_ignored" not in report and "ai_artifacts_ignored_paths" not in report
    assert "unified-storage" in report["capabilities"]
    storage = report["storage"]
    assert storage["repository_dir"] == repository_storage(tmp_path).diagnostics()["repository_dir"]
    assert (storage["state"], storage["problem"]) == ("uninitialized", None)
    assert not os.path.lexists(storage["repository_dir"])
    assert not ((data_dir(tmp_path) / "work")).exists() and not (memory_dir(tmp_path)).exists()


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
