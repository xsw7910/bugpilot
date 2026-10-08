"""Git History v2, Batch 2: the Git History Settings, end to end on the Python side.

Each setting is checked for the one thing it promises — and for the thing it
must not do, which is touch Code Search. The repositories are built in temp
directories with fixed dates, as in ``test_git_history.py``; nothing here reads
the developer's own history.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import git_history, workflow
from bugpilot.core.git_history import (
    HISTORY_DEPTH_LIMITS,
    GitHistoryLimits,
    GitHistoryQuery,
    find_related_commits,
    limits_for,
)
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import (
    DEFAULT_MAX_RELATED_COMMITS,
    MAX_RELATED_COMMITS_LIMIT,
    GitHistoryOptions,
    InvestigationOptions,
    InvestigationPlan,
    InvestigationRequest,
    effective_plan,
)
from bugpilot.core.retrieval import RelatedFile, RetrievalArtifact

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git history needs git")
needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")


def _git(root: Path, *args: str, date: str | None = None) -> str:
    env = dict(os.environ)
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{date}T12:00:00+00:00"
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, env=env, encoding="utf-8"
    ).stdout.strip()


def _commit(root: Path, date: str, message: str, files: dict[str, str]) -> str:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        _git(root, "add", name)
    _git(root, "commit", "-q", "-m", message, date=date)
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
    """One commit per kind of evidence the settings can switch. Read-only."""
    root = _init(tmp_path_factory.mktemp("settings") / "repo")
    hashes = {
        "issue": _commit(root, "2025-01-10", "JR-12345: fix the bucket order", {"src/Bucket.cpp": "v1\n"}),
        "shared": _commit(root, "2025-03-01", "Tidy postblend volumes", {"src/Volumes.cpp": "v1\n"}),
        "git_keyword": _commit(root, "2025-04-01", "Rework the blendmerge pass", {"src/Merge.cpp": "v1\n"}),
        "focus": _commit(root, "2025-05-01", "Adjust focus defaults", {"src/Focus.cpp": "v1\n"}),
        "additional": _commit(root, "2025-06-01", "Rename legacy options", {"src/Legacy.cpp": "v1\n"}),
        "ranked": _commit(root, "2025-07-01", "Speed up renderer", {"src/Renderer.cpp": "v1\n"}),
        # Found by file history, and its message names the issue.
        "issue_on_focus": _commit(root, "2025-08-01", "JR-12345 follow-up", {"src/Focus.cpp": "v2\n"}),
    }
    return root, hashes


FULL_QUERY = GitHistoryQuery(
    issue_id="JR-12345",
    shared_keywords=("postblend",),
    git_keywords=("blendmerge",),
    focus_files=("src/Focus.cpp",),
    git_files=("src/Legacy.cpp",),
    ranked_files=("src/Renderer.cpp",),
)


def _order(result) -> list[str]:
    return [commit.hash for commit in result.commits]


def _by_hash(result, commit: str):
    return next(item for item in result.commits if item.hash == commit)


def _spy_git(monkeypatch) -> list[list[str]]:
    seen: list[list[str]] = []
    real = git_history.run_command

    def spy(args, cwd, timeout=None):
        seen.append(list(args))
        return real(args, cwd, timeout=timeout)

    monkeypatch.setattr(git_history, "run_command", spy)
    return seen


def _message_walks(commands: list[list[str]]) -> list[list[str]]:
    return [command for command in commands if any(arg.startswith("--grep=") for arg in command)]


def _file_walks(commands: list[list[str]]) -> list[list[str]]:
    return [command for command in commands if any(arg.startswith(":(literal") for arg in command)]


# --- 1. defaults are Batch 1 ----------------------------------------------------------


def test_the_default_settings_are_batch_1s_limits():
    assert limits_for(GitHistoryOptions()) == GitHistoryLimits()
    assert HISTORY_DEPTH_LIMITS["recent"] == GitHistoryLimits()
    assert InvestigationOptions().git_history == GitHistoryOptions()


@needs_git
def test_the_default_settings_give_batch_1s_results(repo):
    root, _hashes = repo
    query = GitHistoryQuery(
        issue_id="JR-12345",
        shared_keywords=("postblend",),
        focus_files=("src/Focus.cpp",),
        ranked_files=("src/Renderer.cpp", "src/Bucket.cpp"),
    )

    batch_1 = find_related_commits(root, query)
    batch_2 = find_related_commits(root, query, limits_for(GitHistoryOptions()))

    assert [(c.hash, c.score, c.reasons) for c in batch_2.commits] == [
        (c.hash, c.score, c.reasons) for c in batch_1.commits
    ]


def test_the_default_settings_build_batch_1s_query(tmp_path):
    retrieval = RetrievalArtifact(related_files=(RelatedFile("src/a.cpp", False, 9, "high", 1),))
    options = InvestigationOptions(keywords=["postblend"], focus_files=["src/Focus.cpp"])
    keywords = {"high_value_keywords": ["postblend", "BlendInputModel"], "normal_keywords": []}

    query = workflow._git_history_query(tmp_path, "JR-12345", retrieval, None, keywords, options, GitHistoryOptions())

    assert query == GitHistoryQuery(
        issue_id="JR-12345",
        shared_keywords=("postblend",),
        extracted_terms=("BlendInputModel",),
        focus_files=("src/Focus.cpp",),
        ranked_files=("src/a.cpp",),
        # Batch 4: every Code Search file, never searched — only excluded from supporting files.
        known_files=("src/a.cpp",),
    )


def test_a_command_line_without_git_flags_gets_the_defaults(tmp_path, monkeypatch, capsys):
    captured = _capture_request(tmp_path, monkeypatch, [])
    assert captured.options.git_history == GitHistoryOptions()


# --- 2/3. Use shared Keywords ----------------------------------------------------------


@needs_git
def test_shared_keywords_off_removes_them_from_search_and_ranking(repo, monkeypatch):
    root, hashes = repo
    options = InvestigationOptions(keywords=["postblend"])
    keywords = {"high_value_keywords": ["postblend"], "normal_keywords": []}
    settings = GitHistoryOptions(use_shared_keywords=False)

    query = workflow._git_history_query(root, "JR-12345", None, None, keywords, options, settings)
    commands = _spy_git(monkeypatch)
    result = find_related_commits(root, query, limits_for(settings))

    assert query.shared_keywords == ()
    # Not smuggled back in as an "issue term" by the extraction it heads.
    assert "postblend" not in [term.lower() for term in query.extracted_terms]
    assert not any("--grep=postblend" in command for command in commands)
    assert hashes["shared"] not in _order(result)
    assert all(not commit.shared_keywords for commit in result.commits)


@needs_rg
@needs_git
def test_code_search_still_uses_shared_keywords_git_history_ignores(tmp_path):
    root, work_item = _prepared(
        tmp_path,
        InvestigationOptions(keywords=["postblend"], git_history=GitHistoryOptions(use_shared_keywords=False)),
    )

    terms = json.loads((root / ".ai" / work_item / "retrieval.json").read_text(encoding="utf-8"))["terms"]
    assert {"value": "postblend", "source": "user"}.items() <= terms[0].items()
    history = _history(root, work_item)
    assert "matched shared keyword" not in history


# --- 4/5. Use shared Focus Files --------------------------------------------------------


@needs_git
def test_shared_focus_files_off_removes_their_history_and_credit(repo, monkeypatch):
    root, hashes = repo
    settings = GitHistoryOptions(use_shared_focus_files=False)
    options = InvestigationOptions(focus_files=["src/Focus.cpp"])

    query = workflow._git_history_query(root, "JR-12345", None, None, {}, options, settings)
    commands = _spy_git(monkeypatch)
    result = find_related_commits(root, query, limits_for(settings))

    assert query.focus_files == ()
    assert not any(":(literal,icase)src/Focus.cpp" in command for command in commands)
    assert hashes["focus"] not in _order(result)
    assert all(not commit.focus_files for commit in result.commits)


@needs_rg
@needs_git
def test_code_search_still_uses_focus_files_git_history_ignores(tmp_path):
    root, work_item = _prepared(
        tmp_path,
        InvestigationOptions(
            keywords=["postblend"],
            focus_files=["src/Volumes.cpp"],
            git_history=GitHistoryOptions(use_shared_focus_files=False),
        ),
    )

    related = json.loads((root / ".ai" / work_item / "retrieval.json").read_text(encoding="utf-8"))["related_files"]
    focus = next(item for item in related if item["file"] == "src/Volumes.cpp")
    assert "developer marked this file as a focus area" in focus["reasons"]
    assert "modified focus file" not in _history(root, work_item)


# --- 6/7. Additional Commit Keywords / Additional Files ----------------------------------


@needs_git
def test_additional_commit_keywords_search_commits(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(git_keywords=("blendmerge",)))

    assert _order(result) == [hashes["git_keyword"]]
    commit = result.commits[0]
    assert commit.git_keywords == ["blendmerge"] and commit.shared_keywords == []
    assert "matched commit keyword: blendmerge" in commit.reasons


@needs_git
def test_additional_files_read_their_history(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(git_files=("Legacy.cpp",)))

    assert _order(result) == [hashes["additional"]]
    commit = result.commits[0]
    # Resolved by the same bare-name rule as a Focus File, credited as its own kind.
    assert commit.git_files == ["src/Legacy.cpp"] and commit.focus_files == []
    assert "modified additional file: `src/Legacy.cpp`" in commit.reasons


@needs_rg
@needs_git
def test_additional_keywords_and_files_never_reach_code_search(tmp_path):
    settings = GitHistoryOptions(keywords=("blendmerge",), files=("src/Legacy.cpp",))
    root, work_item = _prepared(tmp_path, InvestigationOptions(keywords=["postblend"], git_history=settings))

    retrieval = json.loads((root / ".ai" / work_item / "retrieval.json").read_text(encoding="utf-8"))
    assert "blendmerge" not in [term["value"].lower() for term in retrieval["terms"]]
    assert all(
        "developer marked this file as a focus area" not in item["reasons"] for item in retrieval["related_files"]
    )
    history = _history(root, work_item)
    assert "matched commit keyword: blendmerge" in history
    assert "modified additional file: `src/Legacy.cpp`" in history


def test_a_word_in_both_keyword_lists_counts_once_as_a_commit_keyword():
    query = GitHistoryQuery(shared_keywords=("postblend", "volumes"), git_keywords=("Postblend",))

    assert git_history._git_keywords(query) == ["Postblend"]
    assert git_history._shared_keywords(query, git_history._git_keywords(query)) == ["volumes"]


def test_commit_keywords_are_trimmed_deduplicated_and_kept_unicode():
    query = GitHistoryQuery(git_keywords=("  blendmerge ", "", "ab", "BLENDMERGE", "ångström-skalierung"))

    assert git_history._git_keywords(query) == ["blendmerge", "ångström-skalierung"]


# --- 8/9/10. the two routes ---------------------------------------------------------------


@needs_git
def test_commit_message_search_off_runs_no_message_walk(repo, monkeypatch):
    root, hashes = repo
    commands = _spy_git(monkeypatch)

    result = find_related_commits(root, FULL_QUERY, limits_for(GitHistoryOptions(search_commit_messages=False)))

    assert _message_walks(commands) == []
    # Only file history found anything: the issue-ID and keyword commits on
    # other files are not searched for.
    for name in ("issue", "shared", "git_keyword"):
        assert hashes[name] not in _order(result)
    # A commit file history found is still judged by the message it carries.
    assert _by_hash(result, hashes["issue_on_focus"]).issue_id == "JR-12345"
    assert result.search_term_count == 0


@needs_git
def test_file_history_off_reads_no_file(repo, monkeypatch):
    root, hashes = repo
    commands = _spy_git(monkeypatch)

    result = find_related_commits(root, FULL_QUERY, limits_for(GitHistoryOptions(search_file_history=False)))

    assert _file_walks(commands) == []
    assert not any("ls-files" in command or "--no-walk=unsorted" in command for command in commands)
    assert result.file_candidate_count == 0
    for name in ("focus", "additional", "ranked"):
        assert hashes[name] not in _order(result)
    # Message search still finds, and nothing gets file credit.
    assert {hashes["issue"], hashes["shared"], hashes["git_keyword"]} <= set(_order(result))
    assert all(not commit.files for commit in result.commits)


def test_both_routes_off_skips_the_step_like_an_unticked_box():
    options = InvestigationOptions(
        git_history=GitHistoryOptions(search_commit_messages=False, search_file_history=False)
    )
    request = InvestigationRequest(spec=bug_spec_from_description("x"), options=options)

    assert "git_context" not in request.resolved_steps()
    assert "git_context" in request.skipped_steps()
    # Only Git History: everything else runs as planned.
    assert effective_plan(InvestigationPlan(), options) == InvestigationPlan(git_history=False)
    # And one route alone is not "nothing".
    one = InvestigationOptions(git_history=GitHistoryOptions(search_commit_messages=False))
    assert effective_plan(InvestigationPlan(), one) == InvestigationPlan()


@needs_rg
@needs_git
def test_both_routes_off_runs_no_git_history_and_does_not_fail(tmp_path, monkeypatch):
    called: list[object] = []
    monkeypatch.setattr(workflow, "collect_git_history", lambda *a, **k: called.append(a) or "")
    settings = GitHistoryOptions(search_commit_messages=False, search_file_history=False)

    root, work_item = _prepared(tmp_path, InvestigationOptions(keywords=["postblend"], git_history=settings))

    assert called == []
    run = json.loads((root / ".ai" / work_item / "run.json").read_text(encoding="utf-8"))
    assert run["status"] == "prepared"
    assert run["steps"]["git_context"] == "skipped"
    assert "_Git context has not been generated yet._" in _history(root, work_item)


def test_refining_with_both_routes_off_skips_git_history(tmp_path, monkeypatch):
    spec = bug_spec_from_description("x")
    options = InvestigationOptions(
        git_history=GitHistoryOptions(search_commit_messages=False, search_file_history=False)
    )
    plan = effective_plan(InvestigationPlan(issue_details=False), options)

    assert "git_context" not in plan.resolve_steps(spec.source)


# --- 11/12. Max Related Commits and History Depth -------------------------------------------


@needs_git
def test_max_related_commits_changes_only_how_many_are_kept(repo):
    root, _hashes = repo

    full = find_related_commits(root, FULL_QUERY, limits_for(GitHistoryOptions()))
    three = find_related_commits(root, FULL_QUERY, limits_for(GitHistoryOptions(max_related_commits=3)))

    assert len(full.commits) > 3
    assert _order(three) == _order(full)[:3]
    assert three.candidate_count == full.candidate_count


def test_broader_reads_three_times_as_far():
    recent, broader = HISTORY_DEPTH_LIMITS["recent"], HISTORY_DEPTH_LIMITS["broader"]

    assert broader.commits_per_ranked_file == 3 * recent.commits_per_ranked_file
    assert broader.commits_per_focus_file == 3 * recent.commits_per_focus_file
    assert broader.term_search_max_commits == 3 * recent.term_search_max_commits
    assert broader.issue_id_max_commits == 3 * recent.issue_id_max_commits
    # Depth never changes how many are kept.
    assert limits_for(GitHistoryOptions(history_depth="broader")).max_related_commits == DEFAULT_MAX_RELATED_COMMITS


@needs_git
def test_broader_history_reaches_older_commits_of_a_file(tmp_path):
    root = _init(tmp_path / "deep")
    made = [_commit(root, f"2026-01-{day:02d}", f"Edit widget {day}", {"src/Widget.cpp": f"{day}\n"}) for day in range(1, 9)]
    query = GitHistoryQuery(ranked_files=("src/Widget.cpp",))

    recent = find_related_commits(root, query, limits_for(GitHistoryOptions()))
    broader = find_related_commits(root, query, limits_for(GitHistoryOptions(history_depth="broader")))

    assert recent.candidate_count == 5
    assert broader.candidate_count == 8
    assert set(_order(broader)) == set(made)


# --- 13. evidence stays distinguishable -----------------------------------------------------


@needs_git
def test_git_specific_evidence_is_its_own_reason_and_weight(repo):
    root, hashes = repo
    result = find_related_commits(root, FULL_QUERY)

    order = _order(result)
    # A commit keyword outranks a shared one; an Additional File a ranked file.
    assert order.index(hashes["git_keyword"]) < order.index(hashes["shared"])
    assert order.index(hashes["additional"]) < order.index(hashes["ranked"])
    assert _without_recency(_by_hash(result, hashes["git_keyword"])) == git_history.SCORE_GIT_KEYWORD
    assert _without_recency(_by_hash(result, hashes["shared"])) == git_history.SCORE_SHARED_KEYWORD
    assert _without_recency(_by_hash(result, hashes["additional"])) == git_history.SCORE_ADDITIONAL_FILE
    reasons = [reason for commit in result.commits for reason in commit.reasons]
    assert any(reason.startswith("matched commit keyword") for reason in reasons)
    assert any(reason.startswith("matched shared keyword") for reason in reasons)
    assert any(reason.startswith("modified additional file") for reason in reasons)
    assert any(reason.startswith("modified focus file") for reason in reasons)
    # Issue ID still strongest.
    assert order[0] in {hashes["issue"], hashes["issue_on_focus"]}


# --- 14/15. old and invalid settings -----------------------------------------------------------


def test_invalid_settings_normalize_to_safe_defaults():
    for bad in (0, -1, MAX_RELATED_COMMITS_LIMIT + 1, 10_000, "5", True, None):
        assert GitHistoryOptions(max_related_commits=bad).normalized().max_related_commits == DEFAULT_MAX_RELATED_COMMITS  # type: ignore[arg-type]
    assert GitHistoryOptions(max_related_commits=25).normalized().max_related_commits == 25
    assert GitHistoryOptions(history_depth="everything").normalized().history_depth == "recent"
    assert limits_for(GitHistoryOptions(history_depth="all", max_related_commits=0)) == GitHistoryLimits()


@pytest.mark.parametrize(
    "argv", [["--git-max-commits", "0"], ["--git-max-commits", "26"], ["--git-max-commits", "-3"]]
)
def test_the_command_line_refuses_an_out_of_range_count(tmp_path, monkeypatch, capsys, argv):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--description", "x", *argv, "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "INVALID_INPUT"


def test_the_command_line_refuses_an_unknown_depth(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as exit_info:
        main(["bug", "--description", "x", "--git-history-depth", "everything", "--json"])
    assert exit_info.value.code == 2


def test_every_git_flag_reaches_the_options(tmp_path, monkeypatch):
    captured = _capture_request(
        tmp_path,
        monkeypatch,
        [
            "--git-keyword=blendmerge", "--git-keyword=ångström", "--git-file=src/Legacy.cpp",
            "--git-no-shared-keywords", "--git-no-shared-focus-files", "--git-no-commit-search",
            "--git-history-depth=broader", "--git-max-commits=7", "--keywords=postblend",
            "--focus-file=src/Focus.cpp",
        ],
    )

    assert captured.options.git_history == GitHistoryOptions(
        use_shared_keywords=False,
        use_shared_focus_files=False,
        keywords=("blendmerge", "ångström"),
        files=("src/Legacy.cpp",),
        search_commit_messages=False,
        search_file_history=True,
        history_depth="broader",
        max_related_commits=7,
    )
    # Code Search's own inputs are untouched by any of them.
    assert captured.options.keywords == ["postblend"]
    assert captured.options.focus_files == ["src/Focus.cpp"]


# --- logging ---------------------------------------------------------------------------------


@needs_git
def test_the_settings_trace_carries_shapes_never_values(repo, execution_trace):
    root, _hashes = repo
    settings = GitHistoryOptions(
        keywords=("SECRET_COMMIT_KEYWORD_4417",),
        files=("src/SecretLegacy_9921.cpp",),
        use_shared_keywords=False,
        history_depth="broader",
        max_related_commits=7,
    )
    options = InvestigationOptions(keywords=["SECRET_SHARED_KEYWORD_3302"], git_history=settings)

    workflow.git_context_step(root, "JR-12345", options=options)

    trace = execution_trace.text
    assert (
        "commitSearch=true fileHistory=true maxCommits=7 historyDepth=broader "
        "sharedKeywords=off sharedFocusFiles=on commitKeywords=1 additionalFiles=1"
    ) in trace
    for secret in ("SECRET_COMMIT_KEYWORD_4417", "SecretLegacy_9921", "SECRET_SHARED_KEYWORD_3302"):
        assert secret not in trace


# --- helpers -----------------------------------------------------------------------------------


def _without_recency(commit) -> int:
    """The score less its recency bonus, read back from the reason that names it."""
    for days, bonus in git_history.RECENCY_BONUS:
        if f"recent: within {days} days of the newest related commit" in commit.reasons:
            return commit.score - bonus
    return commit.score


def _capture_request(tmp_path: Path, monkeypatch, argv: list[str]) -> InvestigationRequest:
    seen: list[InvestigationRequest] = []

    def capture(repo_root, request, **kwargs):
        seen.append(request)
        raise RuntimeError("captured")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(workflow, "run_investigation", capture)
    main(["bug", "--description", "x", *argv, "--json"])
    (request,) = seen
    return request


def _prepared(tmp_path: Path, options: InvestigationOptions) -> tuple[Path, str]:
    """A small git repository with code Code Search can rank, prepared once."""
    root = _init(tmp_path / "prepared")
    _commit(root, "2025-01-01", "Add postblend volumes", {"src/Volumes.cpp": "void postblend() {}\n"})
    _commit(root, "2025-02-01", "Rework the blendmerge pass", {"src/Merge.cpp": "int merge() { return 0; }\n"})
    _commit(root, "2025-03-01", "Rename legacy options", {"src/Legacy.cpp": "int legacy() { return 1; }\n"})
    spec = bug_spec_from_description("postblend volumes vanish after a merge.", title="Volumes vanish")
    workflow.run_investigation(root, InvestigationRequest(spec=spec, options=options))
    return root, spec.work_item_id


def _history(root: Path, work_item: str) -> str:
    context = (root / ".ai" / work_item / "context.md").read_text(encoding="utf-8")
    return context.split("## Git History", 1)[1]


# --- standalone git-context (Batch 5 review) ------------------------------------------------


@needs_rg
@needs_git
def test_standalone_git_context_prints_and_leaves_the_prepared_run_alone(tmp_path, monkeypatch, capsys):
    # A run prepared with its own settings; a manual `bugpilot git-context`
    # searches with the defaults. It used to write that answer into
    # retrieval.json (and the step into run.json) without rebuilding
    # context.md, so the panel and the agent read two different runs.
    root, work_item = _prepared(
        tmp_path,
        InvestigationOptions(keywords=["postblend"], git_history=GitHistoryOptions(max_related_commits=1, history_depth="broader")),
    )
    directory = root / ".ai" / work_item
    before = {name: (directory / name).read_bytes() for name in ("retrieval.json", "run.json", "context.md")}
    monkeypatch.chdir(root)
    capsys.readouterr()

    assert main(["git-context", work_item]) == 0

    assert capsys.readouterr().out.startswith(f"# Git Context: {work_item}")
    assert {name: (directory / name).read_bytes() for name in before} == before
