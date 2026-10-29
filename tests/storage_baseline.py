"""Synthetic 0.1.5 storage baselines (0.1.6 Batch 0A, plan §14.1.A).

What BugPilot 0.1.5 does with storage today, recorded so that Batches 2 and 3
change it on purpose and visibly. Everything runs inside the test isolation
(`tests/_isolation.py`): a synthetic git repository, mock Jira data (no
credentials exist, so no request is made), an isolated home, the guard on, and
the real CLI (`python -m bugpilot`) as a guarded Python child.

    python tests/storage_baseline.py --write     # regenerate tests/baselines/0.1.6-batch0/
    python tests/storage_baseline.py --check     # regenerate into a temporary folder and compare
    python tests/storage_baseline.py --pointers  # regenerate, and list every value that differs, by JSON pointer

The records:

- ``pollution.json``    which BugPilot folders each command creates in the repository. For 0.1.5 this
                        *includes* `.ai/`, `.ai_memory/` and `.bugpilot/`: expected now, flipped by Batch 2.
- ``handoff.json``      the handoff sentences and the agent-facing lines that name a storage path.
- ``cli_paths.json``    the path-bearing fields of the CLI's JSON and JSON-lines output.
- ``task_size.json``    the task goldens' sizes, raw and normalized (US-D30).
- ``prepare_timing.json``  preparation time; machine-dependent, so never compared.
- ``realpath_<platform>.json``  how this platform canonicalizes spellings of one folder (plan §7.3);
                        an observation of the machine that wrote it, never compared.

Determinism: temporary roots become `<repo>`, `<config>`, `<data>`, `<home>` or `<input>`, a
hand-written item's id becomes `local_<timestamp>`, lists are sorted, and nothing machine-specific
(timings, installed tools, versions) is in a compared file. A path-valued command argument is
recorded with `/` on every platform (`portable_path`), so Windows, Linux and macOS write the same
bytes.

Designed differences (0.1.6 Batch 2B-2, plan §14.3, "Batch 2B-2 — final contract resolution"):
the frozen Batch 0A records are never rewritten. A later batch that changes them on purpose lists
each change in `tests/baselines/0.1.6-batch2b2/designed_differences.json` as an exact JSON-pointer
`from`/`to` pair, and `differences()` applies those pairs to the frozen record in memory before
the byte comparison: any other difference fails, and so does a listed one that did not happen.

Chained per-slice records (CH-1, Batch 2B-3a): each later slice has a record of its own
(`tests/baselines/0.1.6-batch2b3a/designed_differences.json`, ...), applied after the earlier ones
in `DESIGNED_CHAIN`'s order. An entry's `from` is the value the earlier records leave, so a value two
slices change is listed by both, and no approved record is ever edited.

The repository ID (M-a, Batch 2B-3a): a session computes its own repository's ID with BugPilot's
identity function, and the records show it as `<repository-id>`. Any other repository ID in a record
is an error, so a namespace computed from the wrong folder can never be normalized away.

Superseded evidence (E-3, Batch 2B-3b): when a later slice sets again a value an earlier slice's entry
set, the earlier entry's own test asserts a state that no longer holds. `SUPERSEDED` names the only
two pairs the owner approved (0.1.7: their successors are U7-10 and U7-12, which set the same two
values 2B-3b's DD-13 and DD-15 were to set; that batch was folded into 0.1.7 and never recorded them); `supersession` judges each one as inactive (no successor yet: the
earlier evidence is still required), pending (a matching successor the owner has not approved: the
approval gate reports it) or active (approved: the earlier test is retired, and must be absent).
Anything else is a problem, never an exemption.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from pathlib import Path, PurePath

import _isolation

TESTS = Path(__file__).resolve().parent
REPO = TESTS.parent
OUT = TESTS / "baselines" / "0.1.6-batch0"
COMPARED = ("pollution.json", "handoff.json", "cli_paths.json", "task_size.json")
DESIGNED = TESTS / "baselines" / "0.1.6-batch2b2" / "designed_differences.json"
#: Every slice's designed-differences record, in the order the slices change the frozen records (CH-1).
DESIGNED_CHAIN = (
    DESIGNED,
    TESTS / "baselines" / "0.1.6-batch2b3a" / "designed_differences.json",
    TESTS / "baselines" / "0.1.6-batch2b3b" / "designed_differences.json",
    TESTS / "baselines" / "0.1.7" / "designed_differences.json",
)
REPOSITORY_ID_LABEL = "<repository-id>"
#: A repository ID (plan §7.2) standing on its own in a text: the slug, a hyphen and 16 hex digits.
REPOSITORY_ID_TEXT = re.compile(r"(?<![a-z0-9._-])[a-z0-9][a-z0-9._-]{0,23}-[0-9a-f]{16}(?![0-9a-z._-])")

JIRA_ID = "JR-12345"
SECOND_ID = "JR-23456"
LOCAL_ID = re.compile(r"local_\d{14}")
BUGPILOT_DIRS = (".ai", ".ai_memory", ".bugpilot")

_SOURCE = {
    "src/export/format_selector.py": (
        "def remember_format(dialog, fmt):\n"
        '    """Keep the chosen export format when the dialog is reopened."""\n'
        "    dialog.format = fmt\n"
    ),
    "src/record.py": "def save_record(record):\n    return record['id']\n",
}


# --- running the CLI -----------------------------------------------------------------------------


def portable_path(path: PurePath, labels: Iterable[tuple[PurePath, str]]) -> str:
    """A path-valued command argument as the baselines record it: the same text on every platform.

    The temporary root the path lies under becomes its label and the parts below it are joined
    with ``/``, so ``C:\\...\\inputs\\review.json`` and ``/tmp/.../inputs/review.json`` both read
    ``<input>/review.json``. Only arguments known to be paths come here: other text, which may
    hold a backslash on purpose, is normalized as text and keeps it.
    """
    for root, label in labels:
        try:
            below = path.relative_to(root)
        except ValueError:
            continue
        return "/".join((label, *below.parts))
    return path.as_posix()


class Session:
    """One synthetic repository, its isolated configuration and data folders, and the CLI run inside it."""

    def __init__(self, base: Path) -> None:
        _isolation.require_isolated()
        self.base = base
        self.repo = base / "repo"
        self.config = base / "config"
        # Each session's own data root (Batch 2B-2), so one session's user files never reach another's. Not
        # created here: BugPilot creates it, private, as it would on a machine. BugPilot before 2B-2 ignores
        # it, so this generator reproduces the frozen records on that product too.
        self.data = base / "data"
        self.inputs = base / "inputs"
        for folder in (self.repo, self.config, self.inputs):
            folder.mkdir(parents=True)
        for relative, text in _SOURCE.items():
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8", newline="\n")
        git = ["git", "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "-c", "core.autocrlf=false",
               "-c", "commit.gpgsign=false"]
        for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "initial"]):
            subprocess.run([*git, *args], cwd=self.repo, check=True, capture_output=True)
        # The repository's ID, from BugPilot's own identity function and never read back from a command's
        # output (M-a): the records show it as <repository-id>, and any other ID fails (`_label_repository_id`).
        from bugpilot.core import storage

        self.repository_id = storage.repository_identity(self.repo).repository_id

    def env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["PYTHONPATH"] = _isolation.child_pythonpath(REPO)
        env["BUGPILOT_CONFIG_DIR"] = str(self.config)
        env["BUGPILOT_HOME"] = str(self.data)
        env["PYTHONIOENCODING"] = "utf-8"
        # Nothing here may start an agent.
        env["BUGPILOT_CLAUDE_COMMAND"] = env["BUGPILOT_COPILOT_COMMAND"] = "bugpilot-baseline-no-agent"
        return env

    def input_file(self, name: str, text: str) -> Path:
        path = self.inputs / name
        path.write_text(text, encoding="utf-8", newline="\n")
        return path

    def run(self, *args: str | Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "bugpilot", *map(os.fspath, args)], cwd=self.repo, env=self.env(),
            capture_output=True, text=True, encoding="utf-8", timeout=300,
        )

    def labels(self) -> tuple[tuple[Path, str], ...]:
        """The session's temporary roots and the labels the records show for them."""
        return ((self.repo, "<repo>"), (self.config, "<config>"), (self.data, "<data>"), (self.inputs, "<input>"))

    def command(self, args: Sequence[str | Path]) -> str:
        """A command as ``pollution.json`` records it: each ``Path`` argument portable, other text normalized."""
        labels = self.labels()
        words = [portable_path(arg, labels) if isinstance(arg, PurePath) else self.normalize(arg) for arg in args]
        return "bugpilot " + " ".join(words)  # type: ignore[arg-type]

    def json(self, *args: str) -> dict[str, object]:
        done = self.run(*args)
        try:
            return json.loads(done.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"bugpilot {' '.join(args)} gave no JSON (exit {done.returncode}): {done.stderr[-400:]}") from error

    def normalize(self, value: object, *, sort: bool = True) -> object:
        """Temporary roots and local ids replaced; lists of strings sorted unless they are a sequence (``sort=False``)."""
        if isinstance(value, str):
            text = value
            for path, label in self.labels():
                for spelling in {str(path), path.as_posix(), str(path.resolve()), path.resolve().as_posix()}:
                    text = text.replace(spelling, label)
            home = os.environ.get("HOME")
            if home:
                text = text.replace(home, "<home>").replace(Path(home).as_posix(), "<home>")
            if text.startswith(("<repo>", "<config>", "<data>", "<input>", "<home>")):
                text = text.replace("\\", "/")
            return self._label_repository_id(LOCAL_ID.sub("local_<timestamp>", text))
        if isinstance(value, list):
            items = [self.normalize(item, sort=sort) for item in value]
            return sorted(items) if sort and all(isinstance(item, str) for item in items) else items
        if isinstance(value, dict):
            return {key: self.normalize(item, sort=sort) for key, item in sorted(value.items())}
        return value

    def _label_repository_id(self, text: str) -> str:
        """This session's repository ID as ``<repository-id>``; another repository ID is an error, never hidden (M-a).

        Only the whole ID is replaced: a longer name that merely contains it is left as it is, and the check
        below then refuses it like any other foreign ID.
        """
        text = re.sub(rf"(?<![a-z0-9._-]){re.escape(self.repository_id)}(?![0-9a-z._-])", REPOSITORY_ID_LABEL, text)
        foreign = REPOSITORY_ID_TEXT.search(text)
        if foreign:
            raise RuntimeError(
                f"a record names a repository ID that is not this session's ({foreign.group(0)}): BugPilot used "
                "another folder's namespace"
            )
        return text

    @contextlib.contextmanager
    def data_root(self) -> Iterator[None]:
        """In-process calls resolve this session's data folder, as its CLI children do (0.1.7: a work item's
        folder is named absolutely, so the in-process handoff sentences need the same folder)."""
        previous = os.environ.get("BUGPILOT_HOME")
        os.environ["BUGPILOT_HOME"] = str(self.data)
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("BUGPILOT_HOME", None)
            else:
                os.environ["BUGPILOT_HOME"] = previous

    def work_folder(self, work_item_id: str) -> Path:
        """A work item's folder, where the session's CLI keeps it: `doctor --json`'s `storage.repository_dir`."""
        report = self.json("doctor", "--json").get("report", {})
        return Path(report["storage"]["repository_dir"]) / "work" / work_item_id  # type: ignore[index]

    def tree(self) -> set[str]:
        """Every path in the repository, `.git` aside, as repository-relative POSIX text."""
        found: set[str] = set()
        for current, folders, files in os.walk(self.repo):
            folders[:] = [folder for folder in folders if not (current == str(self.repo) and folder == ".git")]
            for name in folders + files:
                found.add(Path(current, name).relative_to(self.repo).as_posix())
        return found


# --- the records ----------------------------------------------------------------------------------


def pollution(session: Session) -> dict[str, object]:
    """Which repository paths each command creates. 0.1.5 writes `.ai/`, `.ai_memory/` and `.bugpilot/`."""
    review = session.input_file("review.json", json.dumps({"summary": "Looks right.", "findings": "", "validation_notes": "", "recommendations": ""}))
    checks = session.input_file("checks.json", json.dumps({"checks": [{"name": "unit tests", "status": "passed"}]}))
    project = session.input_file("project.md", "Keep changes small.\n")
    verification = session.input_file("verification.md", "Run the focused tests.\n")
    behavior = session.input_file("behavior.md", "## Reporting Standards\n\n- Name the formats the change affects.\n")
    settings = session.input_file("settings.json", json.dumps({"branch_naming": {"template": "bugfix/{issue}-{slug}"}}))
    user = session.input_file("user.md", "Prefer small changes.\n")
    # Path-valued arguments stay `Path`s, so the recorded command spells them portably (`Session.command`).
    steps: list[tuple[str, list[str | Path]]] = [
        ("prepare a Jira item (mock data)", ["bug", JIRA_ID, "--allow-mock", "--json"]),
        ("prepare a hand-written bug", ["bug", "--description=Saving a record crashes with a KeyError in src/record.py", "--title", "Save crash", "--json"]),
        ("retry (feedback template and retry prompt)", ["bug", JIRA_ID, "--retry", "--json"]),
        ("manual-result (fix report template)", ["manual-result", JIRA_ID]),
        ("record-review", ["record-review", JIRA_ID, "--from-file", review, "--json"]),
        ("record-verification", ["record-verification", JIRA_ID, "--from-file", checks, "--json"]),
        ("jira-comment-draft", ["jira-comment-draft", JIRA_ID]),
        ("notify (preview only)", ["notify", JIRA_ID]),
        ("project instructions set", ["instructions", "set", "--scope", "project", "--from-file", project, "--json"]),
        ("verification policy set", ["verification", "set", "--from-file", verification, "--json"]),
        ("ai-behavior set", ["ai-behavior", "set", "--from-file", behavior, "--json"]),
        ("project-settings set", ["project-settings", "set", "--from-file", settings, "--json"]),
        ("repository-profile set", ["repository-profile", "set", "--mode", "generic"]),
        ("project fix mode", ["fix-mode", "duplicate", "standard", "team-fix", "--scope", "project", "--json"]),
        ("user instructions set (configuration folder)", ["instructions", "set", "--scope", "user", "--from-file", user, "--json"]),
        ("doctor (read-only)", ["doctor", "--json"]),
        ("list (read-only)", ["list", "--json"]),
        ("status (read-only)", ["status", JIRA_ID, "--json"]),
        ("check-results (read-only)", ["check-results", JIRA_ID, "--json"]),
        ("task-preview (read-only)", ["task-preview", JIRA_ID, "--json"]),
        ("context-preview (read-only)", ["context-preview", JIRA_ID, "--json"]),
        ("review-package (read-only)", ["review-package", JIRA_ID, "--json"]),
    ]
    before = session.tree()
    recorded = []
    for label, args in steps:
        done = session.run(*args)
        after = session.tree()
        recorded.append({
            "step": label,
            "command": session.command(args),
            "exit": done.returncode,
            "created": session.normalize(sorted(after - before)),
            "removed": session.normalize(sorted(before - after)),
        })
        before = after
    status = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=session.repo,
        capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    top = sorted({path.split("/", 1)[0] for path in session.tree()} & set(BUGPILOT_DIRS))
    return {
        "describes": "BugPilot 0.1.5 (version in the tree) in a synthetic git repository with no .gitignore",
        "expected_for_0_1_5": "repository-local BugPilot folders are created; Batch 2 flips this to none",
        "bugpilot_folders_in_repository": top,
        "user_configuration_written": sorted(path.name for path in session.config.iterdir()),
        "steps": recorded,
        "git_status": session.normalize(sorted(status)),
    }


def _lines_naming_storage(text: str) -> list[str]:
    return [line for line in text.splitlines() if re.search(r"\.ai/|\.ai_memory|\.bugpilot|/work/|fix_report\.md|task\.md|context\.md", line)]


def _ts_template(path: Path, pattern: str) -> list[str]:
    return sorted(set(re.findall(pattern, path.read_text(encoding="utf-8"))))


def handoff(session: Session) -> dict[str, object]:
    """The sentences and agent-facing lines that name a storage path, from every surface."""
    from bugpilot.core import handoff as core_handoff
    from bugpilot.core.config import prompt_path
    from bugpilot.core.fix_modes import INVESTIGATE_FIRST_FIX, STANDARD_FIX
    from bugpilot.mcp_server import _next_step

    jira_text = session.run("bug", JIRA_ID, "--allow-mock").stdout
    retry_text = session.run("bug", JIRA_ID, "--retry").stdout
    work = session.work_folder(JIRA_ID)
    review = session.json("review-package", JIRA_ID, "--json")
    with session.data_root():
        folder = prompt_path(work)
        python = {
            "handoff_prompt": core_handoff.work_item_handoff(session.repo, JIRA_ID),
            "retry_handoff_prompt": core_handoff.retry_handoff_prompt(f"{folder}/agent_retry_prompt.md"),
            "mcp_fix_bug_prompt": core_handoff.mcp_prompt("prepare_jira_bug", f'issue_key="{JIRA_ID}"'),
            "skill_steps": list(core_handoff.skill_steps()),
            "mcp_next_step_fix": _next_step(folder, STANDARD_FIX),
            "mcp_next_step_investigation": _next_step(folder, INVESTIGATE_FIRST_FIX),
        }
    return session.normalize({  # type: ignore[return-value]
        "python": python,
        "extension_templates": {
            "controller.ts": _ts_template(REPO / "extension/src/app/controller.ts", r"`(Read (?:\.ai/|\$\{promptPath)[^`]+)`"),
            "nextAction.ts": _ts_template(REPO / "extension/src/app/nextAction.ts", r"`(Read (?:\.ai/|\$\{promptPath)[^`]+)`"),
        },
        "cli_text": {
            "bug": _lines_naming_storage(jira_text),
            "bug --retry": _lines_naming_storage(retry_text),
        },
        "task_md_lines": _lines_naming_storage((work / "task.md").read_text(encoding="utf-8")),
        "retry_prompt_lines": _lines_naming_storage((work / "agent_retry_prompt.md").read_text(encoding="utf-8")),
        "context_md_lines": _lines_naming_storage((work / "context.md").read_text(encoding="utf-8")),
        "review_prompt_lines": _lines_naming_storage(str(review.get("prompt", ""))),
        "skill_md_lines": _lines_naming_storage((REPO / "skills/bugpilot-investigate/SKILL.md").read_text(encoding="utf-8")),
    }, sort=False)  # documents: their lines keep their order


def _fields(envelope: dict[str, object], *keys: str) -> dict[str, object]:
    return {key: envelope.get(key) for key in keys}


def cli_paths(session: Session) -> dict[str, object]:
    """The path-bearing fields of each JSON command, as 0.1.5 fills them."""
    bug = session.json("bug", SECOND_ID, "--allow-mock", "--json")
    stream = session.run("bug", "JR-34567", "--allow-mock", "--json-lines").stdout.splitlines()
    events = [json.loads(line) for line in stream if line.strip()]
    missing = session.json("check-results", SECOND_ID, "--json")
    session.run("manual-result", SECOND_ID)
    review = session.input_file("review2.json", json.dumps({"summary": "Fine.", "findings": "", "validation_notes": "", "recommendations": ""}))
    checks = session.input_file("checks2.json", json.dumps({"checks": [{"name": "tests", "status": "passed"}]}))
    retry = session.json("bug", SECOND_ID, "--retry", "--json")
    doctor = session.json("doctor", "--json")
    report = doctor.get("report", {})
    record: dict[str, object] = {
        "bug --json": _fields(bug, "issue_dir", "agent_task", "generated_files"),
        "bug --json-lines artifact events": [event["path"] for event in events if event.get("type") == "artifact"],
        "fetch --json": _fields(session.json("fetch", "JR-45678", "--allow-mock", "--json"), "issue_dir", "generated_files"),
        "status --json": _fields(session.json("status", SECOND_ID, "--json"), "generated_files"),
        "check-results --json (no report)": _fields(missing, "missing", "warnings"),
        "summarize-results --json": _fields(session.json("summarize-results", SECOND_ID, "--no-jira-comment", "--json"), "fix_report"),
        "record-review --json": _fields(session.json("record-review", SECOND_ID, "--from-file", str(review), "--json"), "review_report"),
        "record-verification --json": _fields(session.json("record-verification", SECOND_ID, "--from-file", str(checks), "--json"), "verification_report"),
        "bug --retry --json": _fields(retry, "feedback_file", "retry_prompt"),
        "list --json item keys": sorted({key for item in session.json("list", "--json").get("work_items", []) for key in item}),  # type: ignore[union-attr]
        "doctor --json": {
            "capabilities": report.get("capabilities"),  # type: ignore[union-attr]
            "ai_artifacts_ignored": report.get("ai_artifacts_ignored"),  # type: ignore[union-attr]
            "ai_artifacts_ignored_paths": report.get("ai_artifacts_ignored_paths"),  # type: ignore[union-attr]
        },
    }
    for command in ("verification", "ai-behavior", "project-settings", "repository-profile", "instructions"):
        envelope = session.json(command, "show", "--json")
        found = {}
        for key, value in envelope.items():
            if key == "path" or (isinstance(value, dict) and "path" in value):
                found[key] = value if key == "path" else value["path"]
            if isinstance(value, dict):
                found.update({f"{key}.{inner}.path": item["path"] for inner, item in value.items() if isinstance(item, dict) and "path" in item})
        record[f"{command} show --json path fields"] = found
    return session.normalize(record)  # type: ignore[return-value]


def task_size() -> dict[str, object]:
    """The task goldens as the size gate measures them, with US-D30's normalized measure."""
    import task_golden

    baseline = json.loads((TESTS / "baselines" / "0.1.3-batch0" / "task.json").read_text(encoding="utf-8"))
    cases = {}
    normalized_tokens = []
    for case in task_golden.MATRIX:
        text = task_golden.read_golden(case)
        measured = task_golden.measure(text)
        normalized_tokens.append(task_golden.measure(task_golden.normalized(text, case))["approx_tokens"])
        cases[case.name] = {
            "chars": measured["chars"],
            "approx_tokens": measured["approx_tokens"],
            "ai_path_mentions": len(re.findall(r"\.ai/", text)),
            "absolute_path_mentions": len(re.findall(r"[A-Za-z]:[\\/]|(?<![\w.])/(?:home|Users|tmp|private|var)/", text)),
        }
    median = statistics.median(entry["approx_tokens"] for entry in cases.values())
    before = baseline["median"]["approx_tokens"]
    return {
        "describes": "tests/golden/task/*.txt as committed (0.1.5); approx_tokens = round(chars / 4)",
        "baseline_0_1_3_median_approx_tokens": before,
        "ceiling_approx_tokens": int(before * 0.8),
        "median_approx_tokens": median,
        "normalized_median_approx_tokens": statistics.median(normalized_tokens),
        "normalized_note": (
            "0.1.7 tasks name their work folder absolutely; the normalized measure (US-D30) replaces the golden's "
            "representative folder with <WORK>"
        ),
        "cases": cases,
    }


def prepare_timing(base: Path, runs: int = 5) -> dict[str, object]:
    """End-to-end `bug <id> --allow-mock --json` in a fresh repository each run. Machine-dependent."""
    durations = []
    for run in range(runs):
        session = Session(base / f"timing-{run}")
        start = time.perf_counter()
        done = session.run("bug", JIRA_ID, "--allow-mock", "--json")
        durations.append(time.perf_counter() - start)
        if done.returncode != 0:
            raise RuntimeError(f"timing run failed: {done.stderr[-400:]}")
    return {
        "describes": "python -m bugpilot bug JR-12345 --allow-mock --json, a fresh synthetic repository each run, "
                     "interpreter start included; never compared (machine-dependent)",
        "runs": runs,
        "median_ms": round(statistics.median(durations) * 1000, 1),
        "all_ms": [round(value * 1000, 1) for value in durations],
        "platform": platform.system(),
        "python": platform.python_version(),
    }


def observe_realpath(base: Path) -> dict[str, object]:
    """How this platform canonicalizes spellings of one folder (plan §7.3). Booleans and outcomes, no paths."""
    target = base / "Repo-Root"
    (target / "sub").mkdir(parents=True)
    canonical = os.path.realpath(target)
    seen: dict[str, object] = {"platform": sys.platform}

    def same(spelling: str) -> object:
        try:
            return os.path.realpath(spelling, strict=True) == canonical
        except OSError as error:
            return f"error: {type(error).__name__}"

    seen["separators_and_dots"] = same(str(target / "sub" / ".." / "." ))
    seen["trailing_separator"] = same(str(target) + os.sep)
    seen["forward_slashes"] = same(target.as_posix())
    swapped = str(target.parent / target.name.swapcase())
    seen["case_variant_resolves_to_stored_case"] = same(swapped)
    try:
        os.path.realpath(base / "missing-folder", strict=True)
        seen["strict_missing_raises"] = False
    except OSError:
        seen["strict_missing_raises"] = True
    link = base / "link-to-root"
    try:
        os.symlink(target, link, target_is_directory=True)
        seen["symlink_resolves_to_target"] = same(str(link))
    except (OSError, NotImplementedError) as error:
        seen["symlink_resolves_to_target"] = f"unavailable: {type(error).__name__}"
    if os.name == "nt":
        junction = base / "junction-to-root"
        try:
            import _winapi

            _winapi.CreateJunction(str(target), str(junction))
            seen["junction_resolves_to_target"] = same(str(junction))
        except (OSError, AttributeError, ImportError) as error:
            seen["junction_resolves_to_target"] = f"unavailable: {type(error).__name__}"
        seen["subst_drive"] = "not observed: needs a drive letter; CI only by owner decision"
    if sys.platform == "darwin":
        seen["temp_is_under_private"] = os.path.realpath(tempfile.gettempdir()).startswith("/private/")
        previous = os.getcwd()
        try:
            os.chdir(swapped)
            seen["getcwd_returns_stored_case"] = os.getcwd() == canonical
        except OSError as error:
            seen["getcwd_returns_stored_case"] = f"error: {type(error).__name__}"
        finally:
            os.chdir(previous)
    return seen


def realpath_name() -> str:
    name = {"win32": "windows", "darwin": "macos"}.get(sys.platform, sys.platform)
    return f"realpath_{name}.json"


# --- writing and checking ----------------------------------------------------------------------


def _dump(value: object) -> bytes:
    return (json.dumps(value, indent=1, ensure_ascii=False, sort_keys=False) + "\n").encode("utf-8")


def generate(directory: Path, *, timing: bool) -> list[str]:
    """Write the records to ``directory``; the compared ones always, timing and realpath when asked."""
    _isolation.require_isolated()
    directory.mkdir(parents=True, exist_ok=True)
    written = []
    with tempfile.TemporaryDirectory() as scratch:
        base = Path(scratch)
        records = {
            "pollution.json": pollution(Session(base / "pollution")),
            "handoff.json": handoff(Session(base / "handoff")),
            "cli_paths.json": cli_paths(Session(base / "cli")),
            "task_size.json": task_size(),
        }
        if timing:
            records["prepare_timing.json"] = prepare_timing(base)
            observed = base / "realpath"
            observed.mkdir()
            records[realpath_name()] = observe_realpath(observed)
        for name, value in records.items():
            (directory / name).write_bytes(_dump(value))
            written.append(name)
    return written


# --- designed differences (Batch 2B-2) --------------------------------------------------------------

_ENTRY_KEYS = frozenset({"id", "record", "pointer", "from", "to", "decision", "evidence", "approved"})
_MISSING = object()


def frozen_bytes(path: Path) -> bytes:
    """A committed record's bytes as compared: line endings as the generator writes them (a checkout may add CRs)."""
    return path.read_bytes().replace(b"\r\n", b"\n")


def frozen_sha256(path: Path) -> str:
    return hashlib.sha256(frozen_bytes(path)).hexdigest()


def load_designed(path: Path = DESIGNED) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_chain(paths: Sequence[Path] = DESIGNED_CHAIN) -> list[dict[str, object]]:
    """Every slice's designed-differences record, in the order the slices change the frozen records (CH-1)."""
    return [load_designed(path) for path in paths]


def _as_chain(designed: dict[str, object] | Sequence[dict[str, object]] | None) -> list[dict[str, object]]:
    """One record (as a single slice), a chain of them, or the committed chain."""
    if designed is None:
        return load_chain()
    return [designed] if isinstance(designed, dict) else list(designed)


def _within(parts: Sequence[str], outer: Sequence[str]) -> bool:
    """Whether the value at ``parts`` is the value at ``outer`` or lies inside it."""
    return list(parts[: len(outer)]) == list(outer)


def pointer_parts(pointer: str) -> list[str]:
    """An RFC 6901 JSON pointer's reference tokens (``~1`` is ``/``, ``~0`` is ``~``). The whole document is refused."""
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise ValueError(f"not a JSON pointer to a value inside a record: {pointer!r}")
    tokens = pointer[1:].split("/")
    if any(re.search(r"~(?![01])", token) for token in tokens):
        raise ValueError(f"a JSON pointer with a bad escape: {pointer!r}")
    return [token.replace("~1", "/").replace("~0", "~") for token in tokens]


def _at(document: object, parts: Sequence[str]) -> object:
    node = document
    for part in parts:
        if isinstance(node, dict):
            if part not in node:
                return _MISSING
            node = node[part]
        elif isinstance(node, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", part) or int(part) >= len(node):
                return _MISSING
            node = node[int(part)]
        else:
            return _MISSING
    return node


def _put(document: object, parts: Sequence[str], value: object) -> None:
    parent = _at(document, parts[:-1])
    if isinstance(parent, list):
        parent[int(parts[-1])] = value
    else:
        parent[parts[-1]] = value  # type: ignore[index]


def _same(first: object, second: object) -> bool:
    """Equal as JSON values, type included: ``1``, ``1.0`` and ``true`` are three different values."""
    return json.dumps(first, sort_keys=True, ensure_ascii=False) == json.dumps(second, sort_keys=True, ensure_ascii=False)


def designed_problems(designed: dict[str, object], expected_dir: Path = OUT) -> list[str]:
    """What is wrong with a designed-differences record itself, before anything is compared."""
    problems: list[str] = []
    if set(designed) != {"describes", "base_commit", "frozen", "differences"}:
        return [f"designed differences: unexpected keys {sorted(designed)}"]
    frozen = designed["frozen"]
    if not isinstance(frozen, dict) or sorted(frozen) != sorted(COMPARED):
        return [f"designed differences: `frozen` must hash exactly {list(COMPARED)}"]
    for name in COMPARED:
        path = expected_dir / name
        if not path.exists():
            problems.append(f"{name}: no committed baseline")
        elif frozen[name] != frozen_sha256(path):
            problems.append(f"{name}: the committed baseline is not the one the designed differences were made against")
    entries = designed["differences"]
    if not isinstance(entries, list):
        return problems + ["designed differences: `differences` must be a list"]
    ids: set[str] = set()
    seen: dict[str, list[list[str]]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != _ENTRY_KEYS:
            problems.append(f"designed differences: an entry must have exactly {sorted(_ENTRY_KEYS)}: {entry!r}")
            continue
        label = entry["id"]
        if not isinstance(label, str) or not label or label in ids:
            problems.append(f"designed differences: a missing or repeated id {label!r}")
        ids.add(str(label))
        if entry["record"] not in COMPARED:
            problems.append(f"{label}: {entry['record']!r} is not a compared record")
            continue
        try:
            parts = pointer_parts(entry["pointer"])
        except ValueError as error:
            problems.append(f"{label}: {error}")
            continue
        for other in seen.setdefault(entry["record"], []):
            shorter = min(len(parts), len(other))
            if parts[:shorter] == other[:shorter]:
                problems.append(f"{label}: {entry['pointer']} is listed twice, or lies inside another listed pointer")
        seen[entry["record"]].append(parts)
        if _same(entry["from"], entry["to"]):
            problems.append(f"{label}: `from` and `to` are the same value, so nothing would differ")
    return problems


def chain_problems(chain: Sequence[dict[str, object]], expected_dir: Path = OUT) -> list[str]:
    """What is wrong with each record of a chain, and with the chain: an id may be used by one slice only."""
    problems = [problem for designed in chain for problem in designed_problems(designed, expected_dir)]
    owners: dict[str, int] = {}
    for position, designed in enumerate(chain):
        entries = designed.get("differences")
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                continue
            label = entry["id"]
            if owners.setdefault(label, position) != position:
                problems.append(f"designed differences: the id {label!r} is listed by more than one slice's record")
    return problems


def unapproved(designed: dict[str, object] | Sequence[dict[str, object]]) -> list[str]:
    """The listed differences the owner has not approved yet (``approved`` is empty), in one record or a chain."""
    return [
        str(entry.get("id"))
        for record in _as_chain(designed)
        for entry in record.get("differences", [])  # type: ignore[union-attr]
        if not entry.get("approved")
    ]


# --- superseded evidence (E-3, Batch 2B-3b) -----------------------------------------------------------

#: The only approved pairs (plan §14.3, "Batch 2B-3b — decision gate and implementation contract", part 6):
#: an earlier slice's entry, the later slice's entry that sets the same value again, and the commit and CI run
#: on which the earlier entry's own evidence last passed. Not a skip: each pair is judged by `supersession`.
SUPERSEDED: dict[str, dict[str, str]] = {
    "DD-5": {"by": "U7-10", "verified_at": "743f542ad328b1af5eb9f0b494d07491f2b33ed7", "ci_run": "39675645316"},
    "DD-9": {"by": "U7-12", "verified_at": "743f542ad328b1af5eb9f0b494d07491f2b33ed7", "ci_run": "39675645316"},
}
_APPROVED_PAIRS = frozenset({("DD-5", "U7-10"), ("DD-9", "U7-12")})
INACTIVE, PENDING, ACTIVE = "inactive", "pending", "active"


def evidence_exists(evidence: object) -> bool:
    """Whether ``tests/<file>.py::<name>`` names a test function that is defined in that file."""
    if not isinstance(evidence, str):
        return False
    file, _, name = evidence.partition("::")
    path = REPO / file
    return bool(name) and path.is_file() and f"def {name}(" in path.read_text(encoding="utf-8")


def supersession(
    chain: Sequence[dict[str, object]],
    table: dict[str, dict[str, str]] = SUPERSEDED,
    evidence: Callable[[object], bool] = evidence_exists,
) -> tuple[dict[str, str], list[str]]:
    """Each declared pair's state, keyed by the earlier id, and every problem with the pairs.

    - **inactive:** the successor is not in the chain. The earlier entry's evidence is required.
    - **pending:** the successor matches but is not approved. It is reported by `pending_supersessions`,
      so the approval gate fails while it lasts.
    - **active:** the successor matches and is approved. The earlier test is retired and must be absent.

    The successor matches when it is exactly once in the chain, in a later slice's record, with the same
    record and pointer, a `from` that is the earlier `to`, and evidence of its own that exists. A pair that
    fails any of this has no state: it is a problem, so nothing is exempted for it.
    """
    states: dict[str, str] = {}
    problems: list[str] = []
    found: dict[object, list[tuple[int, dict[str, object]]]] = {}
    for position, designed in enumerate(chain):
        entries = designed.get("differences")
        for entry in entries if isinstance(entries, list) else []:
            if isinstance(entry, dict):
                found.setdefault(entry.get("id"), []).append((position, entry))
    for earlier_id, pair in table.items():
        successor_id = pair.get("by") if isinstance(pair, dict) else None
        label = f"supersession {earlier_id} -> {successor_id}"
        if (earlier_id, successor_id) not in _APPROVED_PAIRS:
            problems.append(f"{label}: not an approved pair (only DD-5 -> U7-10 and DD-9 -> U7-12 are)")
            continue
        if len(found.get(earlier_id, [])) != 1:
            problems.append(f"{label}: {earlier_id} is not listed exactly once in the chain")
            continue
        [(earlier_at, earlier)] = found[earlier_id]
        successors = found.get(successor_id, [])
        if not successors:
            states[earlier_id] = INACTIVE
            if not evidence(earlier.get("evidence")):
                problems.append(f"{label}: inactive, so {earlier_id}'s evidence is still required, and it is missing")
            continue
        if len(successors) > 1:
            problems.append(f"{label}: {successor_id} is listed more than once in the chain")
            continue
        [(successor_at, successor)] = successors
        mismatches = []
        if successor_at <= earlier_at:
            mismatches.append(f"{successor_id} is not in a later slice's record than {earlier_id}")
        if successor.get("record") != earlier.get("record"):
            mismatches.append(f"{successor_id} names another record than {earlier_id}")
        if successor.get("pointer") != earlier.get("pointer"):
            mismatches.append(f"{successor_id} names another pointer than {earlier_id}")
        if not _same(successor.get("from"), earlier.get("to")):
            mismatches.append(f"{successor_id}'s `from` is not {earlier_id}'s `to`")
        if successor.get("evidence") == earlier.get("evidence"):
            mismatches.append(f"{successor_id} names {earlier_id}'s evidence, not its own")
        elif not evidence(successor.get("evidence")):
            mismatches.append(f"{successor_id}'s evidence does not exist")
        if mismatches:
            problems.extend(f"{label}: {mismatch}" for mismatch in mismatches)
            continue
        if not successor.get("approved"):
            states[earlier_id] = PENDING
            continue
        states[earlier_id] = ACTIVE
        if evidence(earlier.get("evidence")):
            problems.append(f"{label}: active, so {earlier_id}'s retired evidence must be removed")
    return states, problems


def pending_supersessions(
    chain: Sequence[dict[str, object]],
    table: dict[str, dict[str, str]] = SUPERSEDED,
    evidence: Callable[[object], bool] = evidence_exists,
) -> list[str]:
    """The pairs awaiting the owner's approval of their successor, for the approval gate to report."""
    states, _problems = supersession(chain, table, evidence)
    return [f"{earlier} -> {table[earlier]['by']}" for earlier, state in states.items() if state == PENDING]


def differences(
    expected_dir: Path, actual_dir: Path, designed: dict[str, object] | Sequence[dict[str, object]] | None = None
) -> list[str]:
    """Every way today's records differ from the committed ones, after the designed differences are applied.

    The committed bytes must match their recorded hashes. The records of the chain (one record counts as a
    chain of one; none given means the committed chain) are applied in their order: for each listed entry the
    value at its pointer must be exactly ``from`` (the committed value, or the value an earlier slice's record
    left); it is replaced by ``to`` in memory, and the result must equal today's record byte for byte. A record
    without entries is compared byte for byte, as Batch 0A did. Approval is judged separately
    (:func:`unapproved`), so a pending review never hides a wrong value.
    """
    chain = _as_chain(designed)
    problems = chain_problems(chain, expected_dir)
    if problems:
        return problems
    by_record: dict[str, list[dict[str, object]]] = {}
    for record in chain:
        for entry in record["differences"]:  # type: ignore[union-attr]
            by_record.setdefault(entry["record"], []).append(entry)
    for name in COMPARED:
        frozen, now = frozen_bytes(expected_dir / name), (actual_dir / name).read_bytes()
        entries = by_record.get(name, [])
        if not entries:
            if frozen != now:
                problems.append(f"{name}: differs from the committed baseline")
            continue
        document = json.loads(frozen)
        if _dump(document) != frozen:
            problems.append(f"{name}: the committed baseline does not survive a JSON round trip")
            continue
        stale = False
        touched: list[list[str]] = []
        for entry in entries:
            parts = pointer_parts(entry["pointer"])  # type: ignore[arg-type]
            found = _at(document, parts)
            if found is _MISSING or not _same(found, entry["from"]):
                earlier = any(_within(parts, other) or _within(other, parts) for other in touched)
                where = "the value the earlier designed differences leave" if earlier else "the committed value"
                problems.append(f"{name} {entry['id']}: {where} at {entry['pointer']} is not `from`")
                stale = True
            else:
                _put(document, parts, json.loads(json.dumps(entry["to"])))
            touched.append(parts)
        if stale or _dump(document) == now:
            continue
        current = json.loads(now)
        for index, entry in enumerate(entries):
            parts = pointer_parts(entry["pointer"])  # type: ignore[arg-type]
            if any(_within(parts, pointer_parts(later["pointer"])) for later in entries[index + 1:]):  # type: ignore[arg-type]
                continue  # a later slice sets this value again: only that slice's `to` is today's
            seen = _at(current, parts)
            if seen is _MISSING or not _same(seen, entry["to"]):
                problems.append(f"{name} {entry['id']}: today's value at {entry['pointer']} is not `to`")
                if seen is not _MISSING:
                    _put(document, parts, seen)
        if _dump(document) != now:
            problems.append(f"{name}: differs from the committed baseline beyond its designed differences")
    return problems


def pointer_differences(expected: object, actual: object, pointer: str = "") -> list[tuple[str, object, object]]:
    """Each place two JSON values differ, as ``(pointer, expected, actual)``; a missing value is ``None``.

    Objects are compared key by key and lists of equal length item by item; a list whose length changed is one
    difference at the list itself. For reviewing what a regeneration changed; never a pass or fail by itself.
    """
    if isinstance(expected, dict) and isinstance(actual, dict):
        found: list[tuple[str, object, object]] = []
        for key in list(expected) + [key for key in actual if key not in expected]:
            here = f"{pointer}/{key.replace('~', '~0').replace('/', '~1')}"
            if key not in actual or key not in expected:
                found.append((here, expected.get(key), actual.get(key)))
            else:
                found.extend(pointer_differences(expected[key], actual[key], here))
        return found
    if isinstance(expected, list) and isinstance(actual, list) and len(expected) == len(actual):
        return [item for index, pair in enumerate(zip(expected, actual))
                for item in pointer_differences(pair[0], pair[1], f"{pointer}/{index}")]
    return [] if _same(expected, actual) else [(pointer, expected, actual)]


def main(argv: list[str] | None = None) -> int:
    import argparse

    _isolation.isolate_session()
    parser = argparse.ArgumentParser(description="Synthetic 0.1.5 storage baselines.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help=f"Regenerate {OUT.relative_to(REPO).as_posix()}/.")
    group.add_argument("--check", action="store_true", help="Regenerate into a temporary folder and compare.")
    group.add_argument("--pointers", action="store_true",
                       help="Regenerate into a temporary folder and list every differing value by JSON pointer.")
    args = parser.parse_args(argv)
    if args.write:
        for name in generate(OUT, timing=True):
            print(f"wrote {OUT.relative_to(REPO).as_posix()}/{name}")
        return 0
    with tempfile.TemporaryDirectory() as scratch:
        generate(Path(scratch), timing=False)
        if args.pointers:
            for name in COMPARED:
                expected = json.loads(frozen_bytes(OUT / name))
                actual = json.loads((Path(scratch) / name).read_text(encoding="utf-8"))
                for pointer, before, after in pointer_differences(expected, actual):
                    print(json.dumps({"record": name, "pointer": pointer, "from": before, "to": after},
                                     ensure_ascii=False))
            return 0
        problems = differences(OUT, Path(scratch))
    chain = load_chain()
    _states, superseded = supersession(chain)
    pending = unapproved(chain) + pending_supersessions(chain)
    for line in problems + superseded:
        print(line)
    print("baselines match" if not problems else f"{len(problems)} baseline(s) differ")
    if pending:
        print(f"awaiting the owner's approval: {', '.join(pending)}")
    return 1 if problems or superseded or pending else 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main(sys.argv[1:]))
