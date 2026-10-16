"""Synthetic 0.1.5 storage baselines (0.1.6 Batch 0A, plan §14.1.A).

What BugPilot 0.1.5 does with storage today, recorded so that Batches 2 and 3
change it on purpose and visibly. Everything runs inside the test isolation
(`tests/_isolation.py`): a synthetic git repository, mock Jira data (no
credentials exist, so no request is made), an isolated home, the guard on, and
the real CLI (`python -m bugpilot`) as a guarded Python child.

    python tests/storage_baseline.py --write     # regenerate tests/baselines/0.1.6-batch0/
    python tests/storage_baseline.py --check     # regenerate into a temporary folder and compare

The records:

- ``pollution.json``    which BugPilot folders each command creates in the repository. For 0.1.5 this
                        *includes* `.ai/`, `.ai_memory/` and `.bugpilot/`: expected now, flipped by Batch 2.
- ``handoff.json``      the handoff sentences and the agent-facing lines that name a storage path.
- ``cli_paths.json``    the path-bearing fields of the CLI's JSON and JSON-lines output.
- ``task_size.json``    the task goldens' sizes, raw and normalized (US-D30).
- ``prepare_timing.json``  preparation time; machine-dependent, so never compared.
- ``realpath_<platform>.json``  how this platform canonicalizes spellings of one folder (plan §7.3);
                        an observation of the machine that wrote it, never compared.

Determinism: temporary roots become `<repo>`, `<config>`, `<home>` or `<input>`, a hand-written
item's id becomes `local_<timestamp>`, lists are sorted, and nothing machine-specific (timings,
installed tools, versions) is in a compared file. A path-valued command argument is recorded
with `/` on every platform (`portable_path`), so Windows, Linux and macOS write the same bytes.
"""

from __future__ import annotations

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
from collections.abc import Iterable, Sequence
from pathlib import Path, PurePath

import _isolation

TESTS = Path(__file__).resolve().parent
REPO = TESTS.parent
OUT = TESTS / "baselines" / "0.1.6-batch0"
COMPARED = ("pollution.json", "handoff.json", "cli_paths.json", "task_size.json")

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
    """One synthetic repository, its isolated configuration folder, and the CLI run inside it."""

    def __init__(self, base: Path) -> None:
        _isolation.require_isolated()
        self.base = base
        self.repo = base / "repo"
        self.config = base / "config"
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

    def env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["PYTHONPATH"] = _isolation.child_pythonpath(REPO)
        env["BUGPILOT_CONFIG_DIR"] = str(self.config)
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

    def command(self, args: Sequence[str | Path]) -> str:
        """A command as ``pollution.json`` records it: each ``Path`` argument portable, other text normalized."""
        labels = ((self.repo, "<repo>"), (self.config, "<config>"), (self.inputs, "<input>"))
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
            for path, label in ((self.repo, "<repo>"), (self.config, "<config>"), (self.inputs, "<input>")):
                for spelling in {str(path), path.as_posix(), str(path.resolve()), path.resolve().as_posix()}:
                    text = text.replace(spelling, label)
            home = os.environ.get("HOME")
            if home:
                text = text.replace(home, "<home>").replace(Path(home).as_posix(), "<home>")
            return LOCAL_ID.sub("local_<timestamp>", text)
        if isinstance(value, list):
            items = [self.normalize(item, sort=sort) for item in value]
            return sorted(items) if sort and all(isinstance(item, str) for item in items) else items
        if isinstance(value, dict):
            return {key: self.normalize(item, sort=sort) for key, item in sorted(value.items())}
        return value

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
    return [line for line in text.splitlines() if re.search(r"\.ai/|\.ai_memory|\.bugpilot|fix_report\.md|task\.md|context\.md", line)]


def _ts_template(path: Path, pattern: str) -> list[str]:
    return sorted(set(re.findall(pattern, path.read_text(encoding="utf-8"))))


def handoff(session: Session) -> dict[str, object]:
    """The sentences and agent-facing lines that name a storage path, from every surface."""
    from bugpilot.core import handoff as core_handoff
    from bugpilot.core.fix_modes import INVESTIGATE_FIRST_FIX, STANDARD_FIX
    from bugpilot.mcp_server import _next_step

    jira_text = session.run("bug", JIRA_ID, "--allow-mock").stdout
    retry_text = session.run("bug", JIRA_ID, "--retry").stdout
    work = session.repo / ".ai" / JIRA_ID
    review = session.json("review-package", JIRA_ID, "--json")
    return session.normalize({  # type: ignore[return-value]
        "python": {
            "handoff_prompt": core_handoff.handoff_prompt(JIRA_ID),
            "retry_handoff_prompt": core_handoff.retry_handoff_prompt(f".ai/{JIRA_ID}/agent_retry_prompt.md"),
            "mcp_fix_bug_prompt": core_handoff.mcp_prompt("prepare_jira_bug", f'issue_key="{JIRA_ID}"'),
            "skill_steps": list(core_handoff.skill_steps()),
            "mcp_next_step_fix": _next_step(JIRA_ID, STANDARD_FIX),
            "mcp_next_step_investigation": _next_step(JIRA_ID, INVESTIGATE_FIRST_FIX),
        },
        "extension_templates": {
            "controller.ts": _ts_template(REPO / "extension/src/app/controller.ts", r"`(Read \.ai/[^`]+)`"),
            "nextAction.ts": _ts_template(REPO / "extension/src/app/nextAction.ts", r"`(Read \.ai/[^`]+)`"),
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
    for case in task_golden.MATRIX:
        text = task_golden.read_golden(case)
        measured = task_golden.measure(text)
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
        "normalized_median_approx_tokens": median,
        "normalized_note": "0.1.5 tasks name no absolute work folder, so the normalized measure (US-D30) equals the raw one",
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


def differences(expected_dir: Path, actual_dir: Path) -> list[str]:
    problems = []
    for name in COMPARED:
        expected, actual = expected_dir / name, actual_dir / name
        if not expected.exists():
            problems.append(f"{name}: no committed baseline")
        elif expected.read_bytes().replace(b"\r\n", b"\n") != actual.read_bytes():
            problems.append(f"{name}: differs from the committed baseline")
    return problems


def main(argv: list[str] | None = None) -> int:
    import argparse

    _isolation.isolate_session()
    parser = argparse.ArgumentParser(description="Synthetic 0.1.5 storage baselines.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help=f"Regenerate {OUT.relative_to(REPO).as_posix()}/.")
    group.add_argument("--check", action="store_true", help="Regenerate into a temporary folder and compare.")
    args = parser.parse_args(argv)
    if args.write:
        for name in generate(OUT, timing=True):
            print(f"wrote {OUT.relative_to(REPO).as_posix()}/{name}")
        return 0
    with tempfile.TemporaryDirectory() as scratch:
        generate(Path(scratch), timing=False)
        problems = differences(OUT, Path(scratch))
    for line in problems:
        print(line)
    print("baselines match" if not problems else f"{len(problems)} baseline(s) differ")
    return 1 if problems else 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main(sys.argv[1:]))
