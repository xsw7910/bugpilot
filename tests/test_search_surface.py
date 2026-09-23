"""What the search can see, and what it lets to the front (§33.2).

Two failures this file exists to prevent:

- a language bugpilot claims to understand being invisible to `rg`, which is
  silent: no error, no warning, just nothing found;
- documentation taking the seats that decide what an agent reads, which is worse
  than silent because the run looks successful.
"""

from __future__ import annotations

import shutil

import pytest

from bugpilot.core import search
from bugpilot.core.code_files import (
    CODE_SUFFIXES,
    DOC_SUFFIXES,
    is_documentation,
    is_implementation,
    is_searchable,
)
from bugpilot.core.keywords import _CODE_EXT
from bugpilot.core.search import FileScore, _select_with_reserved_slots

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")

def _search(repo_root, term: str):
    """One term's matches and true count, as `_probe_term` gathers them."""
    completed = search._run_rg(repo_root, term, [])
    return search._collect(completed.stdout, term, "issue") if completed else ([], 0)



# --- one list, not three ----------------------------------------------------


def test_the_extractor_and_the_search_agree_on_what_code_is():
    """They disagreed by nine extensions, and nothing said so.

    `keywords._CODE_EXT` recognised .ts/.go/.java/.c/.hxx/.qml; the search globs
    did not. A bug naming `reader.ts` produced a keyword for a file the search
    would never open.
    """
    assert _CODE_EXT is CODE_SUFFIXES


def test_the_globs_and_the_output_filter_agree():
    """rg is told the globs; its output is filtered again. Both from one list."""
    for suffix in CODE_SUFFIXES | DOC_SUFFIXES:
        assert f"*.{suffix}" in search.INCLUDE_GLOBS, suffix
        assert is_searchable(f"some/path/file.{suffix}"), suffix
    assert "CMakeLists.txt" in search.INCLUDE_GLOBS
    assert is_searchable("src/CMakeLists.txt")


@pytest.mark.parametrize("suffix", ["c", "hxx", "qml", "ts", "js", "cpp", "h", "py"])
def test_every_supported_language_is_searchable(suffix):
    assert is_searchable(f"src/thing.{suffix}")
    assert is_implementation(f"src/thing.{suffix}")
    assert not is_documentation(f"src/thing.{suffix}")


def test_prose_is_searchable_but_is_not_implementation():
    # Searched on purpose: a design note naming the subsystem is a real lead.
    for suffix in DOC_SUFFIXES:
        assert is_searchable(f"docs/thing.{suffix}")
        assert is_documentation(f"docs/thing.{suffix}")
        assert not is_implementation(f"docs/thing.{suffix}")
    # By extension, not by directory: README.md sits at the root of every
    # repository bugpilot has been pointed at.
    assert is_documentation("README.md")
    assert is_documentation("src/notes.md")


def test_binaries_are_not_searched():
    for path in ["a.png", "b.exe", "c.dll", "d.zip"]:
        assert not is_searchable(path)


@needs_rg
@pytest.mark.parametrize("suffix", ["c", "hxx", "qml", "ts", "js"])
def test_a_file_in_a_newly_supported_language_is_actually_found(tmp_path, suffix):
    """The proof that matters: the real binary, on a real file.

    Each of these was invisible before §33.2 — recognised by the extractor,
    excluded by the search.
    """
    (tmp_path / f"reader.{suffix}").write_text("void mapSampleIndexToSampleValue() {}\n", encoding="utf-8")

    matches, _total = _search(tmp_path, "mapSampleIndexToSampleValue")

    assert [match.file for match in matches] == [f"reader.{suffix}"]


# --- documentation does not take the front seats ----------------------------


def _scored(path: str, score: int, *, focus: bool = False) -> FileScore:
    item = FileScore(file=path)
    item.score = score
    if focus:
        item.reasons.append(search.FOCUS_REASON)
    return item


def test_implementation_leads_even_when_documentation_scores_higher():
    # The §33.1 baseline: docs held 15 of 30 top-5 slots, because prose terms
    # match prose files.
    ordered = [
        _scored("docs/plan.md", 50),
        _scored("README.md", 40),
        _scored("docs/architecture.md", 30),
        _scored("bugpilot/core/thing.py", 20),
        _scored("src/other.cpp", 10),
    ]

    selected = [item.file for item in _select_with_reserved_slots(ordered, 5)]

    assert selected[:2] == ["bugpilot/core/thing.py", "src/other.cpp"]


def test_documentation_is_still_returned_as_supporting_context():
    """Not a filter. A design note naming the subsystem is worth reading."""
    ordered = [
        _scored("docs/plan.md", 50),
        _scored("README.md", 40),
        _scored("bugpilot/core/thing.py", 20),
    ]

    selected = [item.file for item in _select_with_reserved_slots(ordered, 5)]

    assert "docs/plan.md" in selected
    assert "README.md" in selected


def test_an_all_documentation_result_is_not_emptied():
    ordered = [_scored("docs/a.md", 30), _scored("docs/b.md", 20)]

    selected = [item.file for item in _select_with_reserved_slots(ordered, 5)]

    assert selected == ["docs/a.md", "docs/b.md"]


def test_a_focus_file_still_leads_even_when_it_is_documentation():
    """A --focus-file is an instruction, not a heuristic to be overruled."""
    ordered = [
        _scored("docs/design.md", 60, focus=True),
        _scored("docs/plan.md", 50),
        _scored("bugpilot/core/thing.py", 20),
    ]

    selected = [item.file for item in _select_with_reserved_slots(ordered, 5)]

    assert selected[0] == "docs/design.md"


def test_the_cap_is_still_the_cap():
    ordered = [_scored(f"src/f{index}.py", 100 - index) for index in range(20)]

    assert len(_select_with_reserved_slots(ordered, 4)) == 4
    assert len(_select_with_reserved_slots(ordered, 10)) == 10


# --- implementation and documentation are different questions ----------------


@pytest.mark.parametrize(
    "path,implementation,documentation",
    [
        ("CMakeLists.txt", True, False),
        ("src/CMakeLists.txt", True, False),
        ("README.md", False, True),
        ("docs/architecture.md", False, True),
        ("foo.cpp", True, False),
        ("foo.h", True, False),
        ("foo.qml", True, False),
        ("foo.ts", True, False),
    ],
)
def test_each_path_is_one_thing_or_the_other(path, implementation, documentation):
    """`CMakeLists.txt` was both, because it ends in `.txt`.

    Ranking read `is_implementation` and was right; the artifact label and the
    corpus metric read `is_documentation` and were wrong — which would have
    inflated "documentation in top 5" on precisely the CMake-heavy repositories
    §33 is aimed at.
    """
    assert is_implementation(path) is implementation
    assert is_documentation(path) is documentation


def test_nothing_is_both_implementation_and_documentation():
    paths = [
        "CMakeLists.txt", "src/CMakeLists.txt", "README.md", "docs/a.md", "notes.rst",
        "guide.adoc", "a.cpp", "b.h", "c.hxx", "d.qml", "e.ts", "f.js", "g.py",
        "h.cmake", "i.ui", "j.qrc",
    ]

    for path in paths:
        assert not (is_implementation(path) and is_documentation(path)), path


def test_generic_text_files_are_not_searched(tmp_path):
    """`.txt` is the commonest extension for things that are not prose.

    requirements.txt, licence text, generated file lists, data dumps. Searching
    it buys scan time and noise rather than leads, so only the real
    documentation formats are in.
    """
    for path in ["notes.txt", "requirements.txt", "data/dump.txt"]:
        assert not is_searchable(path), path
        assert not is_implementation(path)
        assert not is_documentation(path)
    assert "*.txt" not in search.INCLUDE_GLOBS


def test_the_build_file_is_still_searchable_by_name():
    """Dropping `*.txt` must not drop CMakeLists.txt with it."""
    assert is_searchable("CMakeLists.txt")
    assert is_searchable("src/nested/CMakeLists.txt")
    assert "CMakeLists.txt" in search.INCLUDE_GLOBS


@needs_rg
def test_a_real_cmake_file_is_found_and_a_stray_text_file_is_not(tmp_path):
    (tmp_path / "CMakeLists.txt").write_text("add_library(VolumeReader foo.cpp)\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("VolumeReader is mentioned here too\n", encoding="utf-8")

    matches, _total = _search(tmp_path, "VolumeReader")

    assert [match.file for match in matches] == ["CMakeLists.txt"]
