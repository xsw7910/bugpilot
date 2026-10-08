"""Git History: the structured result in ``retrieval.json.git_history``.

The record is a projection of the ranking, never a second one: the same
commits, order, scores and reasons the ranking produces, with each piece of
evidence still saying where it came from. ``context.md`` renders from it, the
panel reads it, and it is written atomically beside the search it belongs to.
Repositories are built in temp directories with fixed dates.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from bugpilot.core import git_history, retrieval as retrieval_module, workflow
from bugpilot.core.git_history import (
    GitHistoryQuery,
    collect_git_history,
    find_related_commits,
    limits_for,
    record_of,
    render_git_context,
)
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import GitHistoryOptions, InvestigationOptions, InvestigationPlan, InvestigationRequest
from bugpilot.core.retrieval import (
    COMMIT_FILE_SOURCES,
    COMMIT_TERM_SOURCES,
    GIT_HISTORY_SCHEMA_VERSION,
    GitHistoryRecord,
    GitHistorySearch,
    RetrievalArtifact,
    git_history_from_dict,
    git_history_to_dict,
    retrieval_from_dict,
    retrieval_to_dict,
)

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git history needs git")
needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")

COMMIT_KEYS = {"hash", "short_hash", "subject", "date", "score", "matched_terms", "files", "reasons"}
SECTION_KEYS = {"schema_version", "status", "search", "summary", "commits", "warnings", "supporting_files"}
SECRET_BODY = "SECRET_BODY_TEXT_6617 the reviewer said do not ship"


def _git(root: Path, *args: str, date: str | None = None) -> str:
    env = dict(os.environ)
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{date}T12:00:00+00:00"
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, env=env, encoding="utf-8"
    ).stdout.strip()


def _commit(root: Path, date: str, message: str, files: dict[str, str], body: str = "") -> str:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        _git(root, "add", name)
    _git(root, "commit", "-q", "-m", message, *(["-m", body] if body else []), date=date)
    return _git(root, "rev-parse", "HEAD")


def _init(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "dev@example.com")
    _git(root, "config", "user.name", "Dev")
    _git(root, "config", "core.autocrlf", "false")
    return root


@pytest.fixture(scope="module")
def repo(tmp_path_factory):
    """Every kind of evidence once, and a body that must never be persisted. Read-only."""
    root = _init(tmp_path_factory.mktemp("artifact") / "repo")
    hashes = {
        "issue": _commit(root, "2025-01-10", "JR-12345: fix the bucket order", {"src/Bucket.cpp": "v1\n"}),
        "shared": _commit(
            root, "2025-03-01", "Tidy postblend volumes", {"src/Volumes.cpp": "v1\n"}, body=SECRET_BODY
        ),
        "git_keyword": _commit(root, "2025-04-01", "Rework the blendmerge pass", {"src/Merge.cpp": "v1\n"}),
        "extracted": _commit(root, "2025-04-15", "Cache BlendInputModel results", {"src/Model.cpp": "v1\n"}),
        "focus": _commit(root, "2025-05-01", "Adjust focus defaults", {"src/Focus.cpp": "v1\n"}),
        "additional": _commit(root, "2025-06-01", "Rename legacy options", {"src/Legacy.cpp": "v1\n"}),
        "ranked": _commit(root, "2025-07-01", "Speed up renderer", {"src/Renderer.cpp": "v1\n"}),
    }
    return root, hashes


QUERY = GitHistoryQuery(
    issue_id="JR-12345",
    shared_keywords=("postblend",),
    git_keywords=("blendmerge",),
    extracted_terms=("BlendInputModel",),
    focus_files=("src/Focus.cpp",),
    git_files=("src/Legacy.cpp",),
    ranked_files=("src/Renderer.cpp",),
)


def _by_hash(record: GitHistoryRecord, commit: str):
    return next(item for item in record.commits if item.hash == commit)


# --- 2/3/4/5. the record is the ranking ----------------------------------------------


@needs_git
def test_the_record_keeps_the_rankings_commits_order_scores_and_reasons(repo):
    root, _hashes = repo
    ranked = find_related_commits(root, QUERY, limits_for(GitHistoryOptions()))
    record = collect_git_history(root, "JR-12345", QUERY).record

    assert record.status == "completed"
    assert [c.hash for c in record.commits] == [c.hash for c in ranked.commits]
    assert [c.score for c in record.commits] == [c.score for c in ranked.commits]
    assert [list(c.reasons) for c in record.commits] == [c.reasons for c in ranked.commits]
    assert [c.short_hash for c in record.commits] == [c.hash[:10] for c in ranked.commits]
    assert record.candidate_count == ranked.candidate_count


def test_the_section_is_versioned_and_its_keys_are_the_contract():
    record = GitHistoryRecord("completed")
    data = git_history_to_dict(record)

    assert set(data) == SECTION_KEYS
    assert data["schema_version"] == GIT_HISTORY_SCHEMA_VERSION == 1
    assert set(data["summary"]) == {"candidate_count", "related_commit_count", "incomplete", "failed_lookup_count"}
    assert set(data["search"]) == {"commit_message_search", "file_history_search", "history_depth", "max_related_commits"}


# --- 6/7. each piece of evidence says where it came from ---------------------------------


@needs_git
def test_matched_terms_and_files_keep_their_sources(repo):
    root, hashes = repo
    record = collect_git_history(root, "JR-12345", QUERY).record

    def sources(name):
        commit = _by_hash(record, hashes[name])
        return [(term.value, term.source) for term in commit.matched_terms], [(f.path, f.source) for f in commit.files]

    assert sources("issue")[0] == [("JR-12345", "issue_id")]
    assert sources("git_keyword")[0] == [("blendmerge", "additional_commit_keyword")]
    assert sources("shared")[0] == [("postblend", "shared_keyword")]
    assert sources("extracted")[0] == [("BlendInputModel", "extracted_term")]
    assert sources("focus")[1] == [("src/Focus.cpp", "shared_focus_file")]
    assert sources("additional")[1] == [("src/Legacy.cpp", "additional_file")]
    assert sources("ranked")[1] == [("src/Renderer.cpp", "code_search_ranked_file")]
    used = {term.source for c in record.commits for term in c.matched_terms} | {f.source for c in record.commits for f in c.files}
    assert used == set(COMMIT_TERM_SOURCES) | set(COMMIT_FILE_SOURCES)


# --- 8/9. bounded, and nothing beyond what is shown -----------------------------------------


@needs_git
def test_the_record_is_bounded_by_max_related_commits(repo):
    root, _hashes = repo
    record = collect_git_history(root, "JR-12345", QUERY, GitHistoryOptions(max_related_commits=2)).record

    assert len(record.commits) == 2
    assert record.search.max_related_commits == 2
    assert record.candidate_count > 2


@needs_git
def test_no_body_and_no_diff_is_persisted(repo):
    root, hashes = repo
    data = json.dumps(git_history_to_dict(collect_git_history(root, "JR-12345", QUERY).record))

    assert "SECRET_BODY_TEXT_6617" not in data
    assert "diff --git" not in data and "@@" not in data
    for commit in json.loads(data)["commits"]:
        assert set(commit) == COMMIT_KEYS


def test_a_runaway_subject_is_capped():
    candidate = git_history.CommitCandidate("a" * 40, "x" * 1000, 0, shared_keywords=["postblend"])
    result = git_history.GitHistoryResult(commits=(candidate,), candidate_count=1)

    subject = record_of(result, GitHistorySearch()).commits[0].subject
    assert len(subject) == git_history.MAX_SUBJECT_CHARACTERS
    assert subject.endswith("…")


# --- 10/11. no result and a partial result ----------------------------------------------------


@needs_git
def test_no_match_is_a_completed_record_with_no_commits(repo):
    root, _hashes = repo
    outcome = collect_git_history(root, "JR-99999", GitHistoryQuery(issue_id="JR-99999"))

    assert outcome.record.status == "completed"
    assert outcome.record.commits == () and not outcome.record.incomplete
    assert "No related commits found." in render_git_context(outcome)


@needs_git
def test_a_partial_search_is_incomplete_not_failed(repo, monkeypatch):
    root, hashes = repo
    real = git_history.run_command

    def slow_messages(args, cwd, timeout=None):
        if any(arg.startswith("--grep=") for arg in args):
            return git_history.TIMEOUT_EXIT_CODE, "git timed out"
        return real(args, cwd, timeout=timeout)

    monkeypatch.setattr(git_history, "run_command", slow_messages)
    outcome = collect_git_history(root, "JR-12345", QUERY)
    data = git_history_to_dict(outcome.record)

    assert data["status"] == "completed"
    assert data["summary"]["incomplete"] is True
    assert data["summary"]["failed_lookup_count"] == 4
    assert data["warnings"] == ["4 git history lookup(s) did not complete; the list may be incomplete."]
    # What file history found is still there.
    assert hashes["ranked"] in [c["hash"] for c in data["commits"]]
    assert "_4 git history lookup(s) did not complete; the list may be incomplete._" in render_git_context(outcome)


def test_outside_a_repository_the_record_says_unavailable(tmp_path):
    outcome = collect_git_history(tmp_path, "JR-12345", QUERY)

    assert outcome.record.status == "unavailable"
    assert outcome.record.warnings == ("Current directory is not inside a git repository.",)
    assert outcome.repository is None
    assert "## Warning" in render_git_context(outcome)


@needs_git
def test_with_nothing_to_search_the_record_says_so(repo):
    root, _hashes = repo
    outcome = collect_git_history(root, "JR-1", GitHistoryQuery())

    assert outcome.record.status == "nothing_to_search"
    assert "_No related files or search terms available yet._" in render_git_context(outcome)


# --- 16/17. reading it back, and determinism -------------------------------------------------


@needs_git
def test_the_section_round_trips_and_serializes_identically(repo):
    root, _hashes = repo
    first = git_history_to_dict(collect_git_history(root, "JR-12345", QUERY).record)
    second = git_history_to_dict(collect_git_history(root, "JR-12345", QUERY).record)

    assert json.dumps(first) == json.dumps(second)
    assert git_history_to_dict(git_history_from_dict(first)) == first


@pytest.mark.parametrize(
    "section",
    [None, "nonsense", {"schema_version": 2, "status": "completed"}, {"schema_version": 1, "status": "sparkling"}, []],
)
def test_an_unreadable_section_is_no_section_and_the_search_survives(section):
    data = retrieval_to_dict(RetrievalArtifact(confidence="high"))
    data["git_history"] = section

    loaded = retrieval_from_dict(data, "JR-12345")

    assert loaded.git_history is None
    assert loaded.confidence == "high"


def test_a_retrieval_written_before_the_section_existed_has_none():
    legacy = retrieval_to_dict(RetrievalArtifact(confidence="medium"))
    assert "git_history" not in legacy
    assert retrieval_from_dict(legacy, "JR-12345").git_history is None


def test_malformed_commits_and_unknown_sources_are_dropped_on_read():
    data = git_history_to_dict(GitHistoryRecord("completed"))
    data["commits"] = [
        "not a commit",
        {"hash": ""},
        {
            "hash": "b" * 40, "short_hash": "bbbbbbbbbb", "subject": "ok", "date": "2025-01-01", "score": 30,
            "matched_terms": [{"value": "x", "source": "made_up"}, {"value": "postblend", "source": "shared_keyword"}],
            "files": [{"path": "src/a.cpp", "source": "elsewhere"}], "reasons": ["matched shared keyword: postblend"],
        },
    ]

    record = git_history_from_dict(data)

    assert [c.hash for c in record.commits] == ["b" * 40]
    assert [t.value for t in record.commits[0].matched_terms] == ["postblend"]
    assert record.commits[0].files == ()


# --- the pipeline: 1, 12, 13, 14, 15 and failure --------------------------------------------------


def _code_repo(tmp_path: Path) -> Path:
    root = _init(tmp_path / "prepared")
    _commit(root, "2025-01-01", "Add postblend volumes", {"src/Volumes.cpp": "void postblend() {}\n"})
    _commit(root, "2025-02-01", "Rework the blendmerge pass", {"src/Merge.cpp": "int merge() { return 0; }\n"})
    _commit(root, "2025-03-01", "Tidy postblend logging", {"src/Log.cpp": "int log() { return 1; }\n"})
    _git(root, "commit", "-q", "--allow-empty", "-m", "Ignore nothing", date="2025-03-02")
    return root


def _prepare(root: Path, options: InvestigationOptions | None = None, plan: InvestigationPlan | None = None, spec=None, fresh=True):
    spec = spec or bug_spec_from_description("postblend volumes vanish after a merge.", title="Volumes vanish")
    request = InvestigationRequest(
        spec=spec,
        options=options or InvestigationOptions(keywords=["postblend"]),
        **({"plan": plan} if plan else {}),
    )
    workflow.run_investigation(root, request, fresh=fresh)
    return spec


def _section(root: Path, work_item: str) -> dict | None:
    data = json.loads((root / ".ai" / work_item / "retrieval.json").read_text(encoding="utf-8"))
    return data.get("git_history")


def _context_hashes(root: Path, work_item: str) -> list[str]:
    context = (root / ".ai" / work_item / "context.md").read_text(encoding="utf-8")
    return re.findall(r"^#### ([0-9a-f]{10}) — ", context.split("## Git History", 1)[1], flags=re.M)


@needs_rg
@needs_git
def test_a_prepared_run_records_the_section_and_the_context_renders_it(tmp_path):
    root = _code_repo(tmp_path)
    spec = _prepare(root)
    section = _section(root, spec.work_item_id)

    assert section is not None and section["schema_version"] == 1 and section["status"] == "completed"
    assert section["summary"]["related_commit_count"] == len(section["commits"]) > 0
    # The context lists exactly the recorded commits, in the recorded order, once each.
    recorded = [c["short_hash"] for c in section["commits"]]
    assert _context_hashes(root, spec.work_item_id) == recorded
    assert len(set(recorded)) == len(recorded)
    context = (root / ".ai" / spec.work_item_id / "context.md").read_text(encoding="utf-8")
    assert f"{len(recorded)} related commit{'s' if len(recorded) != 1 else ''} found." in context
    for commit in section["commits"]:
        for reason in commit["reasons"]:
            assert f"- {reason}" in context
    # Still exactly the five artifacts.
    assert {p.name for p in (root / ".ai" / spec.work_item_id).iterdir()} == {
        "issue.json", "retrieval.json", "context.md", "task.md", "run.json",
    }


@needs_rg
@needs_git
def test_the_default_run_records_exactly_what_the_ranking_produced(tmp_path, monkeypatch):
    seen = []
    real = git_history.find_related_commits

    def spy(repo_root, query, limits=None):
        result = real(repo_root, query, limits)
        seen.append((query, result))
        return result

    monkeypatch.setattr(git_history, "find_related_commits", spy)
    root = _code_repo(tmp_path)
    spec = _prepare(root)

    (query, result), = seen
    again = real(root, query)  # the default limits, called directly
    section = _section(root, spec.work_item_id)
    assert [c["hash"] for c in section["commits"]] == [c.hash for c in result.commits] == [c.hash for c in again.commits]
    assert [c["score"] for c in section["commits"]] == [c.score for c in again.commits]
    assert [c["reasons"] for c in section["commits"]] == [c.reasons for c in again.commits]


@needs_rg
@needs_git
def test_the_section_is_written_atomically(tmp_path, monkeypatch):
    writes: list[str] = []
    real = retrieval_module.atomic_write_text

    def spy(path, text):
        writes.append(text)
        return real(path, text)

    monkeypatch.setattr(retrieval_module, "atomic_write_text", spy)
    root = _code_repo(tmp_path)
    _prepare(root)

    # Code Search's write, then Git history's: both through the atomic writer,
    # the second the same file with the section added.
    assert len(writes) == 2
    first, second = json.loads(writes[0]), json.loads(writes[1])
    assert "git_history" not in first and "git_history" in second
    second.pop("git_history")
    assert second == first


@needs_rg
@needs_git
def test_a_rerun_replaces_the_section(tmp_path):
    root = _code_repo(tmp_path)
    spec = _prepare(root)
    before = _section(root, spec.work_item_id)

    options = InvestigationOptions(keywords=["postblend"], git_history=GitHistoryOptions(max_related_commits=1))
    _prepare(root, options, spec=spec, fresh=False)
    after = _section(root, spec.work_item_id)

    assert len(before["commits"]) > 1
    assert len(after["commits"]) == 1 and after["search"]["max_related_commits"] == 1
    assert after["commits"][0] == before["commits"][0]


@needs_rg
@needs_git
def test_skipping_git_history_leaves_no_section_behind(tmp_path):
    root = _code_repo(tmp_path)
    spec = _prepare(root)
    assert _section(root, spec.work_item_id) is not None

    off = GitHistoryOptions(search_commit_messages=False, search_file_history=False)
    _prepare(root, InvestigationOptions(keywords=["postblend"], git_history=off), spec=spec, fresh=False)

    # Code Search rewrote the file; Git history did not run, so nothing claims it did.
    assert _section(root, spec.work_item_id) is None
    run = json.loads((root / ".ai" / spec.work_item_id / "run.json").read_text(encoding="utf-8"))
    assert run["steps"]["git_context"] == "skipped"


@needs_rg
@needs_git
def test_a_resume_that_skips_both_steps_keeps_the_section_and_does_not_render_it(tmp_path):
    root = _code_repo(tmp_path)
    spec = _prepare(root)
    path = root / ".ai" / spec.work_item_id / "retrieval.json"
    before = path.read_text(encoding="utf-8")

    _prepare(root, plan=InvestigationPlan(code_search=False, git_history=False), spec=spec, fresh=False)

    # Untouched on disk, for a reader that trusts it only when run.json says
    # the step passed — and this run's context does not present it as its own.
    assert path.read_text(encoding="utf-8") == before
    context = (root / ".ai" / spec.work_item_id / "context.md").read_text(encoding="utf-8")
    assert "_Git context has not been generated yet._" in context
    run = json.loads((root / ".ai" / spec.work_item_id / "run.json").read_text(encoding="utf-8"))
    assert run["steps"]["git_context"] == "skipped"


@needs_rg
@needs_git
def test_a_failed_step_takes_the_earlier_section_out(tmp_path, monkeypatch):
    root = _code_repo(tmp_path)
    spec = _prepare(root)
    assert _section(root, spec.work_item_id) is not None

    def broken(*args, **kwargs):
        raise RuntimeError("git exploded")

    monkeypatch.setattr(workflow, "collect_git_history", broken)
    with pytest.raises(RuntimeError):
        _prepare(root, plan=InvestigationPlan(code_search=False), spec=spec, fresh=False)

    assert _section(root, spec.work_item_id) is None
    run = json.loads((root / ".ai" / spec.work_item_id / "run.json").read_text(encoding="utf-8"))
    assert run["steps"]["git_context"] == "fail"


def test_without_a_retrieval_nothing_is_invented(tmp_path):
    spec = bug_spec_from_description("x")
    workflow.run_investigation(tmp_path, InvestigationRequest(spec=spec, plan=InvestigationPlan(code_search=False)))

    assert not (tmp_path / ".ai" / spec.work_item_id / "retrieval.json").exists()


# --- context rendering -------------------------------------------------------------------------


@needs_git
def test_the_context_section_renders_the_records_fields(repo):
    root, hashes = repo
    outcome = collect_git_history(root, "JR-12345", QUERY)
    text = render_git_context(outcome)
    first = outcome.record.commits[0]

    assert f"### {first.short_hash} — {first.subject}\n\nDate: {first.date}\n" in text
    assert "Matched: JR-12345\n" in text
    assert "Relevant files:\n- `src/Focus.cpp`\n" in text
    assert "Why relevant:\n- matched commit keyword: blendmerge\n" in text
    headings = re.findall(r"^### ([0-9a-f]{10}) — ", text, flags=re.M)
    assert headings == [c.short_hash for c in outcome.record.commits]


def test_a_work_item_whose_git_history_did_not_run_says_so(tmp_path):
    spec = bug_spec_from_description("x")
    workflow.run_investigation(tmp_path, InvestigationRequest(spec=spec, plan=InvestigationPlan(git_history=False)))

    context = (tmp_path / ".ai" / spec.work_item_id / "context.md").read_text(encoding="utf-8")
    assert "_Git context has not been generated yet._" in context


# --- privacy -------------------------------------------------------------------------------------


@needs_rg
@needs_git
def test_recording_logs_counts_and_never_contents(tmp_path, execution_trace):
    root = _code_repo(tmp_path)
    _prepare(root, InvestigationOptions(keywords=["postblend"], git_history=GitHistoryOptions(keywords=("blendmerge",))))

    trace = execution_trace.text
    assert re.search(r"git_context recorded: status=completed, \d+ candidate\(s\), \d+ retained", trace)
    for private in ("postblend", "blendmerge", "Rework the blendmerge pass", "src/Merge.cpp", "Volumes"):
        assert private not in trace
