"""What actually reaches `context.md` (§33.6).

Only the top five related files are written into the context, and the context is
what the agent reads. A ranking mistake here is not a slightly worse list — it is
the difference between an agent opening the implementation and an agent reading
the architecture document about it.

These tests assert the finished artifact rather than the scores behind it,
because the scores were right in cases where the context still was not.
"""

from __future__ import annotations

import shutil

import pytest

from bugpilot.core.context import build_context
from bugpilot.core.issue import IssueArtifact
from bugpilot.core.keywords import extract_keywords
from bugpilot.core.models import InvestigationOptions
from bugpilot.core.workflow import code_search_step

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")

ISSUE = "The volume reader drops traces when the dataset is empty."


def _repo(tmp_path):
    """A repository where the same words appear in code, in tests and in prose."""
    (tmp_path / "src").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "docs").mkdir()
    (tmp_path / "src" / "VolumeReader.cpp").write_text(
        "// the volume reader drops traces when the dataset is empty\n"
        "void VolumeReader::read() {}\n",
        encoding="utf-8",
    )
    (tmp_path / "src" / "VolumeReader.h").write_text("class VolumeReader;\n", encoding="utf-8")
    (tmp_path / "tests" / "test_volume_reader.cpp").write_text(
        "// volume reader drops traces test\n", encoding="utf-8"
    )
    # Prose that mentions the same words more often than the code does.
    for name in ["architecture.md", "design.md", "notes.md"]:
        (tmp_path / "docs" / name).write_text(
            "The volume reader drops traces when the dataset is empty.\n" * 12,
            encoding="utf-8",
        )
    (tmp_path / "README.md").write_text(
        "volume reader traces dataset empty\n" * 12, encoding="utf-8"
    )
    return tmp_path


def _context(tmp_path, options: InvestigationOptions | None = None) -> str:
    keywords = extract_keywords(ISSUE)
    retrieval = code_search_step(tmp_path, "JR-1", options or InvestigationOptions(), keywords=keywords)
    issue = IssueArtifact(id="JR-1", source="jira", title=ISSUE, description=ISSUE)
    return build_context(issue, keywords, retrieval)


def _listed(context: str) -> list[str]:
    """The related files the context actually names, in order."""
    files = []
    for line in context.splitlines():
        stripped = line.strip()
        if stripped.startswith("- `") and "confidence=" in stripped:
            files.append(stripped.split("`")[1])
    return files


@needs_rg
def test_implementation_reaches_the_context_ahead_of_prose(tmp_path):
    # Four prose files repeat the issue's own sentence; one source file mentions
    # it once. Before §33.2 the prose took every slot.
    context = _context(_repo(tmp_path))

    listed = _listed(context)
    assert listed, f"no related files in the context:\n{context}"
    assert listed[0].endswith((".cpp", ".h")), listed
    implementation = [path for path in listed if not path.endswith(".md")]
    assert len(implementation) >= 2, listed


@needs_rg
def test_documentation_is_still_offered_as_supporting_context(tmp_path):
    """Not a filter: a design note naming the subsystem is worth reading."""
    context = _context(_repo(tmp_path))

    assert any(path.endswith(".md") for path in _listed(context)), _listed(context)


@needs_rg
def test_a_test_file_is_a_lead_and_is_not_excluded(tmp_path):
    """A test naming the broken behaviour is one of the better leads there is."""
    context = _context(_repo(tmp_path))

    assert any("test_volume_reader" in path for path in _listed(context)), _listed(context)


@needs_rg
def test_a_focus_file_leads_the_context_whatever_it_is(tmp_path):
    """A --focus-file is an instruction; §33.2's reservation must not overrule it."""
    context = _context(
        _repo(tmp_path), InvestigationOptions(focus_files=["docs/design.md"])
    )

    listed = _listed(context)
    assert listed[0] == "docs/design.md", listed


@needs_rg
def test_the_context_still_reports_search_quality(tmp_path):
    """The §33.4 diagnostics must not have displaced what was there."""
    context = _context(_repo(tmp_path))

    assert "Context Quality" in context or "Search Quality" in context or "confidence" in context.lower()
