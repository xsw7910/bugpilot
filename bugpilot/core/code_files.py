"""Which files code search looks at, and which of them are documentation.

One list, because there were three and they disagreed. `search.INCLUDE_GLOBS`
built ripgrep's `-g` flags, `search._is_included_path` re-stated the same
suffixes inline to filter rg's output, and `keywords._CODE_EXT` decided whether
`widget.cpp` in a bug report looked like a file name. The third had drifted:
it recognised `.ts`, `.go`, `.java`, `.c`, `.hxx` and `.qml`, and the first two
did not — so a bug naming `reader.ts` produced a keyword for a file the search
would never open. Nine extensions were recognised and unsearchable.

The split between implementation and documentation is here for the same reason
the extensions are: `search.py` ranks with it and `context.py` selects with it,
and a second opinion about whether `.md` is documentation is a bug waiting to
happen.
"""

from __future__ import annotations

from pathlib import Path

#: Implementation: source, headers, UI definitions, build files.
#:
#: Extensions rather than languages, because that is what both consumers have.
#: Adding one here makes it searchable, filterable and recognisable as a file
#: name in a bug report, in one edit.
CODE_SUFFIXES: frozenset[str] = frozenset(
    {
        # C and C++
        "c", "cc", "cpp", "cxx", "h", "hpp", "hxx",
        # Qt
        "ui", "qrc", "qml",
        # build
        "cmake",
        # everything else bugpilot has been pointed at
        "py", "ts", "js", "java", "cs", "go", "rs",
    }
)

#: Files with no useful suffix that are still implementation.
CODE_FILENAMES: frozenset[str] = frozenset({"CMakeLists.txt"})

#: Prose. Searched — a design document naming the subsystem is a real lead — but
#: never allowed to displace implementation, which is what §33.2 is about.
#:
#: `txt` is deliberately absent. §33.2's requirement was to align the *code*
#: extensions the extractor already recognised; the documentation formats were
#: an addition of mine, and generic `.txt` turned out to be the wrong one. It is
#: the most common extension for things that are not prose at all —
#: `requirements.txt`, licence text, generated file lists, test fixtures, data
#: dumps — so searching it buys noise and scan time rather than leads. It was
#: also the cause of `CMakeLists.txt` classifying as documentation.
#:
#: `CMakeLists.txt` stays searchable through `CODE_FILENAMES`, which is where it
#: belongs: it is a build file, not a document.
DOC_SUFFIXES: frozenset[str] = frozenset({"md", "rst", "adoc"})


def search_globs() -> list[str]:
    """The `-g` patterns ripgrep is given, implementation and documentation."""
    suffixes = sorted(CODE_SUFFIXES | DOC_SUFFIXES)
    return [f"*.{suffix}" for suffix in suffixes] + sorted(CODE_FILENAMES)


def _suffix(path: str) -> str:
    return Path(path).suffix.lower().lstrip(".")


def is_searchable(path: str) -> bool:
    """Whether a path rg returned is one this search is interested in.

    rg is already told the globs; this filters its output too, because a glob
    and a returned path can disagree — a symlink, an odd separator, a file whose
    name matches a pattern by accident.
    """
    return Path(path).name in CODE_FILENAMES or _suffix(path) in (CODE_SUFFIXES | DOC_SUFFIXES)


def is_documentation(path: str) -> bool:
    """Prose rather than implementation. Never both.

    Mostly by extension: a `.md` under `src/` is still prose, and a path-based
    guess ("does it live in docs/") was wrong for README.md, which sits at the
    root of every repository bugpilot has been pointed at.

    The named-file check is the exception, and it is the whole reason this is
    not a one-line suffix test. `CMakeLists.txt` ends in `.txt`, so a pure
    suffix rule called it documentation *and* implementation at once. Ranking
    read the second answer and was right; the artifact label and the corpus
    metric read the first and were wrong — which would have quietly inflated
    "documentation in top 5" on exactly the CMake-heavy repositories §33 is
    aimed at.
    """
    if Path(path).name in CODE_FILENAMES:
        return False
    return _suffix(path) in DOC_SUFFIXES


def is_implementation(path: str) -> bool:
    return Path(path).name in CODE_FILENAMES or _suffix(path) in CODE_SUFFIXES
