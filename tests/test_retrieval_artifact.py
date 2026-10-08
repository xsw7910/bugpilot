"""retrieval.json: the one canonical retrieval artifact (plan §37).

The search stage used to leave four files. It now leaves one typed artifact,
written once and atomically, and every later reader — the context, git
history, the extension — is a projection of it. These tests hold its schema,
the absence of the files it replaced, the hint every search runs with, and that
the stages after it see exactly what they saw before.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest

from bugpilot.core import retrieval as retrieval_module
from bugpilot.core import workflow
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import InvestigationOptions, InvestigationPlan, InvestigationRequest
from bugpilot.core.retrieval import (
    RelatedFile,
    RetrievalArtifact,
    RetrievalArtifactError,
    RetrievalTerm,
    Snippet,
    load_retrieval,
    read_retrieval_quietly,
    retrieval_from_dict,
    retrieval_to_dict,
    save_retrieval,
)

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")

RETRIEVAL_KEYS = {"schema_version", "confidence", "reasons", "noise_indicators", "terms", "related_files"}
#: A prepare run's Git history step adds its section (Git History v2).
PREPARED_RETRIEVAL_KEYS = RETRIEVAL_KEYS | {"git_history"}
TERM_KEYS = {
    "value", "source", "weight", "effective_weight", "match_count", "classification", "derived_from", "status",
}
FILE_KEYS = {
    "file", "documentation", "score", "confidence", "match_count", "matched_keywords", "reasons",
    "noise_flags", "snippets",
}
# Every retrieval-stage file retrieval.json replaced. Normal execution writes none.
LEGACY_RETRIEVAL_FILES = ("extracted_keywords.json", "code_search.md", "search_quality.json", "related_files.json")
LEGACY_ISSUE_FILES = (
    "jira.json", "jira_summary.md", "jira_parsed.md", "bug_spec.json", "developer_hint.md", "fix_mode.json",
)

HINT = "Check output validation"
NEW_HINT = "Focus on state restoration"


def _repo(root: Path) -> Path:
    """A sample repository with one of each thing the terms should find."""
    (root / "src").mkdir()
    (root / "docs").mkdir()
    (root / "src" / "WidgetController.cpp").write_text(
        '#include "WidgetController.h"\n'
        "bool WidgetController::validate(OutputType outputType) {\n"
        "  throw InvalidOutputType();\n"
        "}\n",
        encoding="utf-8",
    )
    (root / "src" / "WidgetController.h").write_text(
        "class WidgetController { bool validate(OutputType outputType); };\n", encoding="utf-8"
    )
    (root / "src" / "validation.py").write_text("# output validation rules\n", encoding="utf-8")
    (root / "src" / "state_restoration.py").write_text("# state restoration on startup\n", encoding="utf-8")
    # Over BROAD_MATCH_THRESHOLD lines: `reload` stops discriminating.
    (root / "src" / "reloader.py").write_text("def reload():\n    pass\n" * 300, encoding="utf-8")
    (root / "docs" / "widgets.md").write_text("The WidgetController validates the output type.\n", encoding="utf-8")
    return root


def _spec():
    return bug_spec_from_description(
        "WidgetController rejects the output type after reload.\n\n"
        "Error: InvalidOutputType thrown by the widget",
        title="Output type rejected after reload",
    )


def _prepare(root: Path, *, hint: str | None = HINT, keywords=("WidgetController",), fix_mode_id=None):
    spec = _spec()
    request = InvestigationRequest(
        spec=spec,
        options=InvestigationOptions(hint=hint, keywords=list(keywords)),
        fix_mode_id=fix_mode_id,
    )
    workflow.run_investigation(root, request)
    return spec.work_item_id


def _read(root: Path, work_item_id: str) -> dict:
    return json.loads((root / ".ai" / work_item_id / "retrieval.json").read_text(encoding="utf-8"))


def _term(data: dict, value: str) -> dict:
    return next(term for term in data["terms"] if term["value"] == value)


# --- the schema ------------------------------------------------------------------


@needs_rg
def test_a_prepare_run_writes_one_canonical_retrieval_artifact(tmp_path):
    work_item = _prepare(_repo(tmp_path))
    target = tmp_path / ".ai" / work_item
    data = _read(tmp_path, work_item)

    assert set(data) == PREPARED_RETRIEVAL_KEYS
    assert data["schema_version"] == 1
    assert data["confidence"] == "high"
    assert data["reasons"][0] == "At least one high-confidence application source file was found."
    assert data["noise_indicators"] == ["docs_or_examples_path"]
    assert all(set(term) == TERM_KEYS for term in data["terms"])
    assert all(set(item) == FILE_KEYS for item in data["related_files"])
    for name in LEGACY_RETRIEVAL_FILES + LEGACY_ISSUE_FILES:
        assert not (target / name).exists(), name


@needs_rg
def test_terms_record_every_kind_of_term_the_search_tried(tmp_path):
    data = _read(tmp_path, _prepare(_repo(tmp_path)))

    user = _term(data, "WidgetController")
    assert (user["source"], user["weight"], user["classification"], user["status"]) == (
        "user", 8, "specific", "retained",
    )
    # From the error message: an identifier the software printed.
    identifier = _term(data, "InvalidOutputType")
    assert (identifier["source"], identifier["weight"]) == ("identifier", 8)
    hint = _term(data, "validation")
    assert (hint["source"], hint["status"]) == ("hint", "retained")
    issue = _term(data, "widget")
    assert issue["source"] == "issue"
    # A shape the repository confirmed, and where it came from.
    shape = _term(data, "outputType")
    assert (shape["source"], shape["derived_from"], shape["status"]) == (
        "shape_expansion", "output type", "retained",
    )
    # A shape nothing matched stays visible, marked as found wanting.
    zero = _term(data, "output_type")
    assert (zero["match_count"], zero["classification"], zero["status"]) == (0, "zero", "dropped")
    # A term everywhere is demoted, not dropped: match_count is ripgrep *lines*.
    broad = _term(data, "reload")
    assert broad["match_count"] == 300
    assert broad["classification"] == "broad"
    assert (broad["weight"], broad["effective_weight"]) == (2, 1)
    assert broad["status"] == "retained"


@needs_rg
def test_terms_are_in_search_order_weighted_terms_then_shapes(tmp_path):
    data = _read(tmp_path, _prepare(_repo(tmp_path)))
    sources = [term["source"] for term in data["terms"]]
    first_shape = sources.index("shape_expansion")

    assert all(source == "shape_expansion" for source in sources[first_shape:])
    weights = [term["weight"] for term in data["terms"][:first_shape]]
    assert weights == sorted(weights, reverse=True)


@needs_rg
def test_related_files_keep_rank_classification_and_matched_keywords(tmp_path):
    data = _read(tmp_path, _prepare(_repo(tmp_path)))
    related = data["related_files"]
    files = [item["file"] for item in related]

    assert files[:2] == ["src/WidgetController.cpp", "src/WidgetController.h"]
    scores = [item["score"] for item in related if not item["documentation"]]
    assert scores == sorted(scores, reverse=True)
    docs = next(item for item in related if item["file"] == "docs/widgets.md")
    assert docs["documentation"] is True
    assert "docs_or_examples_path" in docs["noise_flags"]
    top = related[0]
    assert top["documentation"] is False
    assert top["matched_keywords"] == sorted(top["matched_keywords"])
    assert {"WidgetController", "InvalidOutputType", "outputType"} <= set(top["matched_keywords"])


@needs_rg
def test_snippets_are_the_matched_lines_with_their_numbers(tmp_path):
    data = _read(tmp_path, _prepare(_repo(tmp_path)))
    top = data["related_files"][0]

    assert {"line": 3, "text": "throw InvalidOutputType();"} in top["snippets"]
    assert all(set(snippet) == {"line", "text"} for snippet in top["snippets"])


@needs_rg
def test_the_line_budget_still_bounds_the_evidence(tmp_path):
    _repo(tmp_path)
    spec = _spec()
    request = InvestigationRequest(spec=spec, options=InvestigationOptions(max_search_lines=4))
    workflow.run_investigation(tmp_path, request)

    kept = [len(item["snippets"]) for item in _read(tmp_path, spec.work_item_id)["related_files"]]
    # Two heading lines for the first file, then two of its lines; nothing after.
    assert kept[0] == 2
    assert sum(kept[1:]) == 0


@needs_rg
def test_the_same_search_serializes_identically(tmp_path):
    _repo(tmp_path)
    work_item = _prepare(tmp_path)
    target = tmp_path / ".ai" / work_item / "retrieval.json"
    first = target.read_text(encoding="utf-8")

    # The same options again: keywords are a per-run option, the hint is recorded.
    workflow.refine_investigation(tmp_path, work_item, InvestigationOptions(keywords=["WidgetController"]))

    assert target.read_text(encoding="utf-8") == first


# --- stages after the search see what they saw before ------------------------------


@needs_rg
def test_git_history_is_looked_up_for_the_top_ranked_files(tmp_path, monkeypatch):
    seen: list[list[str]] = []
    real = workflow.collect_git_history

    def spy(repo_root, issue_key, query=None, settings=None):
        # Git History v2: the ranked files are one input of the query, still
        # the top five in rank order.
        seen.append(list(query.ranked_files))
        return real(repo_root, issue_key, query, settings)

    monkeypatch.setattr(workflow, "collect_git_history", spy)
    work_item = _prepare(_repo(tmp_path))

    assert seen == [[item["file"] for item in _read(tmp_path, work_item)["related_files"][:5]]]


@needs_rg
def test_a_standalone_context_rebuilds_the_same_document(tmp_path):
    """Resume coherence: issue.json + retrieval.json reproduce the pipeline's context.

    The pipeline hands the keywords and the retrieval over in memory; a later
    `bugpilot context` has only the two artifacts. With the developer's own
    keywords out of the picture — they are a per-run option — the two must
    write the same context.md.
    """
    work_item = _prepare(_repo(tmp_path), keywords=())
    target = tmp_path / ".ai" / work_item
    from_pipeline = (target / "context.md").read_text(encoding="utf-8")

    # The steps a developer would run by hand, each from the persisted artifacts:
    # the two the context folds in, then the context itself.
    similar_fixes = workflow.memory_search_step(tmp_path, work_item)
    git_history = workflow.git_context_step(tmp_path, work_item)
    workflow.context_step(tmp_path, work_item, git_history=git_history, similar_fixes=similar_fixes)

    assert (target / "context.md").read_text(encoding="utf-8") == from_pipeline


@needs_rg
def test_the_context_renders_its_retrieval_sections_from_the_artifact(tmp_path):
    work_item = _prepare(_repo(tmp_path))
    context = (tmp_path / ".ai" / work_item / "context.md").read_text(encoding="utf-8")

    assert f"See `.ai/{work_item}/retrieval.json`" in context
    assert "- `src/WidgetController.cpp` confidence=high" in context
    assert "Confidence: High" in context
    assert "#### src/WidgetController.cpp" in context
    assert "- Line 3: `throw InvalidOutputType();`" in context
    assert "code_search.md" not in context


@needs_rg
def test_eleven_ranked_files_all_reach_the_agent_context(tmp_path, monkeypatch):
    """A panel row limit must not become a context limit.

    The panel shows ten rows and says how many more there are; that is
    presentation. context.md is what the agent reads first, and a developer
    who asked for eleven files with --max-files must find all eleven named there.
    It used to name ten: the summary sliced at the panel's number.

    What *is* allowed to bound the context is an evidence budget: the Relevant
    Snippets excerpt carries a fixed number of lines, so later files legitimately
    contribute no snippet there. This test tells the two apart.
    """
    (tmp_path / "src" / "widgets").mkdir(parents=True)
    for index in range(12):
        (tmp_path / "src" / "widgets" / f"WidgetPart{index:02d}.cpp").write_text(
            f"// WidgetController part {index}\nvoid WidgetController::part{index}() {{}}\n",
            encoding="utf-8",
        )
    handed_to_context: list[RetrievalArtifact] = []
    real = workflow.build_context

    def spy(issue, keywords, retrieval, git_history=None, similar_fixes=None):
        handed_to_context.append(retrieval)
        return real(issue, keywords, retrieval, git_history, similar_fixes)

    monkeypatch.setattr(workflow, "build_context", spy)
    spec = bug_spec_from_description("WidgetController loses its state after reload.", title="Widget state lost")
    request = InvestigationRequest(spec=spec, options=InvestigationOptions(max_files=11))
    workflow.run_investigation(tmp_path, request)

    target = tmp_path / ".ai" / spec.work_item_id
    files = [item["file"] for item in _read(tmp_path, spec.work_item_id)["related_files"]]
    # 1. The retrieval kept eleven, as asked — twelve files match.
    assert len(files) == 11
    # 2. The context step was handed all eleven.
    assert [item.file for item in handed_to_context[0].related_files] == files
    context = (target / "context.md").read_text(encoding="utf-8")
    summary = context.split("### Relevant Files", 1)[1].split("### Relevant Snippets", 1)[0]
    # 3. No ten-file slice: every ranked file is listed, in rank order.
    listed = [line.split("`")[1] for line in summary.splitlines() if line.startswith("- `")]
    assert listed == files
    assert all(f"`{file}`" in context for file in files)
    # 4. The snippet excerpt is bounded by its line budget, not by a file count:
    #    it is exactly the first lines of the full matched-line rendering.
    snippets = context.split("### Relevant Snippets", 1)[1].split("## Similar Fixes", 1)[0].strip()
    rendered: list[str] = []
    for item in handed_to_context[0].related_files:
        rendered += [f"#### {item.file}", ""]
        rendered += [f"- Line {snippet.line}: `{snippet.text}`" for snippet in item.snippets]
        rendered.append("")
    assert snippets == "\n".join(rendered[:24]).strip()
    shown = [file for file in files if f"#### {file}" in snippets]
    assert 0 < len(shown) < len(files), "the budget should cut the excerpt, not a file count"
    assert shown == files[: len(shown)]


def test_the_summary_lists_every_ranked_file_however_many():
    from bugpilot.core.context import _relevant_files_markdown

    related = tuple(
        RelatedFile(file=f"src/widgets/Part{index:02d}.cpp", documentation=False, score=30 - index,
                    confidence="high", match_count=1)
        for index in range(15)
    )

    lines = _relevant_files_markdown(RetrievalArtifact(related_files=related)).splitlines()

    assert len(lines) == 15
    assert lines[-1].startswith("- `src/widgets/Part14.cpp`")


# --- the hint every search runs with -------------------------------------------------


@pytest.fixture
def searched_hints(monkeypatch):
    """The hint each code search was actually given."""
    seen: list[str | None] = []
    real = workflow.code_search_step

    def spy(repo_root, issue_key, options=None, keywords=None):
        seen.append(options.hint if options else None)
        return real(repo_root, issue_key, options, keywords=keywords)

    monkeypatch.setattr(workflow, "code_search_step", spy)
    return seen


@needs_rg
def test_refine_without_a_new_hint_searches_with_the_recorded_one(tmp_path, searched_hints):
    work_item = _prepare(_repo(tmp_path), hint=HINT)

    workflow.refine_investigation(tmp_path, work_item)

    assert searched_hints == [HINT, HINT]
    assert _term(_read(tmp_path, work_item), "validation")["source"] == "hint"


@needs_rg
def test_refine_with_a_new_hint_overrides_the_recorded_one(tmp_path, searched_hints):
    work_item = _prepare(_repo(tmp_path), hint=HINT)

    workflow.refine_investigation(tmp_path, work_item, InvestigationOptions(hint=NEW_HINT))

    assert searched_hints == [HINT, NEW_HINT]
    data = _read(tmp_path, work_item)
    assert _term(data, "restoration")["source"] == "hint"
    assert not any(term["value"] == "validation" for term in data["terms"])
    issue = json.loads((tmp_path / ".ai" / work_item / "issue.json").read_text(encoding="utf-8"))
    assert issue["guidance"]["hint"] == NEW_HINT
    # And a refinement after that keeps the new one.
    workflow.refine_investigation(tmp_path, work_item)
    assert searched_hints[-1] == NEW_HINT


@needs_rg
def test_with_no_hint_anywhere_the_search_has_none(tmp_path, searched_hints):
    work_item = _prepare(_repo(tmp_path), hint=None)

    workflow.refine_investigation(tmp_path, work_item)

    assert searched_hints == [None, None]
    assert not any(term["source"] == "hint" for term in _read(tmp_path, work_item)["terms"])


@needs_rg
def test_refining_the_hint_leaves_the_fix_mode_alone(tmp_path):
    work_item = _prepare(_repo(tmp_path), fix_mode_id="conservative")

    workflow.refine_investigation(tmp_path, work_item, InvestigationOptions(hint=NEW_HINT))

    issue = json.loads((tmp_path / ".ai" / work_item / "issue.json").read_text(encoding="utf-8"))
    assert issue["guidance"]["fix_mode"]["id"] == "conservative"
    task = (tmp_path / ".ai" / work_item / "task.md").read_text(encoding="utf-8")
    assert "- Mode: Conservative Fix" in task
    assert NEW_HINT in task


# --- partial plans and resume ---------------------------------------------------------


def test_a_plan_without_code_search_writes_no_retrieval(tmp_path):
    spec = _spec()
    request = InvestigationRequest(spec=spec, plan=InvestigationPlan(code_search=False))
    workflow.run_investigation(tmp_path, request)

    target = tmp_path / ".ai" / spec.work_item_id
    assert not (target / "retrieval.json").exists()
    context = (target / "context.md").read_text(encoding="utf-8")
    assert "_Code search has not been generated yet._" in context
    assert "_Search quality has not been generated yet._" in context


@needs_rg
def test_resume_without_the_search_keeps_the_persisted_retrieval(tmp_path):
    """A resumed plan that skips the search reads what the last search wrote."""
    _repo(tmp_path)
    spec = _spec()
    workflow.run_investigation(tmp_path, InvestigationRequest(spec=spec))
    before = _read(tmp_path, spec.work_item_id)

    request = InvestigationRequest(spec=spec, plan=InvestigationPlan(code_search=False))
    workflow.run_investigation(tmp_path, request, fresh=False)

    assert _read(tmp_path, spec.work_item_id) == before
    context = (tmp_path / ".ai" / spec.work_item_id / "context.md").read_text(encoding="utf-8")
    assert "- `src/WidgetController.cpp`" in context


# --- the on-disk form ---------------------------------------------------------------


def _artifact() -> RetrievalArtifact:
    return RetrievalArtifact(
        confidence="medium",
        reasons=("Some plausible application or implementation files were matched.", "Search failed for keyword `x`"),
        noise_indicators=("docs_or_examples_path",),
        terms=(
            RetrievalTerm("WidgetController", "user", 8, 8, 4, "specific"),
            RetrievalTerm("output_type", "shape_expansion", 5, 5, 0, "zero", "output type", "dropped"),
        ),
        related_files=(
            RelatedFile(
                file="src/WidgetController.cpp", documentation=False, score=20, confidence="medium",
                match_count=4, matched_keywords=("WidgetController",), reasons=("keyword matches file name",),
                snippets=(Snippet(3, "throw InvalidOutputType();"),),
            ),
            RelatedFile(file="docs/widgets.md", documentation=True, score=3, confidence="low", match_count=1,
                        noise_flags=("docs_or_examples_path",)),
        ),
    )


def test_the_dict_form_round_trips():
    artifact = _artifact()

    assert retrieval_from_dict(retrieval_to_dict(artifact), "JR-12345") == artifact


def test_save_and_load_round_trip(tmp_path):
    artifact = replace(_artifact(), reasons=("三维视图切换图层后崩溃",))
    path = save_retrieval(tmp_path, "JR-12345", artifact)

    assert path == tmp_path / ".ai" / "JR-12345" / "retrieval.json"
    assert "三维视图切换图层后崩溃" in path.read_text(encoding="utf-8")
    assert load_retrieval(tmp_path, "JR-12345") == artifact


def test_retrieval_json_is_written_atomically(tmp_path, monkeypatch):
    written: list[Path] = []
    real = retrieval_module.atomic_write_text

    def recording(path, text):
        written.append(path)
        real(path, text)

    monkeypatch.setattr(retrieval_module, "atomic_write_text", recording)
    save_retrieval(tmp_path, "JR-12345", _artifact())

    assert written == [tmp_path / ".ai" / "JR-12345" / "retrieval.json"]


def test_a_missing_retrieval_is_none(tmp_path):
    assert load_retrieval(tmp_path, "JR-12345") is None
    assert read_retrieval_quietly(tmp_path, "JR-12345") is None


@pytest.mark.parametrize(
    "contents",
    [
        "{not json",
        "[]",
        # The old related_files.json and search_quality.json shapes.
        json.dumps([{"file": "src/a.cpp"}]),
        json.dumps({"confidence": "high", "terms": []}),
        json.dumps({"schema_version": 2, "terms": [], "related_files": []}),
    ],
)
def test_an_unusable_retrieval_is_an_error_not_a_fallback(tmp_path, contents):
    target = tmp_path / ".ai" / "JR-12345"
    target.mkdir(parents=True)
    (target / "retrieval.json").write_text(contents, encoding="utf-8")

    with pytest.raises(RetrievalArtifactError):
        load_retrieval(tmp_path, "JR-12345")
    assert read_retrieval_quietly(tmp_path, "JR-12345") is None


def test_the_old_retrieval_files_are_not_read(tmp_path):
    target = tmp_path / ".ai" / "JR-12345"
    target.mkdir(parents=True)
    (target / "related_files.json").write_text(json.dumps([{"file": "src/a.cpp"}]), encoding="utf-8")
    (target / "search_quality.json").write_text(json.dumps({"confidence": "high"}), encoding="utf-8")

    assert load_retrieval(tmp_path, "JR-12345") is None
