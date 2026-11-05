"""Ripgrep-based code search and related file ranking."""

from __future__ import annotations

import subprocess
from collections import defaultdict
from dataclasses import dataclass, field, replace
from pathlib import Path

from .code_files import is_documentation, is_implementation, is_searchable, search_globs
from .executables import batch_file_only, child_environment, find_program, not_found_sentence
from .git_ops import program_available
from .models import InvestigationOptions
from .retrieval import ConfidenceDetails, RelatedFile, RetrievalArtifact, RetrievalTerm, Snippet
from .search_terms import (
    COMMENT_IDENTIFIER_WEIGHT,
    CORE_ORIGINS,
    WEIGHT_IDENTIFIER,
    WEIGHT_PROSE,
    WEIGHT_SHAPE,
    WEIGHT_WEAK,
    SearchTerm,
    is_secondary_only,
    shape_candidates,
    terms_from_extraction,
)


#: Derived, never hand-written: `code_files` is the one list, and this used to be
#: a second one that had drifted nine extensions away from it.
INCLUDE_GLOBS = search_globs()
EXCLUDE_DIRS = [
    ".git",
    "build",
    "out",
    "node_modules",
    "vcpkg",
    "third_party",
    "external",
    ".ai",
    ".ai_memory",
    ".venv",
    "__pycache__",
]
# The retained evidence for one term, counted in *files* rather than lines.
#
# Counting lines was the single worst defect §33 found, and it was invisible:
# ripgrep walks in directory order, so the first 20 lines of a term with 76
# matches are whatever it happened to reach first. `bugpilot/core/fix_mode_state.py`
# contains `persisted` nine times and `FixMode` twenty-four, and was never
# retained for either — its hits sat past the line budget, which had already
# been spent in `bugpilot/cli.py`. A term's evidence should span the repository,
# not its first few directories.
MAX_FILES_PER_TERM = 20
MAX_MATCHES_PER_FILE_PER_TERM = 3
# A broad term gets a much smaller share of that budget. Spreading evidence
# helps a term that names something and hurts one that is everywhere: measured,
# giving broad terms the full budget moved `fix-mode-persistence` from absent to
# rank 6 and simultaneously pushed `identifier-persist-fix-mode` from 3 to 7,
# because sixty matches of `Mode` across twenty files score twenty files.
BROAD_TERM_FILE_BUDGET = 4
# Above this many repository matches, a term stops discriminating and is scored
# as the weakest thing there is (§33.4).
#
# Measured, not guessed. Over the §33.1 corpus against this repository: 58 terms,
# median 193 matches, deciles [12, 27, 40, 76, 193, 308, 512, 791, 2254]. The two
# genuinely specific terms — `persist_fix_mode` (12) and `fix_mode.json` (19) —
# sit in the bottom two deciles, three orders of magnitude below `Fix` (3,472)
# and `Mode` (4,150).
#
# The anchor is the median: a term matching more often than the typical term in
# a bug report is not telling you much. 250 is just above it.
#
# A sweep over the corpus (100/150/200/250/300/400/500/800/1200) put top-5
# recall between 1/5 and 3/5 with no sharp edge — 250 was the best and 200 and
# 300 were one case behind. That flatness is the honest reading: six cases
# cannot resolve this constant finely, and picking the argmax of six would be
# fitting the ranker to them. Re-derive it with `tests/retrieval_corpus.py` on a
# larger corpus, especially a C++/Qt one, where the distribution will differ.
BROAD_MATCH_THRESHOLD = 250
MAX_SNIPPETS_PER_FILE = 5
MAX_TOTAL_RELATED_FILES = 10
# How many of the files that reach `context.md` are kept for implementation.
#
# Measured before this existed (§33.1): documentation held 15 of the 30 top-5
# slots across the corpus, because prose terms match prose files and `.md` is
# searched. The answer is not to stop searching documentation — a design note
# naming the subsystem is a real lead — but to stop it taking the seats that
# decide what an agent reads. Three of five: enough that implementation leads,
# few enough that a genuinely better document still appears.
RESERVED_IMPLEMENTATION_SLOTS = 3
# Large enough to outrank keyword evidence: an explicit --focus-file is a
# stronger signal than any automatic ranking heuristic.
FOCUS_FILE_BONUS = 25
#: The most that terms only the comments or the environment use add to one
#: file, together: what one identifier a comment names is worth (§42.3).
#: Repeating a pipeline's name in four comments made its module outrank the
#: file the issue described.
SECONDARY_EVIDENCE_CAP = COMMENT_IDENTIFIER_WEIGHT
#: Per issue concept beyond the first that one matched line holds (§42.3).
CONCEPTS_TOGETHER_POINTS = 2
MAX_CONCEPTS_TOGETHER_BONUS = 6
#: Written once: `_select_with_reserved_slots` reads it to know what not to demote.
FOCUS_REASON = "developer marked this file as a focus area"
LOW_VALUE_KEYWORDS = {
    "crash",
    "error",
    "failed",
    "issue",
    "problem",
    "stale",
    "result",
    "results",
    "change",
    "changes",
    "update",
}
MEDIUM_VALUE_KEYWORDS = {
    "import",
    "filter",
    "search",
    "export",
    "volume",
    "project",
}
NOISE_PATH_INDICATORS = {
    ".github": "build_or_ci_path",
    ".gitlab": "build_or_ci_path",
    "ci": "build_or_ci_path",
    "build": "build_or_ci_path",
    "out": "build_or_ci_path",
    "cmake": "build_or_ci_path",
    "scripts/build": "build_or_ci_path",
    "license": "license_or_sdk_path",
    "licensing": "license_or_sdk_path",
    "sdk": "license_or_sdk_path",
    "third_party": "vendor_or_external_path",
    "external": "vendor_or_external_path",
    "vendor": "vendor_or_external_path",
    "generated": "generated_path",
    "auto_generated": "generated_path",
    "testdata": "testdata_path",
    "docs": "docs_or_examples_path",
    "documentation": "docs_or_examples_path",
    "examples": "docs_or_examples_path",
    "sample": "docs_or_examples_path",
}
APPLICATION_PATH_INDICATORS = {
    "src",
    "source",
    "lib",
    "app",
    "modules",
    "plugins",
}

# Test directories. Not noise — a test that names the broken behaviour is one of
# the best leads there is — but not an implementation either, and "high
# confidence" is read as "the implementation is here".
#
# Found on real data: a test fixture quoting a Jira issue's own prose produced an
# exact phrase match, which is the strongest per-file signal there is, and that
# one file flipped the whole search from low to high confidence. Test names and
# comments routinely quote ticket text, so this is not a quirk of testing
# bugpilot on itself.
TEST_PATH_INDICATORS = {"test", "tests", "spec", "specs", "__tests__", "testing"}


@dataclass
class TermSearchResult:
    """What one term found, and how much of the repository it touched.

    `total_match_count` and `retained_matches` are different questions. The
    first says whether the term discriminates; the second is the evidence shown
    downstream. Keeping thousands of Match records to learn "this term is
    everywhere" would be paying in memory for a number rg already printed.
    """

    term: SearchTerm
    total_match_count: int
    retained_matches: list["Match"] = field(default_factory=list)

    @property
    def classification(self) -> str:
        if self.total_match_count == 0:
            return "zero"
        return "broad" if self.total_match_count > BROAD_MATCH_THRESHOLD else "specific"

    @property
    def effective_weight(self) -> int:
        """What this term is worth once the repository has had its say.

        A broad term is demoted rather than dropped: it may still be the only
        thread connecting a file to the report, and removing it outright would
        trade a precision problem for a recall one.
        """
        if self.classification == "broad":
            return WEIGHT_WEAK
        return self.term.weight


@dataclass
class Match:
    keyword: str
    tier: str
    file: str
    line_number: int
    line: str
    #: What the term was worth (§33.3). 0 means a caller built this Match without
    #: a term — the legacy tier path below still scores those.
    weight: int = 0
    #: The report fields the term came from (§42.3); empty without a term.
    origins: tuple[str, ...] = ()


@dataclass
class FileScore:
    file: str
    score: int = 0
    matched_keywords: set[str] = field(default_factory=set)
    match_count: int = 0
    snippets: list[Match] = field(default_factory=list)
    confidence: str = "low"
    reasons: list[str] = field(default_factory=list)
    noise_flags: list[str] = field(default_factory=list)
    keyword_quality_counts: dict[str, int] = field(default_factory=lambda: {"high": 0, "medium": 0, "low": 0})
    #: Each matched term (lowercase) -> what it was worth, where it came from
    #: and its source: what Search Confidence reads (§42.3).
    evidence: dict[str, tuple[int, tuple[str, ...], str]] = field(default_factory=dict)
    #: The matched lines, by line number: where concepts are seen together.
    lines: dict[int, str] = field(default_factory=dict)
    #: The most of the issue's own concepts any one matched line holds.
    concepts_together: int = 0
    #: Matched terms the file is named after (`WidgetFoo` in `WidgetFoo.cpp`).
    names: set[str] = field(default_factory=set)


def run_code_search(
    repo_root: Path,
    keywords: dict[str, object],
    options: InvestigationOptions | None = None,
) -> RetrievalArtifact:
    """Search the repository for the extracted terms and rank what they hit.

    ``keywords`` is the extractor's output, handed over in memory by the step
    that produced it. The result is the whole retrieval, ready to persist.
    """
    options = options or InvestigationOptions()
    high_value = _keyword_list(keywords.get("high_value_keywords", []))
    normal = _keyword_list(keywords.get("normal_keywords", []))

    if not program_available("rg"):
        reason = "" if batch_file_only("rg") is None else f" {not_found_sentence('rg')}"
        return _retrieval([], [], [f"rg is unavailable; code search was skipped.{reason}"], options)

    # §33.3: one weighted list, ordered by what each term is worth, instead of
    # four tiers whose membership was decided by position.
    terms = terms_from_extraction(
        keywords, user_keywords=list(options.keywords or []), hint=options.hint or ""
    )
    all_matches: list[Match] = []
    warnings: list[str] = []
    probes: list[TermSearchResult] = []
    for term in terms:
        probe = _probe_term(repo_root, term, warnings)
        probes.append(probe)
        # A term that matches nothing contributes nothing; it is kept in
        # `probes` so the diagnostics can say it was tried and found wanting.
        all_matches.extend(probe.retained_matches)

    # §33.7B: identifier shapes assembled from adjacent words — `output type`
    # becoming `outputType`. Every one is a string this code made up, so each is
    # probed and only the ones the repository actually contains are admitted.
    # A shape with no matches is discarded here and never reaches the ranker.
    for term in shape_candidates(
        keywords, hint=options.hint or "", already={probe.term.key for probe in probes}
    ):
        probe = _probe_term(repo_root, term, warnings)
        probes.append(probe)
        if probe.total_match_count:
            all_matches.extend(probe.retained_matches)

    all_matches = [match for match in all_matches if not _matches_any_path(match.file, options.ignore_paths)]
    ranked = _rank_related_files(
        all_matches, high_value, normal, max_files=options.max_files, focus_files=options.focus_files
    )
    if not ranked:
        warnings.append("No code search results found for extracted keywords.")
    return _retrieval(probes, ranked, warnings, options)


def _retrieval(
    probes: list[TermSearchResult],
    ranked: list[FileScore],
    warnings: list[str],
    options: InvestigationOptions,
) -> RetrievalArtifact:
    related = _related_files(ranked, options.max_search_lines)
    confidence, reasons, noise_indicators, details = _search_confidence(ranked, probes, warnings)
    return RetrievalArtifact(
        confidence=confidence,
        reasons=tuple(reasons),
        noise_indicators=tuple(noise_indicators),
        terms=tuple(_term_diagnostics(probes)),
        related_files=tuple(related),
        confidence_details=details,
    )


def _term_diagnostics(probes: list[TermSearchResult]) -> list[RetrievalTerm]:
    """What each term was worth, what it matched, and what that did to it.

    Beside the files in the same artifact: "should I trust this search" and
    "half your terms match four thousand lines each" are the same question.
    """
    return [
        RetrievalTerm(
            value=probe.term.value,
            source=probe.term.source,
            weight=probe.term.weight,
            effective_weight=probe.effective_weight,
            match_count=probe.total_match_count,
            classification=probe.classification,
            # Why this term exists at all, and whether it survived. Only a
            # generated shape has an answer to the first; everything else was
            # simply present in the text.
            derived_from=probe.term.derived_from,
            status="dropped" if probe.total_match_count == 0 else "retained",
            origins=probe.term.origins,
        )
        for probe in probes
    ]


def _related_files(ranked: list[FileScore], max_search_lines: int) -> list[RelatedFile]:
    snippets = _budgeted_snippets(ranked, max_search_lines)
    return [
        RelatedFile(
            file=item.file,
            # Why a file sits where it does: §33.2 keeps the leading slots for
            # implementation, and without this the artifact cannot show it.
            documentation=is_documentation(item.file),
            score=item.score,
            confidence=item.confidence,
            match_count=item.match_count,
            matched_keywords=tuple(sorted(item.matched_keywords)),
            reasons=tuple(item.reasons),
            noise_flags=tuple(item.noise_flags),
            snippets=kept,
        )
        for item, kept in zip(ranked, snippets)
    ]


def _budgeted_snippets(ranked: list[FileScore], max_search_lines: int) -> list[tuple[Snippet, ...]]:
    """Each file's matched lines, under the line budget the report used to spend.

    `max_search_lines` bounds what an agent has to read, and it used to be spent
    rendering `code_search.md`: two lines of heading per file, one per matched
    line, one blank after. The same arithmetic decides what is kept here, so the
    option still bounds the evidence even though the report is gone.
    """
    kept: list[tuple[Snippet, ...]] = []
    budget = max_search_lines
    for item in ranked:
        if budget <= 0:
            kept.append(())
            continue
        budget -= 2
        lines: list[Snippet] = []
        for match in item.snippets:
            if budget <= 0:
                break
            lines.append(Snippet(line=match.line_number, text=match.line))
            budget -= 1
        budget -= 1
        kept.append(tuple(lines))
    return kept


def _keyword_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def _probe_term(repo_root: Path, term: SearchTerm, warnings: list[str]) -> TermSearchResult:
    """Search for one term, keeping both what it found and how much it touched.

    One ripgrep run, read twice: once to count, once to retain. How much is
    retained depends on what the count said — a term that names something earns
    evidence from across the repository, a term that is everywhere does not.
    """
    completed = _run_rg(repo_root, term.value, warnings)
    if completed is None:
        return TermSearchResult(term=term, total_match_count=0)

    _sample, total = _collect(completed.stdout, term.value, term.source, max_files=0)
    budget = BROAD_TERM_FILE_BUDGET if total > BROAD_MATCH_THRESHOLD else MAX_FILES_PER_TERM
    matches, _total = _collect(completed.stdout, term.value, term.source, max_files=budget)

    result = TermSearchResult(term=term, total_match_count=total)
    weight = result.effective_weight
    result.retained_matches = [replace(match, weight=weight, origins=term.origins) for match in matches]
    return result


def _run_rg(repo_root: Path, keyword: str, warnings: list[str]):
    """Run ripgrep for one literal term, or report why it could not."""
    args = ["rg", "--line-number", "--no-heading", "--ignore-case", "--fixed-strings"]
    for glob in INCLUDE_GLOBS:
        args.extend(["-g", glob])
    for directory in EXCLUDE_DIRS:
        args.extend(["-g", f"!{directory}/**"])
    # `--` ends the flags. Without it a keyword that starts with a dash is read
    # by rg as one: `-Wall` produces "rg: unrecognized flag -W", exit 2, and the
    # keyword is silently dropped into a warning nobody reads. Compiler flags,
    # CLI options and switch names are exactly the terms a bug report is about.
    args.append("--")
    args.append(keyword)
    args.append(".")

    # Started by its absolute PATH location: a repository's own rg.exe must not
    # run because the repository is the working directory. And never as a batch
    # file: the keyword is the issue's text, and cmd.exe would act on it (S-8).
    program = find_program(args[0])
    if program is None:
        warnings.append(f"Search failed for keyword `{keyword}`: {not_found_sentence('rg')}")
        return None
    try:
        completed = subprocess.run(
            [program, *args[1:]],
            cwd=repo_root,
            env=child_environment(),
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=20,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        warnings.append(f"Search failed for keyword `{keyword}`: {exc}")
        return None

    if completed.returncode not in {0, 1}:
        warnings.append(f"Search failed for keyword `{keyword}`: {completed.stderr.strip()}")
        return None

    return completed


def _collect(
    stdout: str, keyword: str, tier: str, max_files: int = MAX_FILES_PER_TERM
) -> tuple[list[Match], int]:
    """Bounded evidence, unbounded count — and the budget spread across files.

    Sorted before anything is kept, because ripgrep walks directories in
    parallel and its output order is not stable between runs. With a per-file
    budget that order decides *which* files a broad term retains, so two
    identical searches of an unchanged tree returned different rankings — caught
    by running the §33.1 corpus twice. A search an agent depends on has to be
    reproducible, and sorting costs one pass over output already in memory.
    """
    parsed_lines = []
    total = 0
    for line in stdout.splitlines():
        parsed = _parse_rg_line(line)
        if parsed is None:
            continue
        path, line_number, text = parsed
        if not _is_included_path(path):
            continue
        total += 1
        parsed_lines.append((path, line_number, text))

    matches: list[Match] = []
    per_file: dict[str, int] = {}
    for path, line_number, text in sorted(parsed_lines, key=lambda item: (item[0], item[1])):
        seen = per_file.get(path, 0)
        if seen >= MAX_MATCHES_PER_FILE_PER_TERM:
            continue
        if seen == 0 and len(per_file) >= max_files:
            continue
        per_file[path] = seen + 1
        matches.append(
            Match(keyword=keyword, tier=tier, file=path, line_number=line_number, line=text.strip())
        )
    return matches, total


def _parse_rg_line(line: str) -> tuple[str, int, str] | None:
    parts = line.split(":", 2)
    if len(parts) != 3:
        return None
    path, line_number, text = parts
    try:
        normalized = path.replace("\\", "/")
        if normalized.startswith("./"):
            normalized = normalized[2:]
        return normalized, int(line_number), text
    except ValueError:
        return None


def _is_included_path(path: str) -> bool:
    return is_searchable(path)


def _match_weight(match: Match, high_set: set[str], normal_set: set[str]) -> tuple[int, str]:
    """Per-keyword weight + quality. Specificity beats frequency: an exact
    phrase or a qualified `Foo::bar` name is near-unique and weighted highest."""
    if match.weight:
        # §33.3: the term already knows what it is worth, from its own shape and
        # provenance rather than from which list it landed in. Quality is the
        # same three bands the confidence rules have always read.
        if match.weight >= WEIGHT_IDENTIFIER:
            return match.weight, "high"
        if match.weight >= WEIGHT_PROSE:
            return match.weight, "medium"
        return match.weight, "low"
    if match.tier == "phrase":
        return 12, "high"
    if match.tier == "expanded":
        return 1, "low"
    if "::" in match.keyword:
        return 10, "high"
    keyword = match.keyword.lower()
    quality = _keyword_quality(match.keyword, keyword in high_set, keyword in normal_set)
    if quality == "high":
        return 6, "high"
    if quality == "medium":
        return 2, "medium"
    return 1, "low"


def _rank_related_files(
    matches: list[Match],
    high_value: list[str],
    normal: list[str],
    max_files: int = MAX_TOTAL_RELATED_FILES,
    focus_files: list[str] | None = None,
) -> list[FileScore]:
    scores: dict[str, FileScore] = {}
    high_set = {keyword.lower() for keyword in high_value}
    normal_set = {keyword.lower() for keyword in normal}

    # file -> keyword(lower) -> [count, weight, quality]
    per_keyword: dict[str, dict[str, list]] = defaultdict(dict)
    for match in matches:
        item = scores.setdefault(match.file, FileScore(file=match.file))
        weight, quality = _match_weight(match, high_set, normal_set)
        stats = per_keyword[match.file].get(match.keyword.lower())
        if stats is None:
            per_keyword[match.file][match.keyword.lower()] = [1, weight, quality]
            item.evidence[match.keyword.lower()] = (weight, match.origins, match.tier)
        else:
            stats[0] += 1
        item.matched_keywords.add(match.keyword)
        item.match_count += 1
        item.lines.setdefault(match.line_number, match.line)
        if len(item.snippets) < MAX_SNIPPETS_PER_FILE:
            item.snippets.append(match)
        if match.tier == "phrase":
            # A quoted message is exact text; a quoted message only a comment
            # carried is worth less (§42.3) and says so.
            reason = "matched a phrase quoted in a comment" if is_secondary_only(match.origins) else "exact phrase match"
            if reason not in item.reasons:
                item.reasons.append(reason)

    for file, keyword_map in per_keyword.items():
        item = scores[file]
        base = Path(file).name.lower()
        distinct_high = 0
        secondary_points = 0
        for keyword, (count, weight, quality) in keyword_map.items():
            # Diminishing returns: repeated hits of the SAME keyword add little,
            # so 100x a common name can't outweigh a few specific matches.
            points = int(round(weight * (1.0 + min(count - 1, 4) * 0.25)))
            if is_secondary_only(item.evidence[keyword][1]):
                secondary_points += points
            else:
                item.score += points
            item.keyword_quality_counts[quality] += 1  # distinct keywords, not raw hits
            if quality == "high":
                distinct_high += 1
                stem = keyword.split("::", 1)[0].rsplit(".", 1)[0]
                if len(stem) >= 4 and stem in base:
                    item.score += 6  # the file *is* the matched class/name
                    item.names.add(keyword)
                    if "keyword matches file name" not in item.reasons:
                        item.reasons.append("keyword matches file name")
        # Comments and the environment are evidence, never the subject (§42.3):
        # whatever they matched in one file adds up to one comment identifier's worth.
        item.score += min(secondary_points, SECONDARY_EVIDENCE_CAP)
        if secondary_points > SECONDARY_EVIDENCE_CAP:
            item.reasons.append(f"comment and environment terms capped at {SECONDARY_EVIDENCE_CAP} points")
        # Breadth: matching several DISTINCT high-value keywords is a strong,
        # precision-friendly signal that this is the right spot.
        if distinct_high >= 2:
            item.score += (distinct_high - 1) * 3
            item.reasons.append(f"matched {distinct_high} distinct high-value keywords")
        # Together: the issue's own concepts on one line — "the preview pane
        # keeps the renderer" — is a phrase the code wrote, wherever it is.
        item.concepts_together = _concepts_together(item)
        if item.concepts_together >= 2:
            item.score += min((item.concepts_together - 1) * CONCEPTS_TOGETHER_POINTS, MAX_CONCEPTS_TOGETHER_BONUS)
            item.reasons.append(f"{item.concepts_together} issue concepts on one line")

    _apply_header_implementation_bonus(scores)
    for item in scores.values():
        _apply_path_adjustments(item)
        _apply_focus_bonus(item, focus_files or [])
        _assign_confidence(item)
    # The only place the file cap is applied, so a caller's max_files cannot be
    # honored in one view of the results and ignored in another.
    ordered = sorted(list(scores.values()), key=lambda item: (-item.score, item.file))
    return _select_with_reserved_slots(ordered, max_files)


def _concept_keys(item: FileScore) -> list[str]:
    """The file's matched terms the issue itself says (or the developer typed), at least prose-strong."""
    return [
        keyword
        for keyword, (weight, origins, _source) in item.evidence.items()
        if weight >= WEIGHT_PROSE and _is_core(origins)
    ]


def _is_core(origins: tuple[str, ...]) -> bool:
    """The issue's own words or the developer's keyword. No recorded origins — an
    extraction that did not record them, a caller's own — reads as the issue's, as before."""
    return not origins or any(origin in CORE_ORIGINS or origin == "user-keyword" for origin in origins)


def _concepts_together(item: FileScore) -> int:
    """The most of the issue's concepts any one matched line of the file holds.

    Read from the lines the search already kept, so it costs no search. A term
    counts on a line where a word starts with it — `reopen` in "Reopening",
    `format` in `output_format` or `outputFormat` — and not inside a word: `out`
    in "timeout" is not the word out.
    """
    keys = _concept_keys(item)
    if len(keys) < 2:
        return 0
    return max((sum(1 for key in keys if _starts_a_word(key, line)) for line in item.lines.values()), default=0)


def _starts_a_word(key: str, line: str) -> bool:
    lower = line.lower()
    start = lower.find(key)
    while start >= 0:
        if start == 0 or not line[start - 1].isalnum() or (line[start - 1].islower() and line[start].isupper()):
            return True
        start = lower.find(key, start + 1)
    return False


def _select_with_reserved_slots(ordered: list[FileScore], max_files: int) -> list[FileScore]:
    """Take the top files, keeping room at the front for implementation.

    Score order is otherwise untouched: this decides *which* files survive the
    cap and in what order, not what any of them scored.

    Files the developer pointed at go first whatever they are. A --focus-file is
    an instruction, and a reservation that could demote one would be this
    function quietly overruling it.
    """
    pinned = [item for item in ordered if FOCUS_REASON in item.reasons]
    rest = [item for item in ordered if FOCUS_REASON not in item.reasons]
    implementation = [item for item in rest if is_implementation(item.file)]

    reserved_count = max(0, min(RESERVED_IMPLEMENTATION_SLOTS, max_files - len(pinned)))
    reserved = implementation[:reserved_count]
    taken = {id(item) for item in pinned} | {id(item) for item in reserved}
    remainder = [item for item in ordered if id(item) not in taken]

    selected = pinned + reserved
    return (selected + remainder)[:max_files]


def _matches_any_path(path: str, patterns: list[str]) -> bool:
    """True when ``path`` is covered by one of the user's path patterns.

    A pattern may be a directory prefix (``src/reader``), a full relative path,
    or a bare file name (``CsvReader.cpp``). Comparison is case-insensitive and
    separator-agnostic so a Windows-style pattern still matches rg's output.
    """
    if not patterns:
        return False
    normalized = path.replace("\\", "/").lower().lstrip("./")
    for pattern in patterns:
        candidate = (pattern or "").replace("\\", "/").strip().lower().lstrip("./").rstrip("/")
        if not candidate:
            continue
        if normalized == candidate or normalized.startswith(candidate + "/"):
            return True
        if "/" not in candidate and normalized.rsplit("/", 1)[-1] == candidate:
            return True
    return False


def _apply_focus_bonus(item: FileScore, focus_files: list[str]) -> None:
    """Lift files the developer pointed at, without hiding anything else.

    A boost rather than a filter: focus is a steer, and silently dropping every
    unlisted file would turn a wrong guess into an empty search with no signal
    that the guess was wrong.
    """
    if _matches_any_path(item.file, focus_files):
        item.score += FOCUS_FILE_BONUS
        item.reasons.append(FOCUS_REASON)


def _apply_header_implementation_bonus(scores: dict[str, FileScore]) -> None:
    by_stem: defaultdict[str, list[FileScore]] = defaultdict(list)
    for item in scores.values():
        path = Path(item.file)
        if path.suffix.lower() in {".h", ".hpp", ".cpp", ".cxx", ".cc"}:
            by_stem[str(path.with_suffix(""))].append(item)
    for items in by_stem.values():
        suffixes = {Path(item.file).suffix.lower() for item in items}
        if suffixes & {".h", ".hpp"} and suffixes & {".cpp", ".cxx", ".cc"}:
            for item in items:
                item.score += 2
                item.reasons.append("header/source pair bonus")


def _keyword_quality(keyword: str, in_high_value: bool, in_normal: bool) -> str:
    lower = keyword.lower()
    if lower in LOW_VALUE_KEYWORDS:
        return "low"
    if _looks_like_specific_identifier(keyword):
        return "high"
    if in_high_value and lower not in MEDIUM_VALUE_KEYWORDS:
        return "high"
    if lower in MEDIUM_VALUE_KEYWORDS or in_normal:
        return "medium"
    return "low"


def _looks_like_specific_identifier(keyword: str) -> bool:
    return (
        any(char.islower() for char in keyword) and any(char.isupper() for char in keyword)
    ) or "." in keyword or "/" in keyword or "\\" in keyword or "::" in keyword or '"' in keyword


def _apply_path_adjustments(item: FileScore) -> None:
    flags = _noise_flags(item.file)
    if flags:
        item.noise_flags = flags
        item.score -= 4
        item.reasons.append("path looks like CI/build/license/vendor/docs/generated content")
    if _is_application_path(item.file):
        item.score += 3
        item.reasons.append("matched keyword in application source path")


def _noise_flags(path: str) -> list[str]:
    normalized = path.replace("\\", "/").lower()
    parts = [part for part in normalized.split("/") if part]
    flags: set[str] = set()
    for indicator, flag in NOISE_PATH_INDICATORS.items():
        if "/" in indicator:
            if indicator in normalized:
                flags.add(flag)
        elif indicator in parts:
            flags.add(flag)
    return sorted(flags)


def _is_application_path(path: str) -> bool:
    parts = [part.lower() for part in path.replace("\\", "/").split("/") if part]
    return any(part in APPLICATION_PATH_INDICATORS for part in parts)


def _is_test_path(path: str) -> bool:
    parts = [part.lower() for part in path.replace("\\", "/").split("/") if part]
    if any(part in TEST_PATH_INDICATORS for part in parts):
        return True
    name = parts[-1] if parts else ""
    return name.startswith("test_") or name.startswith("test.") or "_test." in name


def _assign_confidence(item: FileScore) -> None:
    high = item.keyword_quality_counts["high"]
    medium = item.keyword_quality_counts["medium"]
    low = item.keyword_quality_counts["low"]
    has_app_path = _is_application_path(item.file)
    has_noise = bool(item.noise_flags)
    is_test = _is_test_path(item.file)
    # A keyword matching the file's own name, an exact phrase hit, or several
    # distinct high-value keywords is a strong signal on its own — enough for
    # high confidence even outside a recognised application-source directory.
    strong_signal = (
        "keyword matches file name" in item.reasons
        or "exact phrase match" in item.reasons
        or high >= 3
    )
    if is_test and (high or medium or low):
        # Capped at medium: still listed, still a lead, but it cannot be the
        # file that tells the reader the implementation was located.
        item.confidence = "medium"
        item.reasons.append("matched in a test path, which is a lead rather than an implementation")
        return
    if high and (has_app_path or strong_signal) and not has_noise:
        item.confidence = "high"
        item.reasons.append(
            "matched high-value keyword in application source path" if has_app_path
            else "strong file-name / phrase / multi-keyword match"
        )
    elif (high or medium) and (has_app_path or not has_noise):
        item.confidence = "medium"
        item.reasons.append("matched plausible implementation keyword")
    else:
        item.confidence = "low"
        if low and not high and not medium:
            item.reasons.append("matched only generic keyword")
        if has_noise:
            item.reasons.append("match appears in noisy path")
    if not item.reasons:
        item.reasons.append("keyword match candidate")


# --- Search Confidence v2 (0.1.3, §42.3) -------------------------------------------------
#
# v1 said High as soon as one file was rated high — one strong-looking file, for
# whatever reason, carried the whole search. v2 reads the evidence behind the
# best-ranked files: how much of what the issue itself says the top file holds,
# whether that includes something strong (an identifier, a quoted phrase, a
# confirmed shape, a keyword), whether it stands clear of the next file or the
# next files agree with it, and whether it is there for the issue's words or for
# the comments', the environment's or the hint's. Ranking is untouched: this only
# reads it. The levels and their meaning for an agent are the same three.

#: How many of the best-ranked files are read.
CONFIDENCE_TOP_FILES = 3
#: What the top file's evidence adds up to (3 per strong concept, and 3 more when
#: the file is named after one, up to 6; 1 per plain one, up to 6; 2 for a
#: phrase) for High, and for Medium.
HIGH_CONFIDENCE_POINTS = 6
MEDIUM_CONFIDENCE_POINTS = 2
#: Plain words alone — no identifier, keyword, quoted phrase, confirmed shape or
#: concepts together — are Medium only when this many of them agree on the file.
MEDIUM_PLAIN_CONCEPTS = 4
#: Weaknesses that compound: two of them leave nothing to stand on.
_COMPOUNDING_LIMITS = ("hint_dominated", "no_clear_leader", "low_coverage", "top_file_in_noisy_path")
#: The share of the issue's matched concepts the top file must hold for High.
HIGH_CONFIDENCE_COVERAGE = 0.5
#: The top file's score over the second's that makes it stand out on its own.
CLEAR_MARGIN = 1.5
#: Concepts on one line that read as a phrase the code wrote.
PHRASE_CONCEPTS_TOGETHER = 3

#: Every reason code, and the sentence the context shows for it.
CONFIDENCE_REASONS = {
    "no_related_files": "No related files were found.",
    "no_core_concepts_matched": (
        "Nothing the issue itself says matched the repository: only generic words, or words from "
        "comments or the environment."
    ),
    "top_file_has_no_core_concepts": "The best-ranked file matched none of the issue's own concepts.",
    "secondary_evidence_dominates": (
        "The best-ranked file is there mostly for words from the comments or the environment."
    ),
    "core_concepts_concentrated": "The best-ranked file holds most of the issue's concepts that matched anything.",
    "strong_terms_in_top_file": (
        "Identifiers, quoted phrases, confirmed shapes or keywords from the issue matched the best-ranked file."
    ),
    "phrase_evidence": "The issue's concepts appear together in the best-ranked file.",
    "file_named_by_issue": "The best-ranked file is named after an identifier the issue uses.",
    "clear_margin": "The best-ranked file stands clear of the next one.",
    "top_results_agree": "The next files share the best-ranked file's strongest concept.",
    "hint_dominated": "The best-ranked file is there mostly for the developer hint, which is a hypothesis.",
    "top_file_is_test": "The best-ranked file is a test: a lead, not the implementation.",
    "top_file_in_noisy_path": "The best-ranked file is in a build, CI, vendor, documentation or generated path.",
    "low_coverage": "The best-ranked file holds less than half of the issue's matched concepts.",
    "no_clear_leader": "No file stands clear of the others, and the next files share no strong concept with the first.",
    "mixed_support": "Some of what the issue says matched the best-ranked file, but not enough to be sure.",
    "sparse_core_support": "Only a little of what the issue says matched the best-ranked file.",
}
NOISY_RESULTS_REASON = "Several matches appear in build/CI/license/vendor/docs/generated paths."


def _search_confidence(
    ranked: list[FileScore], probes: list[TermSearchResult], warnings: list[str]
) -> tuple[str, list[str], list[str], ConfidenceDetails]:
    """The level, the sentences that explain it, the noisy-path flags seen, and the details."""
    noise_indicators = sorted({flag for item in ranked for flag in item.noise_flags})
    matched_core = {
        probe.term.key
        for probe in probes
        if probe.total_match_count and probe.effective_weight >= WEIGHT_PROSE and _is_core(probe.term.origins)
    }

    def finish(level: str, codes: list[str], **details) -> tuple[str, list[str], list[str], ConfidenceDetails]:
        sentences = [CONFIDENCE_REASONS[code] for code in codes]
        if noise_indicators:
            sentences.append(NOISY_RESULTS_REASON)
        sentences.extend(warnings)
        return level, sentences, noise_indicators, ConfidenceDetails(
            reasons=tuple(codes), core_terms_matched=len(matched_core), **details
        )

    if not ranked:
        return finish("low", ["no_related_files"])
    top = ranked[0]
    concepts = set(_concept_keys(top))
    strong = {key for key in concepts if top.evidence[key][0] >= WEIGHT_SHAPE}
    phrase = (
        any(top.evidence[key][2] in ("phrase", "shape_expansion") for key in concepts)
        or top.concepts_together >= PHRASE_CONCEPTS_TOGETHER
    )
    support = _source_support(top)
    second = ranked[1].score if len(ranked) > 1 else None
    margin = None if second is None else (round(top.score / second, 2) if second > 0 else None)
    agreeing = sum(1 for item in ranked[1:CONFIDENCE_TOP_FILES] if strong & set(_concept_keys(item)))
    top_3 = set().union(*(set(_concept_keys(item)) for item in ranked[:CONFIDENCE_TOP_FILES]))
    details = dict(
        core_terms_in_top_file=len(concepts),
        core_terms_in_top_3=len(top_3),
        strong_terms_in_top_file=len(strong),
        phrase_in_top_file=phrase,
        source_support=tuple(support.items()),
        top_file_margin=margin,
        agreeing_top_files=agreeing,
    )

    if not matched_core:
        return finish("low", ["no_core_concepts_matched"], **details)
    if not concepts:
        return finish("low", ["top_file_has_no_core_concepts"], **details)
    if support["comment_only"] + support["environment_only"] > len(concepts) and not strong:
        return finish("low", ["secondary_evidence_dominates"], **details)

    # The file *is* what the issue names: worth a second strong concept.
    named = bool(top.names & strong)
    points = min(3 * len(strong) + (3 if named else 0), 6) + min(len(concepts - strong), 6) + (2 if phrase else 0)
    coverage = len(concepts) / len(matched_core)
    clear = second is None or second <= 0 or top.score >= CLEAR_MARGIN * second
    codes = []
    if coverage >= HIGH_CONFIDENCE_COVERAGE:
        codes.append("core_concepts_concentrated")
    if strong:
        codes.append("strong_terms_in_top_file")
    if phrase:
        codes.append("phrase_evidence")
    if named:
        codes.append("file_named_by_issue")
    if clear:
        codes.append("clear_margin")
    elif agreeing:
        codes.append("top_results_agree")
    limits = []
    if support["hint"] >= len(concepts):
        limits.append("hint_dominated")
    if _is_test_path(top.file):
        limits.append("top_file_is_test")
    if top.noise_flags:
        limits.append("top_file_in_noisy_path")
    if coverage < HIGH_CONFIDENCE_COVERAGE:
        limits.append("low_coverage")
    if not (clear or agreeing):
        limits.append("no_clear_leader")
    if points < HIGH_CONFIDENCE_POINTS:
        limits.append("mixed_support")
    if not limits:
        return finish("high", codes, **details)
    compounding = sum(1 for code in limits if code in _COMPOUNDING_LIMITS)
    # A strong term from the hint counts here and nowhere else: enough for a
    # lead, never for High.
    hint_strong = any(
        weight >= WEIGHT_SHAPE and "hint" in origins and not _is_core(origins)
        for weight, origins, _source in top.evidence.values()
    )
    substantive = bool(strong) or phrase or hint_strong or len(concepts) >= MEDIUM_PLAIN_CONCEPTS
    if points >= MEDIUM_CONFIDENCE_POINTS and substantive and compounding < 2:
        return finish("medium", codes + limits, **details)
    return finish("low", codes + [code for code in limits if code != "mixed_support"] + ["sparse_core_support"], **details)


def _source_support(item: FileScore) -> dict[str, int]:
    """The file's distinct matched terms by where they came from, the issue's own first.

    A term without recorded origins comes from an extraction that did not
    record them (a caller's own), and is read as the issue's, as it always was.
    """
    support = {"core": 0, "user_keyword": 0, "hint": 0, "comment_only": 0, "environment_only": 0}
    for _weight, origins, _source in item.evidence.values():
        if "user-keyword" in origins:
            support["user_keyword"] += 1
        elif not origins or any(origin in CORE_ORIGINS for origin in origins):
            support["core"] += 1
        elif "hint" in origins:
            support["hint"] += 1
        elif set(origins) == {"environment"}:
            support["environment_only"] += 1
        elif is_secondary_only(origins):
            support["comment_only"] += 1
    return support
