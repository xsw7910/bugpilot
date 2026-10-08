"""Git History: the corpus, and the two rules it changed.

The corpus (``git_history_corpus.py``) is one synthetic history and nineteen
queries against it; the floors below are what the current ranking measures,
so a change that loses any of it fails here. The two rules the corpus changed
— merge wrappers and broad terms — each have small histories of their own as
well, which the earlier ranking got wrong in the way each test names. Every
history is written with ``git fast-import`` at fixed dates: nothing depends on
the clock or on how fast git answers.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest

import git_history_corpus as corpus
from bugpilot.core import git_history as gh
from bugpilot.core.git_history import GitHistoryQuery, collect_git_history, find_related_commits
from bugpilot.core.models import GitHistoryOptions
from bugpilot.core.retrieval import git_history_from_dict, git_history_to_dict
from git_history_corpus import History, build_repository

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git history needs git")


def _labels(hashes: dict[str, str], commits) -> list[str]:
    names = {commit: label for label, commit in hashes.items()}
    return [names.get(commit.hash, commit.hash[:10]) for commit in commits]


def _record(root: Path, query: GitHistoryQuery, settings: GitHistoryOptions | None = None):
    return collect_git_history(root, "JR-12345", query, settings).record


# --- merge wrappers ----------------------------------------------------------------------------


def _merge_history() -> History:
    h = History()
    h.commit("init", "Initial import", {path: "v0\n" for path in ("src/Angle.cpp", "src/Render.cpp", "src/Other.cpp")})
    # A feature branch merged with --no-ff; the merge says nothing its commits do not.
    h.branch("feature/JR-12345")
    h.commit("feature-a", "JR-12345: clamp the angle range",
             {"src/Angle.cpp": "v1\n", "src/Range.cpp": "v1\n"}, branch="feature/JR-12345")
    h.commit("feature-b", "JR-12345: range tests", {"tests/RangeTest.cpp": "v1\n"}, branch="feature/JR-12345")
    h.commit("master-tidy", "Unrelated tidy", {"src/Other.cpp": "v1\n"})
    h.merge("wrapper", "Merge branch 'feature/JR-12345'", "feature/JR-12345")
    # A merge that resolved a conflict: it has changes of its own.
    h.branch("feature/JR-23456")
    h.commit("conflict-feature", "JR-23456: shader variants",
             {"src/Render.cpp": "branch\n", "src/Variant.cpp": "v1\n"}, branch="feature/JR-23456")
    h.commit("conflict-master", "Frame pacing", {"src/Render.cpp": "master\n"})
    h.merge("resolution", "Merge branch 'feature/JR-23456'", "feature/JR-23456",
            extra={"src/Render.cpp": "resolved\n", "src/Glue.cpp": "v1\n"})
    # A merge whose message names what its commit does not.
    h.branch("feature/JR-34567")
    h.commit("plain-feature", "JR-34567: tidy the pass",
             {"src/Blend.cpp": "v1\n", "src/Plan.cpp": "v1\n"}, branch="feature/JR-34567")
    h.merge("own-evidence", "Merge JR-34567: the blendmerge pass", "feature/JR-34567")
    # A merge whose branch commit found nothing on its own.
    h.branch("feature/JR-45678")
    h.commit("silent-feature", "wip", {"src/Silent.cpp": "v1\n", "src/Quiet.cpp": "v1\n"}, branch="feature/JR-45678")
    h.merge("only-carrier", "Merge branch 'feature/JR-45678'", "feature/JR-45678")
    return h


@pytest.fixture(scope="module")
def merges(tmp_path_factory):
    root = tmp_path_factory.mktemp("merges") / "repo"
    return root, build_repository(root, _merge_history())


def test_a_merge_that_only_repeats_its_branch_is_not_listed(merges):
    # The earlier ranking listed the wrapper as well, first (newest), taking a slot for a
    # change its two commits already stand for.
    root, hashes = merges
    record = _record(root, GitHistoryQuery(issue_id="JR-12345"))
    assert _labels(hashes, record.commits) == ["feature-b", "feature-a"]


def test_a_supporting_file_counts_one_change_once(merges):
    # The earlier ranking read the wrapper's files too (everything the branch brought), so
    # each file of the change was "changed in 2 related commits".
    root, hashes = merges
    query = GitHistoryQuery(issue_id="JR-12345", ranked_files=("src/Angle.cpp",), known_files=("src/Angle.cpp",))
    supporting = {item.path: item for item in _record(root, query).supporting_files}
    assert set(supporting) == {"src/Range.cpp", "tests/RangeTest.cpp"}
    assert supporting["src/Range.cpp"].commit_hashes == (hashes["feature-a"],)
    assert supporting["tests/RangeTest.cpp"].commit_hashes == (hashes["feature-b"],)
    assert all(item.reasons[0] == "changed in 1 related commit" for item in supporting.values())


def test_a_merge_that_resolved_a_conflict_stays_and_lends_only_its_own_files(merges):
    # The resolution is a change nobody else made: the merge stays. The earlier
    # ranking had it lend its branch's file a second time.
    root, hashes = merges
    record = _record(root, GitHistoryQuery(issue_id="JR-23456"))
    assert set(_labels(hashes, record.commits)) == {"conflict-feature", "resolution"}
    supporting = {item.path: item.commit_hashes for item in record.supporting_files}
    assert supporting["src/Variant.cpp"] == (hashes["conflict-feature"],)
    assert supporting["src/Glue.cpp"] == (hashes["resolution"],)
    # Changed on both sides: lent once, by the commit that made the change.
    assert supporting["src/Render.cpp"] == (hashes["conflict-feature"],)


def test_a_merge_with_evidence_of_its_own_stays_without_lending_twice(merges):
    root, hashes = merges
    record = _record(root, GitHistoryQuery(issue_id="JR-34567", git_keywords=("blendmerge",)))
    assert _labels(hashes, record.commits) == ["own-evidence", "plain-feature"]
    assert "matched commit keyword: blendmerge" in record.commits[0].reasons
    supporting = {item.path: item.commit_hashes for item in record.supporting_files}
    assert supporting == {"src/Plan.cpp": (hashes["plain-feature"],), "src/Blend.cpp": (hashes["plain-feature"],)}


def test_a_merge_that_alone_carries_the_evidence_stays(merges):
    # Not every merge is dropped: here the branch commit says nothing, so the
    # merge is the only way to the change, and it lends the change's files.
    root, hashes = merges
    record = _record(root, GitHistoryQuery(issue_id="JR-45678"))
    assert _labels(hashes, record.commits) == ["only-carrier"]
    assert {item.path for item in record.supporting_files} == {"src/Silent.cpp", "src/Quiet.cpp"}


def _recording(monkeypatch, fail_on: str | None = None) -> list[list[str]]:
    seen: list[list[str]] = []
    real = gh.run_command

    def run(args, cwd, timeout=None):
        seen.append(list(args))
        if fail_on is not None and fail_on in args:
            return 128, "fatal"
        return real(args, cwd, timeout=timeout)

    monkeypatch.setattr(gh, "run_command", run)
    return seen


def _merge_checks(seen: list[list[str]]) -> tuple[list[list[str]], list[list[str]]]:
    return [args for args in seen if "--cc" in args], [args for args in seen if args[1] == "rev-list"]


def test_the_merge_check_costs_nothing_without_a_merge_and_one_command_for_a_wrapper(merges, monkeypatch):
    # Every git process costs ~0.1 s on a large repository whatever it does.
    root, _hashes = merges
    seen = _recording(monkeypatch)
    find_related_commits(root, GitHistoryQuery(shared_keywords=("pacing",)))
    assert _merge_checks(seen) == ([], [])

    # The usual wrapper: clean, and its branch tip is a related commit with all
    # its evidence — one command decides it, no rev-list.
    seen.clear()
    find_related_commits(root, GitHistoryQuery(issue_id="JR-12345"))
    clean_checks, rev_lists = _merge_checks(seen)
    assert len(clean_checks) == 1 and rev_lists == []


def test_a_merge_its_branch_tip_does_not_decide_asks_once_and_bounded(merges, monkeypatch):
    root, _hashes = merges
    seen = _recording(monkeypatch)
    find_related_commits(root, GitHistoryQuery(issue_id="JR-34567", git_keywords=("blendmerge",)))
    clean_checks, rev_lists = _merge_checks(seen)
    assert len(clean_checks) == 1 and len(rev_lists) == 1
    assert f"--max-count={gh.MAX_MERGE_MEMBERS}" in rev_lists[0]
    # Every argument is a hash or an option: nothing from the query reaches these.
    arguments = rev_lists[0][2:] + clean_checks[0][2:]
    assert all(re.fullmatch(r"\^?[0-9a-f]{40}|--[a-z=-]+(=\d+)?|--format=\x1e%H", arg) for arg in arguments), arguments


@pytest.mark.parametrize(("query", "fail_on", "merge"), [
    (GitHistoryQuery(issue_id="JR-12345"), "--cc", "wrapper"),
    (GitHistoryQuery(issue_id="JR-34567", git_keywords=("blendmerge",)), "rev-list", "own-evidence"),
])
def test_a_merge_check_that_fails_leaves_the_merge_listed(merges, monkeypatch, query, fail_on, merge):
    root, hashes = merges
    _recording(monkeypatch, fail_on=fail_on)
    result = find_related_commits(root, query)
    assert merge in _labels(hashes, result.commits)
    assert result.failures == ("git_error",)


# --- broad terms ---------------------------------------------------------------------------------


def _template_history(store_commits: int) -> History:
    """``store_commits`` routine commits naming "template", and the two that matter."""
    h = History()
    h.commit("init", "Initial import", {"src/ui/Store.cpp": "v0\n"})
    for i in range(store_commits):
        h.commit(f"store-{i}", "Update template defaults", {"src/ui/Store.cpp": f"v{i + 1}\n"}, days=1)
    h.commit("target", "JR-12345: reject duplicate template names",
             {"src/ui/Dialog.cpp": "v1\n", "src/ui/Names.cpp": "v1\n"}, days=1)
    h.commit("dialog-fix", "Fix a crash on an empty list", {"src/ui/Dialog.cpp": "v2\n"}, days=1)
    return h


@pytest.fixture(scope="module")
def templates(tmp_path_factory):
    """The term in 25 commits — beyond ``BROAD_TERM_COMMITS``."""
    root = tmp_path_factory.mktemp("broad") / "repo"
    return root, build_repository(root, _template_history(24))


_DIALOG = GitHistoryQuery(shared_keywords=("template",), ranked_files=("src/ui/Dialog.cpp",),
                          known_files=("src/ui/Dialog.cpp",))


def test_a_broad_keyword_no_longer_fills_the_list_on_its_own(templates):
    # Previously, 24 routine commits at 30 points each pushed the dialog's own
    # history (20 points) out of a ten-commit list.
    root, hashes = templates
    record = _record(root, _DIALOG)
    assert _labels(hashes, record.commits) == ["target", "dialog-fix"]
    assert record.candidate_count == 2


def test_a_broad_keyword_still_counts_a_little_and_says_why(templates):
    root, hashes = templates
    target = _record(root, _DIALOG).commits[0]
    assert "matched broad term: template (in 25 related commits)" in target.reasons
    assert not any(reason.startswith("matched shared keyword") for reason in target.reasons)
    fix = _record(root, _DIALOG).commits[1]
    # The same file, the same recency: the broad match is the whole difference.
    assert target.score - fix.score == gh.SCORE_BROAD_TERM
    # Recorded as what it is: a shared keyword, marked broad — the panel says
    # "broad term" rather than claim the evidence the ranking discounted.
    assert [(term.value, term.source, term.broad) for term in target.matched_terms] == [("template", "shared_keyword", True)]
    assert git_history_to_dict(_record(root, _DIALOG))["commits"][0]["matched_terms"] == [
        {"value": "template", "source": "shared_keyword", "broad": True}
    ]


def test_a_commit_with_a_broad_keyword_still_lends_its_files(templates):
    root, _hashes = templates
    assert [item.path for item in _record(root, _DIALOG).supporting_files] == ["src/ui/Names.cpp"]


def test_a_broad_extracted_term_is_handled_the_same_way(templates):
    root, hashes = templates
    query = GitHistoryQuery(extracted_terms=("template",), ranked_files=("src/ui/Dialog.cpp",))
    assert _labels(hashes, _record(root, query).commits) == ["target", "dialog-fix"]


def test_a_commit_keyword_and_the_issue_id_are_never_broad(templates):
    # Typed for this search, or naming one piece of work: full credit however
    # many commits they match.
    root, _hashes = templates
    record = _record(root, GitHistoryQuery(git_keywords=("template",)))
    assert len(record.commits) == 10
    assert all("matched commit keyword: template" in commit.reasons for commit in record.commits)


def test_a_keyword_at_the_threshold_is_not_broad(tmp_path):
    root = tmp_path / "repo"
    hashes = build_repository(root, _template_history(gh.BROAD_TERM_COMMITS - 1))
    record = _record(root, _DIALOG)
    assert record.commits[0].hash == hashes["target"]
    assert "matched shared keyword: template" in record.commits[0].reasons
    assert len(record.commits) == 10


def test_only_a_broad_term_carries_the_broad_mark_and_it_survives_a_round_trip(templates):
    root, _hashes = templates
    record = _record(root, GitHistoryQuery(issue_id="JR-12345", shared_keywords=("template",)))
    written = git_history_to_dict(record)
    terms = written["commits"][0]["matched_terms"]
    assert terms == [{"value": "JR-12345", "source": "issue_id"}, {"value": "template", "source": "shared_keyword", "broad": True}]
    assert git_history_from_dict(written) == record


# --- review fixes ----------------------------------------------------------------------


def test_a_short_list_is_the_start_of_the_default_one_even_past_bulk_commits(tmp_path):
    # Three reformats touching the Focus File rank first. With the bulk check
    # reading twice the cap, a one-commit list checked two of them and the third
    # rose to the top with its file credit intact.
    h = History()
    h.commit("init", "Initial import", {"src/Focus.cpp": "v0\n"})
    h.commit("fix", "Handle an empty selection", {"src/Focus.cpp": "v1\n"}, days=1)
    for i in range(3):
        bulk = {f"gen/f{j}.cpp": f"{i}\n" for j in range(gh.BULK_COMMIT_FILES + 1)}
        h.commit(f"bulk-{i}", "Reformat everything", {"src/Focus.cpp": f"b{i}\n", **bulk}, days=1)
    root = tmp_path / "repo"
    hashes = build_repository(root, h)
    query = GitHistoryQuery(focus_files=("src/Focus.cpp",))
    full = _labels(hashes, _record(root, query).commits)
    assert full == ["fix", "init"]
    for cap in (1, 2):
        assert _labels(hashes, _record(root, query, GitHistoryOptions(max_related_commits=cap)).commits) == full[:cap]


def test_a_short_issue_key_is_found_past_the_newer_keys_it_begins(tmp_path, monkeypatch):
    # A fixed-string search for JR-12 also returns JR-120 … JR-129: twenty of
    # those, newer than the fix, used up the issue walk before the boundary
    # check saw the fix.
    h = History()
    h.commit("fix", "JR-12: clamp the angle range", {"src/Angle.cpp": "v1\n"})
    for i in range(25):
        h.commit(f"later-{i}", f"JR-12{i % 10}: unrelated work", {"src/Other.cpp": f"v{i}\n"}, days=1)
    root = tmp_path / "repo"
    hashes = build_repository(root, h)
    seen = _recording(monkeypatch)
    assert _labels(hashes, _record(root, GitHistoryQuery(issue_id="JR-12")).commits) == ["fix"]
    issue_walks = [args for args in seen if any(arg.startswith("--grep=JR-12") for arg in args)]
    # The fast fixed-string walk, then — full of near misses — the whole-key one.
    assert ["--fixed-strings" in args for args in issue_walks] == [True, False]


def test_an_ordinary_issue_key_costs_one_walk(merges, monkeypatch):
    root, _hashes = merges
    seen = _recording(monkeypatch)
    find_related_commits(root, GitHistoryQuery(issue_id="JR-12345"))
    assert len([args for args in seen if "--grep=JR-12345" in args]) == 1


def test_the_whole_key_walk_is_a_regex_only_for_a_key_of_the_usual_shape():
    walk = gh._whole_key_walk("JR-12", 20).args
    assert "--extended-regexp" in walk and "--grep=JR-12([^0-9]|$)" in walk
    assert "--fixed-strings" not in walk
    assert gh._whole_key_walk("JR 12 (draft)", 20) is None


def test_file_names_are_resolved_only_as_far_as_the_cap_and_never_without_limit(merges, monkeypatch):
    root, _hashes = merges
    names = ("Angle.cpp", "Range.cpp", "Render.cpp", "Other.cpp", "Variant.cpp", "Glue.cpp", "Blend.cpp", "Plan.cpp")
    seen = _recording(monkeypatch)
    found = gh.file_candidates(root, GitHistoryQuery(focus_files=names))
    assert [candidate.path for candidate in found] == [f"src/{name}" for name in names[: gh.MAX_FOCUS_HISTORY_FILES]]
    assert len([args for args in seen if args[1] == "ls-files"]) == gh.MAX_FOCUS_HISTORY_FILES

    seen.clear()
    assert gh.file_candidates(root, GitHistoryQuery(focus_files=tuple(f"Missing{i}.cpp" for i in range(60)))) == []
    assert len([args for args in seen if args[1] == "ls-files"]) == gh.MAX_NAME_LOOKUPS


def test_a_merge_that_brought_in_a_bulk_change_is_bulk(tmp_path):
    # Plain diff-tree lists nothing for a merge, so a merge that file history
    # found kept its Focus File credit however much it brought in; it is now
    # measured against its first parent, as the feedback already read it.
    h = History()
    h.commit("init", "Initial import", {"src/Focus.cpp": "v0\n"})
    h.branch("feature/vendor")
    vendored = {f"gen/f{j}.cpp": "x\n" for j in range(gh.BULK_COMMIT_FILES + 1)}
    h.commit("vendor", "Vendor the generator", {"src/Focus.cpp": "branch\n", **vendored}, branch="feature/vendor")
    h.commit("master-edit", "Tune the focus defaults", {"src/Focus.cpp": "master\n"})
    h.merge("merge", "Merge branch 'feature/vendor'", "feature/vendor", extra={"src/Focus.cpp": "resolved\n"})
    root = tmp_path / "repo"
    hashes = build_repository(root, h)
    assert _labels(hashes, _record(root, GitHistoryQuery(focus_files=("src/Focus.cpp",))).commits) == ["master-edit", "init"]


# --- weight order --------------------------------------------------------------------------------


def test_one_signal_each_ranks_in_the_plans_order():
    # Plan §10, checked on the corpus and not retuned (no corpus case moved when
    # any of these weights did): the issue ID; then the strong signals — a
    # commit keyword, an Additional File, a Focus File; a shared Keyword; a
    # Code Search file; an extracted term; and recency, which never outweighs
    # the weakest of them.
    def scored(name: str, **evidence) -> gh.CommitCandidate:
        return gh.CommitCandidate(name.ljust(40, "0"), name, 1_700_000_000, **evidence)

    ranked = gh._ranked([
        scored("e1", extracted_terms=["term"]),
        scored("c1", ranked_files=[(1, "src/A.cpp")]),
        scored("b1", shared_keywords=["keyword"]),
        scored("a3", focus_files=["src/F.cpp"]),
        scored("a2", git_files=["src/G.cpp"]),
        scored("a1", git_keywords=["commit"]),
        scored("f0", issue_id="JR-12345"),
    ])
    score = {candidate.subject: candidate.score - max(bonus for _days, bonus in gh.RECENCY_BONUS) for candidate in ranked}
    assert score["f0"] > score["a1"] == score["a2"] == score["a3"] > score["b1"] > score["c1"] > score["e1"]
    assert max(bonus for _days, bonus in gh.RECENCY_BONUS) < min(score.values())


# --- the corpus ---------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("corpus") / "repo"
    return root, build_repository(root)


@pytest.fixture(scope="module")
def results(built):
    root, hashes = built
    return {result.case.name: result for result in corpus.run_corpus(root, hashes)}


def test_the_corpus_covers_every_scenario():
    kinds = {case.kind for case in corpus.CASES}
    assert kinds >= {
        "issue_id", "shared_keyword", "additional_commit_keyword", "focus_file", "additional_file",
        "generic_keyword", "old_relevant", "recent_weak", "regression", "co_change", "merge", "bulk",
        "rename", "documentation", "manual", "multiple_commits", "noisy_term", "no_match",
    }


def test_the_corpus_stays_at_least_as_good_as_measured(results):
    # The earlier ranking on the same corpus: recall 0.889, top-5 precision 0.482,
    # 31 noise commits, 1 duplicate merge, supporting precision 0.886 (4 noise
    # files).
    summary = corpus.summarise(list(results.values()))
    assert summary["commit_recall"] >= 0.917
    assert summary["top5_precision"] >= 0.542
    assert summary["noise_commits"] <= 22
    assert summary["duplicate_merges"] == 0
    assert summary["supporting_recall"] >= 0.933
    assert summary["supporting_precision"] >= 0.921
    assert summary["supporting_noise"] <= 2


def test_every_case_with_an_answer_ranks_a_right_one_first(results):
    # deep-history is the History Depth case: Recent cannot reach it (below).
    for name, result in results.items():
        if result.case.expected_commits and name != "deep-history":
            assert result.first_correct == 1, name


def test_the_generic_keyword_case_keeps_only_the_relevant_commits(results):
    result = results["generic-keyword"]
    assert result.retained == ["s6-target", "s6-dialog-fix"]
    assert result.supporting == ["src/ui/TemplateNames.cpp"]


def test_no_merge_wrapper_is_listed_and_the_conflict_merge_is(results):
    assert results["issue-id"].retained == ["s1-feature-a", "s1-feature-b"]
    assert "s11-merge" in results["conflict-merge"].retained
    assert "src/render/ShaderVariant.cpp" in results["conflict-merge"].supporting


def test_nothing_is_listed_when_nothing_matches(results):
    assert results["no-match"].retained == [] and results["no-match"].supporting == []


def test_broader_history_reaches_the_deep_commit(built, results):
    # Why Broader exists: thirteen commits down in both histories.
    root, hashes = built
    assert "s19-deep" not in results["deep-history"].retained
    case = next(case for case in corpus.CASES if case.name == "deep-history")
    broader = corpus.run_case(case, root, hashes, GitHistoryOptions(history_depth="broader"))
    assert broader.first_correct == 1


@pytest.mark.parametrize("name", ["issue-id", "generic-keyword", "conflict-merge", "noisy-term"])
def test_max_related_commits_only_shortens_the_list(built, name):
    # The ranking never reads the cap and the checks never read less than the
    # default list needs: five is the first five of twenty-five.
    root, hashes = built
    case = next(case for case in corpus.CASES if case.name == name)
    short = corpus.run_case(case, root, hashes, GitHistoryOptions(max_related_commits=5))
    long = corpus.run_case(case, root, hashes, GitHistoryOptions(max_related_commits=25))
    assert short.retained == long.retained[:5]


def _explained(reasons: tuple[str, ...]) -> int:
    """The score the reasons account for — every weight that applied names itself."""
    score, files = 0, 0
    for reason in reasons:
        label, _sep, values = reason.partition(": ")
        count = len(values.split(", ")) if values else 0
        if label == "exact issue ID match":
            score += gh.SCORE_ISSUE_ID
        elif label.startswith("matched commit keyword"):
            score += gh.SCORE_GIT_KEYWORD + gh.SCORE_EXTRA_GIT_KEYWORD * (count - 1)
        elif label.startswith("matched shared keyword"):
            score += gh.SCORE_SHARED_KEYWORD + gh.SCORE_EXTRA_SHARED_KEYWORD * (count - 1)
        elif label.startswith("matched issue term"):
            score += gh.SCORE_EXTRACTED_TERM * min(count, gh.MAX_SCORED_EXTRACTED_TERMS)
        elif reason == "matched several search terms":
            score += gh.SCORE_MULTIPLE_TERMS
        elif label.startswith("matched broad term"):
            score += gh.SCORE_BROAD_TERM
        elif label.startswith("modified focus file"):
            score, files = score + gh.SCORE_FOCUS_FILE, files + count
        elif label.startswith("modified additional file"):
            score, files = score + gh.SCORE_ADDITIONAL_FILE, files + count
        elif label.startswith("modified Code Search file"):
            best = int(values.split()[0].lstrip("#"))
            score += max(gh.SCORE_RANKED_FILE_MIN, gh.SCORE_RANKED_FILE_TOP - gh.SCORE_RANKED_FILE_STEP * (best - 1))
            files += count
        elif reason == "modified several relevant files":
            pass  # counted below, once every file reason is in
        elif label.startswith("bulk change"):
            pass  # says why the file reasons are missing; worth nothing
        elif label == "recent":
            days = int(re.search(r"within (\d+) days", reason).group(1))
            score += dict(gh.RECENCY_BONUS)[days]
        else:
            raise AssertionError(f"a reason nothing scores: {reason!r}")
    if "modified several relevant files" in reasons:
        score += min(gh.SCORE_EXTRA_FILE * (files - 1), gh.MAX_EXTRA_FILE_BONUS)
    return score


def test_every_score_is_the_sum_of_its_reasons(built, results):
    root, hashes = built
    explained = [item for result in results.values() for item in result.explained]
    broader = corpus.run_corpus(root, hashes, GitHistoryOptions(history_depth="broader"))
    explained += [item for result in broader for item in result.explained]
    assert explained
    for label, score, reasons in explained:
        assert score == _explained(reasons), (label, score, reasons)


def test_every_supporting_file_says_how_many_listed_commits_changed_it(built):
    root, hashes = built
    for case in corpus.CASES:
        record = collect_git_history(root, "JR-0", case.query, case.settings).record
        listed = {commit.hash for commit in record.commits}
        for item in record.supporting_files:
            count = len(item.commit_hashes)
            assert item.reasons[0] == f"changed in {count} related commit{'s' if count != 1 else ''}"
            assert set(item.commit_hashes) <= listed, (case.name, item.path)
            assert len(set(item.commit_hashes)) == count
            assert item.score >= gh.MIN_SUPPORTING_SCORE
