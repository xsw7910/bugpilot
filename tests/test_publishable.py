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

**And now the repository, not only the packages.** `docs/` and `tests/` were
out of scope because neither is published — `MANIFEST.in` prunes them from the
sdist — but the repository itself lives on a git host, and they were where the
remaining disclosures were: a company's product name and a customer's name in
the implementation log, real ticket numbers in docs and fixtures, a developer's
checkout path in the README. `test_the_repository_names_no_company_customer_
person_path_or_real_ticket` scans every text file git tracks or would track,
this one included, with the stricter repository policy below (§37.71).
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PACKAGE = REPO / "bugpilot"

WORD_LIST = Path(__file__).resolve().parent / "forbidden_words.txt"
SAMPLES = Path(__file__).resolve().parent / "forbidden_samples.txt"


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

#: Where a host name ends: not before another label. `\b` alone would let
#: `example.com.au` pass as `example.com`.
_HOST_END = r"(?![\w-]|\.[\w-])"

FORBIDDEN: dict[str, re.Pattern[str]] = {
    "a specific Jira tenant": re.compile(
        # Any atlassian.net host, with or without a scheme, that is not exactly
        # one of the placeholders. A prefix test let `companyname…` through.
        r"(?<![\w.-])(?!(?:your-company|yourcompany|example)\.atlassian\.net" + _HOST_END + ")"
        r"[\w-]+(?:\.[\w-]+)*\.atlassian\.net\b",
        re.IGNORECASE,
    ),
    # Any address, whatever its top-level domain, except on a reserved example
    # domain (RFC 2606: `example.com/.org/.net`, and the `.test`, `.invalid`,
    # `.example` and `.localhost` TLDs) or this repository's `your-company`
    # setup placeholder. Placeholders on real domains — `x.com`, `co.com` — are
    # people's domains all the same, and were moved to `example.com`. Role
    # addresses are nobody in particular: the SSH clone user on the public
    # forges and the commit trailer's. A retina asset (`icon@2x.png`) is a file.
    "a real person": re.compile(
        r"(?<![\w.%+-])"
        r"(?!(?:git@(?:github\.com|gitlab\.com|bitbucket\.org)|noreply@anthropic\.com)" + _HOST_END + ")"
        r"[\w.%+-]+@(?!(?:[\w-]+\.)*example\.(?:com|org|net)" + _HOST_END +
        r"|(?:[\w-]+\.)+(?:test|invalid|example|localhost)" + _HOST_END +
        r"|(?:your-company|yourcompany)\.com" + _HOST_END +
        r"|[1-9]x\.(?:png|jpe?g|gif|svg|webp)\b)"
        r"[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b",
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
        path = REPO / name
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        if not any(found[1] == label for found in repository_findings(text)):
            stale.append(f"{key} is exempted but no longer occurs")
    assert stale == []


# --- the repository ---------------------------------------------------------
#
# Every tracked text file, with the published-surface patterns above plus what
# only a repository can carry: working notes, fixtures and docs written on a
# developer's machine against a real Jira. (§37.71)

#: Generated or vendored: never read as this project's own text.
GENERATED_DIRECTORIES = (
    "node_modules/",
    "extension/out/",
    "dist/",
    "build/",
    ".venv/",
    "__pycache__/",
    "coverage/",
    "extension/.review/",
    # Microsoft's icon font and its attribution, shipped verbatim.
    "extension/media/codicons/",
)
GENERATED_FILES = frozenset({"extension/package-lock.json", "package-lock.json"})

#: This file spells out the samples the scanner must reject, so it is scanned
#: like any other and must carry exactly these findings — every value made up.
#: Excluding it instead left a hole in the one file where a real value is most
#: likely to be pasted as a "sample", so adding a line here is a decision a
#: reviewer sees. The one real value a sample needs, the checkout root, is
#: spelt in two pieces and so is not a finding at all.
SELF = "tests/test_publishable.py"
SELF_FINDINGS = frozenset({
    ("a personal home directory", "/Users/jane"),
    ("a personal home directory", "/home/jsmith"),
    ("a personal home directory", r"C:\Users\jsmith"),
    ("a real person", "dev.person@corp-mail.co"),
    ("a real person", "jane@contoso.io"),
    ("a real person", "jane@example.com.au"),
    ("a specific Jira tenant", "companyname.atlassian.net"),
    ("a specific Jira tenant", "widgets-inc.atlassian.net"),
    ("an internal host", "jira.corp.lan"),
    ("an internal host", "nas.home.arpa"),
    ("an internal host", "printer.local"),
    ("a private network address", "192.168.1.20"),
    ("an unlisted ticket number", "JR-98765"),
    ("another project's ticket number", "ABC-24680"),
    ("another project's ticket number", "MY_ABC-24680"),
})

BINARY_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".ico", ".ttf", ".woff", ".woff2",
                             ".pdf", ".zip", ".gz", ".whl", ".vsix"})

#: The synthetic work item convention. `JR` is a prefix no real project uses;
#: any `JR-` number of one to three digits is an example, and a longer one must
#: be one of these. A five-digit id that is not on the list is what a real
#: ticket looks like, and is exactly what leaked before. `HR` is the real
#: prefix of the codebase this was built against, so it is not allowed at all.
SYNTHETIC_TICKET_NUMBERS = ("9999", "11111", "12345", "23456", "34567", "45678", "77777", "99999")

#: Home-directory names that are examples, not people.
GENERIC_USERS = ("dev", "me", "you", "user", "username", "runner", "example", "name", "a")

REPOSITORY_FORBIDDEN: dict[str, re.Pattern[str]] = {
    "an unlisted ticket number": re.compile(
        r"\bJR-(?!(?:\d{1,3}|" + "|".join(SYNTHETIC_TICKET_NUMBERS) + r")\b)\d+\b", re.IGNORECASE
    ),
    # An upper-case Jira key of four to six digits under any other project
    # prefix. `JR` and `HR` have their own rules; `CVE-2024`, `ISO-8601`,
    # `RFC-2606` and the like are standards. Six digits at most, so the
    # date-shaped ids a run is named with (`BUG-20260925`) are not keys. Lower-
    # case keys and short numbers are left alone: too many ordinary words match.
    "another project's ticket number": re.compile(
        r"(?<![A-Za-z0-9-])(?!(?:JR|HR|CVE|CWE|ISO|IEC|RFC|CP)-)[A-Z][A-Z0-9_]{1,9}-\d{4,6}(?!\d)"
    ),
    # A developer's checkout root, in every spelling a shell or an editor uses:
    # a drive letter, a VS Code URI, Git Bash, WSL and Cygwin.
    "a developer's local path": re.compile(
        r"\b[a-z](?::|%3a)[\\/]+sandbox\b|(?<![\w.])(?:/mnt|/cygdrive)?/[a-z]/sandbox\b", re.IGNORECASE
    ),
    "a personal home directory": re.compile(
        r"(?:\b[a-z]:[\\/]+users|(?<![\w.])/users|(?<![\w.])/home)[\\/]+"
        r"(?!(?:" + "|".join(GENERIC_USERS) + r")(?:[\\/\s\"'`]|$))[^\\/\s\"'`<>]+",
        re.IGNORECASE,
    ),
    # Hosts on a private network. `localhost`, `127.0.0.1` and `example.com`
    # are documentation, and none of these suffixes. A suffix followed by
    # another label is a file name (`settings.local.json`), not a host.
    "an internal host": re.compile(
        r"\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lan|corp|internal|intranet|home\.arpa|local)" + _HOST_END,
        re.IGNORECASE,
    ),
    # A four-part version number in the 10.x range reads the same; none is in
    # the tree, and one that appears can be written with three parts.
    "a private network address": re.compile(
        r"(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d.]*\d)"
    ),
}

#: Names that are known to have leaked into this repository before: a company,
#: its product, one of its internal components and a customer (from real ticket
#: text). Stored as SHA-256 digests of the lowercased word so that the guard
#: does not spell out the names it keeps out. That is obfuscation, not secrecy:
#: the names are short and unsalted, and anyone with a list of guesses can
#: confirm one. A word matches alone or glued to its neighbour — across a line
#: break too, since the docs are hard-wrapped — which covers the spaced,
#: hyphenated and CamelCase spellings alike, and a mail domain's first label.
KNOWN_LEAKED_NAMES = frozenset({
    "7aadb0b2843253081bc75b80529a8ee9b5dfbc49a01a91e4a5d3578999637ae1",
    "4c77cac1139b0f6d8f1811079c7e14daf82696b71a8804722e9fc44a509c1fc4",
    "063f966031bcbca8d60e67d8b485da8d5300eb76c0290161e7549817e982cd2b",
    "d4728fcba255e3225198978a29e37481b6a2f94f9883fff42391c71d70a7e58d",
})

#: The product family's prefix, as (length, digest of the lowercased prefix): a
#: word that is the prefix or starts with it — a class prefix, a prefix inside
#: a version tag, a snake_case or path segment, this tool's old project name.
#: Splitting at case and digit boundaries makes each of those a word of its
#: own, so no substring matching is needed, and none is done: it would flag
#: unrelated words. The bare prefix right after a number reads as a unit of time
#: and is left alone.
KNOWN_LEAKED_PREFIXES = frozenset({
    (3, "4e9682fa850ed767b6ad479026e96bbf69049f5574d0844e48e310e35bf57c58"),
})

LEAKED_NAME = "a known leaked company, product or customer name"


def _digest(word: str) -> str:
    return hashlib.sha256(word.encode()).hexdigest()


def _leaked_names(
    text: str,
    digests: frozenset[str] = KNOWN_LEAKED_NAMES,
    prefixes: frozenset[tuple[int, str]] = KNOWN_LEAKED_PREFIXES,
) -> list[int]:
    """The lines on which a denied name or prefix appears.

    Words split at case and digit boundaries too, so a name inside a longer
    identifier (`SampleGlobex`, `globex2`) is still a word of its own. Capitals
    glued straight to lowercase (`GLOBEXcorp`) split the other way round, so
    the capital run is checked on its own as well.
    """
    lines = set()
    for caps in re.finditer(r"[A-Z]{2,}(?=[a-z])", text):
        word = caps.group(0).lower()
        if _digest(word) in digests or any(
            len(word) >= length and _digest(word[:length]) == digest for length, digest in prefixes
        ):
            lines.add(text.count("\n", 0, caps.start()) + 1)
    tokens = list(re.finditer(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+", text))
    words = [token.group(0).lower() for token in tokens]
    for index, token in enumerate(tokens):
        word = words[index]
        candidates = [word]
        if index + 1 < len(tokens):
            candidates.append(word + words[index + 1])
        hit = any(_digest(candidate) in digests for candidate in candidates)
        for length, digest in prefixes:
            if hit or len(word) < length or _digest(word[:length]) != digest:
                continue
            a_unit = (
                len(word) == length and index > 0 and words[index - 1].isdigit()
                and not text[tokens[index - 1].end():token.start()].strip()
            )
            hit = not a_unit
        if hit:
            lines.add(text.count("\n", 0, token.start()) + 1)
    return sorted(lines)


def repository_findings(
    text: str,
    digests: frozenset[str] = KNOWN_LEAKED_NAMES,
    prefixes: frozenset[tuple[int, str]] = KNOWN_LEAKED_PREFIXES,
) -> list[tuple[int, str, str]]:
    """(line, what, shown) for everything the repository must not carry."""
    found = [(line, LEAKED_NAME, "<withheld>") for line in _leaked_names(text, digests, prefixes)]
    for label, pattern in {**FORBIDDEN, **REPOSITORY_FORBIDDEN}.items():
        for match in pattern.finditer(text):
            line = text[: match.start()].count("\n") + 1
            found.append((line, label, "<withheld>" if label == "a company name" else match.group(0)))
    return sorted(found)


def _tracked_files() -> list[str]:
    """The repository's files as git sees them: tracked, plus new and not ignored.

    Listed by git rather than walked, so ignored output — `dist/`, `build/`,
    `node_modules/`, the visual harness, the private word list — never enters
    the scan, and a new file joins it before it is even staged. Without git (an
    exported tree) there is no telling what is ignored, and a walk would read
    `node_modules/` and the word list, so the scan is skipped rather than
    guessed at.
    """
    try:
        listed = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=REPO, capture_output=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("the repository scan needs git to tell tracked files from ignored ones")
    return sorted(set(name for name in listed.decode("utf-8").split("\0") if name))


def _scanned_files() -> list[str]:
    """Tracked text the repository policy reads: no generated, vendored or binary files."""
    names = []
    for name in _tracked_files():
        if name in GENERATED_FILES or any(name.startswith(prefix) for prefix in GENERATED_DIRECTORIES):
            continue
        if Path(name).suffix.lower() in BINARY_SUFFIXES:
            continue
        path = REPO / name
        if not path.is_file() or b"\0" in path.read_bytes()[:8192]:
            continue
        names.append(name)
    return names


def test_the_repository_names_no_company_customer_person_path_or_real_ticket():
    offenders: list[str] = []
    for name in _scanned_files():
        text = (REPO / name).read_text(encoding="utf-8", errors="replace")
        for line, label, shown in repository_findings(text):
            if f"{name}:{label}" in ALLOWED or (name == SELF and (label, shown) in SELF_FINDINGS):
                continue
            offenders.append(f"{name}:{line} names {label}: {shown}")

    assert offenders == [], (
        "the repository would disclose these. Use the synthetic conventions "
        "(JR-12345, user@example.com, C:\\path\\to\\sample-repo), or add an exemption to "
        "ALLOWED with the reason:\n  " + "\n  ".join(offenders)
    )


def test_the_scan_covers_the_repository_and_skips_what_is_generated():
    scanned = _scanned_files()
    for expected in ("README.md", "MANIFEST.in", "pyproject.toml", "bugpilot/", "docs/", "tests/",
                     "extension/src/", "extension/test/", "extension/README.md", "skills/", "scripts/"):
        assert any(name == expected or name.startswith(expected) for name in scanned), expected
    for excluded in ("node_modules/", "extension/out/", "extension/.review/", "extension/media/codicons/"):
        assert not any(name.startswith(excluded) for name in scanned), excluded
    assert SELF in scanned, "the guard's own samples are checked against SELF_FINDINGS"
    assert "tests/forbidden_words.txt" not in scanned, "the private word list is ignored, never read"
    assert "tests/forbidden_samples.txt" not in scanned, "the private samples are ignored, never read"
    assert "extension/package-lock.json" not in scanned
    assert "extension/media/icon.png" not in scanned, "a binary file was read as text"


def test_the_guard_carries_exactly_its_pinned_samples():
    """SELF_FINDINGS is neither short of this file's findings nor stale."""
    text = (REPO / SELF).read_text(encoding="utf-8")
    found = {(label, shown) for _line, label, shown in repository_findings(text)}
    assert found == SELF_FINDINGS, (
        f"unpinned: {sorted(found - SELF_FINDINGS)}; stale: {sorted(SELF_FINDINGS - found)}"
    )


#: Stand-ins for the real digests: a made-up name and a made-up prefix, so the
#: matching rules are tested on values this file can spell out.
STAND_IN_NAMES = frozenset({_digest("globex")})
STAND_IN_PREFIXES = frozenset({(3, _digest("glx"))})


def test_the_scanner_rejects_what_must_not_be_published():
    must_reject = {
        "Globex shipped it": LEAKED_NAME,
        "the Glo-bex reservoir team": LEAKED_NAME,
        "a hard-wrapped Glo-\nbex": LEAKED_NAME,
        "class SampleGlobexReader": LEAKED_NAME,
        "GLOBEX2 import": LEAKED_NAME,
        "GLOBEXcorp import": LEAKED_NAME,
        "mail ops@globex.example": LEAKED_NAME,
        # The prefix family: alone, as a class prefix, inside a version tag, as
        # a snake_case or path segment, and glued into a longer word.
        "the GLX team": LEAKED_NAME,
        "class GlxFoo": LEAKED_NAME,
        "since preGLX12": LEAKED_NAME,
        "open glx_process_manager.cxx": LEAKED_NAME,
        "platform/glx/plugins/Selector.cpp": LEAKED_NAME,
        "vault glxai": LEAKED_NAME,
        "old name GLXai": LEAKED_NAME,
        # An unlisted five-digit number is what a real ticket looks like; this
        # one is made up. The real prefix is spelt in two pieces so that this
        # file carries no literal id of it either.
        "see JR-98765 for the history": "an unlisted ticket number",
        "the real prefix, HR-" "12345": "a real ticket number",
        "fixed in ABC-24680": "another project's ticket number",
        "see notes/MY_ABC-24680_notes.md": "another project's ticket number",
        # The checkout root in pieces, so that this file does not carry it.
        "cd C:\\" "sandbox\\project": "a developer's local path",
        "cd /c/" "sandbox/project": "a developer's local path",
        "cd /mnt/c/" "sandbox/project": "a developer's local path",
        "cd /cygdrive/d/" "sandbox/project": "a developer's local path",
        "file:///c%3A/" "sandbox/project/a.ts": "a developer's local path",
        "open /Users/jane/src/app": "a personal home directory",
        r"from C:\Users\jsmith\repo": "a personal home directory",
        "clone to /home/jsmith/repo": "a personal home directory",
        "mail dev.person@corp-mail.co now": "a real person",
        "or jane@contoso.io": "a real person",
        "not jane@example.com.au either": "a real person",
        "https://jira.corp.lan/browse/X-1": "an internal host",
        "smb://nas.home.arpa/share": "an internal host",
        "print to printer.local.": "an internal host",
        "http://192.168.1.20:8080": "a private network address",
        "https://widgets-inc.atlassian.net": "a specific Jira tenant",
        "JIRA_BASE_URL=companyname.atlassian.net": "a specific Jira tenant",
    }
    for sample, label in must_reject.items():
        labels = {found[1] for found in repository_findings(sample, STAND_IN_NAMES, STAND_IN_PREFIXES)}
        assert label in labels, f"{sample!r} was not flagged as {label} (got {labels})"
    # The real digests are SHA-256 values, and none is a stand-in.
    assert len(KNOWN_LEAKED_NAMES) == 4 and len(KNOWN_LEAKED_PREFIXES) == 1
    assert all(re.fullmatch(r"[0-9a-f]{64}", digest) for digest in KNOWN_LEAKED_NAMES)
    assert all(re.fullmatch(r"[0-9a-f]{64}", digest) for _length, digest in KNOWN_LEAKED_PREFIXES)


def test_the_prefix_rule_leaves_unrelated_words_alone():
    """No substring matching: the letters inside another word, or a unit after a number."""
    must_allow = ["runs for 24 glx", "an 8glx window", "1.5 glx", "the ogglx frame", "count chglx"]
    for sample in must_allow:
        assert _leaked_names(sample, STAND_IN_NAMES, STAND_IN_PREFIXES) == [], sample


def _samples() -> list[str]:
    """The real spellings the digests must catch, from the gitignored samples file.

    Local for the reason the word list is: a readable sample in a committed file
    — even an encoded one that decodes in a line — would spell out every name
    the digests exist to withhold. `forbidden_samples.example` is the template.
    """
    if not SAMPLES.exists():
        return []
    lines = (line.split("#", 1)[0].strip() for line in SAMPLES.read_text(encoding="utf-8").splitlines())
    return [line for line in lines if line]


def test_the_real_digests_catch_every_known_family():
    samples = _samples()
    if not samples:
        pytest.skip(f"no {SAMPLES.name}: the real digests are proven only where the samples exist")
    # Failures name the sample's position, never the sample: it is a real name.
    for number, sample in enumerate(samples, start=1):
        flagged = _leaked_names(sample.removeprefix("!")) != []
        if sample.startswith("!"):
            assert not flagged, f"must-pass sample #{number} in {SAMPLES.name} was flagged"
        else:
            assert flagged, f"sample #{number} in {SAMPLES.name} was not flagged"


def test_the_scanner_allows_the_documented_examples():
    must_allow = [
        "JR-12345", "JR-23456 and JR-34567", "JR-1, JR-99, JR-999", "jr-12345",
        "user@example.com", "test@example.org", "ops@example.net", "a@x.test", "nobody@example.invalid",
        "you@your-company.com", r"cd C:\path\to\sample-repo", "cd /path/to/sample-repo",
        "/home/dev/.local/bin/bugpilot", "C:/Users/me/My Documents/a log.txt", r"C:\Users\a b\repo.v2",
        "http://localhost:8080", "http://127.0.0.1:5000", "https://example.com/docs",
        "https://your-company.atlassian.net", "example.atlassian.net", "*.atlassian.net",
        "UTF-8, SHA-256, ISO-8601, RFC-2606, CWE-1321, CP-1252 and CVE-2024-3094",
        "run BUG-20260925-1 and LOCAL-2609010949", "X-Request-ID-1234",
        "git@github.com:owner/repo.git", "git@gitlab.com:group/repo.git",
        "Co-Authored-By: Claude <noreply@anthropic.com>", "icon@2x.png",
        ".claude/settings.local.json", "config.internal.json", "types.internal.d.ts", "~/.local/bin",
        "Windows 10.0.26200.6725", "version 10.2.3", "1.10.1.2.3",
    ]
    for sample in must_allow:
        assert repository_findings(sample) == [], (sample, repository_findings(sample))


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


#: Licence text that is not BugPilot's: a third party's notice, kept as written.
THIRD_PARTY_DIRECTORIES = ("extension/media/codicons/",)

LICENCE_FILE = re.compile(r"(?:^|/)(?:LICEN[CS]E|COPYING)(?:\.(?:txt|md))?$", re.IGNORECASE)


def _licence_text(name: str) -> str:
    return (REPO / name).read_text(encoding="utf-8").replace("\r\n", "\n")


def test_every_component_ships_the_same_licence():
    """One licence for every published component (pre-release Batch 3, option a).

    The wheel ships `LICENSE`, the VS Code extension `extension/LICENSE.txt`, and
    anything published from this repository later — a Claude Code plugin, say —
    carries its own copy beside its manifest, found here by name. Each must be
    the root `LICENSE` unchanged: a copy that drifts is a second licence nobody
    chose. Compared as text, so a checkout's line endings do not matter.
    """
    copies = [
        name for name in _tracked_files()
        if LICENCE_FILE.search(name)
        and not any(name.startswith(prefix) for prefix in GENERATED_DIRECTORIES + THIRD_PARTY_DIRECTORIES)
    ]
    assert "LICENSE" in copies and "extension/LICENSE.txt" in copies, copies
    root = _licence_text("LICENSE")
    for name in copies:
        assert _licence_text(name) == root, f"{name} is not a copy of LICENSE"


def test_every_manifest_declares_that_licence():
    """PyPI and the Marketplace show the manifest's field, not the file: they must agree.

    A future manifest — a Claude Code plugin's `.claude-plugin/plugin.json` —
    that declares a licence is held to the same id.
    """
    import json

    assert 'license = "BUSL-1.1"' in _pyproject()
    manifests = [
        name for name in _tracked_files()
        if re.search(r"(?:^|/)(?:package\.json|\.claude-plugin/plugin\.json)$", name)
        and not any(name.startswith(prefix) for prefix in GENERATED_DIRECTORIES)
    ]
    assert "extension/package.json" in manifests, manifests
    for name in manifests:
        declared = json.loads((REPO / name).read_text(encoding="utf-8")).get("license")
        if name == "extension/package.json" or declared is not None:
            assert declared == "BUSL-1.1", f"{name} declares {declared!r}"


def test_third_party_attribution_ships_with_the_extension():
    """Replacing the extension's own licence must not lose the codicons attribution (CC BY 4.0)."""
    attribution = (REPO / "extension" / "media" / "codicons" / "ATTRIBUTION.md").read_text(encoding="utf-8")
    assert "CC BY 4.0" in attribution and "Microsoft" in attribution
    notices = (REPO / "extension" / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    assert "media/codicons/ATTRIBUTION.md" in notices and "CC BY 4.0" in notices
    shipped = (REPO / "extension" / ".vscodeignore").read_text(encoding="utf-8").splitlines()
    for kept in ("!LICENSE.txt", "!THIRD_PARTY_NOTICES.md", "!media/**"):
        assert kept in shipped, kept


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
    """Before it was bugpilot, this tool was named after a company product prefix.

    That prefix is in KNOWN_LEAKED_PREFIXES, so the old name — in any spelling —
    is a finding like the other known names. Checked here against exactly what
    a release ships, apart from the repository scan: the package and the
    extension are what strangers install.
    """
    offenders = []
    for path in _sources():
        text = path.read_text(encoding="utf-8", errors="replace")
        offenders += [f"{_label(path)}:{line}" for line in _leaked_names(text)]

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

    # The samples that prove the digests rot the same two ways.
    assert _samples(), (
        f"{SAMPLES.name} is missing or empty, so nothing proves the digests catch "
        f"the real names. Copy forbidden_samples.example to it and fill it in."
    )
    assert "tests/forbidden_samples.txt" in ignored, (
        "the samples file is not gitignored, so committing it would publish the "
        "names the digests exist to withhold"
    )
