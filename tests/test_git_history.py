"""Git History v2, Batch 1: candidate sources, merge, ranking and bounds.

Every repository here is built in a temporary directory with fixed commit dates,
so the ranking is the same on every machine and nothing depends on the
developer's own history. Assertions are about *order*, not just membership: a
ranker that finds the right commits and puts them last has not done its job.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from bugpilot.core import git_history, workflow
from bugpilot.core.git_history import (
    MAX_EXTRACTED_TERMS,
    MAX_RELATED_COMMITS,
    MAX_SHARED_KEYWORD_TERMS,
    GitHistoryLimits,
    GitHistoryQuery,
    file_candidates,
    collect_git_history,
    find_related_commits,
    render_git_context,
    safe_relative_path,
    select_extracted_terms,
)
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import InvestigationOptions, InvestigationRequest
from bugpilot.core.retrieval import RelatedFile, RetrievalArtifact, RetrievalTerm

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git history needs git")
needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")
pytestmark = needs_git


def _git(root: Path, *args: str, date: str | None = None) -> str:
    env = dict(os.environ)
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{date}T12:00:00+00:00"
    completed = subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, env=env, encoding="utf-8"
    )
    return completed.stdout.strip()


def _commit(root: Path, date: str, message: str, files: dict[str, str], body: str = "") -> str:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        _git(root, "add", name)
    args = ["commit", "-q", "-m", message] + (["-m", body] if body else [])
    _git(root, *args, date=date)
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
    """One history with a commit for every kind of evidence, oldest first.

    Built once per module: nothing here writes to it.
    """
    root = _init(tmp_path_factory.mktemp("history") / "repo")
    hashes = {
        "issue": _commit(
            root, "2024-01-10", "JR-12345: fix poststack angle selection",
            {"src/stack/AngleStack.cpp": "v1\n"},
        ),
        "keyword_old": _commit(
            root, "2024-03-01", "Refactor volume selector for poststack volumes",
            {"src/VolumeSelector.cpp": "v1\n"},
        ),
        "unrelated_old": _commit(root, "2025-06-01", "Tidy logging", {"src/Logger.cpp": "v1\n"}),
        "keyword_body": _commit(
            root, "2025-11-01", "Fix crash on load", {"src/Loader.cpp": "v1\n"},
            body="Root cause: poststack buffer reuse.",
        ),
        "extracted": _commit(
            root, "2026-01-05", "Add StackInputModel caching", {"src/StackInputModel.cpp": "v1\n"}
        ),
        "focus": _commit(
            root, "2026-02-01", "Adjust defaults", {"src/stack/AngleStack.cpp": "v2\n"}
        ),
        "ranked": _commit(root, "2026-03-10", "Speed up renderer", {"src/Renderer.cpp": "v1\n"}),
        "unrelated_new": _commit(root, "2026-03-20", "Update readme", {"README.md": "v1\n"}),
        "near_miss": _commit(
            root, "2026-03-25", "JR-123 and XJR-12 are other tickets", {"docs/notes.md": "v1\n"}
        ),
    }
    return root, hashes


def generate_git_context(root, key, query=None, settings=None) -> str:
    """Batch 1's document, now rendered from the structured record (Batch 3)."""
    return render_git_context(collect_git_history(root, key, query, settings))


def _order(result) -> list[str]:
    return [commit.hash for commit in result.commits]


def _by_hash(result, commit: str):
    return next(item for item in result.commits if item.hash == commit)


# --- 1. issue ID ---------------------------------------------------------------------


def test_an_exact_issue_id_match_ranks_first_even_when_old(repo):
    root, hashes = repo
    result = find_related_commits(
        root, GitHistoryQuery(issue_id="JR-12345", ranked_files=("src/Renderer.cpp",))
    )

    assert _order(result)[0] == hashes["issue"]
    assert "exact issue ID match: JR-12345" in _by_hash(result, hashes["issue"]).reasons


def test_a_key_inside_a_longer_key_is_not_a_match(repo):
    root, _hashes = repo
    # The near-miss commit names `JR-123` and `XJR-12`: each contains `JR-12`
    # as a substring, and each is a different ticket.
    result = find_related_commits(root, GitHistoryQuery(issue_id="JR-12"))

    assert result.commits == ()


# --- 2. shared Keywords ----------------------------------------------------------------


def test_shared_keywords_find_commits_by_subject_and_body(repo):
    root, hashes = repo
    without = find_related_commits(root, GitHistoryQuery(ranked_files=("src/Renderer.cpp",)))
    with_keyword = find_related_commits(
        root, GitHistoryQuery(shared_keywords=("poststack",), ranked_files=("src/Renderer.cpp",))
    )

    assert hashes["keyword_old"] not in _order(without)
    assert hashes["keyword_body"] not in _order(without)
    # Subject and body are both searched.
    found = _order(with_keyword)
    assert {hashes["keyword_old"], hashes["keyword_body"], hashes["issue"]} <= set(found)
    # A shared Keyword outranks a Code Search file, so all three lead.
    assert found.index(hashes["ranked"]) > max(
        found.index(hashes[name]) for name in ("keyword_old", "keyword_body", "issue")
    )
    assert "matched shared keyword: poststack" in _by_hash(with_keyword, hashes["keyword_body"]).reasons


# --- 3. Focus Files -----------------------------------------------------------------


def test_focus_file_history_contributes_candidates(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(focus_files=("src/stack/AngleStack.cpp",)))

    assert set(_order(result)) == {hashes["focus"], hashes["issue"]}
    focus = _by_hash(result, hashes["focus"])
    assert focus.focus_files == ["src/stack/AngleStack.cpp"]
    assert "modified focus file: `src/stack/AngleStack.cpp`" in focus.reasons


def test_a_bare_focus_file_name_resolves_like_code_search_does(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(focus_files=("anglestack.cpp",)))

    assert set(_order(result)) == {hashes["focus"], hashes["issue"]}
    assert _by_hash(result, hashes["focus"]).focus_files == ["src/stack/AngleStack.cpp"]


def test_a_focus_directory_covers_the_files_inside_it(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(focus_files=("src/stack/",)))

    assert set(_order(result)) == {hashes["focus"], hashes["issue"]}


def test_a_focus_file_outranks_a_top_code_search_file(repo):
    root, hashes = repo
    result = find_related_commits(
        root,
        GitHistoryQuery(focus_files=("src/stack/AngleStack.cpp",), ranked_files=("src/Renderer.cpp",)),
    )

    order = _order(result)
    assert order.index(hashes["focus"]) < order.index(hashes["ranked"])
    # Old, but a Focus File: still above the newer ranked-file commit.
    assert order.index(hashes["issue"]) < order.index(hashes["ranked"])


# --- 4. Code Search ranked files -------------------------------------------------------


def test_code_search_ranked_files_contribute_and_rank_by_position(repo):
    root, hashes = repo
    ranked = ("src/Logger.cpp", "src/a.cpp", "src/b.cpp", "src/c.cpp", "src/Renderer.cpp")
    result = find_related_commits(root, GitHistoryQuery(ranked_files=ranked))

    # Rank #1 beats the tail rank #5 even though the #5 commit is nine months newer.
    assert _order(result) == [hashes["unrelated_old"], hashes["ranked"]]
    assert "modified Code Search file: #1 `src/Logger.cpp`" in result.commits[0].reasons
    assert "modified Code Search file: #5 `src/Renderer.cpp`" in result.commits[1].reasons


# --- 5/6. merge, dedupe, reasons ---------------------------------------------------------


def test_a_commit_found_three_ways_appears_once_with_all_three_reasons(repo):
    root, hashes = repo
    result = find_related_commits(
        root,
        GitHistoryQuery(
            issue_id="JR-12345",
            shared_keywords=("poststack",),
            focus_files=("src/stack/AngleStack.cpp",),
        ),
    )

    assert _order(result).count(hashes["issue"]) == 1
    assert len(_order(result)) == len(set(_order(result)))
    commit = _by_hash(result, hashes["issue"])
    assert commit.issue_id == "JR-12345"
    assert commit.shared_keywords == ["poststack"]
    assert commit.focus_files == ["src/stack/AngleStack.cpp"]
    assert commit.reasons[:2] == ["exact issue ID match: JR-12345", "matched shared keyword: poststack"]
    assert "modified focus file: `src/stack/AngleStack.cpp`" in commit.reasons
    assert commit.matched_terms == ["JR-12345", "poststack"]


def test_a_message_match_is_credited_with_the_candidate_file_it_changed(repo):
    """Found only by its message, but it changed a ranked file: both count."""
    root, hashes = repo
    # Depth 0: the file walk returns nothing, so the keyword commit can only
    # learn it touched VolumeSelector.cpp through the overlap check.
    result = find_related_commits(
        root,
        GitHistoryQuery(shared_keywords=("poststack",), ranked_files=("src/VolumeSelector.cpp",)),
        GitHistoryLimits(commits_per_ranked_file=0),
    )

    commit = _by_hash(result, hashes["keyword_old"])
    assert commit.ranked_files == [(1, "src/VolumeSelector.cpp")]
    assert "modified Code Search file: #1 `src/VolumeSelector.cpp`" in commit.reasons


# --- 7/8. extracted terms, and keeping them few and specific -------------------------------


def test_extracted_issue_terms_contribute_candidates(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(extracted_terms=("StackInputModel",)))

    assert _order(result) == [hashes["extracted"]]
    assert "matched issue term: StackInputModel" in result.commits[0].reasons


def test_an_extracted_term_must_match_a_whole_word(repo):
    root, _hashes = repo
    # `Stack` is inside `StackInputModel` and `AngleStack`, never on its own.
    result = find_related_commits(root, GitHistoryQuery(extracted_terms=("Stack",)))

    assert result.commits == ()


def test_only_specific_extracted_terms_are_selected_and_capped():
    keywords = {
        "high_value_keywords": ["correctly", "data", "process", "output", "volume"],
        "normal_keywords": ["AngleStack", "VolumeSelector", "StackInputModel", "RenderQueue", "a_b", "FooBar"],
        "phrase_keywords": ["poststack volume not shown"],
        "priority_keywords": ["RenderQueue"],
    }
    selected = select_extracted_terms(keywords)

    assert len(selected) == MAX_EXTRACTED_TERMS
    # Prose never qualifies; a too-short identifier neither.
    assert not {"correctly", "data", "process", "output", "volume", "a_b"} & set(selected)
    # The stack-trace identifier leads; phrases come after identifiers.
    assert selected[0] == "RenderQueue"
    assert "poststack volume not shown" not in selected


def test_extracted_terms_skip_shared_keywords_and_broad_terms():
    keywords = {"high_value_keywords": ["AngleStack", "VolumeSelector", "RenderQueue"], "normal_keywords": []}
    retrieval = RetrievalArtifact(
        terms=(RetrievalTerm("VolumeSelector", "identifier", 6, 1, 900, "broad"),)
    )

    selected = select_extracted_terms(keywords, exclude=["anglestack"], retrieval=retrieval)

    assert selected == ("RenderQueue",)


def test_shared_keywords_are_bounded_and_short_ones_dropped(repo, monkeypatch):
    root, _hashes = repo
    seen: list[list[str]] = []
    real = git_history._run_all

    def spy(repo_root, commands):
        seen.extend(commands)
        return real(repo_root, commands)

    monkeypatch.setattr(git_history, "_run_all", spy)
    keywords = ("ab",) + tuple(f"keyword{index}" for index in range(30))
    result = find_related_commits(root, GitHistoryQuery(shared_keywords=keywords))

    greps = [arg for command in seen for arg in command if arg.startswith("--grep=")]
    assert len(greps) == MAX_SHARED_KEYWORD_TERMS
    assert "--grep=ab" not in greps
    assert result.search_term_count == MAX_SHARED_KEYWORD_TERMS
    # One git walk for all of them, not one per keyword.
    assert sum(1 for command in seen if any(arg.startswith("--grep=") for arg in command)) == 1


# --- 9/10. ranking order and bounds -------------------------------------------------------


def test_an_old_strong_match_outranks_recent_weak_ones(repo):
    root, hashes = repo
    result = find_related_commits(
        root,
        GitHistoryQuery(
            shared_keywords=("poststack",),
            ranked_files=("src/Renderer.cpp", "README.md", "docs/notes.md"),
        ),
    )

    order = _order(result)
    # Two years old, one shared keyword — above every recent ranked-file commit.
    for recent in ("ranked", "unrelated_new", "near_miss"):
        assert order.index(hashes["keyword_old"]) < order.index(hashes[recent])


def test_recency_breaks_ties_between_equal_evidence(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(shared_keywords=("poststack",)))

    # Same evidence (one keyword); the newer commit leads.
    order = _order(result)
    assert order.index(hashes["keyword_body"]) < order.index(hashes["keyword_old"])


def test_the_related_commits_are_bounded(tmp_path):
    root = _init(tmp_path / "busy")
    for index in range(MAX_RELATED_COMMITS + 6):
        _commit(root, f"2026-01-{index + 1:02d}", f"poststack tweak {index}", {f"src/f{index}.cpp": "x\n"})

    result = find_related_commits(root, GitHistoryQuery(shared_keywords=("poststack",)))
    smaller = find_related_commits(
        root, GitHistoryQuery(shared_keywords=("poststack",)), GitHistoryLimits(max_related_commits=3)
    )

    assert len(result.commits) == MAX_RELATED_COMMITS
    assert result.candidate_count == MAX_RELATED_COMMITS + 6
    assert len(smaller.commits) == 3
    # The newest win among equals.
    assert result.commits[0].subject == f"poststack tweak {MAX_RELATED_COMMITS + 5}"


def test_the_ranking_is_deterministic(repo):
    root, _hashes = repo
    query = GitHistoryQuery(
        issue_id="JR-12345",
        shared_keywords=("poststack",),
        extracted_terms=("StackInputModel",),
        focus_files=("src/stack/AngleStack.cpp",),
        ranked_files=("src/Renderer.cpp", "src/Logger.cpp"),
    )

    first = find_related_commits(root, query)
    second = find_related_commits(root, query)

    assert [(c.hash, c.score, c.reasons) for c in first.commits] == [
        (c.hash, c.score, c.reasons) for c in second.commits
    ]


def test_a_bulk_commit_gets_no_credit_for_the_files_it_touched(tmp_path):
    """The monorepo finding: an import commit touches the Focus File like everything else."""
    root = _init(tmp_path / "bulk")
    files = {f"vendor/f{index}.cpp": "x\n" for index in range(git_history.BULK_COMMIT_FILES + 1)}
    files["src/Focus.cpp"] = "v1\n"
    bulk = _commit(root, "2024-01-01", "Import everything", files)
    labelled = _commit(root, "2024-01-02", "Reformat poststack sources", {
        **{f"fmt/g{index}.cpp": "y\n" for index in range(git_history.BULK_COMMIT_FILES + 1)},
        "src/Focus.cpp": "v2\n",
    })
    fix = _commit(root, "2025-01-01", "Fix the focus bug", {"src/Focus.cpp": "v3\n"})

    result = find_related_commits(
        root, GitHistoryQuery(shared_keywords=("poststack",), focus_files=("src/Focus.cpp",))
    )

    # File-only evidence on a bulk commit is no evidence; the message still counts,
    # and the real fix to the Focus File leads.
    assert bulk not in _order(result)
    assert _order(result) == [fix, labelled]
    reformat = _by_hash(result, labelled)
    assert reformat.bulk and reformat.focus_files == []
    assert any(reason.startswith("bulk change") for reason in reformat.reasons)
    # The real fix is the only commit credited with the Focus File.
    assert _by_hash(result, fix).focus_files == ["src/Focus.cpp"]


def test_a_small_commit_is_counted_exactly(repo):
    root, hashes = repo

    assert git_history._changed_file_count(root, hashes["issue"]) == 1
    assert git_history._changed_file_count(root, "not-a-hash") is None


# --- 11. failure behaviour ------------------------------------------------------------------


def test_outside_a_git_repository_the_document_says_so(tmp_path):
    text = generate_git_context(tmp_path, "JR-12345", GitHistoryQuery(issue_id="JR-12345"))

    assert "## Warning" in text
    assert "Current directory is not inside a git repository." in text


def test_without_git_the_document_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(git_history, "command_available", lambda command: False)

    assert "git command is not available." in generate_git_context(tmp_path, "JR-12345")


def test_a_repository_with_no_commits_does_not_fail(tmp_path):
    root = _init(tmp_path / "empty")

    text = generate_git_context(root, "JR-12345", GitHistoryQuery(issue_id="JR-12345", ranked_files=("a.cpp",)))

    assert "No related commits found." in text


def test_no_matches_is_a_result_not_a_failure(repo):
    root, _hashes = repo
    text = generate_git_context(root, "JR-99999", GitHistoryQuery(issue_id="JR-99999"))

    assert "No related commits found." in text
    assert "## Warning" not in text


def test_a_timed_out_lookup_is_reported_and_the_rest_still_used(repo, monkeypatch):
    root, hashes = repo
    real = git_history.run_command

    def slow_message_search(args, cwd, timeout=None):
        if any(arg.startswith("--grep=") for arg in args):
            return git_history.TIMEOUT_EXIT_CODE, "git timed out"
        return real(args, cwd, timeout=timeout)

    monkeypatch.setattr(git_history, "run_command", slow_message_search)
    query = GitHistoryQuery(issue_id="JR-12345", ranked_files=("src/Renderer.cpp",))
    result = find_related_commits(root, query)

    assert result.failures == ("timeout",)
    assert _order(result) == [hashes["ranked"]]
    assert "did not complete" in generate_git_context(root, "JR-12345", query)


def test_malformed_git_output_is_skipped(repo, monkeypatch):
    root, _hashes = repo
    monkeypatch.setattr(
        git_history,
        "run_command",
        lambda args, cwd, timeout=None: (0, "\x1enot-a-hash\x00123\x00subject\x00\x1e" + "a" * 40 + "\x00soon\x00x"),
    )

    result = find_related_commits(root, GitHistoryQuery(issue_id="JR-12345", ranked_files=("a.cpp",)))

    assert result.commits == ()


# --- 12. paths ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    ["", "   ", "/etc/passwd", "C:/Windows/win.ini", "c:\\x", "\\\\server\\share", "../outside.cpp",
     "src/../../outside.cpp", ":(glob)**", "src/\nInjected.cpp"],
)
def test_unsafe_paths_are_rejected(value):
    assert safe_relative_path(value) is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [("src/A.cpp", "src/A.cpp"), ("./src//A.cpp", "src/A.cpp"), ("src\\stack\\", "src/stack"), ("A.cpp", "A.cpp")],
)
def test_safe_paths_are_normalized(value, expected):
    assert safe_relative_path(value) == expected


def test_invalid_focus_files_are_ignored_and_the_rest_still_searched(repo):
    root, hashes = repo
    query = GitHistoryQuery(
        focus_files=("../../etc/passwd", "C:/x.cpp", "*.cpp", ":(glob)**", "src/stack/AngleStack.cpp"),
        ranked_files=("../escape.cpp", "src/Renderer.cpp"),
    )

    paths = [candidate.path for candidate in file_candidates(root, query)]
    result = find_related_commits(root, query)

    assert paths == ["src/stack/AngleStack.cpp", "src/Renderer.cpp"]
    assert hashes["focus"] in _order(result) and hashes["ranked"] in _order(result)


def test_a_ranked_file_inside_a_focus_directory_counts_as_focus(repo):
    root, _hashes = repo
    candidates = file_candidates(
        root, GitHistoryQuery(focus_files=("src/stack",), ranked_files=("src/stack/AngleStack.cpp",))
    )

    assert [(item.path, item.focus, item.rank) for item in candidates] == [
        ("src/stack", True, None),
        ("src/stack/AngleStack.cpp", True, 1),
    ]


# --- 13/14. what reaches git -------------------------------------------------------------------


def test_a_unicode_term_reaches_git_intact_and_matches(tmp_path):
    root = _init(tmp_path / "unicode")
    unicode_commit = _commit(root, "2026-01-01", "Ångström-Skalierung für Poststack korrigiert", {"a.cpp": "x\n"})
    _commit(root, "2026-01-02", "Unrelated", {"b.cpp": "x\n"})

    result = find_related_commits(root, GitHistoryQuery(shared_keywords=("ångström-skalierung",)))

    assert _order(result) == [unicode_commit]
    assert result.commits[0].subject == "Ångström-Skalierung für Poststack korrigiert"


def test_shell_metacharacters_are_text_not_commands(tmp_path, monkeypatch):
    root = _init(tmp_path / "shell")
    hostile = '$(touch pwned) `touch pwned2`; touch pwned3 && "quoted" | x'
    matching = _commit(root, "2026-01-01", f"Handle {hostile} in input", {"a.cpp": "x\n"})
    seen: list[list[str]] = []
    real = git_history.run_command

    def spy(args, cwd, timeout=None):
        seen.append(list(args))
        return real(args, cwd, timeout=timeout)

    monkeypatch.setattr(git_history, "run_command", spy)
    result = find_related_commits(root, GitHistoryQuery(shared_keywords=(hostile,)))

    assert _order(result) == [matching]
    # One argv element, never a shell string, and nothing was executed.
    assert [arg for command in seen for arg in command if arg.startswith("--grep=")] == [f"--grep={hostile}"]
    assert not any((root / name).exists() for name in ("pwned", "pwned2", "pwned3"))


def test_a_term_that_looks_like_an_option_is_still_a_search_term(repo):
    root, _hashes = repo
    # Carried inside `--grep=…`, so git never parses it as its own option.
    result = find_related_commits(root, GitHistoryQuery(shared_keywords=("--all", "-n")))

    assert result.failures == ()


# --- 15. v1 behaviour, kept as one source ------------------------------------------------------


def test_file_history_alone_still_gives_each_files_recent_commits(tmp_path):
    root = _init(tmp_path / "v1")
    for index in range(8):
        _commit(root, f"2026-02-{index + 1:02d}", f"Edit widget {index}", {"src/Widget.cpp": f"{index}\n"})
    v1 = _git(root, "log", "--format=%H", "-n", "5", "--", "src/Widget.cpp").splitlines()

    result = find_related_commits(root, GitHistoryQuery(ranked_files=("src/Widget.cpp",)))

    # Exactly what `git log -n 5 -- <file>` returned in v1, newest first.
    assert _order(result) == v1


# --- the document --------------------------------------------------------------------------------


def test_the_document_renders_each_commit_with_its_reasons(repo):
    root, hashes = repo
    text = generate_git_context(
        root,
        "JR-12345",
        GitHistoryQuery(issue_id="JR-12345", shared_keywords=("poststack",), focus_files=("src/stack/AngleStack.cpp",)),
    )

    assert "## Related Commits" in text
    assert f"### {hashes['issue'][:10]} — JR-12345: fix poststack angle selection" in text
    assert "\nDate: 2024-01-10\nMatched: JR-12345, poststack\n" in text
    assert "Relevant files:\n- `src/stack/AngleStack.cpp`\n" in text
    assert "Why relevant:\n- exact issue ID match: JR-12345\n" in text
    assert text.count(f"### {hashes['issue'][:10]}") == 1
    assert re.search(r"\n\d+ related commits found\.\n", text)
    # The score orders the list; it is not shown.
    assert "Score" not in text


def test_an_empty_query_reads_no_history(repo, monkeypatch):
    root, _hashes = repo
    monkeypatch.setattr(git_history, "find_related_commits", lambda *a, **k: pytest.fail("searched"))

    assert "_No related files or search terms available yet._" in generate_git_context(root, "JR-1")


def test_the_trace_records_counts_and_never_the_terms(repo, execution_trace):
    root, _hashes = repo
    secret = "SECRET_KEYWORD_58213"
    generate_git_context(
        root,
        "JR-12345",
        GitHistoryQuery(
            issue_id="JR-12345",
            shared_keywords=(secret, "poststack"),
            extracted_terms=("SECRET_TERM_77310",),
            focus_files=("src/stack/AngleStack.cpp",),
        ),
    )

    trace = execution_trace.text
    assert "commit-search term(s)" in trace and "retained" in trace
    for private in (secret, "poststack", "SECRET_TERM_77310", "AngleStack", "fix poststack angle selection"):
        assert private not in trace


# --- workflow integration ----------------------------------------------------------------------


def test_a_jira_work_item_searches_its_key_and_a_described_bug_does_not(tmp_path):
    jira = workflow._git_history_query(tmp_path, "JR-12345", None, None, None, InvestigationOptions())
    local = workflow._git_history_query(tmp_path, "local_20260901094133", None, None, None, InvestigationOptions())

    assert jira.issue_id == "JR-12345"
    assert local.issue_id is None


def test_the_pipeline_hands_shared_guidance_to_git_history(tmp_path, monkeypatch):
    seen: list[GitHistoryQuery] = []
    monkeypatch.setattr(
        workflow, "collect_git_history", lambda root, key, query=None, settings=None: seen.append(query) or _nothing(key)
    )
    retrieval = RetrievalArtifact(
        related_files=tuple(
            RelatedFile(f"src/f{index}.cpp", False, 10 - index, "high", 1) for index in range(7)
        )
    )
    options = InvestigationOptions(keywords=["poststack", " "], focus_files=["src/stack/AngleStack.cpp"])
    keywords = {"high_value_keywords": ["poststack", "StackInputModel"], "normal_keywords": []}

    workflow.git_context_step(tmp_path, "JR-12345", retrieval=retrieval, keywords=keywords, options=options)

    (query,) = seen
    assert query.issue_id == "JR-12345"
    assert query.shared_keywords == ("poststack",)
    assert query.extracted_terms == ("StackInputModel",)
    assert query.focus_files == ("src/stack/AngleStack.cpp",)
    assert query.ranked_files == tuple(f"src/f{index}.cpp" for index in range(5))


def test_a_standalone_rebuild_replays_the_recorded_guidance(tmp_path, monkeypatch):
    seen: list[GitHistoryQuery] = []
    monkeypatch.setattr(
        workflow, "collect_git_history", lambda root, key, query=None, settings=None: seen.append(query) or _nothing(key)
    )
    retrieval = RetrievalArtifact(
        terms=(RetrievalTerm("poststack", "user", 8, 8, 3, "specific"),),
        related_files=(
            RelatedFile("src/stack/AngleStack.cpp", False, 40, "high", 2, reasons=("developer marked this file as a focus area",)),
            RelatedFile("src/Renderer.cpp", False, 10, "medium", 1),
        ),
    )

    workflow.git_context_step(tmp_path, "JR-12345", retrieval=retrieval)

    (query,) = seen
    assert query.shared_keywords == ("poststack",)
    assert query.focus_files == ("src/stack/AngleStack.cpp",)
    assert query.ranked_files == ("src/stack/AngleStack.cpp", "src/Renderer.cpp")


@needs_rg
def test_a_prepared_run_finds_a_commit_file_history_alone_would_miss(tmp_path):
    """The v2 claim, end to end: a keyword commit on a file Code Search never ranked."""
    root = _init(tmp_path / "e2e")
    _commit(
        root, "2025-01-01", "Fix poststack gather ordering",
        {"src/legacy/GatherOrder.cpp": "int order() { return 1; }\n"},
    )
    _commit(
        root, "2026-01-01", "Add WidgetController",
        {"src/WidgetController.cpp": "bool WidgetController::validate() { return true; }\n"},
    )
    spec = bug_spec_from_description("WidgetController rejects the VDS output type.", title="VDS rejected")
    request = InvestigationRequest(
        spec=spec, options=InvestigationOptions(keywords=["poststack", "WidgetController"])
    )

    workflow.run_investigation(root, request)

    context = (root / ".ai" / spec.work_item_id / "context.md").read_text(encoding="utf-8")
    history = context.split("## Git History", 1)[1]
    assert "Fix poststack gather ordering" in history
    assert "matched shared keyword: poststack" in history
    assert "Add WidgetController" in history


def _nothing(key):
    """An outcome for a stub collector: nothing searched, nothing to record."""
    from bugpilot.core.git_history import GitHistoryOutcome
    from bugpilot.core.retrieval import GitHistoryRecord

    return GitHistoryOutcome(key, GitHistoryRecord("unavailable"))
