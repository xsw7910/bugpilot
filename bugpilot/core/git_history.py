"""Git History v2: the commits most related to a work item, ranked and explained.

v1 asked one question — "what recently changed in the files Code Search ranked
highest?" — and so could not find a commit whose files the search missed, even
one whose message named the issue. Git History Retrieval v2
(``BugPilot_Git_History_Retrieval_v2_Plan.md``, Batches 1–5) has two candidate
sources, merged.

- **Commit-message search.** The work item's Jira key, the developer's shared
  Keywords and a few high-value terms the existing extractor mined from the
  issue, matched against commit subjects and bodies.
- **File history.** Recent commits touching the shared Focus Files and the top
  Code Search files. The second half is v1, kept as one source rather than
  replaced.

A commit any source finds is kept once, with every piece of evidence that found
it, scored by the fixed weights below — a bulk commit (an import, a mass
reformat) losing the credit for files it merely happened to touch, a merge that
only repeats its branch left out, a word too common to pick commits out
counting for little — and the best few are recorded, then rendered into the
Git History section of ``context.md``. Deterministic throughout: no model, no
embeddings, and the same repository and query always give the same list.

Bounded throughout, because the target is a monorepo. Measured on one with
221,216 commits: a full-history ``git log --grep`` walk costs ~2 s whether it
carries one pattern or several, a file-history walk ~0.7 s, a bare-file-name
glob pathspec ~10 s (so bare names are resolved through the index instead, in
~0.3 s). Hence one walk per *kind* of term rather than one per term, a capped
file set, and the walks run side by side.

Nothing here logs a keyword, an issue term, a commit message or a path: the
trace gets counts, elapsed time and failure kinds.
"""

from __future__ import annotations

import re
import subprocess
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .code_files import is_documentation, is_searchable
from .config import issue_dir
from .git_ops import (
    TIMEOUT_EXIT_CODE,
    command_available,
    current_branch,
    inside_git_repo,
    run_command,
    working_tree_status,
)
from .logging_utils import log
from .models import DEFAULT_MAX_RELATED_COMMITS, GitHistoryOptions
from .retrieval import (
    CommitFile,
    CommitTerm,
    GitHistoryRecord,
    GitHistorySearch,
    RecordedCommit,
    RetrievalArtifact,
    SupportingFile,
)
from .search import EXCLUDE_DIRS, FOCUS_REASON, _matches_any_path, _noise_flags
from .search_terms import WEIGHT_IDENTIFIER, terms_from_extraction

# --- bounds ---------------------------------------------------------------------

#: Ranked Code Search files whose history is read — v1's ``GIT_HISTORY_FILES``.
RANKED_HISTORY_FILES = 5
#: Commits read per ranked file — v1's ``git log -n 5``.
COMMITS_PER_RANKED_FILE = 5
#: Commits read per Focus File. Deeper than a ranked file's: the developer
#: pointed at this one, so its older history is worth more of the budget.
COMMITS_PER_FOCUS_FILE = 10
#: Focus paths whose history is read, after bare names are resolved.
MAX_FOCUS_HISTORY_FILES = 5
#: Additional Files (Git History Settings) whose history is read, the same way.
MAX_ADDITIONAL_HISTORY_FILES = 5
#: Paths one bare Focus File name (``AngleStack.cpp``) may resolve to.
MAX_PATHS_PER_FOCUS_NAME = 3
#: Shared Keywords searched in commit messages. All of them ride one git walk,
#: so the cap bounds the pattern list, not the number of walks.
MAX_SHARED_KEYWORD_TERMS = 10
#: Extracted issue terms searched in commit messages: only the identifier-shaped
#: and quoted ones, and only this many. Prose never qualifies.
MAX_EXTRACTED_TERMS = 4
#: Additional Commit Keywords (Git History Settings), in a walk of their own so
#: a broad shared Keyword cannot use up the matches they need.
MAX_GIT_KEYWORD_TERMS = 10
#: For shared Keywords and Additional Commit Keywords alike: both are typed.
MIN_SHARED_KEYWORD_LENGTH = 3
MIN_EXTRACTED_TERM_LENGTH = 4
#: Matches one message walk may return. Separate walks per kind of term, so a
#: noisy extracted term cannot fill the space an issue-ID match needs.
ISSUE_ID_MAX_COMMITS = 20
TERM_SEARCH_MAX_COMMITS = 100
#: Message-only candidates checked, in one command, for which of the *known*
#: candidate files they touched. Never a discovery of new files (Batch 4).
MAX_OVERLAP_CHECK_COMMITS = 60
#: Commits kept — the Max Related Commits default in plan §6.2.
MAX_RELATED_COMMITS = DEFAULT_MAX_RELATED_COMMITS
#: A commit touching more files than this is a bulk change — an import, a
#: reformat, a mass rename — and touching a Focus File proves nothing about it.
#: Found on a real monorepo: its initial import commit (some 73,000 files)
#: touched the Focus File and four ranked files, and outranked two real fixes.
#: Its file matches are not counted; its message still is.
BULK_COMMIT_FILES = 200
#: How many of the best file-evidenced candidates are counted, per max commit
#: kept. Counting stops at ``BULK_COMMIT_FILES``, so a bulk commit costs no more
#: than a small one.
BULK_CHECK_FACTOR = 2
#: Per git command, matching the per-term ripgrep timeout in ``search.py``.
GIT_COMMAND_TIMEOUT_SECONDS = 20
MAX_PARALLEL_GIT_COMMANDS = 4

# --- ranking weights (plan §10) ---------------------------------------------------
#
# Chosen so the plan's priority order holds for any single signal: an issue-ID
# match outranks everything else on its own; a Focus File or a shared Keyword
# outranks any Code Search file; recency (5 at most) can never outweigh the
# weakest real signal (one extracted term, 8). Evidence adds up, so a commit
# found three ways beats one found once. Tuning from a corpus is Batch 5.

SCORE_ISSUE_ID = 100
SCORE_FOCUS_FILE = 40
#: An Additional File (Git History Settings): explicit file guidance, like a
#: Focus File, and scored as one (plan §10, "strong").
SCORE_ADDITIONAL_FILE = 40
#: An Additional Commit Keyword: typed for this search specifically, so above a
#: shared Keyword, which was typed for Code Search (plan §10, "strong").
SCORE_GIT_KEYWORD = 40
SCORE_EXTRA_GIT_KEYWORD = 10
SCORE_SHARED_KEYWORD = 30
SCORE_EXTRA_SHARED_KEYWORD = 10
SCORE_EXTRACTED_TERM = 8
MAX_SCORED_EXTRACTED_TERMS = 3
#: A shared Keyword or extracted term matching more related commits than this
#: — twice the default list — cannot pick the relevant ones out (Batch 5).
#: It still counts, a little, and says why; it no longer carries a commit alone.
#: Fixed rather than read from Max Related Commits, so a shorter list is the
#: first part of a longer one.
BROAD_TERM_COMMITS = 20
SCORE_BROAD_TERM = 2
#: Two or more distinct keyword/issue-term matches in one message (shared,
#: commit and extracted together).
SCORE_MULTIPLE_TERMS = 10
#: The best-ranked Code Search file a commit touched: #1 20, #2 17 … #5 8.
SCORE_RANKED_FILE_TOP = 20
SCORE_RANKED_FILE_STEP = 3
SCORE_RANKED_FILE_MIN = 8
#: Each relevant file beyond the first, up to the cap.
SCORE_EXTRA_FILE = 3
MAX_EXTRA_FILE_BONUS = 6
#: (age in days relative to the newest candidate, bonus). Relative to the
#: newest candidate rather than to the clock, so the ranking is reproducible.
RECENCY_BONUS = ((30, 5), (90, 3), (365, 1))

_RECORD = "\x1e"
_FIELD = "\x00"
#: Hash and parents share the first field: ``%P`` is empty for a root commit.
_MESSAGE_FORMAT = f"--format={_RECORD}%H %P%x00%ct%x00%s%x00%b"
_HASH_RE = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")
#: Characters a bare Focus File name may not carry into a glob pathspec.
_GLOB_CHARACTERS = set("*?[]\\")


@dataclass(frozen=True)
class GitHistoryQuery:
    """What Git History searches with, by where each part came from.

    Kept apart by origin because each origin is ranked differently and the
    Git History Settings act per origin: *Use shared Keywords* off empties
    ``shared_keywords``, *Use shared Focus Files* off empties ``focus_files``,
    and the Additional Commit Keywords and Additional Files are their own
    fields with their own weights — never folded into the shared ones.
    """

    #: The external issue key (``JR-12345``). ``None`` for a hand-written bug:
    #: its ``local_…`` id was minted here and no commit can name it.
    issue_id: str | None = None
    shared_keywords: tuple[str, ...] = ()
    #: Additional Commit Keywords: Git History's own.
    git_keywords: tuple[str, ...] = ()
    extracted_terms: tuple[str, ...] = ()
    focus_files: tuple[str, ...] = ()
    #: Additional Files: Git History's own.
    git_files: tuple[str, ...] = ()
    #: Code Search's ranked paths, best first.
    ranked_files: tuple[str, ...] = ()
    #: Every file Code Search returned. Never searched — only what changed-file
    #: feedback (Batch 4) must not offer again as "new".
    known_files: tuple[str, ...] = ()

    def is_empty(self) -> bool:
        return not (
            self.issue_id
            or self.shared_keywords
            or self.git_keywords
            or self.extracted_terms
            or self.focus_files
            or self.git_files
            or self.ranked_files
        )


@dataclass(frozen=True)
class GitHistoryLimits:
    """How far one search reads, and by which routes.

    The defaults are Batch 1's — History Depth *Recent*, Max Related Commits 10,
    both routes on. :func:`limits_for` builds one from the Git History Settings.
    """

    max_related_commits: int = MAX_RELATED_COMMITS
    commits_per_focus_file: int = COMMITS_PER_FOCUS_FILE
    commits_per_ranked_file: int = COMMITS_PER_RANKED_FILE
    term_search_max_commits: int = TERM_SEARCH_MAX_COMMITS
    issue_id_max_commits: int = ISSUE_ID_MAX_COMMITS
    #: Search commit messages: off, no message walk runs — the issue ID's
    #: included — though a commit file history found is still judged by its message.
    search_commit_messages: bool = True
    #: Search related file history: off, no file is walked or checked at all.
    search_file_history: bool = True


#: What each History Depth reads. *Recent* is Batch 1's bounds. *Broader* reads
#: three times as far back per file, and lets each message walk return three
#: times as many matches; the message walks already cover all of ``HEAD``'s
#: history, so it is the per-file and per-walk counts that a depth can move.
#: Neither changes how many commits are kept: that is Max Related Commits.
HISTORY_DEPTH_LIMITS: dict[str, GitHistoryLimits] = {
    "recent": GitHistoryLimits(),
    "broader": GitHistoryLimits(
        commits_per_focus_file=3 * COMMITS_PER_FOCUS_FILE,
        commits_per_ranked_file=3 * COMMITS_PER_RANKED_FILE,
        term_search_max_commits=3 * TERM_SEARCH_MAX_COMMITS,
        issue_id_max_commits=3 * ISSUE_ID_MAX_COMMITS,
    ),
}


def limits_for(options: GitHistoryOptions) -> GitHistoryLimits:
    """The bounds and routes the Git History Settings ask for, normalized first."""
    options = options.normalized()
    depth = HISTORY_DEPTH_LIMITS[options.history_depth]
    return GitHistoryLimits(
        max_related_commits=options.max_related_commits,
        commits_per_focus_file=depth.commits_per_focus_file,
        commits_per_ranked_file=depth.commits_per_ranked_file,
        term_search_max_commits=depth.term_search_max_commits,
        issue_id_max_commits=depth.issue_id_max_commits,
        search_commit_messages=options.search_commit_messages,
        search_file_history=options.search_file_history,
    )


@dataclass(frozen=True)
class FileCandidate:
    """One path whose history is read, and why."""

    path: str
    focus: bool
    #: 1-based Code Search rank; ``None`` for a Focus File the search did not rank.
    rank: int | None
    pathspec: str
    #: An Additional File (Git History Settings) rather than a shared Focus File.
    additional: bool = False


@dataclass
class CommitCandidate:
    """One commit and every piece of evidence that found it."""

    hash: str
    subject: str
    timestamp: int
    #: As the walk that found it printed them; two or more is a merge.
    parents: tuple[str, ...] = ()
    issue_id: str | None = None
    shared_keywords: list[str] = field(default_factory=list)
    #: Additional Commit Keywords that matched — kept apart from the shared ones.
    git_keywords: list[str] = field(default_factory=list)
    extracted_terms: list[str] = field(default_factory=list)
    focus_files: list[str] = field(default_factory=list)
    #: Additional Files it changed — kept apart from the Focus Files.
    git_files: list[str] = field(default_factory=list)
    #: Shared Keywords and extracted terms it matched that are broad (Batch 5),
    #: each with how many related commits it matched.
    broad_keywords: list[tuple[str, int]] = field(default_factory=list)
    broad_terms: list[tuple[str, int]] = field(default_factory=list)
    #: ``(rank, path)``, best rank first once scored.
    ranked_files: list[tuple[int, str]] = field(default_factory=list)
    #: Touched more than ``BULK_COMMIT_FILES`` files; its file matches were dropped.
    bulk: bool = False
    #: For a merge that stays in the list: the retained commits it brought in,
    #: whose files it must not lend a second time (Batch 5).
    merge_members: tuple[str, ...] = ()
    score: int = 0
    reasons: list[str] = field(default_factory=list)

    @property
    def short_hash(self) -> str:
        return self.hash[:10]

    @property
    def date(self) -> str:
        return datetime.fromtimestamp(self.timestamp, tz=timezone.utc).strftime("%Y-%m-%d")

    @property
    def matched_terms(self) -> list[str]:
        return (
            ([self.issue_id] if self.issue_id else [])
            + self.git_keywords
            + self.shared_keywords
            + self.extracted_terms
            + [term for term, _count in self.broad_keywords + self.broad_terms]
        )

    @property
    def files(self) -> list[str]:
        return self.focus_files + self.git_files + [path for _rank, path in self.ranked_files]

    def has_evidence(self) -> bool:
        # A broad term is not evidence on its own: it was moved out of the lists.
        return bool(self.issue_id or self.git_keywords or self.shared_keywords or self.extracted_terms or self.files)

    def add_file(self, candidate: FileCandidate) -> None:
        if candidate.focus:
            if candidate.path not in self.focus_files:
                self.focus_files.append(candidate.path)
        elif candidate.additional:
            if candidate.path not in self.git_files:
                self.git_files.append(candidate.path)
        elif candidate.rank is not None and (candidate.rank, candidate.path) not in self.ranked_files:
            self.ranked_files.append((candidate.rank, candidate.path))


@dataclass(frozen=True)
class GitHistoryResult:
    commits: tuple[CommitCandidate, ...] = ()
    candidate_count: int = 0
    search_term_count: int = 0
    file_candidate_count: int = 0
    #: Failure kinds (``timeout``, ``git_error``), one per command that failed.
    failures: tuple[str, ...] = ()
    #: The files whose history was read, for changed-file feedback to recognise.
    files: tuple[FileCandidate, ...] = ()


# --- inputs ----------------------------------------------------------------------


def select_extracted_terms(
    keywords: dict[str, object] | None,
    exclude: tuple[str, ...] | list[str] = (),
    retrieval: RetrievalArtifact | None = None,
) -> tuple[str, ...]:
    """The few extracted terms worth a commit-message search.

    Read through ``terms_from_extraction`` — the weighting Code Search already
    uses — rather than a second extractor. Identifier-shaped terms first (a
    class, a function, a file name, a stack-trace name), then quoted phrases;
    prose never, because "output" or "selected" matches half of any history.
    A term Code Search found *broad* in the repository is dropped too: a word
    on hundreds of lines of code is on hundreds of commits.
    """
    if not keywords:
        return ()
    excluded = {value.strip().lower() for value in exclude}
    broad = (
        {term.value.lower() for term in retrieval.terms if term.classification == "broad"}
        if retrieval is not None
        else set()
    )
    terms = terms_from_extraction(keywords)
    ordered = [term for term in terms if term.source == "identifier"] + [
        term for term in terms if term.source == "phrase"
    ]
    chosen: list[str] = []
    for term in ordered:
        value = _clean_term(term.value)
        if value is None or term.weight < WEIGHT_IDENTIFIER:
            continue
        key = value.lower()
        if len(value) < MIN_EXTRACTED_TERM_LENGTH or value.isdigit():
            continue
        if key in excluded or key in broad or key in {item.lower() for item in chosen}:
            continue
        chosen.append(value)
        if len(chosen) >= MAX_EXTRACTED_TERMS:
            break
    return tuple(chosen)


def focus_files_from_retrieval(retrieval: RetrievalArtifact | None) -> tuple[str, ...]:
    """The Focus Files a recorded search ranked, for a standalone rebuild.

    Focus Files are a per-run option, not persisted, so a ``bugpilot context``
    run on its own recovers the ones the search marked. A focus file no keyword
    matched never reached ``retrieval.json``, and is not recoverable here.
    """
    if retrieval is None:
        return ()
    return tuple(item.file for item in retrieval.related_files if FOCUS_REASON in item.reasons)


def safe_relative_path(value: str) -> str | None:
    """``value`` as a repository-relative path, or ``None`` when it is not one.

    Rejected: empty, absolute (``/x``, ``C:\\x``, ``\\\\server``), anything with a
    ``..`` segment, git pathspec magic (a leading ``:``) and control characters.
    """
    text = (value or "").strip().replace("\\", "/")
    if not text or any(ord(ch) < 32 for ch in text):
        return None
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text) or text.startswith(":"):
        return None
    while text.startswith("./"):
        text = text[2:]
    text = text.rstrip("/")
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        return None
    return "/".join(parts)


def _clean_term(value: str) -> str | None:
    text = " ".join((value or "").split())
    if not text or any(ord(ch) < 32 for ch in text):
        return None
    return text


def _typed_keywords(values: tuple[str, ...], cap: int, taken: set[str] = frozenset()) -> list[str]:
    """Typed keywords as searched: trimmed, whole, at least three characters, deduplicated, capped.

    The one rule for both lists a developer types — shared Keywords and
    Additional Commit Keywords — so neither can be validated differently.
    Unicode is kept as typed; only whitespace is collapsed.
    """
    seen = {value.lower() for value in taken}
    kept: list[str] = []
    for raw in values:
        value = _clean_term(raw)
        if value is None or len(value) < MIN_SHARED_KEYWORD_LENGTH or value.lower() in seen:
            continue
        seen.add(value.lower())
        kept.append(value)
        if len(kept) >= cap:
            break
    return kept


def _git_keywords(query: GitHistoryQuery) -> list[str]:
    return _typed_keywords(query.git_keywords, MAX_GIT_KEYWORD_TERMS)


def _shared_keywords(query: GitHistoryQuery, git: list[str] | None = None) -> list[str]:
    # A word in both lists is an Additional Commit Keyword: the stronger claim
    # wins, and it is searched and scored once.
    return _typed_keywords(query.shared_keywords, MAX_SHARED_KEYWORD_TERMS, set(git or ()))


def _extracted_terms(query: GitHistoryQuery, shared: list[str], git: list[str] | None = None) -> list[str]:
    taken = {value.lower() for value in [*shared, *(git or ())]}
    kept: list[str] = []
    for raw in query.extracted_terms:
        value = _clean_term(raw)
        if value is None or value.lower() in taken:
            continue
        taken.add(value.lower())
        kept.append(value)
        if len(kept) >= MAX_EXTRACTED_TERMS:
            break
    return kept


def file_candidates(repo_root: Path, query: GitHistoryQuery) -> list[FileCandidate]:
    """Focus Files, then Additional Files, then the top ranked files; safe, deduplicated.

    A Focus File keeps Code Search's matching rules: a path or directory prefix,
    or a bare name matching that file anywhere. A bare name is resolved through
    the index, because the equivalent glob pathspec on ``git log`` costs a full
    unpruned history walk (~10 s in a large monorepo). An Additional File is read
    by exactly the same rules — one path validator, one resolver. A ranked file
    a focus pattern covers is a Focus File here too, and one an Additional File
    pattern covers is an Additional File: the developer said so.
    """
    focus_patterns = [path for path in (safe_relative_path(item) for item in query.focus_files) if path]
    additional_patterns = [path for path in (safe_relative_path(item) for item in query.git_files) if path]
    seen: set[str] = set()
    out: list[FileCandidate] = []

    for patterns, additional, cap in (
        (focus_patterns, False, MAX_FOCUS_HISTORY_FILES),
        (additional_patterns, True, MAX_ADDITIONAL_HISTORY_FILES),
    ):
        taken = 0
        # Lazily: no name is resolved once the cap is reached.
        for path in _explicit_paths(repo_root, patterns):
            if path.lower() in seen:
                continue
            seen.add(path.lower())
            taken += 1
            out.append(
                FileCandidate(
                    path=path,
                    focus=not additional,
                    rank=None,
                    pathspec=f":(literal,icase){path}",
                    additional=additional,
                )
            )
            if taken >= cap:
                break

    for rank, raw in enumerate(query.ranked_files[:RANKED_HISTORY_FILES], start=1):
        path = safe_relative_path(raw)
        if path is None or path.lower() in seen:
            continue
        seen.add(path.lower())
        focus = _matches_any_path(path, focus_patterns)
        additional = not focus and _matches_any_path(path, additional_patterns)
        out.append(
            FileCandidate(path=path, focus=focus, rank=rank, pathspec=f":(literal){path}", additional=additional)
        )
    return out


#: Bare names resolved per kind (one ``git ls-files`` each): twice the files
#: walked, so a few names that match nothing still leave room, and a pasted list
#: of sixty never costs sixty index scans (review, Batch 5).
MAX_NAME_LOOKUPS = 2 * MAX_FOCUS_HISTORY_FILES


def _explicit_paths(repo_root: Path, patterns: list[str]) -> Iterator[str]:
    """Typed file patterns as repository paths: a path as given, a bare name resolved."""
    lookups = 0
    for pattern in patterns:
        if "/" in pattern or (repo_root / pattern).exists():
            yield pattern
        elif lookups < MAX_NAME_LOOKUPS:
            lookups += 1
            yield from _resolve_file_name(repo_root, pattern)


def _resolve_file_name(repo_root: Path, name: str) -> list[str]:
    if any(ch in _GLOB_CHARACTERS for ch in name):
        return []
    code, output = run_command(
        ["git", "ls-files", "-z", "--", f":(glob,icase)**/{name}"], repo_root, timeout=GIT_COMMAND_TIMEOUT_SECONDS
    )
    if code != 0:
        return []
    paths = sorted({path for path in output.split("\0") if path and safe_relative_path(path) == path})
    return paths[:MAX_PATHS_PER_FOCUS_NAME]


# --- candidate generation -----------------------------------------------------------


@dataclass(frozen=True)
class _Walk:
    args: list[str]
    #: The file whose history this is; ``None`` for a message search.
    file: FileCandidate | None = None


def _message_walk(terms: list[str], max_count: int) -> _Walk:
    # One argv entry per pattern: nothing is ever joined into a shell string,
    # so a term containing `;`, `$(…)` or a quote reaches git as text.
    greps = [f"--grep={term}" for term in terms]
    return _Walk(
        [
            "git", "log", "--no-show-signature", "--fixed-strings", "--regexp-ignore-case", *greps,
            f"--max-count={max_count}", _MESSAGE_FORMAT, "HEAD", "--",
        ]
    )


#: An issue key of the usual shape: letters, digits and ``_``, a hyphen, a number.
_ISSUE_KEY_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*-[0-9]+")


def _whole_key_walk(issue_id: str, max_count: int) -> _Walk | None:
    """The issue ID's walk again, with git matching the key whole; ``None`` for an unusual ID.

    Asked only when the fixed-string walk came back full and with near misses
    in it (:func:`_near_misses_filled`): a search for ``JR-12`` also returns
    every ``JR-120`` … ``JR-129`` commit, and twenty of those newer than the
    fix used up the walk before the boundary check ever saw the fix (review,
    Batch 5). A key of the usual shape holds no regex metacharacter, so git is
    given the trailing boundary as an extended regex built from it. Only the
    trailing one: on a 221k-commit history the regex costs ~0.25 s over the
    fixed string, a leading boundary ~1 s more (nothing literal left to anchor
    the scan) — which is also why it is not the first walk. The near miss only
    a leading boundary excludes — another project's key ending in this one —
    is rare, and :func:`_issue_id_pattern` still rejects it.
    """
    if not _ISSUE_KEY_RE.fullmatch(issue_id):
        return None
    return _Walk(
        [
            "git", "log", "--no-show-signature", "--extended-regexp", "--regexp-ignore-case",
            f"--grep={issue_id}([^0-9]|$)", f"--max-count={max_count}", _MESSAGE_FORMAT, "HEAD", "--",
        ]
    )


def _near_misses_filled(output: str, issue_id: str, max_count: int) -> bool:
    """The issue walk returned all it may, and some of it does not name the key whole."""
    records = _parse_messages(output)
    pattern = _issue_id_pattern(issue_id)
    return len(records) >= max_count and not all(
        pattern.search(f"{subject}\n{body}") for _commit, _parents, _time, subject, body in records
    )


def _file_walk(candidate: FileCandidate, max_count: int) -> _Walk:
    return _Walk(
        [
            "git", "log", "--no-show-signature", f"--max-count={max_count}", _MESSAGE_FORMAT,
            "HEAD", "--", candidate.pathspec,
        ],
        file=candidate,
    )


def _parse_messages(output: str) -> list[tuple[str, tuple[str, ...], int, str, str]]:
    """``(hash, parents, timestamp, subject, body)`` per well-formed record; the rest is skipped."""
    records: list[tuple[str, tuple[str, ...], int, str, str]] = []
    for chunk in output.split(_RECORD):
        fields = chunk.split(_FIELD, 3)
        if len(fields) < 3:
            continue
        commit, *parents = fields[0].split() or [""]
        if not _HASH_RE.fullmatch(commit):
            continue
        try:
            timestamp = int(fields[1].strip())
        except ValueError:
            continue
        subject = " ".join(fields[2].split())
        body = fields[3] if len(fields) > 3 else ""
        records.append((commit, tuple(p for p in parents if _HASH_RE.fullmatch(p)), timestamp, subject, body))
    return records


def _issue_id_pattern(issue_id: str) -> re.Pattern[str]:
    # `JR-12` must not match `JR-123` or `XJR-12`.
    return re.compile(rf"(?<![A-Za-z0-9]){re.escape(issue_id)}(?![0-9])", re.IGNORECASE)


def _term_pattern(term: str) -> re.Pattern[str]:
    # Whole words: git's fixed-string search is a substring prefilter, this is
    # the decision. `Stack` must not count as a match inside `AngleStackModel`.
    return re.compile(rf"(?<!\w){re.escape(term)}(?!\w)", re.IGNORECASE)


def find_related_commits(
    repo_root: Path, query: GitHistoryQuery, limits: GitHistoryLimits | None = None
) -> GitHistoryResult:
    """Search, merge, score and cap. The caller has checked git and the repository."""
    limits = limits or GitHistoryLimits()
    issue_id = _clean_term(query.issue_id or "")
    git = _git_keywords(query)
    shared = _shared_keywords(query, git)
    extracted = _extracted_terms(query, shared, git)
    # File history off: no file is resolved, walked or checked — not even a
    # Focus File's. Nothing forces it back on.
    files = file_candidates(repo_root, query) if limits.search_file_history else []

    walks: list[_Walk] = []
    # Commit messages off: no message walk at all, the issue ID's included.
    if limits.search_commit_messages:
        if issue_id:
            walks.append(_message_walk([issue_id], limits.issue_id_max_commits))
        if git:
            walks.append(_message_walk(git, limits.term_search_max_commits))
        if shared:
            walks.append(_message_walk(shared, limits.term_search_max_commits))
        if extracted:
            walks.append(_message_walk(extracted, limits.term_search_max_commits))
    for candidate in files:
        depth = limits.commits_per_focus_file if candidate.focus else limits.commits_per_ranked_file
        walks.append(_file_walk(candidate, depth))

    failures: list[str] = []
    answers = _run_all(repo_root, [walk.args for walk in walks])
    # The issue walk is first when it ran. Full of near misses, it is asked
    # again with the key matched whole: rare, and the strongest signal.
    if issue_id and limits.search_commit_messages and answers[0][0] == 0:
        retry = _whole_key_walk(issue_id, limits.issue_id_max_commits)
        if retry is not None and _near_misses_filled(answers[0][1], issue_id, limits.issue_id_max_commits):
            answer = run_command(retry.args, repo_root, timeout=GIT_COMMAND_TIMEOUT_SECONDS)
            if answer[0] == 0:
                answers[0] = answer
            else:
                failures.append(_failure_kind(answer[0]))
    candidates: dict[str, CommitCandidate] = {}
    #: Messages are matched here and never kept: a commit body can carry
    #: anything, and nothing downstream needs it.
    messages: dict[str, str] = {}
    for walk, (code, output) in zip(walks, answers):
        if code != 0:
            failures.append(_failure_kind(code))
            continue
        for commit, parents, timestamp, subject, body in _parse_messages(output):
            candidate = candidates.get(commit)
            if candidate is None:
                candidate = candidates[commit] = CommitCandidate(commit, subject, timestamp, parents)
                messages[commit] = f"{subject}\n{body}"
            if walk.file is not None:
                candidate.add_file(walk.file)

    # Message evidence is judged the same way whichever walk found the commit:
    # a commit found through a Focus File that also names the issue gets both.
    # With commit-message search off this still applies to what file history
    # found — its messages are already read — but nothing is searched for them.
    id_pattern = _issue_id_pattern(issue_id) if issue_id else None
    git_patterns = [(term, _term_pattern(term)) for term in git]
    shared_patterns = [(term, _term_pattern(term)) for term in shared]
    extracted_patterns = [(term, _term_pattern(term)) for term in extracted]
    for commit, candidate in candidates.items():
        message = messages[commit]
        if id_pattern is not None and id_pattern.search(message):
            candidate.issue_id = issue_id
        candidate.git_keywords = [term for term, pattern in git_patterns if pattern.search(message)]
        candidate.shared_keywords = [term for term, pattern in shared_patterns if pattern.search(message)]
        candidate.extracted_terms = [term for term, pattern in extracted_patterns if pattern.search(message)]
    _separate_broad_terms(list(candidates.values()))

    _check_file_overlap(repo_root, candidates, files, failures)

    evidenced = _ranked([candidate for candidate in candidates.values() if candidate.has_evidence()])
    # The bulk and merge checks read at least what the default list needs, so a
    # shorter Max Related Commits only cuts the list: with a window of twice the
    # cap, a third bulk commit just past a two-commit window rose to the top
    # with its file credit intact (review, Batch 5). A longer list widens it.
    window = BULK_CHECK_FACTOR * max(limits.max_related_commits, DEFAULT_MAX_RELATED_COMMITS)
    contenders = [candidate for candidate in evidenced if candidate.files]
    if _discount_bulk_commits(repo_root, contenders[:window]):
        evidenced = _ranked([candidate for candidate in evidenced if candidate.has_evidence()])
    evidenced = _collapse_merge_wrappers(repo_root, evidenced, window, failures)
    return GitHistoryResult(
        commits=tuple(evidenced[: max(0, limits.max_related_commits)]),
        candidate_count=len(evidenced),
        search_term_count=(
            ((1 if issue_id else 0) + len(git) + len(shared) + len(extracted)) if limits.search_commit_messages else 0
        ),
        file_candidate_count=len(files),
        files=tuple(files),
        failures=tuple(failures),
    )


#: Commits a merge is asked to list as brought in: enough for a feature branch,
#: never a long-lived one's whole history.
MAX_MERGE_MEMBERS = 100


def _collapse_merge_wrappers(
    repo_root: Path, ranked: list[CommitCandidate], window: int, failures: list[str]
) -> list[CommitCandidate]:
    """Take out merges that only repeat the commits they merged (Batch 5).

    A feature branch's merge carries the branch's message and changes again, so
    it took a second slot in the list and lent the same files twice — seen on
    every merged case of a real monorepo. A merge is a *wrapper*, and goes, when
    all three hold: it is clean (no change of its own — a conflict resolution
    is a change, and such a merge stays), at least one commit it brought in is
    among the related commits found, and every piece of its evidence is also on
    those commits. Any other merge stays, ranked as before, and remembers those
    members so it never lends a file they lent. Scores are not touched:
    dropping a wrapper only frees its slot.

    Only merges among the first ``window`` are looked at; a list without one
    costs nothing — the walks already said which commits are merges. Each git
    process costs ~0.1 s on a large repository whatever it does, so: one
    command says which merges are clean, for all of them; a clean merge whose
    branch tip is itself a related commit carrying all its evidence is decided
    by that alone (the usual feature-branch merge); only the rest ask, one
    bounded ``rev-list`` each, which commits they brought in.
    """
    merges = [c for c in ranked[:window] if len(c.parents) >= 2]
    if not merges:
        return ranked
    # `--cc` lists only paths a merge changed differently from every parent —
    # a conflict resolution, or a file of its own: a clean merge lists none.
    code, output = run_command(
        [
            "git", "log", "--no-walk=unsorted", "--no-show-signature", "--cc", "--name-only",
            f"--format={_RECORD}%H", *[merge.hash for merge in merges],
        ],
        repo_root,
        timeout=GIT_COMMAND_TIMEOUT_SECONDS,
    )
    if code != 0:
        failures.append(_failure_kind(code))
        return ranked
    clean: dict[str, bool] = {}
    for chunk in output.split(_RECORD):
        lines = [line.strip() for line in chunk.splitlines() if line.strip()]
        if lines and _HASH_RE.fullmatch(lines[0]):
            clean[lines[0]] = len(lines) == 1
    retained = {c.hash: c for c in ranked}
    wrappers: set[str] = set()
    undecided: list[CommitCandidate] = []
    for merge in merges:
        if merge.hash not in clean:
            continue
        tips = [retained[parent] for parent in merge.parents[1:] if parent in retained]
        if clean[merge.hash] and tips and _evidence_of(merge) <= set().union(*(_evidence_of(tip) for tip in tips)):
            wrappers.add(merge.hash)
        else:
            undecided.append(merge)
    answers = _run_all(
        repo_root,
        [
            ["git", "rev-list", f"--max-count={MAX_MERGE_MEMBERS}", *merge.parents[1:], f"^{merge.parents[0]}"]
            for merge in undecided
        ],
    )
    for merge, (members_code, members_out) in zip(undecided, answers):
        if members_code != 0:
            failures.append(_failure_kind(members_code))
            continue
        members = [retained[h] for h in members_out.split() if h in retained and h != merge.hash]
        if not members:
            continue
        covered = set().union(*(_evidence_of(member) for member in members))
        if clean[merge.hash] and _evidence_of(merge) <= covered:
            wrappers.add(merge.hash)
        else:
            merge.merge_members = tuple(member.hash for member in members)
    return [c for c in ranked if c.hash not in wrappers]


def _evidence_of(commit: CommitCandidate) -> set[tuple[str, str]]:
    """Every piece of evidence a commit carries, as comparable pairs."""
    return (
        ({("issue_id", commit.issue_id)} if commit.issue_id else set())
        | {("commit_keyword", term.lower()) for term in commit.git_keywords}
        | {("shared_keyword", term.lower()) for term in commit.shared_keywords}
        | {("extracted_term", term.lower()) for term in commit.extracted_terms}
        | {("broad_term", term.lower()) for term, _count in commit.broad_keywords + commit.broad_terms}
        | {("file", path.lower()) for path in commit.files}
    )


def _separate_broad_terms(candidates: list[CommitCandidate]) -> None:
    """Move shared Keywords and extracted terms that match too many commits aside.

    Counted over every candidate, after matching. Commit keywords and the issue
    ID are never broad: the first was typed for this search, the second names
    one piece of work. The move is the whole adjustment — the scoring below
    reads which list a term is in, and the reason says how many commits it hit.
    """
    counts: dict[str, int] = {}
    for candidate in candidates:
        for term in {*candidate.shared_keywords, *candidate.extracted_terms}:
            counts[term] = counts.get(term, 0) + 1
    broad = {term: count for term, count in counts.items() if count > BROAD_TERM_COMMITS}
    if not broad:
        return
    for candidate in candidates:
        candidate.broad_keywords = [(t, broad[t]) for t in candidate.shared_keywords if t in broad]
        candidate.broad_terms = [(t, broad[t]) for t in candidate.extracted_terms if t in broad]
        candidate.shared_keywords = [t for t in candidate.shared_keywords if t not in broad]
        candidate.extracted_terms = [t for t in candidate.extracted_terms if t not in broad]


def _check_file_overlap(
    repo_root: Path,
    candidates: dict[str, CommitCandidate],
    files: list[FileCandidate],
    failures: list[str],
) -> None:
    """Which known candidate files the message-only commits touched.

    One command for all of them, restricted by pathspec to the candidate files,
    so it can only confirm a file already in play — it never names a new one.
    An issue-ID commit that also changed a Focus File is then credited with both.
    """
    if not files:
        return
    unseen = [candidate for candidate in candidates.values() if not candidate.files]
    if not unseen:
        return
    unseen.sort(key=lambda item: (-_message_score(item), -item.timestamp, item.hash))
    hashes = [candidate.hash for candidate in unseen[:MAX_OVERLAP_CHECK_COMMITS]]
    code, output = _run_all(
        repo_root,
        [
            [
                "git", "-c", "core.quotepath=off", "log", "--no-walk=unsorted", f"--format={_RECORD}%H",
                "--name-only", *hashes, "--", *[candidate.pathspec for candidate in files],
            ]
        ],
    )[0]
    if code != 0:
        failures.append(_failure_kind(code))
        return
    for chunk in output.split(_RECORD):
        lines = [line.strip() for line in chunk.splitlines() if line.strip()]
        if not lines or lines[0] not in candidates:
            continue
        commit = candidates[lines[0]]
        for path in lines[1:]:
            for candidate in files:
                if _covers(candidate.path, path):
                    commit.add_file(candidate)


def _covers(candidate: str, path: str) -> bool:
    """``path`` is the candidate file, or inside the candidate directory."""
    candidate, path = candidate.lower(), path.replace("\\", "/").lower()
    return path == candidate or path.startswith(candidate + "/")


def _discount_bulk_commits(repo_root: Path, contenders: list[CommitCandidate]) -> bool:
    """Drop the file matches of bulk commits among ``contenders``; True if any were.

    Only the best few are counted, after ranking, and each count stops reading
    at the threshold — so the check costs one short git process per contender
    however large the commit. A count that cannot be made leaves the commit as
    it was.
    """
    if not contenders:
        return False
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_GIT_COMMANDS) as pool:
        counts = list(pool.map(lambda item: _changed_file_count(repo_root, item.hash), contenders))
    changed = False
    for candidate, count in zip(contenders, counts):
        if count is not None and count > BULK_COMMIT_FILES:
            candidate.bulk = True
            candidate.focus_files = []
            candidate.git_files = []
            candidate.ranked_files = []
            changed = True
    return changed


def _changed_file_count(repo_root: Path, commit: str) -> int | None:
    """Files ``commit`` changed, counted up to ``BULK_COMMIT_FILES + 1``; ``None`` on failure.

    Streamed and cut off rather than read whole: an import commit lists every
    file in the repository, and only "more than the threshold" matters.
    """
    if not _HASH_RE.fullmatch(commit):
        return None
    try:
        process = subprocess.Popen(
            # A merge against its first parent — what it brought in, as the
            # feedback reads it; plain diff-tree lists nothing for a merge.
            ["git", "diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "--diff-merges=first-parent", commit],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return None
    watchdog = threading.Timer(GIT_COMMAND_TIMEOUT_SECONDS, process.kill)
    watchdog.start()
    count = 0
    try:
        assert process.stdout is not None
        for line in process.stdout:
            if line.strip():
                count += 1
                if count > BULK_COMMIT_FILES:
                    break
    finally:
        watchdog.cancel()
        if process.poll() is None:
            process.kill()
        process.wait()
        if process.stdout is not None:
            process.stdout.close()
    if count <= BULK_COMMIT_FILES and process.returncode != 0:
        return None
    return count


def _run_all(repo_root: Path, commands: list[list[str]]) -> list[tuple[int, str]]:
    """Run git commands side by side; results come back in command order."""
    if not commands:
        return []
    if len(commands) == 1:
        return [run_command(commands[0], repo_root, timeout=GIT_COMMAND_TIMEOUT_SECONDS)]
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_GIT_COMMANDS) as pool:
        return list(
            pool.map(lambda args: run_command(args, repo_root, timeout=GIT_COMMAND_TIMEOUT_SECONDS), commands)
        )


def _failure_kind(code: int) -> str:
    return "timeout" if code == TIMEOUT_EXIT_CODE else "git_error"


# --- ranking ------------------------------------------------------------------------


def _ranked(candidates: list[CommitCandidate]) -> list[CommitCandidate]:
    """Score every candidate and sort: score, then newest, then hash — a total order."""
    newest = max((candidate.timestamp for candidate in candidates), default=0)
    for candidate in candidates:
        _score(candidate, newest)
    return sorted(candidates, key=lambda item: (-item.score, -item.timestamp, item.hash))


def _term_count(candidate: CommitCandidate) -> int:
    return len(candidate.git_keywords) + len(candidate.shared_keywords) + len(candidate.extracted_terms)


def _message_score(candidate: CommitCandidate) -> int:
    score = SCORE_ISSUE_ID if candidate.issue_id else 0
    if candidate.git_keywords:
        score += SCORE_GIT_KEYWORD + SCORE_EXTRA_GIT_KEYWORD * (len(candidate.git_keywords) - 1)
    if candidate.shared_keywords:
        score += SCORE_SHARED_KEYWORD + SCORE_EXTRA_SHARED_KEYWORD * (len(candidate.shared_keywords) - 1)
    score += SCORE_EXTRACTED_TERM * min(len(candidate.extracted_terms), MAX_SCORED_EXTRACTED_TERMS)
    if _term_count(candidate) >= 2:
        score += SCORE_MULTIPLE_TERMS
    if candidate.broad_keywords or candidate.broad_terms:
        score += SCORE_BROAD_TERM
    return score


def _score(candidate: CommitCandidate, newest: int) -> None:
    """Fixed weights, and one reason per weight that applied."""
    candidate.ranked_files.sort()
    reasons: list[str] = []
    if candidate.issue_id:
        reasons.append(f"exact issue ID match: {candidate.issue_id}")
    if candidate.git_keywords:
        reasons.append(_labelled("matched commit keyword", candidate.git_keywords))
    if candidate.shared_keywords:
        reasons.append(_labelled("matched shared keyword", candidate.shared_keywords))
    if candidate.extracted_terms:
        reasons.append(_labelled("matched issue term", candidate.extracted_terms))
    if _term_count(candidate) >= 2:
        reasons.append("matched several search terms")
    if candidate.broad_keywords or candidate.broad_terms:
        broad = [f"{term} (in {count} related commits)" for term, count in candidate.broad_keywords + candidate.broad_terms]
        reasons.append(_labelled("matched broad term", broad))
    score = _message_score(candidate)

    if candidate.focus_files:
        score += SCORE_FOCUS_FILE
        reasons.append(_labelled("modified focus file", [f"`{path}`" for path in candidate.focus_files]))
    if candidate.git_files:
        score += SCORE_ADDITIONAL_FILE
        reasons.append(_labelled("modified additional file", [f"`{path}`" for path in candidate.git_files]))
    if candidate.ranked_files:
        best = candidate.ranked_files[0][0]
        score += max(SCORE_RANKED_FILE_MIN, SCORE_RANKED_FILE_TOP - SCORE_RANKED_FILE_STEP * (best - 1))
        reasons.append(
            _labelled("modified Code Search file", [f"#{rank} `{path}`" for rank, path in candidate.ranked_files])
        )
    extra_files = len(candidate.files) - 1
    if extra_files > 0:
        score += min(SCORE_EXTRA_FILE * extra_files, MAX_EXTRA_FILE_BONUS)
        reasons.append("modified several relevant files")
    if candidate.bulk:
        reasons.append(f"bulk change (more than {BULK_COMMIT_FILES} files): its file matches are not counted")

    age_days = max(0, newest - candidate.timestamp) / 86400
    for days, bonus in RECENCY_BONUS:
        if age_days <= days:
            score += bonus
            reasons.append(f"recent: within {days} days of the newest related commit")
            break
    candidate.score = score
    candidate.reasons = reasons


def _labelled(label: str, values: list[str]) -> str:
    return f"{label}{'s' if len(values) > 1 else ''}: {', '.join(values)}"


# --- the structured result ----------------------------------------------------------

#: Why there is no list, in the sentence the context and the panel both show.
NO_GIT_WARNING = "git command is not available."
NOT_A_REPOSITORY_WARNING = "Current directory is not inside a git repository."
NOTHING_TO_SEARCH_WARNING = "No related files or search terms available yet."
#: A subject is one line, but nothing stops it being a paragraph long.
MAX_SUBJECT_CHARACTERS = 300

#: Each evidence kind, as the record names its source.
_TERM_SOURCE_OF = {
    "issue_id": "issue_id",
    "git_keywords": "additional_commit_keyword",
    "shared_keywords": "shared_keyword",
    "extracted_terms": "extracted_term",
}


@dataclass(frozen=True)
class RepositoryState:
    """Where the checkout stands: context for the agent, not part of the history search."""

    branch: str
    clean: bool
    #: ``git status --short``, or ``clean``.
    status: str


@dataclass(frozen=True)
class GitHistoryOutcome:
    """What the Git history step produced: the structured record, and the checkout's state.

    The record is persisted in ``retrieval.json`` and is the one source of the
    commit list wherever it is shown; the repository state is rendered into
    the context only, as it was before the record existed.
    """

    work_item_id: str
    record: GitHistoryRecord
    repository: RepositoryState | None = None


def collect_git_history(
    repo_root: Path,
    work_item_id: str,
    query: GitHistoryQuery | None = None,
    settings: GitHistoryOptions | None = None,
) -> GitHistoryOutcome:
    """Search, rank and record. The Git queries are Batch 1's, bounded by Batch 2's settings.

    ``query`` comes from what the caller already holds — the issue, the
    keywords, the options and the retrieval — so this reads no artifact.
    """
    settings = (settings or GitHistoryOptions()).normalized()
    search = GitHistorySearch(
        commit_message_search=settings.search_commit_messages,
        file_history_search=settings.search_file_history,
        history_depth=settings.history_depth,
        max_related_commits=settings.max_related_commits,
    )
    if not command_available("git"):
        return GitHistoryOutcome(work_item_id, GitHistoryRecord("unavailable", search, warnings=(NO_GIT_WARNING,)))
    if not inside_git_repo(repo_root):
        return GitHistoryOutcome(
            work_item_id, GitHistoryRecord("unavailable", search, warnings=(NOT_A_REPOSITORY_WARNING,))
        )
    status = working_tree_status(repo_root) or "unknown"
    repository = RepositoryState(branch=current_branch(repo_root) or "unknown", clean=status == "clean", status=status)
    query = query or GitHistoryQuery()
    if query.is_empty():
        record = GitHistoryRecord("nothing_to_search", search, warnings=(NOTHING_TO_SEARCH_WARNING,))
        return GitHistoryOutcome(work_item_id, record, repository)

    started = time.monotonic()
    limits = limits_for(settings)
    result = find_related_commits(repo_root, query, limits)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    # Counts only. The terms are the developer's keywords and the issue's words.
    log(
        issue_dir(repo_root, work_item_id),
        f"[INFO] git_context: {result.search_term_count} commit-search term(s), "
        f"{result.file_candidate_count} file-history candidate(s), {result.candidate_count} candidate "
        f"commit(s), {len(result.commits)} retained, {len(result.failures)} failed lookup(s)"
        f"{' (' + ', '.join(sorted(set(result.failures))) + ')' if result.failures else ''}, {elapsed_ms} ms",
    )
    supporting: tuple[SupportingFile, ...] = ()
    # The file side of Git history: off with "Search related file history",
    # like every other file lookup (Batch 2's rule).
    if limits.search_file_history:
        started = time.monotonic()
        supporting, stats = discover_supporting_files(repo_root, result, query)
        log(
            issue_dir(repo_root, work_item_id),
            f"[INFO] git_context feedback: {stats.commits_inspected} commit(s) inspected, "
            f"{stats.files_read} changed file(s) read, {len(supporting)} supporting file(s) retained, "
            f"{int((time.monotonic() - started) * 1000)} ms",
        )
    return GitHistoryOutcome(work_item_id, record_of(result, search, supporting), repository)


def record_of(
    result: GitHistoryResult, search: GitHistorySearch, supporting: tuple[SupportingFile, ...] = ()
) -> GitHistoryRecord:
    """The ranked result as a record: the same commits, order, scores and reasons.

    A projection, never a second ranking — nothing is sorted, filtered or
    rescored here. What is dropped is what neither the context nor the panel
    needs: the timestamp beyond its date, and the message, which was only ever
    matched against.
    """
    failed = len(result.failures)
    warnings = (_incomplete_warning(failed),) if failed else ()
    return GitHistoryRecord(
        status="completed",
        search=search,
        candidate_count=result.candidate_count,
        failed_lookup_count=failed,
        commits=tuple(_recorded(commit) for commit in result.commits),
        warnings=warnings,
        supporting_files=supporting,
    )


def _recorded(commit: CommitCandidate) -> RecordedCommit:
    terms: list[CommitTerm] = []
    if commit.issue_id:
        terms.append(CommitTerm(commit.issue_id, _TERM_SOURCE_OF["issue_id"]))
    for field_name in ("git_keywords", "shared_keywords", "extracted_terms"):
        terms.extend(CommitTerm(value, _TERM_SOURCE_OF[field_name]) for value in getattr(commit, field_name))
    terms.extend(CommitTerm(value, "shared_keyword", broad=True) for value, _count in commit.broad_keywords)
    terms.extend(CommitTerm(value, "extracted_term", broad=True) for value, _count in commit.broad_terms)
    files = (
        [CommitFile(path, "shared_focus_file") for path in commit.focus_files]
        + [CommitFile(path, "additional_file") for path in commit.git_files]
        + [CommitFile(path, "code_search_ranked_file") for _rank, path in commit.ranked_files]
    )
    subject = commit.subject
    if len(subject) > MAX_SUBJECT_CHARACTERS:
        subject = subject[: MAX_SUBJECT_CHARACTERS - 1].rstrip() + "…"
    return RecordedCommit(
        hash=commit.hash,
        short_hash=commit.short_hash,
        subject=subject,
        date=commit.date,
        score=commit.score,
        matched_terms=tuple(terms),
        files=tuple(files),
        reasons=tuple(commit.reasons),
    )


# --- changed-file feedback (Batch 4) ----------------------------------------------------
#
# One pass, after ranking: the strongest retained commits are asked which files
# they changed, and the ones Code Search did not return become supporting
# files. Nothing found here is searched again, ranked by Code Search, or fed back
# into a walk — the results go into the record and stop there.

#: Commits whose changed files are read: the best retained commits with evidence
#: of their own. Measured on a monorepo: the key files of the case Batch 1 could
#: not finish (no issue key, one Keyword) were already in the top three; the
#: fifth was a ranked-file-only commit touching 80+ unrelated files.
MAX_FEEDBACK_COMMITS = 5
#: Supporting files kept, and rendered into the context.
MAX_SUPPORTING_FILES = 5
#: The least a file needs: one of the top three commits, or corroboration.
MIN_SUPPORTING_SCORE = 8
#: What a commit lends each file it changed, by its place among those inspected.
SUPPORT_RANK_POINTS = (10, 9, 8, 6, 5)
SUPPORT_ISSUE_ID = 6
SUPPORT_GIT_KEYWORD = 4
#: The commit also changed a Focus File or an Additional File.
SUPPORT_WITH_EXPLICIT_FILE = 4
#: The commit also changed a file Code Search returned.
SUPPORT_WITH_RANKED_FILE = 2
#: Code Search's own noise reading of a path (build, vendor, generated, docs dirs).
SUPPORT_NOISE_PATH = -6
SUPPORT_DOCUMENTATION = -3

_CHANGE_OF = {"A": "added", "M": "modified", "T": "modified", "R": "renamed", "C": "copied"}


@dataclass(frozen=True)
class FeedbackStats:
    commits_inspected: int = 0
    files_read: int = 0


def feedback_commits(commits: tuple[CommitCandidate, ...] | list[CommitCandidate]) -> list[CommitCandidate]:
    """The commits worth asking for their files: the best retained, with evidence of their own.

    Retained order, never re-ranked. A commit kept only because it touched a
    Code Search file is left out — its co-changes are what file history already
    showed — and so is a bulk commit, whose files are everything.
    """
    chosen: list[CommitCandidate] = []
    for commit in commits:
        explicit = (
            commit.issue_id
            or commit.git_keywords
            or commit.shared_keywords
            or commit.extracted_terms
            or commit.focus_files
            or commit.git_files
            # A broad term (Batch 5) is weak in the ranking but still the
            # message's own evidence — what separates such a commit from one
            # kept only for touching a Code Search file. The generic-keyword
            # case's supporting file comes from exactly that pair.
            or commit.broad_keywords
            or commit.broad_terms
        )
        if explicit and not commit.bulk:
            chosen.append(commit)
        if len(chosen) >= MAX_FEEDBACK_COMMITS:
            break
    return chosen


def discover_supporting_files(
    repo_root: Path, result: GitHistoryResult, query: GitHistoryQuery
) -> tuple[tuple[SupportingFile, ...], FeedbackStats]:
    """Files the strongest commits changed that Code Search did not return. One pass."""
    inspected = feedback_commits(result.commits)
    if not inspected:
        return (), FeedbackStats()
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_GIT_COMMANDS) as pool:
        changes = list(pool.map(lambda commit: _changed_files(repo_root, commit.hash), inspected))

    explicit = [candidate for candidate in result.files if candidate.focus or candidate.additional]
    ranked = {path.replace("\\", "/").lower() for path in (*query.known_files, *query.ranked_files)}
    # Already in play: Code Search's files and every file whose history was read
    # by name. A directory of guidance is not a file; the files inside it are
    # new evidence, and only real paths git returned are ever considered.
    known = ranked | {candidate.path.lower() for candidate in result.files}
    root = repo_root.resolve()
    found: dict[str, _Support] = {}
    files_read = 0
    # What each inspected commit changed, so a merge that stayed in the list
    # (Batch 5) lends only files its inspected members did not already lend.
    changed_by = {
        commit.hash: {path.lower() for _status, path in changed}
        for commit, changed in zip(inspected, changes)
        if changed is not None and len(changed) <= BULK_COMMIT_FILES
    }
    # A commit's place among the ones that lent files: a bulk or unreadable
    # commit lends nothing and does not push the commits after it down.
    position = -1
    for commit, changed in zip(inspected, changes):
        if changed is None or len(changed) > BULK_COMMIT_FILES:
            continue
        position += 1
        files_read += len(changed)
        paths = [path for _status, path in changed]
        with_explicit = next(
            (candidate for candidate in explicit if any(_covers(candidate.path, path) for path in paths)), None
        )
        with_ranked = next((path for path in paths if path.lower() in ranked), None)
        points = (
            SUPPORT_RANK_POINTS[position]
            + (SUPPORT_ISSUE_ID if commit.issue_id else 0)
            + (SUPPORT_GIT_KEYWORD if commit.git_keywords else 0)
            + (SUPPORT_WITH_EXPLICIT_FILE if with_explicit else 0)
            + (SUPPORT_WITH_RANKED_FILE if with_ranked else 0)
        )
        lent_by_members = set().union(*(changed_by.get(member, set()) for member in commit.merge_members))
        for status, path in changed:
            if status == "D" or path.lower() in known or path.lower() in lent_by_members or not _current_file(root, path):
                continue
            support = found.setdefault(path.lower(), _Support(path, _CHANGE_OF.get(status, "modified")))
            if commit.hash in support.hashes:
                continue
            support.score += points
            support.hashes.append(commit.hash)
            support.issue_id = support.issue_id or bool(commit.issue_id)
            support.git_keyword = support.git_keyword or bool(commit.git_keywords)
            if with_explicit and support.with_explicit is None:
                support.with_explicit = with_explicit
            if with_ranked and support.with_ranked is None:
                support.with_ranked = with_ranked

    supporting = [support.finish() for support in found.values()]
    kept = sorted(
        (item for item in supporting if item.score >= MIN_SUPPORTING_SCORE),
        key=lambda item: (-item.score, -len(item.commit_hashes), item.path),
    )
    return tuple(kept[:MAX_SUPPORTING_FILES]), FeedbackStats(len(inspected), files_read)


@dataclass
class _Support:
    path: str
    change: str
    score: int = 0
    hashes: list[str] = field(default_factory=list)
    issue_id: bool = False
    git_keyword: bool = False
    with_explicit: FileCandidate | None = None
    with_ranked: str | None = None

    def finish(self) -> SupportingFile:
        count = len(self.hashes)
        reasons = [f"changed in {count} related commit{'s' if count != 1 else ''}"]
        if self.issue_id:
            reasons.append("changed in a commit matching the issue ID")
        if self.git_keyword:
            reasons.append("changed in a commit matching a commit keyword")
        if self.with_explicit is not None:
            kind = "focus file" if self.with_explicit.focus else "additional file"
            reasons.append(f"changed with {kind} `{self.with_explicit.path}`")
        if self.with_ranked is not None:
            reasons.append(f"changed with Code Search file `{self.with_ranked}`")
        score = self.score
        if _noise_flags(self.path):
            score += SUPPORT_NOISE_PATH
            reasons.append("path looks like CI/build/docs/vendor/generated content")
        if is_documentation(self.path):
            score += SUPPORT_DOCUMENTATION
            reasons.append("documentation, not implementation")
        return SupportingFile(
            path=self.path, score=score, change=self.change, commit_hashes=tuple(self.hashes), reasons=tuple(reasons)
        )


def _current_file(root: Path, path: str) -> bool:
    """A path git returned that is safe, of interest, and a file in the checkout now.

    The same path rule as every other file here (``safe_relative_path``), the
    same file kinds and excluded directories Code Search uses, and the file must
    exist and resolve inside the repository — so a deleted file, a directory and
    a symlink that leads out of the checkout are all refused.
    """
    if path.startswith('"') or safe_relative_path(path) != path:
        return False
    if not is_searchable(path):
        return False
    if any(part in EXCLUDE_DIRS for part in path.split("/")):
        return False
    target = root / path
    try:
        if not target.is_file():
            return False
        target.resolve().relative_to(root)
    except (OSError, ValueError):
        return False
    return True


def _changed_files(repo_root: Path, commit: str) -> list[tuple[str, str]] | None:
    """``(status, path)`` for each file ``commit`` changed — names only, never a diff.

    Streamed and cut off past ``BULK_COMMIT_FILES``, so a huge commit costs no
    more than a small one and reads as bulk. A merge is compared with its first
    parent: what the branch brought in. A rename gives its new path; the old one
    is not traced. ``None`` when git could not answer.
    """
    if not _HASH_RE.fullmatch(commit):
        return None
    try:
        process = subprocess.Popen(
            [
                "git", "-c", "core.quotepath=off", "log", "-1", "--no-show-signature", "--format=",
                "--name-status", "-M", "--diff-merges=first-parent", commit,
            ],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return None
    watchdog = threading.Timer(GIT_COMMAND_TIMEOUT_SECONDS, process.kill)
    watchdog.start()
    changed: list[tuple[str, str]] = []
    try:
        assert process.stdout is not None
        for line in process.stdout:
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) < 2 or not fields[0]:
                continue
            changed.append((fields[0][0], fields[-1]))
            if len(changed) > BULK_COMMIT_FILES:
                break
    finally:
        watchdog.cancel()
        if process.poll() is None:
            process.kill()
        process.wait()
        if process.stdout is not None:
            process.stdout.close()
    if len(changed) <= BULK_COMMIT_FILES and process.returncode != 0:
        return None
    return changed


def _incomplete_warning(failed: int) -> str:
    return f"{failed} git history lookup(s) did not complete; the list may be incomplete."


# --- the git context document ---------------------------------------------------------


def render_git_context(outcome: GitHistoryOutcome) -> str:
    """The Git context document, from the record and the checkout state alone.

    The only renderer of the commit list: ``context.md`` demotes this under its
    Git History heading, ``bugpilot git-context`` prints it. It ranks nothing
    and reads nothing — what it shows is the record, in the record's order.
    """
    record = outcome.record
    lines = [f"# Git Context: {outcome.work_item_id}", ""]
    if record.status == "unavailable" or outcome.repository is None:
        lines.extend(["## Warning", ""])
        lines.extend(record.warnings or (NOT_A_REPOSITORY_WARNING,))
        return "\n".join(lines).rstrip() + "\n"

    repository = outcome.repository
    lines.extend(
        [
            "## Repository",
            "",
            f"- Current branch: {repository.branch}",
            f"- Working tree: {'clean' if repository.clean else 'dirty'}",
            "",
            "## Status",
            "",
            "```text",
            repository.status,
            "```",
            "",
            "## Related Commits",
            "",
        ]
    )
    if record.status == "nothing_to_search":
        lines.append(f"_{NOTHING_TO_SEARCH_WARNING}_")
        return "\n".join(lines).rstrip() + "\n"
    lines.extend(_commit_markdown(record))
    lines.extend(_supporting_markdown(record))
    return "\n".join(lines).rstrip() + "\n"


def _supporting_markdown(record: GitHistoryRecord) -> list[str]:
    """The supporting files, said to be what they are: history's evidence, not search matches."""
    if not record.supporting_files:
        return []
    lines = [
        "## Supporting Files From Related Commits",
        "",
        "Files the related commits above also changed that Code Search did not return. "
        "Git history evidence, not search matches: read them as leads.",
        "",
    ]
    for item in record.supporting_files:
        hashes = ", ".join(commit[:10] for commit in item.commit_hashes)
        lines.append(f"- `{item.path}` ({item.change})")
        lines.append(f"  Why: {'; '.join(item.reasons)} — commits {hashes}")
    lines.append("")
    return lines


def related_commits_phrase(count: int) -> str:
    """The count as the context and the panel say it: one phrase, singular or plural."""
    if count == 0:
        return "No related commits found"
    return f"{count} related commit{'s' if count != 1 else ''} found"


def _commit_markdown(record: GitHistoryRecord) -> list[str]:
    lines: list[str] = [f"{related_commits_phrase(len(record.commits))}.", ""]
    for commit in record.commits:
        lines.extend([f"### {commit.short_hash} — {commit.subject or '(no subject)'}", ""])
        lines.append(f"Date: {commit.date}")
        if commit.matched_terms:
            lines.append(f"Matched: {', '.join(term.value for term in commit.matched_terms)}")
        lines.append("")
        if commit.files:
            lines.extend(["Relevant files:", *(f"- `{item.path}`" for item in commit.files), ""])
        lines.extend(["Why relevant:", *(f"- {reason}" for reason in commit.reasons), ""])
    for warning in record.warnings:
        lines.extend([f"_{warning}_", ""])
    return lines
