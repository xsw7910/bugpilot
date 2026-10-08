"""Ripgrep-based code search and related file ranking."""

from __future__ import annotations

import subprocess
from collections import defaultdict
from dataclasses import dataclass, field, replace
from pathlib import Path

from .code_files import is_documentation, is_implementation, is_searchable, search_globs
from .executables import child_environment, find_executable
from .git_ops import command_available
from .models import InvestigationOptions
from .retrieval import RelatedFile, RetrievalArtifact, RetrievalTerm, Snippet
from .search_terms import (
    WEIGHT_IDENTIFIER,
    WEIGHT_PROSE,
    WEIGHT_WEAK,
    SearchTerm,
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

    if not command_available("rg"):
        return _retrieval([], [], ["rg is unavailable; code search was skipped."], options)

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
    confidence, reasons, noise_indicators = _overall_quality(related, warnings)
    return RetrievalArtifact(
        confidence=confidence,
        reasons=tuple(reasons),
        noise_indicators=tuple(noise_indicators),
        terms=tuple(_term_diagnostics(probes)),
        related_files=tuple(related),
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
    result.retained_matches = [replace(match, weight=weight) for match in matches]
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
    # run because the repository is the working directory.
    program = find_executable(args[0])
    if program is None:
        warnings.append(f"Search failed for keyword `{keyword}`: rg was not found on PATH.")
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
        else:
            stats[0] += 1
        item.matched_keywords.add(match.keyword)
        item.match_count += 1
        if len(item.snippets) < MAX_SNIPPETS_PER_FILE:
            item.snippets.append(match)
        if match.tier == "phrase" and "exact phrase match" not in item.reasons:
            item.reasons.append("exact phrase match")

    for file, keyword_map in per_keyword.items():
        item = scores[file]
        base = Path(file).name.lower()
        distinct_high = 0
        for keyword, (count, weight, quality) in keyword_map.items():
            # Diminishing returns: repeated hits of the SAME keyword add little,
            # so 100x a common name can't outweigh a few specific matches.
            item.score += int(round(weight * (1.0 + min(count - 1, 4) * 0.25)))
            item.keyword_quality_counts[quality] += 1  # distinct keywords, not raw hits
            if quality == "high":
                distinct_high += 1
                stem = keyword.split("::", 1)[0].rsplit(".", 1)[0]
                if len(stem) >= 4 and stem in base:
                    item.score += 6  # the file *is* the matched class/name
                    if "keyword matches file name" not in item.reasons:
                        item.reasons.append("keyword matches file name")
        # Breadth: matching several DISTINCT high-value keywords is a strong,
        # precision-friendly signal that this is the right spot.
        if distinct_high >= 2:
            item.score += (distinct_high - 1) * 3
            item.reasons.append(f"matched {distinct_high} distinct high-value keywords")

    _apply_header_implementation_bonus(scores)
    for item in scores.values():
        _apply_path_adjustments(item)
        _apply_focus_bonus(item, focus_files or [])
        _assign_confidence(item)
    # The only place the file cap is applied, so a caller's max_files cannot be
    # honored in one view of the results and ignored in another.
    ordered = sorted(list(scores.values()), key=lambda item: (-item.score, item.file))
    return _select_with_reserved_slots(ordered, max_files)


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


def _overall_quality(related: list[RelatedFile], warnings: list[str]) -> tuple[str, list[str], list[str]]:
    """Confidence, the reasons for it, and the noisy-path flags seen."""
    high_files = [item.file for item in related if item.confidence == "high"]
    medium_files = [item.file for item in related if item.confidence == "medium"]
    low_files = [item.file for item in related if item.confidence == "low"]
    noise_indicators = sorted({flag for item in related for flag in item.noise_flags})
    reasons: list[str] = []
    if high_files:
        confidence = "high"
        reasons.append("At least one high-confidence application source file was found.")
    elif medium_files:
        confidence = "medium"
        reasons.append("Some plausible application or implementation files were matched.")
    else:
        confidence = "low"
        reasons.append("No high-confidence application source file was found.")

    if related and len(low_files) >= max(1, len(related) // 2) and not high_files:
        reasons.append("Matches are mostly from low-value keywords or weak candidates.")
        confidence = "low" if not medium_files else confidence
    if noise_indicators:
        reasons.append("Several matches appear in build/CI/license/vendor/docs/generated paths.")
        if not high_files:
            confidence = "low"
    if not related:
        confidence = "low"
        reasons.append("No related files were found.")
    reasons.extend(warnings)
    return confidence, reasons, noise_indicators
