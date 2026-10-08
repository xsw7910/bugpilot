"""Small git and command helpers."""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

from .executables import child_environment, find_executable
from .identity import is_local_work_item_id


def command_available(command: str) -> bool:
    """Whether ``command`` resolves on PATH — never from the current directory."""
    return find_executable(command) is not None


#: What :func:`run_command` returns for a command that outlived its ``timeout``.
TIMEOUT_EXIT_CODE = 124


def run_command(args: list[str], cwd: Path, timeout: float | None = None) -> tuple[int, str]:
    """Run a program by its absolute PATH location, never one found in ``cwd``."""
    program = find_executable(args[0]) if args else None
    if program is None:
        return 127, f"{args[0] if args else 'program'} command not found"
    try:
        completed = subprocess.run(
            [program, *args[1:]],
            cwd=cwd,
            env=child_environment(),
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError:
        return 127, f"{args[0]} command not found"
    except subprocess.TimeoutExpired:
        # The argv is not echoed: a git search carries the developer's keywords.
        return TIMEOUT_EXIT_CODE, f"{args[0]} timed out"
    return completed.returncode, completed.stdout.strip()


def inside_git_repo(repo_root: Path) -> bool:
    code, output = run_command(["git", "rev-parse", "--is-inside-work-tree"], repo_root)
    return code == 0 and output.lower() == "true"


def current_branch(repo_root: Path) -> str | None:
    code, output = run_command(["git", "branch", "--show-current"], repo_root)
    return output if code == 0 and output else None


def working_tree_status(repo_root: Path) -> str | None:
    code, output = run_command(["git", "status", "--short"], repo_root)
    if code != 0:
        return None
    return output or "clean"


#: The directories bugpilot writes into a repository, as ``.gitignore`` names them.
ARTIFACT_DIRECTORIES = (".ai", ".ai_memory")


def artifact_directories_ignored(repo_root: Path) -> dict[str, bool] | None:
    """Whether git ignores each directory bugpilot writes into this repository.

    ``{".ai": bool, ".ai_memory": bool}``. ``docs/safety.md`` forbids an agent
    from committing ``.ai/`` or ``.ai_memory/`` — those hold fetched Jira
    content and per-run logs — but nothing stopped a *developer* from doing it,
    and after one run their `git status` is full of files they did not create.
    This only reports; bugpilot never edits someone's `.gitignore` on its own.
    (The extension offers a button that does, which the developer presses.)

    Git's own answer, so a rule written as ``.ai``, ``/.ai/`` or in
    ``.git/info/exclude`` counts exactly as it does for git. `doctor` reports
    it per directory, which is what lets that button add only the missing rule,
    and as one ``ai_artifacts_ignored`` flag for the warning.

    ``None`` when the question cannot be answered (no git, or not a checkout).
    """
    if not (command_available("git") and inside_git_repo(repo_root)):
        return None
    # Two things this got wrong before, both found by asking real repositories:
    #
    #  - one path per call. `git check-ignore -q` refuses several with
    #    "fatal: --quiet is only valid with a single pathname" and exit 128,
    #    which a naive `code == 0` reads as "not ignored" everywhere.
    #  - ask about a path *inside* the directory. A `.ai/` pattern only matches
    #    a path git knows is a directory, so asking about `.ai` answered "not
    #    ignored" until the directory existed — a false alarm at exactly the
    #    moment the advice is worth giving, before the first run.
    return {
        directory: run_command(["git", "check-ignore", "-q", f"{directory}/probe"], repo_root)[0] == 0
        for directory in ARTIFACT_DIRECTORIES
    }


def branch_name(issue_key: str, description: str | None = None, template: str | None = None) -> str:
    """The branch a work item would get: ``feature/<work-item>-<slug>``.

    A hand-written bug is the exception. Its id is minted afresh on every run
    (``local_<timestamp>``), so a name built from it named a new branch every
    time the same bug was prepared again. Its name comes from its title alone
    — the same bug, the same branch — or, for a title with nothing to slug
    (one in another script), from a hash of the title.

    ``template`` is the repository's branch naming template
    (``project_settings.json``): ``{issue}`` and ``{slug}`` in a fixed
    pattern such as ``bugfix/{issue}-{slug}``. None or empty is the default
    above, unchanged. A template only names a branch; whether one is created
    is the branch policy's, and a recorded name is reused before any template.
    """
    if template:
        rendered = render_branch_template(template, issue_key, description)
        if rendered is not None:
            return rendered
    slug = summary_slug(description)
    if is_local_work_item_id(issue_key):
        if slug:
            return f"feature/{slug}"[:120].rstrip("-")
        seed = (description or "").strip() or issue_key
        return f"feature/bug-{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:8]}"
    branch = f"feature/{issue_key}-{slug or 'jira-workflow'}"
    return branch[:120].rstrip("-")


#: The placeholders a branch naming template may use. Nothing else is
#: substituted: no user name, no date — nothing that would make the same work
#: item's name differ between two preparations.
BRANCH_TEMPLATE_PLACEHOLDERS = ("{issue}", "{slug}")

#: The longest template, and the longest name one may produce.
MAX_BRANCH_TEMPLATE_CHARS = 80
MAX_BRANCH_NAME_CHARS = 120

#: Names a template may never produce: the protected branches, and HEAD.
_RESERVED_BRANCH_NAMES = frozenset({"main", "master", "head"})

_TEMPLATE_LITERAL = re.compile(r"[A-Za-z0-9._/-]*")


def branch_template_problem(template: str) -> str | None:
    """Why ``template`` may not be used as a branch naming template, or None.

    The rules keep every name it can produce a plain, valid git ref: letters,
    digits, ``.``, ``_``, ``-`` and ``/`` around ``{issue}`` and ``{slug}``; no
    ``..``, ``//``, ``@{``, no leading ``/``, ``-`` or ``.``, no segment
    beginning with ``.`` or ending in ``.lock`` or ``/``, and no leading
    ``refs/``, which names a ref rather than a branch.

    ``{issue}`` must appear. ``{slug}`` alone named two
    issues with the same title — or any two non-Latin titles, whose slug is
    empty — the same branch, so under "one branch per issue" one issue's work
    could land on another's branch.
    """
    if not isinstance(template, str) or template.strip() == "":
        return "A branch naming template cannot be empty."
    if template != template.strip():
        return "A branch naming template cannot start or end with a space."
    if len(template) > MAX_BRANCH_TEMPLATE_CHARS:
        return f"A branch naming template is at most {MAX_BRANCH_TEMPLATE_CHARS} characters."
    if "{issue}" not in template:
        return "A branch naming template must include {issue}, so each work item gets its own branch."
    literal = template
    for placeholder in BRANCH_TEMPLATE_PLACEHOLDERS:
        literal = literal.replace(placeholder, "x")
    if "{" in literal or "}" in literal:
        return "A branch naming template may use only {issue} and {slug}."
    if not _TEMPLATE_LITERAL.fullmatch(literal):
        return "A branch naming template may use only letters, digits, '.', '_', '-' and '/'."
    if ".." in literal or "//" in literal or "@{" in literal:
        return "A branch naming template cannot contain '..' or '//'."
    if literal[0] in "/-." or literal[-1] in "/.":
        return "A branch naming template cannot start with '/', '-' or '.', or end with '/' or '.'."
    for segment in literal.split("/"):
        if segment.startswith(".") or segment.endswith(".lock"):
            return "A branch naming template segment cannot start with '.' or end with '.lock'."
    if literal.split("/", 1)[0].lower() == "refs":
        return "A branch naming template cannot start with 'refs/': it names the branch, not the ref."
    return None


def render_branch_template(template: str, issue_key: str, description: str | None = None) -> str | None:
    """The name ``template`` gives a work item, or None when it cannot give a safe one.

    Deterministic: the same template, id and title give the same name, so a
    rebuild or a retry names the same branch. ``{issue}`` is the Jira key; for a
    hand-written bug, whose id changes on every run, it is ``bug-`` and a hash
    of the title. ``{slug}`` is the title's slug, and may be empty. The result
    is cleaned into a plain ref; one that is empty, malformed, or a protected
    name (``main``, ``master``, ``HEAD``) is None, and the caller falls back to
    the default name.
    """
    if branch_template_problem(template) is not None:
        return None
    if is_local_work_item_id(issue_key):
        seed = (description or "").strip() or issue_key
        issue = f"bug-{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:8]}"
    else:
        issue = issue_key

    def render(slug: str) -> str:
        name = template.replace("{issue}", issue).replace("{slug}", slug)
        name = re.sub(r"[^A-Za-z0-9._/-]+", "-", name)
        name = re.sub(r"\.{2,}", ".", name)
        segments = []
        for segment in name.split("/"):
            segment = re.sub(r"-{2,}", "-", segment).strip("-.")
            while segment.endswith(".lock"):
                segment = segment[: -len(".lock")].rstrip("-.")
            if segment:
                segments.append(segment)
        return "/".join(segments)

    # Too long: the slug gives up words from its end, never the issue. Cutting
    # the finished name could cut the key — two issues sharing a branch again,
    # or a shorter, different key left in it (release-freeze review).
    slug = summary_slug(description)
    name = render(slug)
    while len(name) > MAX_BRANCH_NAME_CHARS and slug:
        slug = slug.rsplit("-", 1)[0] if "-" in slug else ""
        name = render(slug)
    if len(name) > MAX_BRANCH_NAME_CHARS:
        return None
    if not name or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", name) or name.lower() in _RESERVED_BRANCH_NAMES:
        return None
    # The template's text is checked, but a title can still put words where they
    # matter: `{slug}/{issue}` with the title "Refs". The rendered name must keep
    # the issue whole and must not name a ref.
    if issue not in name or name.split("/", 1)[0].lower() == "refs":
        return None
    return name


def summary_slug(description: str | None, max_length: int = 80) -> str:
    if not description:
        return ""
    slug = re.sub(r"[^a-z0-9]+", "-", description.lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    words = [word for word in slug.split("-") if word and word not in {"are"}]
    capped: list[str] = []
    current_length = 0
    for word in words:
        next_length = current_length + len(word) + (1 if capped else 0)
        if next_length > max_length:
            break
        capped.append(word)
        current_length = next_length
    return "-".join(capped)
