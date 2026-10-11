"""A retrieval harness: does the search actually find the right file?

Not a test module (no `test_` prefix, so pytest does not collect it). It exists
because the question that matters about keyword extraction cannot be asked of
keyword extraction. "Did we produce sensible-looking keywords" is easy to assert
and nearly worthless; "does `bugpilot/core/fix_mode_state.py` come back in the
top three for a bug about Fix Mode persistence" is the thing a developer feels.

So every case here names an *issue* and the *files* that would help fix it, runs
the real pipeline — extract, merge, search, rank — and measures where those files
landed. What the keywords were is diagnostic output, not the assertion.

Three kinds of corpus:

- **fixture repositories**, written to a tmp_path, for anything that has to be
  deterministic (a term's breadth, an extension being searchable at all);
- **the synthetic repository** below (`SYNTHETIC_REPOSITORY`), one small
  invented product with its decoys, and `SYNTHETIC_CORPUS`: structured issues —
  title, description, comments, environment — each exercising one kind of
  retrieval trouble. Deterministic, so its ranks and confidence are pinned;
- **this repository**, for the cases worth having real code behind. Those move
  as the tree moves, which is why the baseline records ranks rather than
  asserting exact ones.

Every case is run the way a real preparation runs it (`run_case`): the issue is
normalized by the production builders, its keywords extracted by
`workflow.extract_issue_keywords`, and the search is `run_code_search` with the
options `code_search_step` would pass. Nothing here re-implements extraction.
"""

from __future__ import annotations

import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from bugpilot.core.code_files import is_documentation
from bugpilot.core.git_ops import command_available
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.issue import IssueArtifact, IssueGuidance, issue_from_jira, issue_from_spec
from bugpilot.core.models import InvestigationOptions
from bugpilot.core.retrieval import RetrievalTerm
from bugpilot.core.search import run_code_search
from bugpilot.core.workflow import extract_issue_keywords

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The two sources a work item comes from, as `issue.json` names them.
SOURCES = ("manual", "jira")
#: The search's own confidence vocabulary (`RetrievalArtifact.confidence`).
CONFIDENCES = ("high", "medium", "low")
#: When every hand-written case is "described": its local id is a timestamp, and
#: a fixed one keeps a case's issue byte-identical from run to run.
CASE_TIME = datetime(2026, 1, 1, 9, 0, 0, tzinfo=timezone.utc)
#: The Jira key every synthetic Jira case is fetched as. Retrieval never reads it.
CASE_JIRA_KEY = "JR-12345"


class RipgrepUnavailable(RuntimeError):
    """Code search needs ripgrep, and a run without it is not a measurement.

    `run_code_search` returns an empty retrieval with a warning when `rg` is
    missing, which is right for a work item and wrong for a corpus: every case
    would score "not found" and read as a regression. So the harness refuses.
    """


def require_ripgrep() -> None:
    if not command_available("rg"):
        raise RipgrepUnavailable(
            "ripgrep (rg) is not on PATH: code search cannot run, so the retrieval corpus cannot be measured."
        )


@dataclass(frozen=True)
class Observation:
    """What retrieval did for a case when it was last pinned.

    The current behaviour, recorded so a change to it is seen — not a target.
    Where retrieval should land later is `RetrievalCase.expected_confidence`.
    """

    #: The best rank any expected file reached; None when none came back.
    best_rank: int | None
    #: The search's overall confidence: `high`, `medium` or `low`.
    confidence: str


@dataclass(frozen=True)
class RetrievalCase:
    """One bug, and the files that would actually help fix it.

    For a real historical case the expected files are the ones the fixing commit
    changed — minus anything that was along for the ride. A formatting sweep, a
    regenerated file or a changelog edit appears in the diff without being what
    the bug was about, and counting those as ground truth would reward a search
    for finding the wrong thing.

    The issue is either `issue_text` — one flat text, read as a hand-written
    description, which is what every case was before structured evidence — or
    the structured fields. Structured fields are rendered the way a report
    carries them: `reproduction`, `actual`, `expected` and `environment` as the
    labelled sections of the description that the shared parser reads, and
    `comments` as a Jira issue's comments. A hand-written bug has no comments.
    """

    name: str
    issue_text: str = ""
    expected_files: tuple[str, ...] = ()
    hint: str = ""
    #: The developer's own `--keywords`, passed exactly as a run passes them.
    user_keywords: tuple[str, ...] = ()
    #: What this case is here to exercise; the baseline groups by it.
    kind: str = "general"
    #: `manual` (`bugpilot bug --description`) or `jira` (a fetched issue).
    source: str = "manual"
    title: str = ""
    description: str = ""
    comments: tuple[str, ...] = ()
    environment: str = ""
    reproduction: tuple[str, ...] = ()
    actual: str = ""
    expected: str = ""
    #: Where Search Confidence should land for this case: asserted for the
    #: synthetic corpus since Search Confidence v2 (§42.3); "" when the case
    #: makes no claim.
    expected_confidence: str = ""
    #: Terms the issue is about, reported as searched or not.
    expected_core_terms: tuple[str, ...] = ()
    #: Terms that should not be what puts a file near the top, reported when they are.
    forbidden_top_terms: tuple[str, ...] = ()
    #: The behaviour pinned at the last baseline; None for a case that drifts.
    current: Observation | None = None

    def __post_init__(self) -> None:
        if self.source not in SOURCES:
            raise ValueError(f"case {self.name}: source must be one of {SOURCES}, not {self.source!r}")
        structured = bool(
            self.title or self.description or self.comments or self.environment
            or self.reproduction or self.actual or self.expected
        )
        if self.issue_text and structured:
            raise ValueError(f"case {self.name}: give issue_text or the structured fields, not both")
        if not (self.issue_text.strip() or self.description.strip() or self.title.strip()):
            raise ValueError(f"case {self.name}: the issue has no text")
        if self.source == "manual" and self.comments:
            raise ValueError(f"case {self.name}: a hand-written bug has no comments; use source='jira'")
        if self.source == "jira" and not (self.title.strip() or self.issue_text.strip()):
            raise ValueError(f"case {self.name}: a Jira issue has a summary; give a title")
        for value in (self.expected_confidence, self.current.confidence if self.current else ""):
            if value and value not in CONFIDENCES:
                raise ValueError(f"case {self.name}: confidence must be one of {CONFIDENCES}, not {value!r}")


def _section(label: str, body: str) -> str:
    return f"{label}:\n{body.strip()}"


def issue_body(case: RetrievalCase) -> str:
    """The description a case's issue carries, its labelled sections included."""
    if case.issue_text:
        return case.issue_text.strip()
    parts = [case.description.strip()] if case.description.strip() else []
    if case.reproduction:
        steps = "\n".join(f"{index}. {step}" for index, step in enumerate(case.reproduction, start=1))
        parts.append(_section("Steps to Reproduce", steps))
    if case.actual:
        parts.append(_section("Actual Result", case.actual))
    if case.expected:
        parts.append(_section("Expected Result", case.expected))
    if case.environment:
        parts.append(_section("Environment", case.environment))
    return "\n\n".join(parts)


def issue_for(case: RetrievalCase) -> IssueArtifact:
    """The case as `issue.json` would hold it, normalized by the production builders.

    A hand-written case goes through `bug_spec_from_description` and
    `issue_from_spec` — a title derived from the first line when none is given,
    as `bugpilot bug --description` derives one. A Jira case is a fetched
    payload through `issue_from_jira`, comments in the comment field.
    """
    body = issue_body(case)
    if case.source == "manual":
        spec = bug_spec_from_description(body, case.title or None, now=CASE_TIME)
        return issue_from_spec(spec, IssueGuidance())
    payload = {
        "key": CASE_JIRA_KEY,
        "fields": {
            "summary": case.title.strip() or body.splitlines()[0],
            "description": body,
            "comment": {
                "comments": [
                    {
                        "author": {"displayName": f"Commenter {index}"},
                        "created": f"2026-01-{index:02d}T09:00:00.000+0000",
                        "body": text,
                    }
                    for index, text in enumerate(case.comments, start=1)
                ]
            },
        },
    }
    return issue_from_jira(payload, CASE_JIRA_KEY, IssueGuidance())


def case_options(case: RetrievalCase) -> InvestigationOptions:
    """The options a run with this case's hint and `--keywords` hands the search."""
    return InvestigationOptions(hint=case.hint or None, keywords=list(case.user_keywords))


@dataclass
class RetrievalResult:
    case: RetrievalCase
    #: Ranked file paths, best first, as the searcher returned them.
    ranked: list[str] = field(default_factory=list)
    #: expected file -> 1-based rank, or None when it did not appear at all.
    ranks: dict[str, int | None] = field(default_factory=dict)
    #: The terms that reached ripgrep, in search order (`retrieval.json.terms`).
    terms: list[str] = field(default_factory=list)
    duration_s: float = 0.0
    #: The search's overall confidence.
    confidence: str = "low"
    #: Every searched term as `retrieval.json` records it: source, weight, matches.
    searched: tuple[RetrievalTerm, ...] = ()
    #: The terms that matched each of the top files, best first.
    top_matched: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)

    def observation(self) -> Observation:
        return Observation(best_rank=self.best_rank, confidence=self.confidence)

    def forbidden_in_top(self, n: int = 3) -> list[str]:
        """The case's forbidden terms that matched one of the top `n` files."""
        matched = {term.casefold() for _path, terms in self.top_matched[:n] for term in terms}
        return [term for term in self.case.forbidden_top_terms if term.casefold() in matched]

    def noise_only_in_top(self, n: int = 5) -> list[str]:
        """Top-`n` files that are there only because of the case's forbidden terms.

        A file every one of whose matched terms is forbidden — the operations
        module a pipeline comment found, the hosts file a hostname found — is
        context the agent pays for and the issue never asked about.
        """
        forbidden = {term.casefold() for term in self.case.forbidden_top_terms}
        if not forbidden:
            return []
        return [
            path for path, terms in self.top_matched[:n]
            if terms and all(term.casefold() in forbidden for term in terms)
        ]

    def core_terms_searched(self) -> list[str]:
        """The case's core terms that reached the search at all."""
        searched = {term.value.casefold() for term in self.searched}
        return [term for term in self.case.expected_core_terms if term.casefold() in searched]

    @property
    def best_rank(self) -> int | None:
        """The best rank any expected file reached; None if none appeared."""
        found = [rank for rank in self.ranks.values() if rank is not None]
        return min(found) if found else None

    @property
    def reciprocal_rank(self) -> float:
        """1/rank, or 0 when nothing was found.

        The metric recall thresholds cannot express: 15 -> 6 is a real
        improvement and both are outside the top 5, so top-5 recall records it
        as nothing happening.
        """
        rank = self.best_rank
        return 1.0 / rank if rank else 0.0

    def hit_at(self, n: int) -> bool:
        rank = self.best_rank
        return rank is not None and rank <= n

    def docs_in_top(self, n: int) -> int:
        """Prose in the slots that reach the context.

        Uses the production classifier rather than a second suffix list of its
        own. The harness previously kept one, and it counted `CMakeLists.txt` as
        documentation — which would have inflated this metric on exactly the
        CMake-heavy repositories the corpus exists to measure.
        """
        return sum(1 for path in self.ranked[:n] if is_documentation(path))


def _normalize(path: str) -> str:
    return path.replace("\\", "/").lstrip("./").lower()


def run_case(case: RetrievalCase, repo_root: Path = REPO_ROOT) -> RetrievalResult:
    """Run the production retrieval for one case and measure where files land.

    The same two calls `code_search_step` makes for a work item with no
    keywords handed in: `extract_issue_keywords` over the normalized issue and
    the developer's `--keywords`, then `run_code_search` with the run's options.
    `test_retrieval_regression` holds the two to the same result.
    """
    require_ripgrep()
    issue = issue_for(case)
    options = case_options(case)
    started = time.perf_counter()
    keywords = extract_issue_keywords(issue, options.keywords)
    retrieval = run_code_search(repo_root, keywords, options)
    duration = time.perf_counter() - started

    ranked = [item.file for item in retrieval.related_files]
    lookup = {_normalize(path): index + 1 for index, path in enumerate(ranked)}
    ranks = {expected: lookup.get(_normalize(expected)) for expected in case.expected_files}

    return RetrievalResult(
        case=case,
        ranked=ranked,
        ranks=ranks,
        terms=[term.value for term in retrieval.terms],
        duration_s=duration,
        confidence=retrieval.confidence,
        searched=retrieval.terms,
        top_matched=[(item.file, item.matched_keywords) for item in retrieval.related_files],
    )


# --- the corpus --------------------------------------------------------------
#
# Cases against this repository. Chosen because the answer is knowable: each
# expected file is the one a developer would open for that bug.

CORPUS: tuple[RetrievalCase, ...] = (
    RetrievalCase(
        name="fix-mode-persistence",
        kind="natural language, known implementation file",
        issue_text="Fix Mode selection is not persisted when the run fails halfway.",
        expected_files=("bugpilot/core/fix_mode_state.py",),
    ),
    RetrievalCase(
        name="identifier-persist-fix-mode",
        kind="strong identifier",
        issue_text=(
            "persist_fix_mode writes fix_mode.json before the pipeline runs, so a "
            "half-failed resume records a mode the task file was never built under."
        ),
        expected_files=("bugpilot/core/fix_mode_state.py", "bugpilot/core/workflow.py"),
    ),
    RetrievalCase(
        name="prose-heavy-keyword-extraction",
        kind="prose heavy",
        issue_text=(
            "The keywords that come out of a bug report are not very good. Generic "
            "words are treated as important and the useful ones are ranked below them, "
            "so the files that come back are not the ones you need."
        ),
        expected_files=("bugpilot/core/keywords.py",),
    ),
    RetrievalCase(
        name="generic-terms-only",
        kind="generic terms",
        issue_text="The data process output is wrong and the volume is not updated correctly.",
        # Nothing in this repository genuinely implements that sentence. The case
        # exists to measure noise: what a bug made only of generic words retrieves.
        expected_files=(),
    ),
    RetrievalCase(
        name="atomic-write-crash",
        kind="natural language",
        issue_text=(
            "Writing the workflow status file sometimes fails on Windows when another "
            "process has it open, and the artifact is left truncated."
        ),
        expected_files=("bugpilot/core/artifact_io.py",),
    ),
    RetrievalCase(
        name="hint-points-at-the-fix",
        kind="hint carries the technical direction",
        issue_text="Improving a hint does not use the issue text.",
        hint="Look at how the issue details are loaded before the prompt is built.",
        expected_files=("extension/src/app/hintImprovement.ts",),
    ),
)


# --- the synthetic repository -----------------------------------------------
#
# One small invented product — an export dialog, an importer, preferences, a
# renderer, a cache, an uploader — with the decoys real trees have: an
# operations module that speaks pipeline-and-deploy, a license client, a hosts
# file, build scripts, CMake platform notes, release notes, a test. Every name
# is invented; the hosts are `.example.invalid`.
#
# Only the file types code search reads (`code_files.search_globs`): Python,
# CMake and Markdown. The bugs are written into comments the way real code
# carries its own hazards, so a correct retrieval has something to find.

SYNTHETIC_REPOSITORY: dict[str, str] = {
    "src/export/format_selector.py": '''"""The export dialog's output format selector."""

from src.preferences.user_preferences import UserPreferences

OUTPUT_FORMATS = ("FormatA", "FormatB", "FormatC")


class ExportFormatSelector:
    """Which output format the export dialog writes, and what it shows when reopened."""

    def __init__(self, preferences: UserPreferences):
        self.preferences = preferences
        self.selected_output_format = OUTPUT_FORMATS[0]

    def choose(self, output_format):
        if output_format in OUTPUT_FORMATS:
            self.selected_output_format = output_format
        return self.selected_output_format

    def on_dialog_reopened(self):
        # Reopening the export dialog resets the output format to the first entry.
        self.selected_output_format = OUTPUT_FORMATS[0]
''',
    "src/export/row_writer.py": '''"""Serializes exported rows for each output format."""


def write_rows(rows, output_format):
    if output_format == "FormatA":
        return "\\n".join(",".join(row) for row in rows)
    if output_format == "FormatB":
        # FormatB writes its columns as label, identifier, value.
        header = ("label", "identifier", "value")
        return "\\n".join("\\t".join(row) for row in [header, *rows])
    raise ValueError(f"unsupported output format: {output_format}")
''',
    "src/importer/input_format.py": '''"""Detects the input format of a file being imported."""

SIGNATURES = {b"FMTA": "FormatA", b"FMTB": "FormatB"}


def detect_input_format(path, header):
    for signature, input_format in SIGNATURES.items():
        if header.startswith(signature):
            return input_format
    # Without a known signature the input format comes from the extension, and a
    # file without an extension is left with an unknown input format.
    suffix = path.rsplit(".", 1)[-1] if "." in path else ""
    return {"fa": "FormatA", "fb": "FormatB"}.get(suffix.lower(), "unknown")
''',
    "src/preferences/user_preferences.py": '''"""User preferences: loaded at startup, saved when the settings dialog closes."""

DEFAULT_PREFERENCES = {"default_output_format": "FormatA", "theme": "light"}


class UserPreferences:
    def __init__(self, store):
        self.store = store
        self.values = dict(DEFAULT_PREFERENCES)

    def load_defaults(self):
        """Read the saved preferences over the built-in defaults."""
        saved = self.store.read("preferences") or {}
        # The saved default output format is skipped, so the default preference
        # never reaches the export dialog.
        self.values.update({key: value for key, value in saved.items() if key != "default_output_format"})
        return self.values

    def save(self):
        self.store.write("preferences", self.values)
''',
    "src/render/renderer_registry.py": '''"""Keeps the selected renderer for the preview pane."""

RENDERERS = ("software", "accelerated")


class RendererRegistry:
    def __init__(self):
        self.selected_renderer = RENDERERS[0]
        self.preview_renderer = RENDERERS[0]

    def select_renderer(self, name):
        if name in RENDERERS:
            self.selected_renderer = name
        # The preview pane keeps the renderer it was created with.
        return self.selected_renderer
''',
    "src/cache/thumbnail_cache.py": '''"""Thumbnails for the file browser, dropped when their source file changes."""


class ThumbnailCache:
    def __init__(self):
        self.entries = {}

    def put(self, key, image, modified):
        self.entries[key] = (image, modified)

    def invalidate_stale_entries(self, current_times):
        """Drop the thumbnails whose source changed after they were cached."""
        for key, (_image, modified) in list(self.entries.items()):
            if current_times.get(key, modified) < modified:  # compares the wrong way round
                del self.entries[key]
''',
    "src/net/mirror_uploader.py": '''"""Uploads exported files to the shared mirror."""

UPLOAD_TIMEOUT_SECONDS = 5


def upload_to_mirror(client, path):
    # A large export cannot finish inside the upload timeout, so it is retried until it gives up.
    return client.put(path, timeout=UPLOAD_TIMEOUT_SECONDS)
''',
    "src/net/license_client.py": '''"""License server client: token refresh, with retries."""


def refresh_license_token(session, retries=3):
    for _attempt in range(retries):
        if session.refresh_token():
            return True
    return False
''',
    "src/ops/deploy_status.py": '''"""Release pipeline status for the about page."""

PIPELINE_STATES = ("queued", "deployed", "verified", "released")


class NightlyPipeline:
    """The nightly deploy pipeline: deployed to staging, verified, then released."""

    def __init__(self, run):
        self.run = run

    def status(self):
        if self.run.deployed and self.run.verified:
            return "released"
        return "queued"
''',
    "src/ui/main_window.py": '''"""The main window: restores the last document when the window is opened again."""


class MainWindow:
    def __init__(self, documents):
        self.documents = documents

    def on_opened_again(self):
        # Shows the format of the last document in the title bar.
        return self.documents.last().format_name
''',
    "src/export/export_job.py": '''"""Runs an export in the background, in the chosen format."""


def run_export_job(rows, chosen_format, writer):
    return writer(rows, chosen_format)
''',
    "src/ui/settings_dialog.py": '''"""The settings dialog: shows and edits the user's settings."""


def apply_settings(dialog, preferences):
    for name, value in dialog.changed_values().items():
        preferences.values[name] = value
    preferences.save()
''',
    "config/hosts.py": '''"""The machines the tooling talks to."""

BUILD_HOSTS = ("build-host-01.example.invalid", "build-host-02.example.invalid")
MIRROR_HOST = "mirror-01.example.invalid"
''',
    "scripts/build/agents.py": '''"""Registers build-host-01.example.invalid with the nightly pipeline."""

AGENT_HOST = "build-host-01.example.invalid"
''',
    "cmake/platforms.cmake": """# Supported platforms: Windows 11 x86-64 and Linux x86-64, version 2027.0.
set(PRODUCT_VERSION 2027.0)
""",
    "docs/release_notes.md": """# Release notes

## 2027.0

- Released for Windows 11 and Linux on x86-64.
- The nightly pipeline is verified on staging before every release.
- Export: FormatB added as an output format.
""",
    "tests/test_format_selector.py": '''from src.export.format_selector import ExportFormatSelector


def test_choose_keeps_the_output_format():
    selector = ExportFormatSelector(preferences=None)
    assert selector.choose("FormatB") == "FormatB"
''',
}


def build_synthetic_repository(root: Path) -> Path:
    """Write `SYNTHETIC_REPOSITORY` under `root`, byte for byte, and return `root`."""
    for relative, text in SYNTHETIC_REPOSITORY.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
    return root


# --- the synthetic repository's history ---------------------------------------
#
# Git History reads commits, so what it does with the corpus's noise is measured
# on a history of the same product (0.1.3, §42.3): an import, then one
# commit per decoy and one per real fix. A later commit appends blank lines and
# nothing else, so the history adds no searchable word: code search over this
# checkout finds what it finds over the plain one.

SYNTHETIC_IMPORT_SUBJECT = "Import the product sources"
#: (subject, the files it changed), oldest first, a day apart after the import.
SYNTHETIC_HISTORY: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("NightlyPipeline: mark staging runs verified", ("src/ops/deploy_status.py",)),
    ("Platform notes for Windows 11 x86-64", ("cmake/platforms.cmake",)),
    ("License token refresh: retry three times", ("src/net/license_client.py",)),
    ("Keep the output format when the export dialog is reopened", ("src/export/format_selector.py",)),
    ("Retry large uploads to the shared mirror", ("src/net/mirror_uploader.py",)),
    ("Keep the selected renderer for the preview pane", ("src/render/renderer_registry.py",)),
)


def build_synthetic_history(root: Path) -> dict[str, str]:
    """`SYNTHETIC_REPOSITORY` as a git repository with `SYNTHETIC_HISTORY`; subject -> commit hash.

    A fixed identity and fixed dates, so every run writes the same commits.
    """
    import os
    import subprocess

    build_synthetic_repository(root)

    def git(*args: str, day: int | None = None) -> str:
        env = dict(os.environ)
        if day is not None:
            stamp = f"2026-01-{day + 1:02d}T09:00:00+0000"
            env.update(GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
        completed = subprocess.run(
            ["git", "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "-c", "core.autocrlf=false",
             "-c", "commit.gpgsign=false", *args],
            cwd=root, check=True, capture_output=True, text=True, env=env,
        )
        return completed.stdout.strip()

    git("init", "-q")
    hashes: dict[str, str] = {}
    for day, (subject, paths) in enumerate(((SYNTHETIC_IMPORT_SUBJECT, ()), *SYNTHETIC_HISTORY)):
        for relative in paths:
            with (root / relative).open("ab") as handle:
                handle.write(b"\n")
        git("add", "-A")
        git("commit", "-q", "-m", subject, day=day)
        hashes[subject] = git("rev-parse", "HEAD")
    return hashes


@dataclass
class HistoryResult:
    """What Git History and Context Quality made of one case, over the synthetic history."""

    case: RetrievalCase
    #: The issue terms Git History searched commit messages for.
    extracted_terms: tuple[str, ...]
    #: Ranked files whose history earned nothing (`git_history.weak_ranked_files`).
    weak_ranked_files: tuple[str, ...]
    #: Retained commits, best first: (subject, score, reasons).
    commits: list[tuple[str, int, tuple[str, ...]]]
    #: (overall, issue completeness, retrieval quality, repository context, cap).
    context_quality: tuple[int, int, int, int, int | None]


def context_quality_cap_cases() -> dict[str, tuple[int, int, int, int, int | None]]:
    """Context Quality's cap, on a context that has everything else (§42.3).

    The best search there is, related commits, a similar fix, and a report with
    a description, an environment, an error message and an attachment — then
    none, one or all three of reproduction steps, actual and expected result.
    And a hand-written bug that is one line long: complete it is not, invalid
    it is not either. (overall, issue completeness, retrieval quality,
    repository context, cap) per case.
    """
    from dataclasses import replace

    from bugpilot.core.context import context_quality
    from bugpilot.core.git_history import GitHistoryOutcome, RepositoryState
    from bugpilot.core.issue import IssueAttachment, IssueDetails, IssueSignals
    from bugpilot.core.retrieval import (
        ConfidenceDetails, GitHistoryRecord, RecordedCommit, RelatedFile, RetrievalArtifact,
    )

    retrieval = RetrievalArtifact(
        confidence="high",
        related_files=(RelatedFile(file="src/export/format_selector.py", documentation=False, score=40,
                                   confidence="high", match_count=5),),
        confidence_details=ConfidenceDetails(core_terms_matched=4, core_terms_in_top_file=4, core_terms_in_top_3=4,
                                             strong_terms_in_top_file=2, phrase_in_top_file=True),
    )
    commit = RecordedCommit(hash="0" * 40, short_hash="0" * 10, subject="Keep the output format", date="2026-01-05", score=25)
    git = GitHistoryOutcome(CASE_JIRA_KEY, GitHistoryRecord("completed", commits=(commit,)), RepositoryState("main", True, "clean"))
    similar = "## Similar Historical Issues\n\n- One similar fix."
    base = IssueArtifact(
        id=CASE_JIRA_KEY,
        source="jira",
        title="Export dialog forgets the chosen output format",
        description="Choose FormatB, close the export dialog and reopen it.",
        signals=IssueSignals(error_messages=("ExportError: unknown output format",)),
        details=IssueDetails(
            environment="Windows 11, version 2027.0",
            attachments=(IssueAttachment(filename="export.log", kind="log"),),
        ),
    )
    issues = {
        "cap-all-three-missing": base,
        "cap-expected-result-only": replace(base, details=replace(base.details, expected_result="FormatB stays selected.")),
        "cap-all-three-present": replace(
            base,
            details=replace(
                base.details,
                reproduction_steps=("Open the export dialog.", "Choose FormatB.", "Reopen the dialog."),
                actual_result="FormatA is selected.",
                expected_result="FormatB stays selected.",
            ),
        ),
        "cap-one-line-hand-written": issue_for(
            RetrievalCase(name="one-line", issue_text="The export dialog forgets the chosen output format.")
        ),
    }
    out: dict[str, tuple[int, int, int, int, int | None]] = {}
    for name, issue in issues.items():
        quality = context_quality(issue, {"high_value_keywords": ["FormatB"]}, retrieval, similar, git)
        out[name] = (
            quality.overall, quality.issue_completeness, quality.retrieval_quality, quality.repository_context, quality.cap
        )
    return out


def run_history_case(case: RetrievalCase, root: Path, hashes: dict[str, str]) -> HistoryResult:
    """The production path past Code Search: the Git History query, the commits, Context Quality.

    The query is built the way a pipeline run builds it (`workflow._git_history_query`),
    so its gates are the ones measured.
    """
    from bugpilot.core.context import context_quality
    from bugpilot.core.git_history import collect_git_history
    from bugpilot.core.models import GitHistoryOptions
    from bugpilot.core.workflow import _git_history_query

    require_ripgrep()
    issue = issue_for(case)
    options = case_options(case)
    keywords = extract_issue_keywords(issue, options.keywords)
    retrieval = run_code_search(root, keywords, options)
    settings = GitHistoryOptions()
    query = _git_history_query(root, issue.id, retrieval, issue, keywords, options, settings)
    outcome = collect_git_history(root, issue.id, query, settings)
    subjects = {commit: subject for subject, commit in hashes.items()}
    quality = context_quality(issue, keywords, retrieval, "", outcome)
    return HistoryResult(
        case=case,
        extracted_terms=query.extracted_terms,
        weak_ranked_files=query.weak_ranked_files,
        commits=[(subjects.get(commit.hash, commit.subject), commit.score, commit.reasons) for commit in outcome.record.commits],
        context_quality=(
            quality.overall, quality.issue_completeness, quality.retrieval_quality, quality.repository_context, quality.cap
        ),
    )


#: The categories the synthetic corpus covers, in report order.
SYNTHETIC_CATEGORIES = (
    "comment-noise",
    "hostname-noise",
    "environment-noise",
    "identifier-led",
    "user-keyword-led",
    "hint-led",
    "phrase-led",
    "mixed-description-comments",
    "generic-only",
)

#: Structured issues against `SYNTHETIC_REPOSITORY`. `current` is what retrieval
#: does now: pinned so any change is seen, and changed only on purpose, with the
#: plan recording the before and after. 0.1.3 (§42.3) changed six of
#: them; what was pinned before is in `tests/baselines/0.1.3-batch0/retrieval.json`.
SYNTHETIC_CORPUS: tuple[RetrievalCase, ...] = (
    RetrievalCase(
        name="synthetic-comment-noise",
        kind="comment-noise",
        source="jira",
        title="Export dialog forgets the chosen output format",
        description=(
            "Choose FormatB in the export dialog, close it and reopen it: the output format "
            "selector shows FormatA again."
        ),
        comments=(
            "Nightly pipeline deployed to staging and verified; still released with this.",
            "Pipeline verified again on staging after the nightly deploy.",
            "Released build verified, nightly pipeline green.",
            "Deployed to staging, pipeline verified, waiting for the next nightly.",
        ),
        expected_files=("src/export/format_selector.py",),
        expected_confidence="high",
        expected_core_terms=("output format", "export dialog"),
        forbidden_top_terms=("pipeline", "nightly", "verified", "staging", "deployed", "released"),
        current=Observation(best_rank=1, confidence="high"),
    ),
    RetrievalCase(
        # The shape that motivated field-level provenance: a description in
        # ordinary words, and comments repeating an operational name that looks
        # like code — an identifier the extractor rates above any prose.
        name="synthetic-comment-noise-identifier",
        kind="comment-noise",
        source="jira",
        title="Chosen format is lost after reopening",
        description=(
            "The format chosen in the export window is lost when the window is opened again; "
            "the first format is shown instead."
        ),
        comments=(
            "NightlyPipeline marked the build verified on staging.",
            "NightlyPipeline verified it again after the staging deploy.",
            "Still reproducible after the NightlyPipeline run.",
            "NightlyPipeline deployed the candidate to staging; not fixed.",
        ),
        expected_files=("src/export/format_selector.py",),
        expected_confidence="medium",
        expected_core_terms=("format", "export"),
        forbidden_top_terms=("NightlyPipeline", "pipeline", "nightly", "verified", "staging", "deployed"),
        # Before 0.1.3: rank 3, high — the operations module first, on comments alone.
        current=Observation(best_rank=2, confidence="medium"),
    ),
    RetrievalCase(
        name="synthetic-hostname-noise",
        kind="hostname-noise",
        title="Large exports never finish uploading to the shared mirror",
        description=(
            "Uploading a large export to the shared mirror never finishes; the upload is "
            "retried until it times out. Seen from build-host-01.example.invalid and "
            "build-host-02.example.invalid."
        ),
        expected_files=("src/net/mirror_uploader.py",),
        expected_confidence="high",
        expected_core_terms=("upload", "mirror"),
        forbidden_top_terms=("build-host-01.example.invalid", "build-host-02.example.invalid"),
        # Before 0.1.3: low.
        current=Observation(best_rank=1, confidence="high"),
    ),
    RetrievalCase(
        name="synthetic-environment-noise",
        kind="environment-noise",
        title="Preview keeps the previous renderer",
        description=(
            "After choosing the accelerated renderer, the preview pane still draws with the "
            "software renderer."
        ),
        environment="Windows 11, x86-64, version 2027.0",
        expected_files=("src/render/renderer_registry.py",),
        expected_confidence="high",
        expected_core_terms=("renderer", "preview"),
        forbidden_top_terms=("Windows", "2027.0", "x86-64"),
        # Before 0.1.3: low.
        current=Observation(best_rank=1, confidence="high"),
    ),
    RetrievalCase(
        name="synthetic-identifier-led",
        kind="identifier-led",
        issue_text=(
            "ThumbnailCache.invalidate_stale_entries never removes the thumbnails of files "
            "that changed."
        ),
        expected_files=("src/cache/thumbnail_cache.py",),
        expected_confidence="high",
        expected_core_terms=("invalidate_stale_entries",),
        # Before 0.1.3: medium.
        current=Observation(best_rank=1, confidence="high"),
    ),
    RetrievalCase(
        name="synthetic-user-keyword-led",
        kind="user-keyword-led",
        issue_text="Saved settings are ignored after a restart.",
        user_keywords=("load_defaults", "UserPreferences"),
        expected_files=("src/preferences/user_preferences.py",),
        expected_confidence="high",
        expected_core_terms=("load_defaults", "UserPreferences"),
        current=Observation(best_rank=1, confidence="high"),
    ),
    RetrievalCase(
        name="synthetic-hint-led",
        kind="hint-led",
        issue_text="Some exported files have their columns in the wrong order.",
        hint="Probably the code that serializes rows for FormatB.",
        expected_files=("src/export/row_writer.py",),
        expected_confidence="medium",
        expected_core_terms=("columns", "FormatB"),
        # Before 0.1.3: high.
        current=Observation(best_rank=1, confidence="medium"),
    ),
    RetrievalCase(
        name="synthetic-phrase-led",
        kind="phrase-led",
        issue_text="The input format is not detected for a file without an extension.",
        expected_files=("src/importer/input_format.py",),
        expected_confidence="high",
        expected_core_terms=("input format",),
        # Before 0.1.3: low.
        current=Observation(best_rank=1, confidence="high"),
    ),
    RetrievalCase(
        name="synthetic-mixed-description-comments",
        kind="mixed-description-comments",
        source="jira",
        title="ExportFormatSelector resets the output format when the dialog is reopened",
        description=(
            "on_dialog_reopened sets the selected output format back to the first entry, so a "
            "chosen FormatB is lost."
        ),
        reproduction=("Open the export dialog.", "Choose FormatB.", "Close and reopen the dialog."),
        actual="FormatA is selected.",
        expected="FormatB stays selected.",
        comments=(
            "Could this be the license server token refresh again?",
            "The license server token refresh was retried twice here.",
            "Same license token refresh retries in my log.",
        ),
        expected_files=("src/export/format_selector.py",),
        expected_confidence="high",
        expected_core_terms=("on_dialog_reopened", "output format"),
        forbidden_top_terms=("license", "token", "refresh"),
        current=Observation(best_rank=1, confidence="high"),
    ),
    RetrievalCase(
        name="synthetic-generic-only",
        kind="generic-only",
        issue_text="The data output is wrong and the values are not updated correctly.",
        # Nothing implements that sentence: the case measures what generic words
        # retrieve, and how confident the search claims to be about it.
        expected_files=(),
        expected_confidence="low",
        current=Observation(best_rank=None, confidence="low"),
    ),
)


# --- a real historical corpus ------------------------------------------------
#
# Six hand-written cases against this repository found three real defects and
# cannot calibrate anything: six sentences will not resolve a threshold, and all
# of them are Python or TypeScript while BugPilot was built for a C++/Qt tree.
#
# So the harness also evaluates real solved issues, where the ground truth is
# what the fixing commit actually changed. That text is internal, so none of it
# lives here: the committed part is the loader and the format, and the cases
# themselves come from a local file a developer populates and git ignores.

#: Where a developer's own corpus is looked for by default.
REAL_CORPUS_PATH = REPO_ROOT / "tests" / "retrieval_corpus" / "real_cases.json"

#: What a corpus file looks like. Kept flat on purpose — it is written by hand
#: or by a short script, and a schema nobody can type from memory will not be
#: populated. `issue_text` alone is enough, as it always was; the structured
#: fields (any of `title`, `description`, `comments`, `environment`,
#: `reproduction`, `actual`, `expected`, with `"source": "jira"` for comments)
#: replace it when a case needs the evidence kept apart.
CORPUS_FORMAT = """
{
  "repo_root": "C:/path/to/the/product/checkout",
  "cases": [
    {
      "id": "JR-12345",
      "issue_text": "CSV cannot be selected as the export format.",
      "hint": "maybe format validation",
      "expected_files": ["src/export/FormatSelector.cpp"],
      "notes": "fixed in MR !456; the header change was incidental"
    },
    {
      "id": "JR-23456",
      "source": "jira",
      "title": "Export dialog forgets the chosen output format",
      "description": "Choose FormatB, close the dialog, reopen it: FormatA is selected.",
      "comments": ["Seen again on the nightly build."],
      "environment": "Windows 11, version 2027.0",
      "keywords": ["FormatSelector"],
      "expected_files": ["src/export/FormatSelector.cpp"],
      "expected_confidence": "high"
    }
  ]
}
"""

#: The structured fields a corpus file may give instead of `issue_text`.
_STRUCTURED_TEXT = ("title", "description", "environment", "actual", "expected")
_STRUCTURED_LISTS = ("comments", "reproduction")


class CorpusError(Exception):
    """A corpus file that cannot be trusted to measure anything."""


def load_real_corpus(path: Path | None = None) -> tuple[list[RetrievalCase], Path | None]:
    """A developer's historical cases, and the repository to run them against.

    Returns an empty corpus rather than raising when the file is absent: the
    standard suite must never depend on a private repository, and never fail for
    not having one.
    """
    import json

    source = path or REAL_CORPUS_PATH
    if not source.is_file():
        return [], None
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise CorpusError(f"{source} is not valid JSON: {error}") from error

    repo_root = payload.get("repo_root")
    seen: set[str] = set()
    for entry in payload.get("cases", []):
        name = str(entry.get("id") or entry.get("name") or "").strip()
        if not name:
            raise CorpusError(f"{source}: a case has no id.")
        if not (
            str(entry.get("issue_text", "")).strip()
            or str(entry.get("description", "")).strip()
            or str(entry.get("title", "")).strip()
        ):
            # Silently becoming an empty search would score as "not found" and
            # pull the corpus average down for a reason nobody could see.
            raise CorpusError(f"{source}: case {name} has no issue_text (and no title or description).")
        if name in seen:
            raise CorpusError(f"{source}: case id {name} appears more than once.")
        seen.add(name)

    cases: list[RetrievalCase] = []
    for entry in payload.get("cases", []):
        name = str(entry.get("id") or entry.get("name") or "unnamed")
        # `keywords` is the CLI's own name for them; `user_keywords` the older one.
        keywords = entry.get("keywords", entry.get("user_keywords", []))
        try:
            cases.append(
                RetrievalCase(
                    name=name,
                    issue_text=str(entry.get("issue_text", "")),
                    expected_files=tuple(str(item) for item in entry.get("expected_files", [])),
                    hint=str(entry.get("hint", "")),
                    user_keywords=tuple(str(item) for item in keywords),
                    kind=str(entry.get("category", "real")),
                    source=str(entry.get("source", "manual")),
                    expected_confidence=str(entry.get("expected_confidence", "")).lower(),
                    expected_core_terms=tuple(str(item) for item in entry.get("expected_core_terms", [])),
                    forbidden_top_terms=tuple(str(item) for item in entry.get("forbidden_top_terms", [])),
                    **{key: str(entry.get(key, "")) for key in _STRUCTURED_TEXT},
                    **{key: tuple(str(item) for item in entry.get(key, [])) for key in _STRUCTURED_LISTS},
                )
            )
        except ValueError as error:
            raise CorpusError(f"{source}: {error}") from error
    return cases, Path(repo_root) if repo_root else None


# --- reporting ----------------------------------------------------------------


def summarise(results: list[RetrievalResult]) -> dict[str, float | int]:
    """The aggregate numbers, over the cases that have an answer to find.

    Cases with no expected file are excluded from recall and MRR — they exist to
    measure noise, and scoring them would be scoring a question with no answer.
    """
    scored = [result for result in results if result.case.expected_files]
    count = len(scored) or 1
    confidence = Counter(result.confidence for result in results)
    targeted = [result for result in results if result.case.expected_confidence]
    return {
        # Cases with a confidence target, and how many land on it (§42.3).
        "expected_confidence_cases": len(targeted),
        "expected_confidence_matches": sum(result.confidence == result.case.expected_confidence for result in targeted),
        "cases": len(results),
        "scored": len(scored),
        "top_3": sum(result.hit_at(3) for result in scored),
        "top_5": sum(result.hit_at(5) for result in scored),
        "top_10": sum(result.hit_at(10) for result in scored),
        "recall_at_5": round(sum(result.hit_at(5) for result in scored) / count, 3),
        "mrr": round(sum(result.reciprocal_rank for result in scored) / count, 3),
        "confidence": {level: confidence.get(level, 0) for level in CONFIDENCES},
        "docs_in_top_5": sum(result.docs_in_top(5) for result in results),
        "noise_only_in_top_5": sum(len(result.noise_only_in_top(5)) for result in results),
        "forbidden_in_top_3": sum(1 for result in results if result.forbidden_in_top(3)),
        "terms": sum(len(result.terms) for result in results),
        "duration_s": round(sum(result.duration_s for result in results), 2),
    }


def summarise_by_kind(results: list[RetrievalResult]) -> dict[str, dict[str, float | int]]:
    """`summarise` per case kind — the categories a retrieval change is judged by."""
    kinds: dict[str, list[RetrievalResult]] = {}
    for result in results:
        kinds.setdefault(result.case.kind, []).append(result)
    return {kind: summarise(group) for kind, group in kinds.items()}


#: The summary fields a baseline records: no timings, which differ run to run.
_BASELINE_TOTALS = (
    "cases", "scored", "top_3", "top_5", "top_10", "recall_at_5", "mrr", "confidence",
    "expected_confidence_cases", "expected_confidence_matches",
    "docs_in_top_5", "noise_only_in_top_5", "forbidden_in_top_3", "terms",
)


def baseline_record(results: list[RetrievalResult]) -> dict[str, object]:
    """A deterministic, JSON-ready record of a corpus run: totals, per kind, per case.

    For the synthetic corpus every value is reproducible; for this repository's
    live cases the ranks move as the tree moves, which the record cannot help.
    """

    def totals(summary: dict[str, object]) -> dict[str, object]:
        return {key: summary[key] for key in _BASELINE_TOTALS}

    return {
        "summary": totals(summarise(results)),
        "by_kind": {kind: totals(summary) for kind, summary in summarise_by_kind(results).items()},
        "cases": [
            {
                "name": result.case.name,
                "kind": result.case.kind,
                "source": result.case.source,
                "expected_files": list(result.case.expected_files),
                "best_rank": result.best_rank,
                "confidence": result.confidence,
                "expected_confidence": result.case.expected_confidence,
                "top_5": result.ranked[:5],
                "top_5_matched": [list(terms) for _path, terms in result.top_matched[:5]],
                "searched": [
                    {"value": term.value, "source": term.source, "weight": term.weight,
                     "effective_weight": term.effective_weight, "match_count": term.match_count,
                     "origins": list(term.origins)}
                    for term in result.searched
                ],
                "core_terms_searched": result.core_terms_searched(),
                "forbidden_in_top_3": result.forbidden_in_top(3),
                "noise_only_in_top_5": result.noise_only_in_top(5),
            }
            for result in results
        ],
    }


def report(results: list[RetrievalResult]) -> str:
    """A report to read while working on retrieval, not only to assert on."""
    lines: list[str] = []
    for result in results:
        lines.append(f"{result.case.name}  [{result.case.kind}]")
        if result.case.expected_files:
            lines.append("  expected:")
            for expected, rank in result.ranks.items():
                lines.append(f"    {expected}  ->  rank {rank if rank else 'not found'}")
        else:
            lines.append("  expected: (none; this case measures noise)")
        lines.append("  retrieved:")
        for index, path in enumerate(result.ranked[:10], start=1):
            marker = " <-- expected" if _normalize(path) in {
                _normalize(item) for item in result.case.expected_files
            } else ""
            lines.append(f"    {index:>2}. {path}{marker}")
        if result.case.expected_files:
            lines.append(
                f"  best rank {result.best_rank or '-'} | "
                f"top-3 {'yes' if result.hit_at(3) else 'no'} | "
                f"top-5 {'yes' if result.hit_at(5) else 'no'} | "
                f"top-10 {'yes' if result.hit_at(10) else 'no'} | "
                f"RR {result.reciprocal_rank:.3f}"
            )
        expected = f" (expected {result.case.expected_confidence})" if result.case.expected_confidence else ""
        lines.append(f"  confidence {result.confidence}{expected}")
        if result.case.forbidden_top_terms:
            lines.append(f"  forbidden terms matching the top 3: {', '.join(result.forbidden_in_top(3)) or 'none'}")
            lines.append(f"  top-5 files there only for forbidden terms: {', '.join(result.noise_only_in_top(5)) or 'none'}")
        lines.append("")

    totals = summarise(results)
    lines.append(
        f"cases {totals['cases']} ({totals['scored']} scored)   "
        f"top-3 {totals['top_3']}/{totals['scored']}   "
        f"top-5 {totals['top_5']}/{totals['scored']}   "
        f"top-10 {totals['top_10']}/{totals['scored']}   "
        f"MRR {totals['mrr']}"
    )
    distribution = totals["confidence"]
    lines.append(
        f"confidence high {distribution['high']} / medium {distribution['medium']} / low {distribution['low']}   "
        f"on target {totals['expected_confidence_matches']}/{totals['expected_confidence_cases']}   "
        f"docs in top 5 {totals['docs_in_top_5']}   noise-only in top 5 {totals['noise_only_in_top_5']}   "
        f"terms {totals['terms']}   "
        f"{totals['duration_s']}s"
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """`python tests/retrieval_corpus.py [--synthetic | --real [PATH]] [--repo PATH]`.

    A developer command rather than a test: retrieval work needs to see where
    every file landed, which an assertion cannot show.
    """
    import argparse
    import tempfile

    parser = argparse.ArgumentParser(description="Evaluate BugPilot retrieval against a corpus.")
    parser.add_argument("--synthetic", action="store_true",
                        help="Evaluate the synthetic corpus against a fresh copy of the synthetic repository.")
    parser.add_argument("--real", nargs="?", const=str(REAL_CORPUS_PATH), default=None,
                        help="Evaluate a local historical corpus instead of the fixture cases.")
    parser.add_argument("--repo", default=None,
                        help="The checkout to search. Defaults to the corpus file's repo_root.")
    parser.add_argument("--format", action="store_true", help="Print the corpus file format and exit.")
    args = parser.parse_args(argv)

    if args.format:
        print(CORPUS_FORMAT.strip())
        return 0

    try:
        require_ripgrep()
    except RipgrepUnavailable as error:
        print(f"error: {error}")
        return 1

    if args.synthetic:
        with tempfile.TemporaryDirectory() as directory:
            root = build_synthetic_repository(Path(directory))
            print(f"repository: synthetic ({len(SYNTHETIC_REPOSITORY)} files)")
            print(f"cases: {len(SYNTHETIC_CORPUS)}\n")
            print(report([run_case(case, root) for case in SYNTHETIC_CORPUS]))
        return 0

    if args.real:
        try:
            cases, corpus_root = load_real_corpus(Path(args.real))
        except CorpusError as error:
            print(f"error: {error}")
            return 1
        if not cases:
            print(f"No corpus at {args.real}.")
            print("Populate it with cases in this format:")
            print(CORPUS_FORMAT.strip())
            return 1
        repo_root = Path(args.repo) if args.repo else corpus_root
        if repo_root is None or not repo_root.is_dir():
            print(f"The corpus names no usable repo_root (got {repo_root}). Pass --repo.")
            return 1
    else:
        cases, repo_root = list(CORPUS), REPO_ROOT

    print(f"repository: {repo_root}")
    print(f"cases: {len(cases)}\n")
    print(report([run_case(case, repo_root) for case in cases]))
    return 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main())
