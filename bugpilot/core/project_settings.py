"""Project settings: the repository's Verification Policy and branch naming.

Two small things a team decides once for a repository and that every task
then follows, kept beside the repository's other BugPilot configuration::

    <repo>/.bugpilot/project_settings.json

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

**Branch naming** is only the name a new branch would get
(``git_ops.render_branch_template``): ``{issue}`` and ``{slug}``. Whether a
branch is created is the branch policy's, and a work item's recorded branch is
reused before any template. Empty is the default ``feature/{issue}-{slug}``.

Every entry point reads the same file the same way: the CLI, the MCP prepare
tools and the VS Code extension (through ``bugpilot project-settings``). No file
means the defaults. A file that cannot be used — a link, unreadable, not JSON —
is the defaults plus a warning; a single bad value is that value's default plus
a warning. Change Scope was considered and deferred: every Fix Mode already
sets how broad a change may be, so a second control would duplicate it;
teams that need one write it in their project instructions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .artifact_io import atomic_write_text
from .git_ops import branch_template_problem
from .safe_paths import is_link_or_junction

PROJECT_CONFIG_DIR = ".bugpilot"
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
    return repo_root / PROJECT_CONFIG_DIR / SETTINGS_FILE_NAME


SHOWN_PATH = f"{PROJECT_CONFIG_DIR}/{SETTINGS_FILE_NAME}"


def _link_problem(repo_root: Path) -> str | None:
    for candidate, name in ((repo_root / PROJECT_CONFIG_DIR, PROJECT_CONFIG_DIR), (settings_path(repo_root), SHOWN_PATH)):
        if is_link_or_junction(candidate):
            return (
                f"{name} is a symbolic link or junction. Project settings are read and written only as a "
                "real file inside this repository."
            )
    return None


def settings_from_mapping(data: object, *, strict: bool) -> tuple[ProjectSettings, list[str]]:
    """Settings from a parsed JSON object.

    ``strict`` (a save) refuses what a lenient read (a run) warns about and
    replaces with the default; the message says which happened.
    """
    warnings: list[str] = []

    def problem(message: str, fallback: str) -> None:
        if strict:
            raise ProjectSettingsError(f"{message}.")
        warnings.append(f"{message}; {fallback}.")

    if not isinstance(data, dict):
        if strict:
            raise ProjectSettingsError("Project settings must be a JSON object.")
        return ProjectSettings(), [f"{SHOWN_PATH} is not a JSON object. Using the defaults."]
    unknown = sorted(str(key) for key in set(data) - _TOP_LEVEL_KEYS)
    if unknown:
        problem(f"{SHOWN_PATH} has unknown key(s) {', '.join(unknown)}", "they were ignored")

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
    """The saved settings, or the defaults, and what was wrong with the file if anything was."""
    problem = _link_problem(repo_root)
    if problem:
        return ProjectSettings(), [f"{problem} Using the defaults."]
    path = settings_path(repo_root)
    if not path.is_file():
        return ProjectSettings(), []
    try:
        if path.stat().st_size > _MAX_FILE_BYTES:
            raise ValueError("it is far larger than project settings")
        # utf-8-sig: Windows tools (PowerShell 5's `-Encoding UTF8`) write a BOM.
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except RecursionError:
        return ProjectSettings(), [f"{SHOWN_PATH} could not be read (it is nested too deeply). Using the defaults."]
    except (OSError, ValueError) as exc:
        reason = exc.strerror if isinstance(exc, OSError) and exc.strerror else str(exc)
        return ProjectSettings(), [f"{SHOWN_PATH} could not be read ({reason}). Using the defaults."]
    return settings_from_mapping(data, strict=False)


def save_project_settings(repo_root: Path, settings: ProjectSettings) -> Path:
    """Write the settings where every entry point reads them. Refuses through a link or an unsafe template."""
    if settings.branch_template:
        reason = branch_template_problem(settings.branch_template)
        if reason:
            raise ProjectSettingsError(reason)
    problem = _link_problem(repo_root)
    if problem:
        raise ProjectSettingsError(problem)
    path = settings_path(repo_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    problem = _link_problem(repo_root)
    if problem:
        raise ProjectSettingsError(problem)
    atomic_write_text(path, json.dumps(settings.to_dict(), indent=2) + "\n")
    return path


def is_saved(repo_root: Path) -> bool:
    return settings_path(repo_root).is_file()


@dataclass(frozen=True)
class ResolvedProjectSettings:
    """The settings one task is written with, whether they came from the file, and what was wrong."""

    settings: ProjectSettings = field(default_factory=ProjectSettings)
    saved: bool = False
    warnings: tuple[str, ...] = ()

    @property
    def log_line(self) -> str:
        policy = ", ".join(f"{key}={str(value).lower()}" for key, value in self.settings.verification.to_dict().items())
        naming = "custom template" if self.settings.branch_template else "default"
        origin = SHOWN_PATH if self.saved else "defaults"
        return f"[INFO] project settings: {origin} (verification: {policy}; branch naming: {naming})"


def resolve_project_settings(repo_root: Path) -> ResolvedProjectSettings:
    settings, warnings = load_project_settings(repo_root)
    return ResolvedProjectSettings(settings=settings, saved=is_saved(repo_root) and not warnings_mean_defaults(warnings), warnings=tuple(warnings))


def warnings_mean_defaults(warnings: list[str]) -> bool:
    """A file that could not be used at all reads as the defaults, not as saved settings."""
    return any(warning.endswith("Using the defaults.") for warning in warnings)


# --- task.md ---------------------------------------------------------------------------


def verification_policy_section(policy: VerificationPolicy | None, *, saved: bool = False) -> str:
    """``## Verification Policy`` for ``task.md``: four short lines, no commands.

    ``None`` is the defaults. The section is always present, so what the project
    expects is said rather than assumed.
    """
    policy = policy or VerificationPolicy()
    source = "repository configuration (project settings)" if saved else "BugPilot defaults (no project settings saved)"
    lines = [
        "- Run the tests relevant to the changed behavior."
        if policy.relevant_tests
        else "- Running tests for the changed behavior is not required by this project.",
        "- Run the repository's existing static checks (linters, type checks, compiler warnings) when they are available."
        if policy.static_checks
        else "- Static checks are not required by this project.",
        "- Run the repository's full test suite before reporting, if it can run in this environment."
        if policy.full_suite
        else "- The repository's full test suite is not required.",
        "- Report the relevant verification you did not run, and why."
        if policy.report_not_run
        else "- Listing verification you did not run is optional; never claim a check ran unless it did.",
    ]
    return (
        "## Verification Policy\n\n"
        f"Source: {source}.\n\n"
        "What this project expects from a pass that changes source code. It is part of the project / team layer in "
        "BugPilot Rule Precedence below; the AI Fix Mode decides how this attempt verifies within it, and in an "
        "investigation-only pass you record the verification you would run instead.\n\n"
        + "\n".join(lines)
        + "\n\nUse the repository's own test and check commands; do not invent commands the repository gives no "
        "evidence of. Project / team instructions may name them.\n\n"
    )


def project_settings_payload(settings: ProjectSettings, *, saved: bool, warnings: list[str]) -> dict[str, object]:
    """``bugpilot project-settings show --json``."""
    return {
        "settings": settings.to_dict(),
        "saved": saved,
        "path": SHOWN_PATH,
        "defaults": ProjectSettings().to_dict(),
        "default_branch_template": DEFAULT_BRANCH_TEMPLATE_LABEL,
        "warnings": warnings,
    }
