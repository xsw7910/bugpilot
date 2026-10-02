"""Git History v2, Batch 4: changed-file feedback — supporting files from related commits.

The strongest retained commits are asked which files they changed; the ones
Code Search did not return become *supporting files* in Git history's own
section of ``retrieval.json``, never in ``related_files``. One pass: nothing
found here is searched again. Repositories are built in temp directories with
fixed dates; nothing reads the developer's own history.
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
    BULK_COMMIT_FILES,
    MAX_SUPPORTING_FILES,
    GitHistoryQuery,
    _current_file,
    collect_git_history,
    feedback_commits,
    find_related_commits,
    limits_for,
    render_git_context,
)
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import GitHistoryOptions, InvestigationOptions, InvestigationRequest
from bugpilot.core.retrieval import (
    GitHistoryRecord,
    git_history_from_dict,
    git_history_to_dict,
)

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git history needs git")
needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")
pytestmark = needs_git


def _git(root: Path, *args: str, date: str | None = None) -> str:
    env = dict(os.environ)
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"{date}T12:00:00+00:00"
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, env=env, encoding="utf-8"
    ).stdout.strip()


def _write(root: Path, name: str, text: str) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _commit(root: Path, date: str, message: str, files: dict[str, str] | None = None, *, delete=(), rename=None) -> str:
    for name, text in (files or {}).items():
        _write(root, name, text)
        _git(root, "add", name)
    for name in delete:
        _git(root, "rm", "-q", name)
    if rename:
        _git(root, "mv", *rename)
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
    """One history with every case the feedback must handle. Read-only."""
    root = _init(tmp_path_factory.mktemp("feedback") / "repo")
    base = {name: "v0\n" for name in (
        "src/A.cpp", "src/B.cpp", "src/C.cpp", "src/D.cpp", "src/E.cpp", "src/F.cpp", "src/Old.cpp",
        "src/Focus.cpp", "src/H.cpp", "src/W.cpp", "src/legacy/Gather.cpp", "src/legacy/Util.cpp",
        "docs/notes.md", "vendor/lib.cpp", "build/gen.cpp", "package-lock.json",
    )}
    hashes = {"init": _commit(root, "2024-12-01", "Initial import", base)}
    hashes["issue"] = _commit(root, "2025-01-10", "JR-12345: fix poststack ordering", {"src/A.cpp": "v1\n", "src/C.cpp": "v1\n"})
    hashes["keyword"] = _commit(root, "2025-02-01", "Tidy poststack volumes", {"src/A.cpp": "v2\n", "src/D.cpp": "v1\n"})
    hashes["mixed"] = _commit(
        root, "2025-03-01", "poststack cleanup",
        {"src/C.cpp": "v2\n", "src/E.cpp": "v1\n", "docs/notes.md": "v1\n", "vendor/lib.cpp": "v1\n",
         "build/gen.cpp": "v1\n", "package-lock.json": "v1\n"},
        delete=("src/Old.cpp",),
    )
    hashes["rename"] = _commit(root, "2025-04-01", "poststack rename", rename=("src/F.cpp", "src/G.cpp"))
    hashes["gone_added"] = _commit(root, "2025-04-15", "poststack helper", {"src/Gone.cpp": "v1\n"})
    hashes["gone_removed"] = _commit(root, "2025-04-20", "Remove the helper", delete=("src/Gone.cpp",))
    hashes["weak"] = _commit(root, "2025-06-01", "Speed up B", {"src/B.cpp": "v1\n", "src/W.cpp": "v1\n"})
    hashes["bulk"] = _commit(
        root, "2025-07-01", "poststack reformat",
        {**{f"src/bulk/f{i}.cpp": "x\n" for i in range(BULK_COMMIT_FILES + 1)}, "src/A.cpp": "v3\n"},
    )
    hashes["focus"] = _commit(root, "2025-08-01", "Adjust focus defaults", {"src/Focus.cpp": "v1\n", "src/H.cpp": "v1\n"})
    hashes["legacy"] = _commit(
        root, "2025-09-01", "Rename legacy options", {"src/legacy/Gather.cpp": "v1\n", "src/legacy/Util.cpp": "v1\n"}
    )
    return root, hashes


def _supporting(root: Path, query: GitHistoryQuery, settings: GitHistoryOptions | None = None):
    return collect_git_history(root, "JR-12345", query, settings).record.supporting_files


def _paths(items) -> list[str]:
    return [item.path for item in items]


def _by_path(items, path):
    return next(item for item in items if item.path == path)


# --- 1/2. the key case: a file only history knew about ------------------------------------


def test_a_file_changed_with_a_code_search_file_in_a_related_commit_surfaces(repo):
    root, hashes = repo
    found = _supporting(
        root, GitHistoryQuery(issue_id="JR-12345", ranked_files=("src/A.cpp", "src/B.cpp"), known_files=("src/A.cpp", "src/B.cpp"))
    )

    assert "src/C.cpp" in _paths(found)
    c = _by_path(found, "src/C.cpp")
    assert c.source == "git_history"
    assert c.commit_hashes[0] == hashes["issue"]
    assert "changed in a commit matching the issue ID" in c.reasons
    assert "changed with Code Search file `src/A.cpp`" in c.reasons
    # What Code Search already returned is never offered again.
    assert "src/A.cpp" not in _paths(found) and "src/B.cpp" not in _paths(found)


def test_every_code_search_file_counts_as_known_not_only_the_top_five(repo):
    root, _hashes = repo
    found = _supporting(
        root,
        GitHistoryQuery(issue_id="JR-12345", ranked_files=("src/A.cpp",), known_files=("src/A.cpp", "src/X.cpp", "src/C.cpp")),
    )
    assert "src/C.cpp" not in _paths(found)


# --- 3/11. explicit guidance: never duplicated, and a directory is never a file ------------------


def test_a_focus_file_is_not_offered_and_its_co_change_says_so(repo):
    root, _hashes = repo
    found = _supporting(root, GitHistoryQuery(focus_files=("src/Focus.cpp",)))

    assert "src/Focus.cpp" not in _paths(found)
    assert "changed with focus file `src/Focus.cpp`" in _by_path(found, "src/H.cpp").reasons


def test_directory_guidance_never_becomes_a_supporting_file(repo):
    root, _hashes = repo
    found = _supporting(root, GitHistoryQuery(git_files=("src/legacy",)))

    assert "src/legacy" not in _paths(found)
    # The files inside it are real paths git returned, and new evidence.
    assert {"src/legacy/Gather.cpp", "src/legacy/Util.cpp"} <= set(_paths(found))
    assert "changed with additional file `src/legacy`" in _by_path(found, "src/legacy/Gather.cpp").reasons


# --- 4/5/6. evidence adds up, and stronger commits count for more ---------------------------------


def test_the_same_file_in_two_commits_gathers_both(repo):
    root, hashes = repo
    once = _by_path(_supporting(root, GitHistoryQuery(issue_id="JR-12345", known_files=("src/A.cpp",))), "src/C.cpp")
    found = _supporting(root, GitHistoryQuery(issue_id="JR-12345", shared_keywords=("poststack",), known_files=("src/A.cpp",)))

    c = _by_path(found, "src/C.cpp")
    assert set(c.commit_hashes) == {hashes["issue"], hashes["mixed"]}
    assert c.commit_hashes[0] == hashes["issue"], "the stronger commit is named first"
    assert c.reasons[0] == "changed in 2 related commits"
    assert c.score > once.score


def test_a_file_from_a_stronger_commit_ranks_above_one_from_a_weaker(tmp_path):
    root = _init(tmp_path / "order")
    _commit(root, "2025-01-01", "Base", {"src/A.cpp": "0\n", "src/X.cpp": "0\n", "src/Y.cpp": "0\n"})
    _commit(root, "2025-02-01", "poststack older change", {"src/Y.cpp": "1\n"})
    _commit(root, "2025-03-01", "poststack newer change", {"src/X.cpp": "1\n"})

    found = _supporting(root, GitHistoryQuery(shared_keywords=("poststack",)))

    # Same evidence, so recency put the newer commit first — and its file leads.
    assert _paths(found) == ["src/X.cpp", "src/Y.cpp"]
    assert found[0].score - found[1].score == git_history.SUPPORT_RANK_POINTS[0] - git_history.SUPPORT_RANK_POINTS[1]


def test_a_bulk_commit_does_not_take_a_stronger_commits_place(tmp_path):
    root = _init(tmp_path / "bulky")
    _commit(root, "2025-01-01", "Base", {"src/X.cpp": "0\n"})
    _commit(root, "2025-02-01", "poststack fix", {"src/X.cpp": "1\n"})
    _commit(root, "2025-03-01", "poststack reformat", {f"src/many/f{i}.cpp": "x\n" for i in range(BULK_COMMIT_FILES + 1)})

    found = _supporting(root, GitHistoryQuery(shared_keywords=("poststack",)))

    # The newer bulk commit lent nothing, so the fix is the first commit that lent files.
    assert _paths(found) == ["src/X.cpp"]
    assert found[0].score == git_history.SUPPORT_RANK_POINTS[0]


def test_an_issue_id_commit_lends_more_than_a_keyword_commit(repo):
    root, _hashes = repo
    with_id = _by_path(_supporting(root, GitHistoryQuery(issue_id="JR-12345", known_files=("src/A.cpp",))), "src/C.cpp")
    keyword_only = _by_path(_supporting(root, GitHistoryQuery(shared_keywords=("fix poststack ordering",), known_files=("src/A.cpp",))), "src/C.cpp")

    assert with_id.score - keyword_only.score == git_history.SUPPORT_ISSUE_ID


# --- 7/8/10/12. what is never promoted -------------------------------------------------------------


def test_a_bulk_commit_lends_none_of_its_files(repo):
    root, _hashes = repo
    found = _supporting(root, GitHistoryQuery(shared_keywords=("poststack",), ranked_files=("src/A.cpp",), known_files=("src/A.cpp",)))

    assert not any(path.startswith("src/bulk/") for path in _paths(found))


def test_deleted_and_since_deleted_files_are_not_promoted(repo):
    root, _hashes = repo
    found = _supporting(root, GitHistoryQuery(shared_keywords=("poststack",), known_files=("src/A.cpp",)))

    assert "src/Old.cpp" not in _paths(found)  # deleted by the commit
    assert "src/Gone.cpp" not in _paths(found)  # added, then deleted later
    assert _current_file(root.resolve(), "src/Gone.cpp") is False


def test_a_rename_offers_the_new_path_only(repo):
    root, hashes = repo
    found = _supporting(root, GitHistoryQuery(shared_keywords=("poststack rename",)))

    assert _paths(found) == ["src/G.cpp"]
    assert found[0].change == "renamed"
    assert found[0].commit_hashes == (hashes["rename"],)


def test_files_code_search_would_never_read_are_not_promoted(repo):
    root, _hashes = repo
    found = _supporting(root, GitHistoryQuery(shared_keywords=("poststack cleanup",)))

    paths = _paths(found)
    assert {"src/C.cpp", "src/E.cpp"} <= set(paths)
    assert "package-lock.json" not in paths  # not a file kind Code Search reads
    assert "build/gen.cpp" not in paths  # a directory Code Search excludes
    # From one commit, a vendor path and a document fall below the bar.
    assert "vendor/lib.cpp" not in paths and "docs/notes.md" not in paths


def test_noise_and_prose_are_marked_down_and_say_so():
    vendor = git_history._Support("vendor/lib.cpp", "modified", score=20, hashes=["a" * 40]).finish()
    prose = git_history._Support("src/notes.md", "modified", score=20, hashes=["a" * 40]).finish()

    assert vendor.score == 20 + git_history.SUPPORT_NOISE_PATH
    assert "path looks like CI/build/docs/vendor/generated content" in vendor.reasons
    assert prose.score == 20 + git_history.SUPPORT_DOCUMENTATION
    assert "documentation, not implementation" in prose.reasons


def test_a_commit_kept_only_for_touching_a_code_search_file_lends_nothing(repo):
    root, hashes = repo
    result = find_related_commits(root, GitHistoryQuery(ranked_files=("src/B.cpp",)))

    assert hashes["weak"] in [c.hash for c in result.commits]
    assert feedback_commits(result.commits) == []
    assert "src/W.cpp" not in _paths(_supporting(root, GitHistoryQuery(ranked_files=("src/B.cpp",))))


# --- 9. path safety -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    ["../outside.cpp", "/etc/passwd.cpp", "C:/x.cpp", '"src/quoted.cpp"', "src/\tTab.cpp", ":(glob)*.cpp", "src", "src/Nope.cpp"],
)
def test_unsafe_missing_or_non_file_paths_are_refused(repo, path):
    root, _hashes = repo
    assert _current_file(root.resolve(), path) is False


def test_a_symlink_out_of_the_repository_is_refused(tmp_path):
    root = _init(tmp_path / "linked")
    outside = tmp_path / "outside.cpp"
    outside.write_text("secret\n", encoding="utf-8")
    try:
        (root / "src").mkdir()
        (root / "src" / "link.cpp").symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available here")
    assert _current_file(root.resolve(), "src/link.cpp") is False


# --- 13/14. bounded, and one pass ---------------------------------------------------------------------------


def test_the_list_is_bounded(tmp_path):
    root = _init(tmp_path / "wide")
    _commit(root, "2025-01-01", "poststack wide change", {f"src/m{i:02d}.cpp": "x\n" for i in range(12)})

    found = _supporting(root, GitHistoryQuery(shared_keywords=("poststack",)))

    assert len(found) == MAX_SUPPORTING_FILES
    # Equal evidence: the order is the path's, so it never varies.
    assert _paths(found) == [f"src/m{i:02d}.cpp" for i in range(MAX_SUPPORTING_FILES)]


def test_no_supporting_file_is_ever_searched(repo, monkeypatch):
    root, _hashes = repo
    query = GitHistoryQuery(issue_id="JR-12345", shared_keywords=("poststack",), ranked_files=("src/A.cpp",), known_files=("src/A.cpp",))
    searched: list[list[str]] = []
    real = git_history.run_command

    def spy(args, cwd, timeout=None):
        searched.append(list(args))
        return real(args, cwd, timeout=timeout)

    monkeypatch.setattr(git_history, "run_command", spy)
    found = _supporting(root, query)

    walked = " ".join(arg for command in searched for arg in command)
    assert found
    for item in found:
        assert item.path not in walked, f"{item.path} was searched after it was found"


def test_file_history_off_means_no_feedback(repo):
    root, _hashes = repo
    found = _supporting(
        root, GitHistoryQuery(issue_id="JR-12345", known_files=("src/A.cpp",)), GitHistoryOptions(search_file_history=False)
    )
    assert found == ()


def test_the_ranking_of_commits_is_untouched(repo):
    root, _hashes = repo
    query = GitHistoryQuery(issue_id="JR-12345", shared_keywords=("poststack",), ranked_files=("src/A.cpp",), known_files=("src/A.cpp",))
    ranked = find_related_commits(root, query, limits_for(GitHistoryOptions()))
    record = collect_git_history(root, "JR-12345", query).record

    assert [(c.hash, c.score, tuple(c.reasons)) for c in record.commits] == [
        (c.hash, c.score, tuple(c.reasons)) for c in ranked.commits
    ]


# --- artifact and context -------------------------------------------------------------------------------------


def test_the_section_round_trips_its_supporting_files_and_stays_version_1(repo):
    root, _hashes = repo
    record = collect_git_history(root, "JR-12345", GitHistoryQuery(issue_id="JR-12345", known_files=("src/A.cpp",))).record
    data = git_history_to_dict(record)

    assert data["schema_version"] == 1
    assert data["supporting_files"] and all(item["source"] == "git_history" for item in data["supporting_files"])
    assert set(data["supporting_files"][0]) == {"path", "source", "score", "change", "commit_hashes", "reasons"}
    assert git_history_to_dict(git_history_from_dict(data)) == data
    assert "@@" not in json.dumps(data) and "diff --git" not in json.dumps(data)


def test_a_batch_3_section_without_the_list_reads_as_none():
    data = git_history_to_dict(GitHistoryRecord("completed"))
    data.pop("supporting_files")
    assert git_history_from_dict(data).supporting_files == ()


def test_a_supporting_file_with_another_source_is_not_read():
    data = git_history_to_dict(GitHistoryRecord("completed"))
    data["supporting_files"] = [
        {"path": "src/a.cpp", "source": "code_search", "score": 9, "change": "modified", "commit_hashes": [], "reasons": []},
        {"path": "src/b.cpp", "source": "git_history", "score": 9, "change": "exploded", "commit_hashes": [], "reasons": []},
        {"path": "src/c.cpp", "source": "git_history", "score": 9, "change": "added", "commit_hashes": ["c" * 40], "reasons": ["x"]},
    ]
    assert [item.path for item in git_history_from_dict(data).supporting_files] == ["src/c.cpp"]


def test_the_supporting_files_are_deterministic(repo):
    root, _hashes = repo
    query = GitHistoryQuery(issue_id="JR-12345", shared_keywords=("poststack",), known_files=("src/A.cpp",))
    first = git_history_to_dict(collect_git_history(root, "JR-12345", query).record)["supporting_files"]
    second = git_history_to_dict(collect_git_history(root, "JR-12345", query).record)["supporting_files"]
    assert json.dumps(first) == json.dumps(second)


def test_the_context_says_where_supporting_files_came_from(repo):
    root, hashes = repo
    outcome = collect_git_history(root, "JR-12345", GitHistoryQuery(issue_id="JR-12345", known_files=("src/A.cpp",)))
    text = render_git_context(outcome)

    assert "## Supporting Files From Related Commits" in text
    assert "Git history evidence, not search matches" in text
    assert f"- `src/C.cpp` (modified)\n  Why: changed in 1 related commit; changed in a commit matching the issue ID" in text
    assert f"commits {hashes['issue'][:10]}" in text
    # Each file once, and nothing the record does not hold.
    listed = re.findall(r"^- `([^`]+)` \(", text.split("## Supporting Files From Related Commits", 1)[1], flags=re.M)
    assert listed == [item.path for item in outcome.record.supporting_files]


def test_no_supporting_files_no_section(tmp_path):
    root = _init(tmp_path / "plain")
    _commit(root, "2025-01-01", "JR-12345 fix", {"src/A.cpp": "x\n"})
    text = render_git_context(collect_git_history(root, "JR-12345", GitHistoryQuery(issue_id="JR-12345", known_files=("src/A.cpp",))))
    assert "Supporting Files" not in text


def test_the_trace_counts_and_never_names(repo, execution_trace):
    root, _hashes = repo
    collect_git_history(root, "JR-12345", GitHistoryQuery(issue_id="JR-12345", known_files=("src/A.cpp",)))

    trace = execution_trace.text
    assert re.search(r"git_context feedback: \d+ commit\(s\) inspected, \d+ changed file\(s\) read, \d+ supporting file\(s\) retained", trace)
    for private in ("src/C.cpp", "C.cpp", "fix poststack ordering", "poststack"):
        assert private not in trace


# --- 15 and the acceptance case, end to end ----------------------------------------------------------------------


def _acceptance_repo(tmp_path: Path) -> Path:
    """Code Search can find A and B (they name poststack); C names nothing, and only history links it."""
    root = _init(tmp_path / "accept")
    _commit(root, "2025-01-01", "Add the stack sources", {
        "src/A.cpp": "void selectPoststack() {}\n",
        "src/B.cpp": "int poststackCount() { return 0; }\n",
        "src/C.cpp": "int sortSteps() { return 1; }\n",
    })
    _commit(root, "2025-05-01", "Fix poststack ordering", {
        "src/A.cpp": "void selectPoststack() { sortSteps(); }\n",
        "src/C.cpp": "int sortSteps() { return 2; }\n",
    })
    return root


@needs_rg
def test_acceptance_history_surfaces_the_file_code_search_could_not(tmp_path, monkeypatch):
    searches: list[int] = []
    real_search = workflow.run_code_search

    def counted(*args, **kwargs):
        searches.append(1)
        return real_search(*args, **kwargs)

    monkeypatch.setattr(workflow, "run_code_search", counted)
    writes: list[str] = []
    real_write = retrieval_module.atomic_write_text
    monkeypatch.setattr(retrieval_module, "atomic_write_text", lambda path, text: (writes.append(text), real_write(path, text))[1])

    root = _acceptance_repo(tmp_path)
    spec = bug_spec_from_description("Poststack selection loses the last angle.", title="Angle lost")
    workflow.run_investigation(root, InvestigationRequest(spec=spec, options=InvestigationOptions(keywords=["poststack"])))
    target = root / ".ai" / spec.work_item_id
    data = json.loads((target / "retrieval.json").read_text(encoding="utf-8"))

    related = [item["file"] for item in data["related_files"]]
    assert {"src/A.cpp", "src/B.cpp"} <= set(related) and "src/C.cpp" not in related
    supporting = data["git_history"]["supporting_files"]
    assert [item["path"] for item in supporting] == ["src/C.cpp"]
    assert supporting[0]["source"] == "git_history"
    assert "changed with Code Search file `src/A.cpp`" in supporting[0]["reasons"]
    # Code Search ran once, and its part of the file is exactly what it wrote.
    assert searches == [1]
    first, second = json.loads(writes[0]), json.loads(writes[1])
    second.pop("git_history")
    assert second == first
    # The agent reads it, labelled for what it is, and not among Relevant Files.
    context = (target / "context.md").read_text(encoding="utf-8")
    assert "#### Supporting Files From Related Commits" in context or "### Supporting Files From Related Commits" in context
    assert "- `src/C.cpp` (modified)" in context
    relevant = context.split("### Relevant Files", 1)[1].split("### Relevant Snippets", 1)[0]
    assert "src/C.cpp" not in relevant
    # Still five artifacts.
    assert {p.name for p in target.iterdir()} == {"issue.json", "retrieval.json", "context.md", "task.md", "run.json"}
    # task.md carries no second copy of the list.
    assert "src/C.cpp" not in (target / "task.md").read_text(encoding="utf-8")
