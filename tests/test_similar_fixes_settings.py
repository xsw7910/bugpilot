"""Similar Fixes Settings, end to end on the Python side.

Each setting is checked for the one thing it promises — and for what it must
not do, which is reach another step: Similar Fixes' Additional Keywords never
reach Code Search or Git History, and Similar Fixes never reads a Focus File.
The memories are seeded into temp directories; nothing here reads the
developer's own ``.ai_memory`` or contacts Jira.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.issue import IssueGuidance, issue_from_spec
from bugpilot.core.memory import search_memory
from bugpilot.core.models import (
    DEFAULT_MAX_SIMILAR_FIXES,
    MAX_SIMILAR_FIXES_LIMIT,
    GitHistoryOptions,
    InvestigationOptions,
    InvestigationPlan,
    InvestigationRequest,
    SimilarFixesOptions,
)

ISSUE_TEXT = "Saving a seismic volume crashes the application."

#: One memory per kind of evidence the settings can switch. None of them shares
#: a word with another's evidence, or with the issue text unless it says so.
MEMORIES = {
    "brick-handling": "# Brick handling\n\nTouched OpenVdsBrick handling in the reader.\n",
    "legacy-exporter": "# Legacy exporter\n\nThe legacyexporter regressed after a refactor.\n",
    "seismic-crash": "# Seismic volume crash\n\nA seismic volume crash on save.\n",
    "path-only": "# Path only\n\nsrc/OnlyFocus.cpp src/OnlyGitFile.cpp ONLYGITWORD ONLYIGNORED\n",
}


def _seed(root: Path, memories: dict[str, str]) -> Path:
    folder = root / ".ai_memory" / "bugs"
    folder.mkdir(parents=True, exist_ok=True)
    for name, text in memories.items():
        (folder / f"{name}.md").write_text(text, encoding="utf-8")
    return folder


def _extraction(supplied: list[str] | None = None, text: str = ISSUE_TEXT) -> dict[str, object]:
    spec = bug_spec_from_description(text, title="Crash on save")
    return workflow.extract_issue_keywords(issue_from_spec(spec, IssueGuidance()), supplied)


def _found(report: str) -> list[str]:
    """The memory files the report lists, in its order."""
    section = report.split("## Similar Historical Issues", 1)[1]
    return [line.split("`")[1] for line in section.splitlines() if line.startswith("- `")]


def _search(root: Path, options: InvestigationOptions, supplied: list[str] | None = None) -> list[str]:
    extracted = _extraction(supplied if supplied is not None else options.keywords)
    report = workflow.memory_search_step(root, "JR-12345", keywords=extracted, options=options)
    return _found(report)


def _file(name: str) -> str:
    return f".ai_memory/bugs/{name}.md"


# --- defaults -----------------------------------------------------------------------------


def test_the_defaults_are_the_steps_behaviour_before_the_settings():
    assert DEFAULT_MAX_SIMILAR_FIXES == 5
    assert MAX_SIMILAR_FIXES_LIMIT == 20
    assert SimilarFixesOptions() == SimilarFixesOptions(use_shared_keywords=True, keywords=(), max_results=5)
    assert InvestigationOptions().similar_fixes == SimilarFixesOptions()


def test_the_default_terms_are_the_extraction_the_step_always_scored():
    # Before the settings the step scored the merged extraction's high-value and
    # normal keywords — shared Keywords at their head. At the defaults it still
    # does, each term once.
    extracted = _extraction(["OpenVdsBrick", "seismic"])
    before = [*extracted["high_value_keywords"], *extracted["normal_keywords"]]
    unique_before = list(dict.fromkeys(term.casefold() for term in before))

    terms = workflow.similar_fixes_terms(extracted)

    assert [term.casefold() for term in terms] == unique_before
    assert terms[0] == "OpenVdsBrick"


def test_a_command_line_without_similar_flags_gets_the_defaults(tmp_path, monkeypatch):
    captured = _capture_request(tmp_path, monkeypatch, [])
    assert captured.options.similar_fixes == SimilarFixesOptions()


def test_every_similar_flag_reaches_the_options_and_nothing_else(tmp_path, monkeypatch):
    captured = _capture_request(
        tmp_path,
        monkeypatch,
        [
            "--similar-fixes-keyword=legacyexporter", "--similar-fixes-keyword=ångström",
            "--similar-fixes-no-shared-keywords", "--max-similar-fixes=2",
            "--keywords=poststack", "--focus-file=src/Focus.cpp",
        ],
    )

    assert captured.options.similar_fixes == SimilarFixesOptions(
        use_shared_keywords=False, keywords=("legacyexporter", "ångström"), max_results=2
    )
    # Code Search's inputs and Git History's settings are untouched by any of them.
    assert captured.options.keywords == ["poststack"]
    assert captured.options.focus_files == ["src/Focus.cpp"]
    assert captured.options.git_history == GitHistoryOptions()
    # And the step still runs: the settings are not a switch.
    assert captured.plan.similar_fixes is True


@pytest.mark.parametrize("count", ["1", "20"])
def test_the_command_line_accepts_the_range_ends(tmp_path, monkeypatch, count):
    captured = _capture_request(tmp_path, monkeypatch, [f"--max-similar-fixes={count}"])
    assert captured.options.similar_fixes.max_results == int(count)


@pytest.mark.parametrize("count", ["0", "21", "-3"])
def test_the_command_line_refuses_an_out_of_range_count(tmp_path, monkeypatch, capsys, count):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--description", "x", f"--max-similar-fixes={count}", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "INVALID_INPUT"
    assert "--max-similar-fixes must be between 1 and 20" in payload["error"]["message"]


def test_invalid_settings_normalize_to_safe_defaults():
    for count in (0, 21, -1, True, "5"):
        assert SimilarFixesOptions(max_results=count).normalized().max_results == 5  # type: ignore[arg-type]
    assert SimilarFixesOptions(use_shared_keywords=None).normalized().use_shared_keywords is True  # type: ignore[arg-type]


# --- Use shared keywords ----------------------------------------------------------------------


def test_shared_keywords_on_reach_the_memory_search(tmp_path):
    _seed(tmp_path, MEMORIES)
    options = InvestigationOptions(keywords=["OpenVdsBrick"])

    found = _search(tmp_path, options)

    assert _file("brick-handling") in found
    assert "OpenVdsBrick" in workflow.similar_fixes_terms(_extraction(["OpenVdsBrick"]), options.similar_fixes)


def test_shared_keywords_off_leaves_them_out_and_nothing_else(tmp_path):
    _seed(tmp_path, MEMORIES)
    settings = SimilarFixesOptions(use_shared_keywords=False, keywords=("legacyexporter",))
    options = InvestigationOptions(keywords=["OpenVdsBrick"], similar_fixes=settings)

    found = _search(tmp_path, options)
    terms = workflow.similar_fixes_terms(_extraction(["OpenVdsBrick"]), settings)

    # The shared Keyword is gone ...
    assert "openvdsbrick" not in [term.casefold() for term in terms]
    assert _file("brick-handling") not in found
    # ... the issue's own terms and the Additional Keyword are not.
    assert _file("seismic-crash") in found
    assert _file("legacy-exporter") in found
    assert {"seismic", "volume", "legacyexporter"} <= {term.casefold() for term in terms}


def test_shared_keywords_off_keeps_a_term_the_issue_itself_names():
    # "seismic" is a shared Keyword and an issue term. Off removes the shared
    # Keyword, not the issue's word for the same thing.
    extracted = _extraction(["seismic", "OpenVdsBrick"])
    terms = workflow.similar_fixes_terms(extracted, SimilarFixesOptions(use_shared_keywords=False))

    assert "seismic" in [term.casefold() for term in terms]
    assert "openvdsbrick" not in [term.casefold() for term in terms]


def test_shared_keywords_off_leaves_the_extraction_for_the_other_steps_alone():
    extracted = _extraction(["OpenVdsBrick"])
    snapshot = json.dumps(extracted, sort_keys=True)

    workflow.similar_fixes_terms(extracted, SimilarFixesOptions(use_shared_keywords=False))

    assert json.dumps(extracted, sort_keys=True) == snapshot
    assert extracted["high_value_keywords"][0] == "OpenVdsBrick"


# --- Additional keywords ----------------------------------------------------------------------


def test_additional_keywords_find_past_fixes(tmp_path):
    _seed(tmp_path, MEMORIES)
    options = InvestigationOptions(similar_fixes=SimilarFixesOptions(keywords=("legacyexporter",)))

    assert _file("legacy-exporter") in _search(tmp_path, options)
    assert _file("legacy-exporter") not in _search(tmp_path, InvestigationOptions())


def test_additional_keywords_never_reach_code_search_or_git_history(tmp_path):
    root = tmp_path / "repo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "Volume.cpp").write_text("void saveVolume() {}\n", encoding="utf-8")
    _seed(root, MEMORIES)
    spec = bug_spec_from_description(ISSUE_TEXT, title="Crash on save")
    options = InvestigationOptions(
        keywords=["seismic"], similar_fixes=SimilarFixesOptions(keywords=("legacyexporter",))
    )

    workflow.run_investigation(
        root, InvestigationRequest(spec=spec, options=options, plan=InvestigationPlan(git_history=False))
    )

    retrieval = json.loads((root / ".ai" / spec.work_item_id / "retrieval.json").read_text(encoding="utf-8"))
    assert "legacyexporter" not in [term["value"].casefold() for term in retrieval["terms"]]
    # Git History's query, built from the same options, does not carry it either.
    query = workflow._git_history_query(root, spec.work_item_id, None, None, None, options, GitHistoryOptions())
    searched = [*query.shared_keywords, *query.git_keywords, *query.extracted_terms]
    assert "legacyexporter" not in [term.casefold() for term in searched]
    # The shared Keywords themselves are unchanged by it.
    assert options.keywords == ["seismic"]
    # And the past fix it names is in the context.
    context = (root / ".ai" / spec.work_item_id / "context.md").read_text(encoding="utf-8")
    assert _file("legacy-exporter") in context.split("## Similar Fixes", 1)[1]


def test_other_steps_inputs_never_reach_the_memory_search(tmp_path):
    # path-only holds only words that are some other step's input: a Focus File,
    # a Git History Additional File and Commit Keyword, an Ignore Path.
    _seed(tmp_path, MEMORIES)
    options = InvestigationOptions(
        focus_files=["src/OnlyFocus.cpp"],
        ignore_paths=["ONLYIGNORED"],
        max_files=1,
        git_history=GitHistoryOptions(keywords=("ONLYGITWORD",), files=("src/OnlyGitFile.cpp",)),
    )

    assert _file("path-only") not in _search(tmp_path, options)
    terms = workflow.similar_fixes_terms(_extraction([]), options.similar_fixes)
    for word in ("onlyfocus", "onlygitfile", "onlygitword", "onlyignored"):
        assert not any(word in term.casefold() for term in terms), word


# --- deduplication ----------------------------------------------------------------------------


def test_a_term_several_inputs_name_is_scored_once():
    extracted = {
        "issue_terms": ["openvdsbrick", "Volume"],
        "supplied_keywords": ["OpenVdsBrick"],
        "high_value_keywords": ["OpenVdsBrick", "Volume"],
        "normal_keywords": [],
    }
    settings = SimilarFixesOptions(keywords=("  OPENVDSBRICK ", "", "volume", "Export"))

    terms = workflow.similar_fixes_terms(extracted, settings)

    # Shared first, then additional, then the issue's; the first spelling wins.
    assert terms == ["OpenVdsBrick", "volume", "Export"]


def test_a_duplicated_term_adds_no_weight(tmp_path):
    _seed(tmp_path, {"brick-handling": MEMORIES["brick-handling"]})
    extracted = {"issue_terms": ["openvdsbrick"], "supplied_keywords": ["OpenVdsBrick"]}
    terms = workflow.similar_fixes_terms(extracted, SimilarFixesOptions(keywords=("OPENVDSBRICK",)))

    _id, _report, results = search_memory(tmp_path, "JR-12345", terms=terms)

    # Once in the memory, once in the score: not once per input that named it.
    assert [result["score"] for result in results] == [1]


# --- Max similar fixes ------------------------------------------------------------------------


@pytest.mark.parametrize(("count", "kept"), [(1, 1), (2, 2), (5, 5), (20, 7)])
def test_max_similar_fixes_is_how_many_are_kept(tmp_path, count, kept):
    _seed(tmp_path, {f"past-{index}": f"# Past fix {index}\n\nseismic {'volume ' * index}\n" for index in range(7)})
    options = InvestigationOptions(similar_fixes=SimilarFixesOptions(max_results=count))

    found = _search(tmp_path, options)

    assert len(found) == kept
    # The best first, as ever: the count only cuts the list.
    assert found[0] == _file("past-6")


def test_the_default_keeps_five(tmp_path):
    _seed(tmp_path, {f"past-{index}": f"# Past fix {index}\n\nseismic\n" for index in range(7)})

    assert len(_search(tmp_path, InvestigationOptions())) == 5
    _id, _report, results = search_memory(tmp_path, "JR-12345", terms=["seismic"])
    assert len(results) == 5


def test_a_library_count_below_one_keeps_the_default(tmp_path):
    _seed(tmp_path, {f"past-{index}": f"# Past fix {index}\n\nseismic\n" for index in range(7)})

    for count in (0, -1):
        _id, _report, results = search_memory(tmp_path, "JR-12345", terms=["seismic"], max_results=count)
        assert len(results) == 5


# --- the step switched off, and no memory -----------------------------------------------------


def test_similar_fixes_off_never_searches_memory(tmp_path, monkeypatch):
    _seed(tmp_path, MEMORIES)
    calls: list[object] = []
    monkeypatch.setattr(workflow, "search_memory", lambda *args, **kwargs: calls.append(args))
    spec = bug_spec_from_description(ISSUE_TEXT, title="Crash on save")
    options = InvestigationOptions(
        similar_fixes=SimilarFixesOptions(use_shared_keywords=False, keywords=("legacyexporter",), max_results=2)
    )

    workflow.run_investigation(
        tmp_path,
        InvestigationRequest(
            spec=spec, options=options, plan=InvestigationPlan(git_history=False, similar_fixes=False)
        ),
    )

    assert calls == []
    run = json.loads((tmp_path / ".ai" / spec.work_item_id / "run.json").read_text(encoding="utf-8"))
    assert run["steps"]["memory_search"] == "skipped"
    # The settings are still what the run was given: switching the step off
    # does not clear them.
    assert options.similar_fixes.keywords == ("legacyexporter",)


@pytest.mark.parametrize("memory", ["absent", "empty"])
def test_no_memory_is_a_quick_clean_no_result(tmp_path, memory):
    if memory == "empty":
        _seed(tmp_path, {})
    before = sorted(path.relative_to(tmp_path).as_posix() for path in tmp_path.rglob("*") if ".ai" not in path.parts)

    started = time.perf_counter()
    report = workflow.memory_search_step(
        tmp_path,
        "JR-12345",
        keywords=_extraction(["seismic"]),
        options=InvestigationOptions(similar_fixes=SimilarFixesOptions(keywords=("legacyexporter",), max_results=20)),
    )
    elapsed = time.perf_counter() - started

    assert "No similar memory entries found." in report
    assert _found(report) == []
    assert elapsed < 1.0
    # Nothing written beside the work item's own folder: no memory folder
    # invented, no memory_search.md, no similar_fixes.json.
    after = sorted(path.relative_to(tmp_path).as_posix() for path in tmp_path.rglob("*") if ".ai" not in path.parts)
    assert after == before
    work_item = tmp_path / ".ai" / "JR-12345"
    for name in ("memory_search.md", "memory_search.json", "similar_fixes.json"):
        assert not (work_item / name).exists()


# --- logging ----------------------------------------------------------------------------------


def test_the_settings_trace_carries_shapes_never_values(tmp_path, execution_trace):
    _seed(tmp_path, MEMORIES)
    options = InvestigationOptions(
        keywords=["SECRET_SHARED_KEYWORD_3302"],
        similar_fixes=SimilarFixesOptions(
            use_shared_keywords=False, keywords=("SECRET_SIMILAR_KEYWORD_5521",), max_results=2
        ),
    )

    workflow.memory_search_step(tmp_path, "JR-12345", keywords=_extraction(options.keywords), options=options)

    trace = execution_trace.text
    assert "memory_search settings: sharedKeywords=off additionalKeywords=1 maxResults=2" in trace
    for secret in ("SECRET_SHARED_KEYWORD_3302", "SECRET_SIMILAR_KEYWORD_5521"):
        assert secret not in trace


def test_a_standalone_memory_search_uses_the_defaults(tmp_path, execution_trace):
    workflow.memory_search_step(tmp_path, "JR-12345")

    assert "memory_search settings: sharedKeywords=on additionalKeywords=0 maxResults=5" in execution_trace.text


# --- helpers ----------------------------------------------------------------------------------


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
