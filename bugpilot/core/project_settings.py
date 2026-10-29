"""Project settings: the repository's Verification Policy and branch naming.

Two small things the developer decides once for a repository and that every
task then follows, kept with that repository's other settings in its namespace
in BugPilot's data folder (0.1.6, plan §14.3, Batch 2B-3a), not in the
repository and not shared through it (US-D9)::

    ~/.bugpilot/repositories/<repository id>/settings/project_settings.json

The 0.1.5 ``<repo>/.bugpilot/project_settings.json`` is never read, copied or
deleted. The file is reached only through :mod:`repository_settings`: a link on
the way or at the file, or a namespace that is not this repository's, is
refused, for a read too (owner decision G-6).

The file::

    {
      "schema_version": 1,
      "verification": {
        "relevant_tests": true,
        "static_checks": true,
        "full_suite": false,
        "report_not_run": true
      },
      "branch_naming": {"template": "bugfix/{issue}-{slug}"}
    }

**Verification Policy** says what level of validation the project expects in a
pass that changes source code. It is not a second Fix Mode: the mode decides
how this attempt investigates, implements and verifies; the policy is the
project's floor, rendered as four short lines in ``task.md``. It names no
commands — the repository's own, or its Project / Team Instructions, do.

Since 0.1.3 the policy is text: ``settings/verification.md`` (`verification.py`)
replaces it whole when it exists, and the switches here are its legacy source —
used when there is no file, kept readable and writable for BugPilot 0.1.2 and
earlier, and deciding nothing once the file is there (``verification_source``).

**Branch naming** is only the name a new branch would get
(``git_ops.render_branch_template``): ``{issue}`` and ``{slug}``. Whether a
branch is created is the branch policy's, and a work item's recorded branch is
reused before any template. Empty is the default ``feature/{issue}-{slug}``.

Every entry point reads the same file the same way: the CLI, the MCP prepare
tools and the VS Code extension (through ``bugpilot project-settings``). No file
means the defaults. A file that cannot be used — unreadable, not JSON — is the
defaults plus a warning; a single bad value is that value's default plus a
warning. Change Scope was considered and deferred: every Fix Mode already
sets how broad a change may be, so a second control would duplicate it;
teams that need one write it in their project instructions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from . import repository_settings
from .git_ops import branch_template_problem
from .safe_paths import decode_text, is_link_or_junction
from .verification import (
    SOURCE_FILE,
    ResolvedVerification,
    resolve_verification,
    verification_from_switches,
)

SETTINGS_FILE_NAME = "project_settings.json"
SETTINGS_SCHEMA_VERSION = 1
DEFAULT_BRANCH_TEMPLATE_LABEL = "feature/{issue}-{slug}"

#: The Verification Policy's switches, their file keys and defaults, in the order
#: the task and the settings page show them.
VERIFICATION_KEYS: tuple[tuple[str, bool], ...] = (
    ("relevant_tests", True),
    ("static_checks", True),
    ("full_suite", False),
    ("report_not_run", True),
)

_TOP_LEVEL_KEYS = {"schema_version", "verification", "branch_naming"}
_MAX_FILE_BYTES = 64 * 1024


class ProjectSettingsError(ValueError):
    """Settings that may not be saved, said in one sentence naming no absolute path."""


@dataclass(frozen=True)
class VerificationPolicy:
    relevant_tests: bool = True
    static_checks: bool = True
    full_suite: bool = False
    report_not_run: bool = True

    def to_dict(self) -> dict[str, bool]:
        return {key: getattr(self, key) for key, _default in VERIFICATION_KEYS}


@dataclass(frozen=True)
class ProjectSettings:
    verification: VerificationPolicy = field(default_factory=VerificationPolicy)
    #: Empty is the default name; otherwise a template ``branch_template_problem`` accepts.
    branch_template: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": SETTINGS_SCHEMA_VERSION,
            "verification": self.verification.to_dict(),
            "branch_naming": {"template": self.branch_template},
        }


def settings_path(repo_root: Path) -> Path:
    """``settings/project_settings.json`` in the repository's namespace, from storage's checked accessor; creates nothing."""
    return repository_settings.settings_file(repo_root, SETTINGS_FILE_NAME, create=False)


def shown_path(repo_root: Path) -> str:
    """The file as messages name it: ``~/.bugpilot/repositories/<id>/settings/project_settings.json`` (US-D22)."""
    return repository_settings.shown_path(repo_root, SETTINGS_FILE_NAME)


#: How a message names the file when no repository is at hand (a file checked on its own, before it is saved).
SHOWN_NAME = SETTINGS_FILE_NAME


def _link_problem(path: Path, shown: str) -> str | None:
    """A link that appeared at the file, or at its folder, after storage's checks: never read or written through."""
    for candidate, name in ((path.parent, shown.rsplit("/", 1)[0]), (path, shown)):
        if is_link_or_junction(candidate):
            return f"{name} is a symbolic link or junction. Project settings are read and written only as a real file."
    return None


def settings_from_mapping(data: object, *, strict: bool, shown: str = SHOWN_NAME) -> tuple[ProjectSettings, list[str]]:
    """Settings from a parsed JSON object.

    ``strict`` (a save) refuses what a lenient read (a run) warns about and
    replaces with the default; the message says which happened. ``shown`` names
    the file in those messages.
    """
    warnings: list[str] = []

    def problem(message: str, fallback: str) -> None:
        if strict:
            raise ProjectSettingsError(f"{message}.")
        warnings.append(f"{message}; {fallback}.")

    if not isinstance(data, dict):
        if strict:
            raise ProjectSettingsError("Project settings must be a JSON object.")
        return ProjectSettings(), [f"{shown} is not a JSON object. Using the defaults."]
    unknown = sorted(str(key) for key in set(data) - _TOP_LEVEL_KEYS)
    if unknown:
        problem(f"{shown} has unknown key(s) {', '.join(unknown)}", "they were ignored")

    values: dict[str, bool] = {}
    verification = data.get("verification", {})
    if not isinstance(verification, dict):
        problem("verification must be an object of true/false switches", "the defaults were used")
        verification = {}
    for key, default in VERIFICATION_KEYS:
        value = verification.get(key, default)
        if not isinstance(value, bool):
            problem(f"verification.{key} must be true or false", f"the default ({str(default).lower()}) was used")
            value = default
        values[key] = value
    extra = sorted(str(key) for key in set(verification) - {key for key, _ in VERIFICATION_KEYS})
    if extra:
        problem(f"verification has unknown switch(es) {', '.join(extra)}", "they were ignored")

    template = ""
    naming = data.get("branch_naming", {})
    if not isinstance(naming, dict):
        problem("branch_naming must be an object", "the default branch name is used")
        naming = {}
    raw = naming.get("template", "")
    if raw is None:
        raw = ""
    if not isinstance(raw, str):
        problem("branch_naming.template must be text", "the default branch name is used")
    elif raw.strip() != "":
        reason = branch_template_problem(raw)
        if reason:
            problem(reason.rstrip("."), "the default branch name is used")
        else:
            template = raw
    return ProjectSettings(verification=VerificationPolicy(**values), branch_template=template), warnings


def load_project_settings(repo_root: Path) -> tuple[ProjectSettings, list[str]]:
    """The saved settings, or the defaults, and what was wrong with the file if anything was.

    Reaching the file may refuse (storage's checks), which fails the command (G-6); so does a folder on the
    way that cannot be read. The file's own state — unreadable, not JSON, a bad value — is the defaults plus a
    warning, as in 0.1.5.
    """
    settings, warnings, _present = _load(repo_root)
    return settings, warnings


def _load(repo_root: Path) -> tuple[ProjectSettings, list[str], bool]:
    """The settings and their warnings, and whether a regular file is there: one read, following no link (M2).

    Storage reads the file without following a link (Option C): a link there is refused with the command,
    never the defaults; nothing there, or no regular file, is the defaults without a warning, as before.
    """
    shown = shown_path(repo_root)
    try:
        found = repository_settings.read_settings(repo_root, SETTINGS_FILE_NAME, limit=_MAX_FILE_BYTES)
    except repository_settings.FileReadError as exc:
        reason = exc.strerror or type(exc).__name__
        return ProjectSettings(), [f"{shown} could not be read ({reason}). Using the defaults."], True
    if found.state in ("absent", "not_a_file"):
        return ProjectSettings(), [], False
    try:
        if found.state == "too_large":
            raise ValueError("it is far larger than project settings")
        # utf-8-sig: Windows tools (PowerShell 5's `-Encoding UTF8`) write a BOM. Line endings as `read_text` gave them.
        data = json.loads(decode_text(found.data, "utf-8-sig"))
    except RecursionError:
        return ProjectSettings(), [f"{shown} could not be read (it is nested too deeply). Using the defaults."], True
    except ValueError as exc:
        return ProjectSettings(), [f"{shown} could not be read ({exc}). Using the defaults."], True
    settings, warnings = settings_from_mapping(data, strict=False, shown=shown)
    return settings, warnings, True


def save_project_settings(repo_root: Path, settings: ProjectSettings) -> Path:
    """Write the settings where every entry point reads them. Refuses through a link or an unsafe template."""
    if settings.branch_template:
        reason = branch_template_problem(settings.branch_template)
        if reason:
            raise ProjectSettingsError(reason)
    path = settings_path(repo_root)
    problem = _link_problem(path, shown_path(repo_root))
    if problem:
        raise ProjectSettingsError(problem)
    return repository_settings.write_text(repo_root, SETTINGS_FILE_NAME, json.dumps(settings.to_dict(), indent=2) + "\n")


@dataclass(frozen=True)
class ResolvedProjectSettings:
    """The settings one task is written with, whether they came from the file, and what was wrong.

    ``verification`` is the effective Verification Policy (`verification.py`):
    the repository's ``verification.md`` when it has one, else what the saved
    switches — or BugPilot's default — say. ``None`` (settings built by hand)
    is read from the switches alone.
    """

    settings: ProjectSettings = field(default_factory=ProjectSettings)
    saved: bool = False
    warnings: tuple[str, ...] = ()
    verification: ResolvedVerification | None = None
    #: The file as messages name it (US-D22), when known; never part of what the settings are.
    shown: str = field(default="", compare=False)

    @property
    def effective_verification(self) -> ResolvedVerification:
        if self.verification is not None:
            return self.verification
        return _switches(self.settings.verification, saved=self.saved)

    @property
    def log_line(self) -> str:
        policy = ", ".join(f"{key}={str(value).lower()}" for key, value in self.settings.verification.to_dict().items())
        naming = "custom template" if self.settings.branch_template else "default"
        origin = (self.shown or SHOWN_NAME) if self.saved else "defaults"
        return f"[INFO] project settings: {origin} (verification: {policy}; branch naming: {naming})"


def resolve_project_settings(repo_root: Path) -> ResolvedProjectSettings:
    settings, warnings, present = _load(repo_root)  # one read: what was loaded is what is called saved
    saved = present and not warnings_mean_defaults(warnings)
    return ResolvedProjectSettings(
        settings=settings,
        saved=saved,
        warnings=tuple(warnings),
        verification=resolve_verification(repo_root, _switches(settings.verification, saved=saved)),
        shown=shown_path(repo_root),
    )


def _switches(policy: VerificationPolicy, *, saved: bool) -> ResolvedVerification:
    return verification_from_switches(
        policy.relevant_tests, policy.static_checks, policy.full_suite, policy.report_not_run, saved=saved
    )


def warnings_mean_defaults(warnings: list[str]) -> bool:
    """A file that could not be used at all reads as the defaults, not as saved settings."""
    return any(warning.endswith("Using the defaults.") for warning in warnings)


#: Said with a `project-settings set` once ``verification.md`` exists: the
#: switches are still saved, for BugPilot 0.1.2 and earlier, but decide nothing here.
VERIFICATION_FILE_WINS = (
    "The Verification switches were saved for BugPilot 0.1.2 and earlier, but this repository's Verification "
    "Policy file is its effective Verification Policy: the switches do not change it."
)


def project_settings_payload(
    settings: ProjectSettings,
    *,
    saved: bool,
    warnings: list[str],
    path: str,
    verification_source: str | None = None,
) -> dict[str, object]:
    """``bugpilot project-settings show --json``.

    ``path`` is the file in display form (J-2, Batch 2B-3a: §8.10's absolute
    ``path`` and new ``display_path`` come later). ``verification_source`` says
    which policy is effective (`bugpilot-default`, `legacy-project-settings` or
    `verification-file`; `verification.py`), so a client can tell when the
    switches it shows no longer decide anything.
    """
    payload: dict[str, object] = {
        "settings": settings.to_dict(),
        "saved": saved,
        "path": path,
        "defaults": ProjectSettings().to_dict(),
        "default_branch_template": DEFAULT_BRANCH_TEMPLATE_LABEL,
        "warnings": warnings,
    }
    if verification_source is not None:
        payload["verification_source"] = verification_source
    return payload


def verification_file_wins(source: str) -> bool:
    return source == SOURCE_FILE
