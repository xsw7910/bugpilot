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
- Git history and similar fixes. Neither produces structured data yet; both
  still reach the context as Markdown.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .artifact_io import atomic_write_text
from .artifacts import ARTIFACT_SCHEMA_VERSION, RETRIEVAL_ARTIFACT
from .config import issue_dir


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


@dataclass(frozen=True)
class RetrievalArtifact:
    confidence: str = "low"
    #: Why the confidence is what it is, followed by any search warnings.
    reasons: tuple[str, ...] = ()
    noise_indicators: tuple[str, ...] = ()
    #: In search order: the weighted terms first, then the generated shapes.
    terms: tuple[RetrievalTerm, ...] = ()
    related_files: tuple[RelatedFile, ...] = ()

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
