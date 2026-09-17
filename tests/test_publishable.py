"""Nothing published identifies one company, one person, or one Jira.

`bugpilot` is installable by anyone, so `bugpilot/**` is public surface. It used
to carry a hard-coded company Jira tenant as the default base URL, which is two
problems in one line: it discloses an internal hostname, and it points every
stranger's first run at somebody else's Jira.

**README.md is scanned too, and that was a gap.** It is `readme` in
pyproject.toml, so it becomes the PyPI project page — as public as any module,
and it was carrying real ticket numbers while this file looked only at the
package.

**So is the extension, and that was the same gap a second time.** The `.vsix`
is a second published artifact and nothing here read it, so a real ticket
number sat in its issue-key placeholder through several releases. `_sources()`
now covers both.

Still deliberately out of scope: `docs/` and `tests/`. Neither is published —
`MANIFEST.in` prunes them from the sdist, and a test asserts that — and whether
the repository itself goes public is a decision, not a property of the code.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PACKAGE = REPO / "bugpilot"

WORD_LIST = Path(__file__).resolve().parent / "forbidden_words.txt"


def _forbidden_words() -> list[str]:
    """The company identifiers, read from a file that is not in the repository.

    Naming them here would be self-defeating: this guard exists so that nothing
    published carries a company's name, and a public repository containing
    `re.compile(r"<company>")` publishes it in the one file anyone auditing the
    project is sure to read. So the list lives in a gitignored
    `forbidden_words.txt`, with `forbidden_words.example` committed beside it.

    The cost is real and is accepted: a fork gets an empty list, and this one
    check does nothing for them. What stops the same thing happening silently
    to the person who does know the words is
    `test_the_word_list_is_present_and_private`.
    """
    if not WORD_LIST.exists():
        return []
    words = []
    for line in WORD_LIST.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            words.append(line)
    return words


# Each pattern is something that must not be *baked in*. Placeholders are fine
# and necessary — a setup prompt has to show an example — so the patterns match
# real values rather than the shape of a value.
FORBIDDEN: dict[str, re.Pattern[str]] = {
    "a specific Jira tenant": re.compile(
        # Any atlassian.net host that is not an obvious placeholder.
        r"https://(?!your-company|yourcompany|example|acme|company)[\w.-]+\.atlassian\.net",
        re.IGNORECASE,
    ),
    # `example.com` and `your-company.com` are both placeholder conventions in
    # this repository; neither is a person.
    "a real person": re.compile(
        r"[\w.+-]+@(?!example\.|your-company\.|yourcompany\.)[\w-]+\.(?:com|net|org|io)",
        re.IGNORECASE,
    ),
    # `HR` is the real Jira project prefix of the codebase this was built
    # against, so the whole prefix is forbidden and not just the real numbers.
    # It used to be allowed with one number carved out as "the fictional one",
    # and that carve-out was the hiding place: a colleague's actual ticket sat
    # in the extension's issue-key placeholder and read as an example. Naming
    # it here would only move the disclosure into the guard against it. Every
    # example is now `JR-12345`, a prefix nobody uses.
    "a real ticket number": re.compile(r"\bHR-\d+", re.IGNORECASE),
}

# Added rather than written out, so the words themselves stay out of the
# repository. Absent list, absent pattern — and a test below that fails when
# that is the state here, where the list is supposed to exist.
if _forbidden_words():
    FORBIDDEN["a company name"] = re.compile(
        "|".join(re.escape(word) for word in _forbidden_words()), re.IGNORECASE
    )

# Exemptions, with reasons. Empty, and kept as a mechanism so that adding one is
# a decision somebody makes on purpose rather than a pattern quietly loosened.
#
# Not listed here, because it is not a disclosure: `keywords.py` keeps the
# product prefix `hrs` in its generic-parts list. That list is tuned for a
# Qt/C++ codebase, the entry changes ranking for the repository this was built
# for, and the three letters mean nothing anywhere else.
ALLOWED: dict[str, str] = {}


def _label(path: Path) -> str:
    """A path as it reads in a failure message, and as an ALLOWED key."""
    return path.relative_to(REPO).as_posix()


def _sources() -> list[Path]:
    """Everything that gets published: the Python package and the extension.

    Two artifacts, one guard. The extension was not covered until a real ticket
    number rode into a shipped `.vsix` inside the issue-key placeholder of
    `panel/html.ts` — this file was reading `bugpilot/**` and nothing else, so
    it saw a clean package and said so. The paths below mirror the allowlist in
    `extension/.vscodeignore`: `src/` is what becomes `out/`, and the other
    entries are shipped verbatim.
    """
    files = [path for path in PACKAGE.rglob("*.py") if "__pycache__" not in path.parts]
    files.append(REPO / "README.md")

    extension = REPO / "extension"
    files += [extension / name for name in ("package.json", "README.md", "CHANGELOG.md")]
    for directory, suffixes in ((extension / "src", {".ts"}), (extension / "media", {".js", ".css"})):
        files += [path for path in directory.rglob("*") if path.suffix in suffixes]

    return sorted(path for path in files if path.is_file())


def test_the_package_names_no_company_person_or_jira_site():
    offenders: list[str] = []
    for path in _sources():
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in FORBIDDEN.items():
            for match in pattern.finditer(text):
                key = f"{_label(path)}:{label}"
                if key in ALLOWED:
                    continue
                line = text[: match.start()].count("\n") + 1
                offenders.append(f"{_label(path)}:{line} names {label}: {match.group(0)}")

    assert offenders == [], (
        "the published package would disclose these. Make it configuration, or "
        "add it to ALLOWED with the reason:\n  " + "\n  ".join(offenders)
    )


def test_there_is_no_built_in_jira_site():
    """The specific regression: a default that made one tenant everyone's default."""
    source = (PACKAGE / "core" / "user_config.py").read_text(encoding="utf-8")
    assert "DEFAULT_JIRA_BASE_URL" not in source
    # And nothing else reintroduced one under another name.
    for path in _sources():
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in re.finditer(r"^[A-Z_]*BASE_URL[A-Z_]*\s*=\s*['\"]([^'\"]*)['\"]", text, re.M):
            assert match.group(1) == "", f"{_label(path)} hard-codes a base URL: {match.group(1)}"


def test_the_allowlist_itself_stays_honest():
    """An exemption whose reason has gone should leave, or the guard rots."""
    stale: list[str] = []
    for key in ALLOWED:
        name, label = key.split(":", 1)
        matches = [
            path
            for path in _sources()
            if _label(path) == name and FORBIDDEN[label].search(path.read_text(encoding="utf-8"))
        ]
        if not matches:
            stale.append(f"{key} is exempted but no longer occurs")
    assert stale == []


# --- the licence ------------------------------------------------------------


def _pyproject() -> str:
    return (REPO / "pyproject.toml").read_text(encoding="utf-8")


def test_the_package_declares_a_licence_and_ships_it():
    """A published package with no licence grants nobody anything.

    Both halves matter: the metadata field is what PyPI displays, and
    `license-files` is what puts the actual text in the wheel. Declaring one
    without the other is the failure that looks fine on the project page.
    """
    text = _pyproject()
    assert 'license = "BUSL-1.1"' in text
    assert 'license-files = ["LICENSE"]' in text
    assert (REPO / "LICENSE").exists()


def test_the_licence_parameters_are_filled_in():
    """BSL is a template. Unfilled, it is three blanks where the terms should be.

    The Additional Use Grant is the one that decides what the licence actually
    permits - without it, BSL forbids *all* production use, which would forbid
    the internal company use this grant exists to allow.
    """
    licence = (REPO / "LICENSE").read_text(encoding="utf-8")
    assert "Licensor:             Shiwei Xing" in licence
    assert "Change Date:          2030-09-08" in licence
    assert "Change License:       Apache License, Version 2.0" in licence
    grant = licence.split("Additional Use Grant:")[1].split("Change Date:")[0]
    assert "production use" in grant
    assert "competitive offering" in grant
    # No leftover template placeholders anywhere.
    for placeholder in ("[Licensor Name]", "TODO", "XXX", "FIXME"):
        assert placeholder not in licence, placeholder


def test_the_sdist_does_not_ship_the_test_suite():
    """`MANIFEST.in` earns its keep here.

    A source distribution built without it carried 19 test files — which is how
    a company product name in a fixture and three real ticket numbers reached a
    publishable artifact while the scan above, which reads only the package,
    saw nothing. Checked by reading the rules rather than by building, because
    building needs network and an isolated environment; the build itself was
    verified by hand once the rules existed.
    """
    manifest = REPO / "MANIFEST.in"
    assert manifest.exists(), "without MANIFEST.in the sdist picks up tests/"
    rules = manifest.read_text(encoding="utf-8")
    for pruned in ("tests", "docs", "extension"):
        assert f"prune {pruned}" in rules, f"{pruned}/ would ship in the sdist"


# --- the old project name ----------------------------------------------------


def test_the_package_does_not_carry_the_old_project_name():
    """`hrs-ai` was this tool's name before it was bugpilot.

    Harmless in itself, but it is a company product prefix (`HrsQt…`) and it
    would ship in a public package as a puzzle: readers would have to work out
    that the two names are the same thing.
    """
    offenders = []
    for path in _sources():
        text = path.read_text(encoding="utf-8", errors="replace")
        for index, line in enumerate(text.splitlines(), start=1):
            if "hrs_ai" in line.lower() or "hrs-ai" in line.lower():
                offenders.append(f"{_label(path)}:{index}: {line.strip()[:70]}")

    # No exemption. There was one — a compatibility read of the old environment
    # variable names — and it was removed on the grounds that this tool has one
    # user, whose machine is one command away from the new names, and a
    # permanent shim costs more than that command.
    assert offenders == []


def test_the_word_list_is_present_and_private():
    """Two ways this guard rots, pulling in opposite directions.

    It rots quietly if the list goes missing: every other check keeps passing
    and the company-name one simply stops existing. It rots loudly if the list
    is committed, because then the repository discloses the words. Both are
    failures here, so neither can happen without somebody noticing.
    """
    assert WORD_LIST.exists(), (
        f"{WORD_LIST.name} is missing, so nothing is checked for company names. "
        f"Copy forbidden_words.example to it and fill it in."
    )
    assert "a company name" in FORBIDDEN, "the list is present but has no words in it"

    ignored = (REPO / ".gitignore").read_text(encoding="utf-8")
    assert "tests/forbidden_words.txt" in ignored, (
        "the word list is not gitignored, so committing it would publish the "
        "names this whole file exists to keep unpublished"
    )
