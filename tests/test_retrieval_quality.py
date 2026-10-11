"""Retrieval and Context Quality: 0.1.3 (plan section 42.3).

Field-level provenance (a term knows which part of the report it came from),
what comments and the environment may contribute, noise that is never searched
and the technical tokens that look like noise but are not, issue concepts seen
together on one line, Search Confidence v2, the Git History gate, Context
Quality v2, and `retrieval.json` read by older and newer versions alike.
Synthetic data only.
"""

from __future__ import annotations

import pytest

import retrieval_corpus
from bugpilot.core.context import MISSING_CORE_EVIDENCE_CAP, build_context, context_quality
from bugpilot.core.git_history import GitHistoryQuery, file_candidates, select_extracted_terms, weak_ranked_files
from bugpilot.core.git_ops import command_available
from bugpilot.core.issue import IssueArtifact, IssueComment, IssueDetails, IssueSignals
from bugpilot.core.jira_parse import extract_parsed_details, free_description
from bugpilot.core.keywords import extract_keywords, remove_noise
from bugpilot.core.retrieval import (
    ConfidenceDetails,
    RelatedFile,
    RetrievalArtifact,
    RetrievalTerm,
    retrieval_from_dict,
    retrieval_to_dict,
)
from bugpilot.core.search import (
    SECONDARY_EVIDENCE_CAP,
    FileScore,
    Match,
    TermSearchResult,
    _rank_related_files,
    _search_confidence,
    _starts_a_word,
)
from bugpilot.core.search_terms import (
    COMMENT_IDENTIFIER_WEIGHT,
    WEIGHT_AGREED,
    WEIGHT_IDENTIFIER,
    WEIGHT_PHRASE,
    WEIGHT_PROSE,
    WEIGHT_STRONG,
    WEIGHT_WEAK,
    SearchTerm,
    qualified_parts,
    terms_from_extraction,
    weigh,
)
from bugpilot.core.workflow import extract_issue_keywords

requires_search = pytest.mark.skipif(
    not (command_available("rg") and command_available("git")),
    reason="the synthetic history needs ripgrep (rg) and git on PATH",
)


def _jira(title: str, description: str, comments: tuple[str, ...] = (), environment: str = "") -> IssueArtifact:
    return IssueArtifact(
        id="JR-12345",
        source="jira",
        title=title,
        description=description,
        comments=tuple(IssueComment(created="2026-01-01", body=body) for body in comments),
        details=IssueDetails(environment=environment),
    )


# --- where a term came from ------------------------------------------------------------------


def test_every_term_knows_the_fields_it_came_from():
    issue = _jira(
        "Export dialog forgets the output format",
        "The output format selector resets.\n\nEnvironment:\nWindows 11",
        comments=("NightlyPipeline verified it again.",),
        environment="Windows 11",
    )
    origins = extract_issue_keywords(issue)["term_origins"]

    assert origins["format"] == ["title", "description"]
    assert origins["selector"] == ["description"]
    assert origins["nightlypipeline"] == ["comment"]
    # The Environment section is the environment's, not the description's.
    assert origins["windows"] == ["environment"]


def test_a_hand_written_title_is_not_a_field_of_its_own():
    """Its title is its first line — cut short — so every word of it would look agreed on."""
    text = (
        "The export dialog forgets the chosen output format whenever it is closed and opened again, "
        "which happens on every machine we have tried so far, including the fast ones."
    )
    issue = retrieval_corpus.issue_for(retrieval_corpus.RetrievalCase(name="long", issue_text=text))
    assert issue.title.endswith("…")

    origins = extract_issue_keywords(issue)["term_origins"]
    assert all("title" not in found for found in origins.values()), origins


def test_the_description_leaves_its_field_sections_to_their_fields():
    description = (
        "Intro line.\n\nSteps to Reproduce:\n1. Open it.\n\nEnvironment:\nWindows 11\n\nNotes:\nKeep me."
    )
    assert free_description(description) == "Intro line.\n\nNotes:\nKeep me."
    assert free_description("") == ""


# --- what a term is worth ----------------------------------------------------------------------


def test_comment_and_environment_words_are_worth_less_and_the_issue_s_are_unchanged():
    assert weigh("ExportFormatSelector", "issue", origins=("description",)).weight == WEIGHT_IDENTIFIER
    assert weigh("NightlyPipeline", "issue", origins=("comment",)).weight == COMMENT_IDENTIFIER_WEIGHT
    assert weigh("staging", "issue", origins=("comment",)).weight == WEIGHT_WEAK
    assert weigh("selector", "issue", origins=("description",)).weight == WEIGHT_PROSE
    # The title and the description agreeing is the issue's subject said twice.
    assert weigh("renderer", "issue", origins=("title", "description")).weight == WEIGHT_AGREED
    # Generic stays generic wherever it came from.
    assert weigh("output", "issue", origins=("title", "description")).weight == WEIGHT_WEAK
    # A quoted message is exact text; a commenter's is worth less.
    assert weigh("Cannot write file", "phrase", origins=("description",)).weight == WEIGHT_PHRASE
    assert weigh("Cannot write file", "phrase", origins=("comment",)).weight == WEIGHT_IDENTIFIER
    # A stack trace pasted into a comment is still the software speaking.
    assert weigh("NightlyPipeline", "issue", is_priority=True, origins=("comment",)).weight == WEIGHT_STRONG
    # No origins recorded: a caller's own extraction, weighed as it always was.
    assert weigh("selector", "issue").weight == WEIGHT_PROSE


def test_explicit_keywords_stay_the_strongest_signal():
    terms = terms_from_extraction(
        {"high_value_keywords": ["settings"], "term_origins": {"settings": ["description"]}},
        user_keywords=["load_defaults", "UserPreferences"],
    )
    user = [term for term in terms if term.source == "user"]

    assert {term.value for term in user} == {"load_defaults", "UserPreferences"}
    assert all(term.weight == WEIGHT_STRONG and "user-keyword" in term.origins for term in user)
    assert terms[0].source == "user", "keywords lead the search"


def test_environment_only_words_are_not_searched_but_stay_in_the_context():
    extracted = {
        "high_value_keywords": ["renderer", "Windows", "x86-64"],
        "term_origins": {"renderer": ["title"], "windows": ["environment"], "x86-64": ["environment"]},
    }
    assert [term.value for term in terms_from_extraction(extracted)] == ["renderer"]

    issue = _jira("Preview keeps the previous renderer", "The preview pane draws with the software renderer.",
                  environment="Windows 11, x86-64, version 2027.0")
    text = build_context(issue, extracted, None)
    assert "- Not searched, environment only: Windows, x86-64" in text
    assert "Windows 11, x86-64, version 2027.0" in text, "the environment itself is still shown"


def test_a_qualified_name_is_searched_by_its_parts_too():
    whole = weigh("ThumbnailCache.invalidate_stale_entries", "issue", origins=("description",))
    parts = qualified_parts(whole)

    assert [(part.value, part.weight, part.derived_from) for part in parts] == [
        ("ThumbnailCache", WEIGHT_IDENTIFIER, "ThumbnailCache.invalidate_stale_entries"),
        ("invalidate_stale_entries", WEIGHT_IDENTIFIER, "ThumbnailCache.invalidate_stale_entries"),
    ]
    assert qualified_parts(weigh("widget.cpp", "issue")) == [], "a file name is searched with its stem already"
    assert qualified_parts(weigh("os.path", "issue")) == [], "neither part names anything on its own"


# --- repetition, noise and the tokens that only look like noise -------------------------------


def test_repeating_a_word_in_the_comments_does_not_make_it_the_subject():
    core = "The export dialog resets the format."
    comments = "verified\nverified\nverified\nverified"

    flattened = extract_keywords(f"{core}\n{comments}")
    assert flattened["high_value_keywords"][0] == "verified", "the old reading: four comments outvote the issue"

    kept_apart = extract_keywords(core, secondary_text=comments)
    ranked = kept_apart["high_value_keywords"] + kept_apart["normal_keywords"]
    assert ranked[-1] == "verified"


def test_hosts_machine_names_links_and_addresses_are_never_searched():
    text, removed = remove_noise(
        "Seen from build-host-01.example.invalid and build-host-02.example.invalid. "
        "Log at https://build-host-03.example.invalid/job/12?token=abc, ask dev@example.com, "
        "agent build-host-04 failed."
    )
    assert removed == [
        "build-host-01.example.invalid", "build-host-02.example.invalid", "build-host-04",
    ], "a link and an address are dropped, never recorded"
    assert "example" not in text and "abc" not in text and "dev@" not in text

    keywords = extract_keywords("Large exports never finish uploading from build-host-01.example.invalid.")
    searched = {str(value).lower() for key in ("high_value_keywords", "normal_keywords") for value in keywords[key]}
    assert not searched & {"example.invalid", "build-host-01", "example", "invalid"}
    assert keywords["noise_keywords"] == ["build-host-01.example.invalid"]


def test_technical_tokens_that_look_like_noise_are_kept():
    text = (
        "Fails with utf-8 on x86-64 and qt-6 builds; self.test, socket.io, System.Net, "
        "os.path and module.func are involved, see widget.cpp and Qt5."
    )
    _cleaned, removed = remove_noise(text)
    assert removed == []
    keywords = extract_keywords(text)
    found = {str(value) for key in ("high_value_keywords", "normal_keywords", "dropped_keywords") for value in keywords[key]}
    for token in ("utf-8", "x86-64", "qt-6", "self.test", "socket.io", "System.Net", "os.path",
                  "module.func", "widget.cpp", "Qt5"):
        assert token in found, token


def test_a_version_string_is_never_a_search_term_but_stays_in_the_environment():
    parsed = extract_parsed_details("Renderer is wrong.\n\nEnvironment:\nWindows 11, x86-64, version 2027.0", [], [])
    assert parsed["environment"] == "Windows 11, x86-64, version 2027.0"
    keywords = extract_keywords("Renderer is wrong on 2027.0 and v2.3.1.")
    assert not any(any(ch.isdigit() for ch in str(value)) for value in keywords["high_value_keywords"])


def test_environment_filler_is_not_an_environment():
    assert extract_parsed_details("Released build verified, nightly pipeline green.", [], [])["environment"] == ""
    assert extract_parsed_details("Only on build 2027.0.1 so far.", [], [])["environment"] == "2027.0.1"
    assert extract_parsed_details("Version: 2027.0", [], [])["environment"] == "2027.0"
    assert extract_parsed_details("Seen on Windows 11 and Linux.", [], [])["environment"] == "Windows 11, Linux"


def test_jira_s_own_environment_field_is_the_environment_and_is_not_searched():
    from bugpilot.core.issue import IssueGuidance, issue_from_jira

    payload = {
        "key": "JR-12345",
        "fields": {
            "summary": "Preview keeps the previous renderer",
            "description": "The preview pane draws with the software renderer.\n\nEnvironment:\nLinux",
            "environment": {"type": "doc", "version": 1, "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "Windows 11, x86-64"}]},
            ]},
        },
    }
    issue = issue_from_jira(payload, "JR-12345", IssueGuidance())
    assert issue.details.environment == "Windows 11, x86-64\nLinux", "the field and the section, both"

    keywords = extract_issue_keywords(issue)
    searched = {term.value.lower() for term in terms_from_extraction(keywords)}
    assert not searched & {"windows", "x86-64", "linux"}
    assert {"preview", "renderer"} <= searched


def test_the_parser_s_own_log_labels_are_not_priority_text():
    issue = IssueArtifact(
        id="JR-12345",
        source="jira",
        signals=IssueSignals(error_messages=("ValueError: bad header",), log_signals=("Comment mentions log",)),
    )
    assert issue.priority_text == "ValueError: bad header"


# --- ranking ------------------------------------------------------------------------------------


def _match(keyword: str, file: str, line: int, text: str, weight: int, origins: tuple[str, ...], tier: str = "issue"):
    return Match(keyword=keyword, tier=tier, file=file, line_number=line, line=text, weight=weight, origins=origins)


def test_what_comments_match_in_one_file_adds_up_to_one_comment_identifier():
    matches = [
        _match("NightlyPipeline", "src/ops/deploy.py", 1, "class NightlyPipeline:", COMMENT_IDENTIFIER_WEIGHT, ("comment",)),
        *(_match(word, "src/ops/deploy.py", index, f"{word} here", WEIGHT_WEAK, ("comment",))
          for index, word in enumerate(("staging", "deployed", "verified", "released"), start=2)),
    ]
    ranked = _rank_related_files(matches, [], [])

    assert ranked[0].score == SECONDARY_EVIDENCE_CAP + 3, "the cap, plus the application-path bonus"
    assert f"comment and environment terms capped at {SECONDARY_EVIDENCE_CAP} points" in ranked[0].reasons


def test_issue_concepts_on_one_line_are_worth_more_than_the_same_words_apart():
    words = (("preview", ("title", "description")), ("pane", ("description",)), ("renderer", ("title", "description")))
    together = [
        _match(word, "src/render/together.py", 1, "# The preview pane keeps the renderer.", WEIGHT_PROSE, origins)
        for word, origins in words
    ]
    apart = [
        _match(word, "src/render/apart.py", index, f"# {word}", WEIGHT_PROSE, origins)
        for index, (word, origins) in enumerate(words, start=1)
    ]
    ranked = {item.file: item for item in _rank_related_files(together + apart, [], [])}

    assert ranked["src/render/together.py"].score > ranked["src/render/apart.py"].score
    assert "3 issue concepts on one line" in ranked["src/render/together.py"].reasons


def test_a_concept_counts_where_a_word_starts_never_inside_one():
    assert _starts_a_word("reopen", "# Reopening the export dialog")
    assert _starts_a_word("format", "self.selected_output_format = x")
    assert _starts_a_word("format", "outputFormat")
    assert not _starts_a_word("out", "the upload timeout")


# --- Search Confidence v2 -----------------------------------------------------------------------


def _probe(value: str, weight: int, origins: tuple[str, ...], matches: int = 3) -> TermSearchResult:
    return TermSearchResult(term=SearchTerm(value, "issue", weight, origins=origins), total_match_count=matches)


def test_one_high_file_is_no_longer_overall_high():
    """v1: any file rated high made the search High. That file here holds one of four concepts."""
    top = FileScore(file="src/foo_widget.py", score=20, confidence="high")
    top.evidence = {"foowidget": (WEIGHT_IDENTIFIER, ("description",), "identifier")}
    second = FileScore(file="src/export_dialog.py", score=18, confidence="medium")
    second.evidence = {word: (WEIGHT_PROSE, ("description",), "issue") for word in ("export", "dialog", "format")}
    probes = [
        _probe("FooWidget", WEIGHT_IDENTIFIER, ("description",)),
        *(_probe(word, WEIGHT_PROSE, ("description",)) for word in ("export", "dialog", "format")),
    ]
    level, sentences, _noise, details = _search_confidence([top, second], probes, [])

    assert level != "high"
    assert "low_coverage" in details.reasons and details.core_terms_in_top_file == 1 and details.core_terms_matched == 4
    assert any("less than half" in sentence for sentence in sentences)


def test_a_file_there_for_the_comments_is_low_confidence():
    top = FileScore(file="src/ops/deploy.py", score=12)
    top.evidence = {
        "nightlypipeline": (COMMENT_IDENTIFIER_WEIGHT, ("comment",), "identifier"),
        "staging": (WEIGHT_WEAK, ("comment",), "issue"),
        "deployed": (WEIGHT_WEAK, ("comment",), "issue"),
        "export": (WEIGHT_PROSE, ("description",), "issue"),
    }
    level, _sentences, _noise, details = _search_confidence([top], [_probe("export", WEIGHT_PROSE, ("description",))], [])

    assert level == "low"
    assert details.reasons == ("secondary_evidence_dominates",)
    assert dict(details.source_support)["comment_only"] == 3


def test_nothing_the_issue_says_matched_is_low_confidence():
    top = FileScore(file="src/a.py", score=5)
    top.evidence = {"output": (WEIGHT_WEAK, ("description",), "issue")}
    level, _sentences, _noise, details = _search_confidence([top], [_probe("output", WEIGHT_WEAK, ("description",))], [])

    assert (level, details.reasons) == ("low", ("no_core_concepts_matched",))


# --- retrieval.json, read by older and newer versions -------------------------------------------


def test_retrieval_json_gains_optional_fields_and_keeps_its_version():
    retrieval = RetrievalArtifact(
        confidence="high",
        reasons=("The best-ranked file stands clear of the next one.",),
        terms=(RetrievalTerm("format", "issue", 3, 3, 38, "specific", origins=("title", "description")),),
        related_files=(RelatedFile("src/export/format_selector.py", False, 40, "high", 5),),
        confidence_details=ConfidenceDetails(
            reasons=("core_concepts_concentrated", "clear_margin"),
            core_terms_matched=4, core_terms_in_top_file=3, core_terms_in_top_3=4,
            strong_terms_in_top_file=1, phrase_in_top_file=True,
            source_support=(("core", 3), ("user_keyword", 0), ("hint", 0), ("comment_only", 1), ("environment_only", 0)),
            top_file_margin=1.82, agreeing_top_files=1,
        ),
    )
    data = retrieval_to_dict(retrieval)

    assert data["schema_version"] == 1, "additive fields do not bump the artifact version"
    assert data["terms"][0]["origins"] == ["title", "description"]
    assert data["confidence_details"]["version"] == 2
    assert data["confidence_details"]["core_term_coverage"] == {"matched": 4, "top_file": 3, "top_3": 4}
    assert retrieval_from_dict(data, "JR-12345") == retrieval

    # A file written before 0.1.3 has neither, and reads as it always did.
    del data["confidence_details"]
    del data["terms"][0]["origins"]
    older = retrieval_from_dict(data, "JR-12345")
    assert older.confidence_details is None and older.terms[0].origins == ()
    # A section of another version is no section, never a failure.
    data["confidence_details"] = {"version": 99, "reasons": ["x"]}
    assert retrieval_from_dict(data, "JR-12345").confidence_details is None


# --- Git History ---------------------------------------------------------------------------------


def test_a_comment_only_term_does_not_search_commit_messages_unless_the_software_printed_it():
    extracted = {
        "high_value_keywords": ["NightlyPipeline", "ExportFormatSelector"],
        "term_origins": {"nightlypipeline": ["comment"], "exportformatselector": ["description"]},
    }
    assert select_extracted_terms(extracted) == ("ExportFormatSelector",)
    assert select_extracted_terms({**extracted, "priority_keywords": ["NightlyPipeline"]}) == (
        "NightlyPipeline", "ExportFormatSelector",
    )


def test_ranked_files_without_relevant_evidence_earn_their_commits_nothing(tmp_path):
    retrieval = RetrievalArtifact(
        terms=(
            RetrievalTerm("format", "issue", 3, 3, 9, "specific", origins=("title", "description")),
            RetrievalTerm("verified", "issue", 1, 1, 4, "specific", origins=("comment",)),
            RetrievalTerm("legacy", "issue", 2, 2, 4, "specific"),
        ),
        related_files=(
            RelatedFile("src/a.py", False, 20, "medium", 3, matched_keywords=("format",)),
            RelatedFile("src/b.py", False, 9, "medium", 2, matched_keywords=("verified",)),
            RelatedFile("docs/c.md", True, 8, "low", 2, matched_keywords=("format",)),
            RelatedFile("src/d.py", False, 7, "medium", 1, matched_keywords=("legacy",)),
        ),
    )
    weak = weak_ranked_files(retrieval)
    assert weak == ("src/b.py", "docs/c.md"), "comment-only, and a low-confidence path; an older term still counts"

    candidates = file_candidates(
        tmp_path, GitHistoryQuery(ranked_files=tuple(item.file for item in retrieval.related_files), weak_ranked_files=weak)
    )
    assert [(candidate.path, candidate.rank) for candidate in candidates] == [("src/a.py", 1), ("src/d.py", 4)], (
        "the others keep their Code Search rank"
    )


@pytest.fixture(scope="module")
def synthetic_history(tmp_path_factory):
    root = tmp_path_factory.mktemp("synthetic-history")
    return root, retrieval_corpus.build_synthetic_history(root)


def _history(name: str, synthetic_history):
    root, hashes = synthetic_history
    case = next(case for case in retrieval_corpus.SYNTHETIC_CORPUS if case.name == name)
    return retrieval_corpus.run_history_case(case, root, hashes)


@requires_search
@pytest.mark.parametrize(
    "name, noise",
    [
        ("synthetic-comment-noise", "NightlyPipeline: mark staging runs verified"),
        ("synthetic-comment-noise-identifier", "NightlyPipeline: mark staging runs verified"),
        ("synthetic-environment-noise", "Platform notes for Windows 11 x86-64"),
    ],
)
def test_git_history_does_not_amplify_comment_or_environment_noise(name, noise, synthetic_history):
    """Before 0.1.3 every one of these commits was retained (§42.3)."""
    result = _history(name, synthetic_history)

    assert noise not in [subject for subject, _score, _reasons in result.commits]
    assert "NightlyPipeline" not in result.extracted_terms


@requires_search
def test_the_issue_s_own_evidence_still_finds_its_commits(synthetic_history):
    mixed = _history("synthetic-mixed-description-comments", synthetic_history)
    assert "Keep the output format when the export dialog is reopened" in [subject for subject, *_ in mixed.commits]
    assert {"ExportFormatSelector", "on_dialog_reopened"} <= set(mixed.extracted_terms)

    identifier = _history("synthetic-identifier-led", synthetic_history)
    assert {"ThumbnailCache", "invalidate_stale_entries"} <= set(identifier.extracted_terms)


# --- Context Quality v2 ---------------------------------------------------------------------------


def test_context_quality_is_capped_without_steps_actual_or_expected():
    cases = retrieval_corpus.context_quality_cap_cases()

    # (overall, issue completeness, retrieval quality, repository context, cap)
    assert cases["cap-all-three-missing"] == (MISSING_CORE_EVIDENCE_CAP, 50, 100, 100, MISSING_CORE_EVIDENCE_CAP)
    assert MISSING_CORE_EVIDENCE_CAP < 90, "materially below what v1 gave such a report"
    assert cases["cap-expected-result-only"] == (86, 65, 100, 100, None)
    assert cases["cap-all-three-present"] == (100, 100, 100, 100, None)
    # Not invalid: lower Issue Completeness, said honestly.
    assert cases["cap-one-line-hand-written"] == (70, 25, 100, 100, MISSING_CORE_EVIDENCE_CAP)


def test_the_context_shows_every_component_and_the_cap():
    issue = _jira("Export dialog forgets the output format", "Choose FormatB and reopen the dialog.")
    retrieval = RetrievalArtifact(
        confidence="medium",
        related_files=(RelatedFile("src/export/format_selector.py", False, 18, "medium", 4),),
        confidence_details=ConfidenceDetails(core_terms_matched=4, core_terms_in_top_file=2, strong_terms_in_top_file=1),
    )
    quality = context_quality(issue, {"high_value_keywords": ["FormatB"]}, retrieval, "", None)
    text = build_context(issue, {"high_value_keywords": ["FormatB"]}, retrieval)

    # 25 for the description; 35 + 25 * 2/4 + 15; no git, no similar fix.
    assert (quality.issue_completeness, quality.retrieval_quality, quality.repository_context) == (25, 63, 0)
    assert quality.overall == round(0.4 * 25 + 0.4 * 63)
    for line in (
        f"Overall: {quality.overall}/100",
        "Issue completeness: 25/100",
        "Retrieval quality: 63/100",
        "Repository context: 0/100",
        "- Reproduction steps found: no",
        "- Related files found: 1 (search confidence: medium)",
        "- Issue concepts in the best-ranked file: 2 of 4",
        f"- Overall at most {MISSING_CORE_EVIDENCE_CAP}: the report has no reproduction steps, actual result or expected result.",
    ):
        assert line in text, line
