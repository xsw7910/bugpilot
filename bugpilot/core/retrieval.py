"""What the code search found: one typed object, persisted as ``retrieval.json``.

The search stage used to leave four files — the extracted keywords, a Markdown
report, a quality file and a ranked file list — each written by one step and
read back from disk by the next. This is the one result they described: the
terms that were searched and what each found, the files that ranked, the lines
that put them there, and how far to trust the lot.

The extension's Code search row — its counts, Relevant files and Search
details — is a projection of this one artifact, so its parts cannot disagree.

What is deliberately *not* here:

- The extracted keyword lists. They are the extractor's intermediate state, a
  pure function of the issue text, and are passed in memory; ``terms`` records
  what was actually searched.
- Raw ripgrep output. ``match_count`` keeps the one number it was needed for;
  ``snippets`` keeps the bounded evidence the context and the agent read.
- Per-confidence file lists. Each was ``related_files[].confidence`` filtered.
- Similar fixes. It produces no structured data yet and reaches the context as
  Markdown.

Git history's structured result lives here too, as the ``git_history`` section
(Git History Retrieval v2, Batch 3): the place the artifact contract reserved
for it, so the work item keeps its five files. It is written by the Git history
step into the retrieval Code Search wrote, and is absent when that step did not
run — Code Search rewrites the file without it, so a section is never left over
from an earlier run. It carries its own ``schema_version``: a reader that does
not understand it ignores it, and the code search part stays readable. Since
Batch 4 it also holds ``supporting_files`` — files Git history's commits
changed that Code Search did not return, each marked ``source: "git_history"``
— which stay in that section and never join ``related_files``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .artifact_io import atomic_write_text
from .artifacts import ARTIFACT_SCHEMA_VERSION, RETRIEVAL_ARTIFACT
from .config import issue_dir
from .models import DEFAULT_MAX_RELATED_COMMITS


class RetrievalArtifactError(ValueError):
    """``retrieval.json`` exists but is not a readable version-1 artifact."""


@dataclass(frozen=True)
class RetrievalTerm:
    """One term that reached ripgrep, and what the repository said about it.

    ``match_count`` is matching *lines* across the repository — one per line
    ripgrep printed — not files and not the evidence kept downstream.
    """

    value: str
    source: str
    weight: int
    effective_weight: int
    match_count: int
    #: ``zero``, ``specific`` or ``broad``, decided by ``search.py``.
    classification: str
    #: The phrase a generated shape was built from; empty for everything else.
    derived_from: str = ""
    #: ``retained`` or ``dropped`` (a term that matched nothing).
    status: str = "retained"


@dataclass(frozen=True)
class Snippet:
    """One matched line, as the context and the agent read it."""

    line: int
    text: str


@dataclass(frozen=True)
class RelatedFile:
    """One ranked file. Order in ``RetrievalArtifact.related_files`` is the rank."""

    file: str
    #: Prose rather than implementation, as ``code_files.is_documentation`` decided.
    documentation: bool
    score: int
    confidence: str
    match_count: int
    matched_keywords: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()
    noise_flags: tuple[str, ...] = ()
    #: The matched lines kept for this file, under the search's line budget.
    snippets: tuple[Snippet, ...] = ()


# --- Git history's section --------------------------------------------------------

#: The version of the ``git_history`` section, independent of the file's own.
GIT_HISTORY_SCHEMA_VERSION = 1
#: ``completed`` — the search ran (no commits is a result); ``unavailable`` —
#: no git, or not a repository; ``nothing_to_search`` — no issue key, term or file.
GIT_HISTORY_STATUSES = ("completed", "unavailable", "nothing_to_search")
#: Where a matched term came from, strongest first.
COMMIT_TERM_SOURCES = ("issue_id", "additional_commit_keyword", "shared_keyword", "extracted_term")
#: Why a file counted as evidence for a commit.
COMMIT_FILE_SOURCES = ("shared_focus_file", "additional_file", "code_search_ranked_file")
#: The provenance of every supporting file (Batch 4): found through Git history's
#: commits, never by Code Search. One value, written out so no reader can mistake
#: the list for search results.
SUPPORTING_FILE_SOURCE = "git_history"
#: How the strongest commit that changed a supporting file changed it.
SUPPORTING_FILE_CHANGES = ("added", "modified", "renamed", "copied")


@dataclass(frozen=True)
class CommitTerm:
    """One term a commit message matched, and which input it came from."""

    value: str
    source: str
    #: Matched too many candidate commits to count fully (Batch 5): written as
    #: ``"broad": true`` only when set, so every other term reads as before.
    broad: bool = False


@dataclass(frozen=True)
class CommitFile:
    """One known candidate file a commit changed, and why that file was a candidate."""

    path: str
    source: str


@dataclass(frozen=True)
class RecordedCommit:
    """One retained commit: what the context and the panel show, nothing more.

    No body and no diff: the message was matched and discarded, and only the
    candidate files already in play are named.
    """

    hash: str
    short_hash: str
    subject: str
    #: UTC committer date, ``YYYY-MM-DD``.
    date: str
    score: int
    matched_terms: tuple[CommitTerm, ...] = ()
    files: tuple[CommitFile, ...] = ()
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class SupportingFile:
    """A file the related commits changed that Code Search did not return (Batch 4).

    Supporting evidence, not a search result: it lives in Git history's section
    and never in ``related_files``. The commits that changed it are named by
    hash, best first; the reasons say why those commits counted.
    """

    path: str
    score: int
    #: How the best of its commits changed it; a rename records the new path.
    change: str
    commit_hashes: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()
    source: str = SUPPORTING_FILE_SOURCE


@dataclass(frozen=True)
class GitHistorySearch:
    """The Git History Settings the search ran with, as far as they shape the result."""

    commit_message_search: bool = True
    file_history_search: bool = True
    history_depth: str = "recent"
    max_related_commits: int = DEFAULT_MAX_RELATED_COMMITS


@dataclass(frozen=True)
class GitHistoryRecord:
    """Git history's structured result: the one source for the context and the panel."""

    status: str
    search: GitHistorySearch = GitHistorySearch()
    candidate_count: int = 0
    #: Git lookups that timed out or failed; the list may be missing commits.
    failed_lookup_count: int = 0
    #: Retained commits, best first — the ranking's order, never re-sorted.
    commits: tuple[RecordedCommit, ...] = ()
    #: Sentences a reader should see: why there is no result, or that it is partial.
    warnings: tuple[str, ...] = ()
    #: Files the strongest commits changed that Code Search did not find, best
    #: first (Batch 4). Absent from a section written before Batch 4.
    supporting_files: tuple[SupportingFile, ...] = ()

    @property
    def incomplete(self) -> bool:
        return self.failed_lookup_count > 0


@dataclass(frozen=True)
class RetrievalArtifact:
    confidence: str = "low"
    #: Why the confidence is what it is, followed by any search warnings.
    reasons: tuple[str, ...] = ()
    noise_indicators: tuple[str, ...] = ()
    #: In search order: the weighted terms first, then the generated shapes.
    terms: tuple[RetrievalTerm, ...] = ()
    related_files: tuple[RelatedFile, ...] = ()
    #: Git history's section; ``None`` when that step has not run since Code
    #: Search last wrote the file.
    git_history: GitHistoryRecord | None = None

    def top_files(self, count: int) -> list[str]:
        """The first ``count`` ranked paths."""
        return [item.file for item in self.related_files[:count]]


# --- on-disk form ------------------------------------------------------------


def retrieval_path(repo_root: Path, work_item_id: str) -> Path:
    return issue_dir(repo_root, work_item_id) / RETRIEVAL_ARTIFACT


def save_retrieval(repo_root: Path, work_item_id: str, retrieval: RetrievalArtifact) -> Path:
    """Write ``retrieval.json`` atomically, once, when the search is complete.

    Atomically because the extension reads it to draw Relevant files and
    Search details, possibly while a refinement is rewriting it.
    """
    path = retrieval_path(repo_root, work_item_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(retrieval_to_dict(retrieval), indent=2, ensure_ascii=False) + "\n")
    return path


def load_retrieval(repo_root: Path, work_item_id: str) -> RetrievalArtifact | None:
    """The persisted retrieval, or ``None`` when the search has not run.

    Raises :class:`RetrievalArtifactError` when the file exists but cannot be
    used, including one from before this schema.
    """
    path = retrieval_path(repo_root, work_item_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        raise RetrievalArtifactError(
            f".ai/{work_item_id}/{RETRIEVAL_ARTIFACT} could not be read ({exc})."
        ) from exc
    return retrieval_from_dict(data, work_item_id)


def read_retrieval_quietly(repo_root: Path, work_item_id: str) -> RetrievalArtifact | None:
    """:func:`load_retrieval` for a caller that renders "not available" instead."""
    try:
        return load_retrieval(repo_root, work_item_id)
    except RetrievalArtifactError:
        return None


def retrieval_to_dict(retrieval: RetrievalArtifact) -> dict[str, object]:
    data = _code_search_dict(retrieval)
    if retrieval.git_history is not None:
        data["git_history"] = git_history_to_dict(retrieval.git_history)
    return data


def _code_search_dict(retrieval: RetrievalArtifact) -> dict[str, object]:
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "confidence": retrieval.confidence,
        "reasons": list(retrieval.reasons),
        "noise_indicators": list(retrieval.noise_indicators),
        "terms": [
            {
                "value": term.value,
                "source": term.source,
                "weight": term.weight,
                "effective_weight": term.effective_weight,
                "match_count": term.match_count,
                "classification": term.classification,
                "derived_from": term.derived_from,
                "status": term.status,
            }
            for term in retrieval.terms
        ],
        "related_files": [
            {
                "file": item.file,
                "documentation": item.documentation,
                "score": item.score,
                "confidence": item.confidence,
                "match_count": item.match_count,
                "matched_keywords": list(item.matched_keywords),
                "reasons": list(item.reasons),
                "noise_flags": list(item.noise_flags),
                "snippets": [{"line": snippet.line, "text": snippet.text} for snippet in item.snippets],
            }
            for item in retrieval.related_files
        ],
    }


def retrieval_from_dict(data: object, work_item_id: str) -> RetrievalArtifact:
    """Rebuild a retrieval from ``retrieval.json``. Version 1 only, by design."""
    where = f".ai/{work_item_id}/{RETRIEVAL_ARTIFACT}"
    if not isinstance(data, dict):
        raise RetrievalArtifactError(f"{where} does not contain a JSON object.")
    if data.get("schema_version") != ARTIFACT_SCHEMA_VERSION:
        raise RetrievalArtifactError(
            f"{where} has schema_version {data.get('schema_version')!r}; expected "
            f"{ARTIFACT_SCHEMA_VERSION}. Re-run the search."
        )
    return RetrievalArtifact(
        confidence=str(data.get("confidence") or "low"),
        reasons=_strings(data.get("reasons")),
        noise_indicators=_strings(data.get("noise_indicators")),
        terms=tuple(
            RetrievalTerm(
                value=str(item.get("value") or ""),
                source=str(item.get("source") or ""),
                weight=_int(item.get("weight")),
                effective_weight=_int(item.get("effective_weight")),
                match_count=_int(item.get("match_count")),
                classification=str(item.get("classification") or ""),
                derived_from=str(item.get("derived_from") or ""),
                status=str(item.get("status") or ""),
            )
            for item in _list(data.get("terms"))
            if isinstance(item, dict) and str(item.get("value") or "").strip()
        ),
        related_files=tuple(
            RelatedFile(
                file=str(item.get("file")),
                documentation=item.get("documentation") is True,
                score=_int(item.get("score")),
                confidence=str(item.get("confidence") or "low"),
                match_count=_int(item.get("match_count")),
                matched_keywords=_strings(item.get("matched_keywords")),
                reasons=_strings(item.get("reasons")),
                noise_flags=_strings(item.get("noise_flags")),
                snippets=tuple(
                    Snippet(line=_int(snippet.get("line")), text=str(snippet.get("text") or ""))
                    for snippet in _list(item.get("snippets"))
                    if isinstance(snippet, dict)
                ),
            )
            for item in _list(data.get("related_files"))
            if isinstance(item, dict) and str(item.get("file") or "").strip()
        ),
        # A section this version cannot read is no section — never a reason to
        # lose the search it sits beside.
        git_history=git_history_from_dict(data.get("git_history")),
    )


def git_history_to_dict(record: GitHistoryRecord) -> dict[str, object]:
    """The ``git_history`` section. Key order is fixed, so equal records serialize equally."""
    return {
        "schema_version": GIT_HISTORY_SCHEMA_VERSION,
        "status": record.status,
        "search": {
            "commit_message_search": record.search.commit_message_search,
            "file_history_search": record.search.file_history_search,
            "history_depth": record.search.history_depth,
            "max_related_commits": record.search.max_related_commits,
        },
        "summary": {
            "candidate_count": record.candidate_count,
            "related_commit_count": len(record.commits),
            "incomplete": record.incomplete,
            "failed_lookup_count": record.failed_lookup_count,
        },
        "commits": [
            {
                "hash": commit.hash,
                "short_hash": commit.short_hash,
                "subject": commit.subject,
                "date": commit.date,
                "score": commit.score,
                "matched_terms": [
                    {"value": term.value, "source": term.source, **({"broad": True} if term.broad else {})}
                    for term in commit.matched_terms
                ],
                "files": [{"path": item.path, "source": item.source} for item in commit.files],
                "reasons": list(commit.reasons),
            }
            for commit in record.commits
        ],
        "warnings": list(record.warnings),
        "supporting_files": [
            {
                "path": item.path,
                "source": item.source,
                "score": item.score,
                "change": item.change,
                "commit_hashes": list(item.commit_hashes),
                "reasons": list(item.reasons),
            }
            for item in record.supporting_files
        ],
    }


def git_history_from_dict(data: object) -> GitHistoryRecord | None:
    """The section, or ``None`` when it is absent or not a version-1 section."""
    if not isinstance(data, dict) or data.get("schema_version") != GIT_HISTORY_SCHEMA_VERSION:
        return None
    status = data.get("status")
    if status not in GIT_HISTORY_STATUSES:
        return None
    search = data.get("search") if isinstance(data.get("search"), dict) else {}
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    return GitHistoryRecord(
        status=str(status),
        search=GitHistorySearch(
            commit_message_search=search.get("commit_message_search") is not False,
            file_history_search=search.get("file_history_search") is not False,
            history_depth=str(search.get("history_depth") or "recent"),
            max_related_commits=_int(search.get("max_related_commits")) or DEFAULT_MAX_RELATED_COMMITS,
        ),
        candidate_count=_int(summary.get("candidate_count")),
        failed_lookup_count=_int(summary.get("failed_lookup_count")),
        commits=tuple(
            RecordedCommit(
                hash=str(item.get("hash")),
                short_hash=str(item.get("short_hash") or ""),
                subject=str(item.get("subject") or ""),
                date=str(item.get("date") or ""),
                score=_int(item.get("score")),
                matched_terms=tuple(
                    CommitTerm(str(term.get("value")), str(term.get("source")), broad=term.get("broad") is True)
                    for term in _list(item.get("matched_terms"))
                    if isinstance(term, dict) and term.get("source") in COMMIT_TERM_SOURCES and term.get("value")
                ),
                files=tuple(
                    CommitFile(str(entry.get("path")), str(entry.get("source")))
                    for entry in _list(item.get("files"))
                    if isinstance(entry, dict) and entry.get("source") in COMMIT_FILE_SOURCES and entry.get("path")
                ),
                reasons=_strings(item.get("reasons")),
            )
            for item in _list(data.get("commits"))
            if isinstance(item, dict) and isinstance(item.get("hash"), str) and item.get("hash")
        ),
        warnings=_strings(data.get("warnings")),
        # A Batch 3 section has no list: no supporting files, not an error.
        supporting_files=tuple(
            SupportingFile(
                path=str(item.get("path")),
                score=_int(item.get("score")),
                change=str(item.get("change")),
                commit_hashes=_strings(item.get("commit_hashes")),
                reasons=_strings(item.get("reasons")),
            )
            for item in _list(data.get("supporting_files"))
            if isinstance(item, dict)
            and item.get("source") == SUPPORTING_FILE_SOURCE
            and item.get("change") in SUPPORTING_FILE_CHANGES
            and isinstance(item.get("path"), str)
            and item.get("path")
        ),
    )


def _list(value: object) -> list:
    return value if isinstance(value, list) else []


def _strings(value: object) -> tuple[str, ...]:
    return tuple(str(item) for item in _list(value) if item is not None)


def _int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
