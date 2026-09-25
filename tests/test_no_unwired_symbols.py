"""Nothing is defined without being used, unless someone said why.

The recurring defect in this project is not an unused helper. It is a *guard*
that was written, documented, and never wired in — four of them before this
test existed:

  - the argv credential check, built in phase 2 and called from nowhere until
    phase 4's review;
  - "the host re-checks the command id against COMMANDS", promised in a comment
    while nothing did, which also left the install wizard's buttons dead;
  - "the built output must be current", which counted files instead;
  - `_atomic_write_text`, which existed for exactly the file the extension reads
    while a run writes it, and had zero callers.

Each read as protection while protecting nothing, and each was found by a human
reading code months later. So this counts references for production and tests
separately: a symbol used only by its own tests is the precise shape of that
bug, and anything genuinely meant to be unused has to say so below.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Symbols that exist without a production caller, each with the reason. Adding a
# line here is a decision; leaving one out is a failing test.
ALLOWED: dict[str, str] = {
    "workflow.run_bug_workflow": (
        "The Jira-shaped wrapper over run_investigation, documented in "
        "docs/architecture.md as the orchestrator entry point. The CLI moved to "
        "run_investigation; this stays as the library API."
    ),
    "handoff.TRIGGER_DESCRIPTION": (
        "Consumed by a *file* rather than by code: it is the trigger sentence in "
        "skills/bugpilot-investigate/SKILL.md, and test_handoff.py compares them."
    ),
    "handoff.TRIGGER_TOKENS": (
        "Same: the words the skill and the MCP tool descriptions must share, "
        "checked against both by test_handoff.py."
    ),
    "handoff.skill_steps": (
        "Renders the numbered steps of SKILL.md, which is a file rather than a "
        "caller. test_handoff.py compares the file against it step by step, so "
        "the skill cannot quietly drift from the other three handoff paths."
    ),
}


def _defined_symbols(path: Path, source: str) -> list[tuple[str, int]]:
    """Top-level functions, classes and constants a module defines."""
    try:
        tree = ast.parse(source)
    except SyntaxError:  # pragma: no cover - a syntax error fails elsewhere first
        return []
    found: list[tuple[str, int]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.append((node.name, node.lineno))
        elif isinstance(node, ast.Assign):
            found.extend(
                (target.id, node.lineno)
                for target in node.targets
                if isinstance(target, ast.Name) and target.id.isupper()
            )
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id.isupper():
                found.append((node.target.id, node.lineno))
    return found


def _strip_prose(source: str) -> str:
    """Comments and docstrings removed before counting.

    A name mentioned in a docstring would count as a use, making this guard
    lenient in exactly the case it exists for: a symbol everyone talks about and
    nobody calls. (The third file scanner in this project to need this; the
    stylesheet scan and the nonce scan hit it first.)
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:  # pragma: no cover
        return source
    spans: list[tuple[int, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                if isinstance(body[0].value.value, str):
                    spans.append((body[0].lineno, body[0].end_lineno or body[0].lineno))
    lines = source.split("\n")
    for start, end in spans:
        for index in range(start - 1, min(end, len(lines))):
            lines[index] = ""
    return "\n".join(
        "" if line.lstrip().startswith("#") else line.split("  #")[0] for line in lines
    )


def _references(name: str, sources: dict[Path, str], skip: Path | None) -> int:
    pattern = re.compile(rf"\b{re.escape(name)}\b")
    total = 0
    for path, text in sources.items():
        hits = len(pattern.findall(text))
        if path == skip:
            hits -= 1  # the definition itself
        total += max(hits, 0)
    return total


def _sources(directory: str) -> dict[Path, str]:
    """Read once and strip once: this runs against every symbol in the package."""
    return {
        path: _strip_prose(path.read_text(encoding="utf-8", errors="replace"))
        for path in sorted((ROOT / directory).rglob("*.py"))
    }


def test_every_symbol_has_a_production_caller_or_a_reason():
    production = _sources("bugpilot")
    tests = _sources("tests")

    unwired: list[str] = []
    for path in production:
        module = path.stem
        # The symbol list comes from the original source, so line numbers in the
        # failure message still point at the definition.
        source = path.read_text(encoding="utf-8", errors="replace")
        for name, line in _defined_symbols(path, source):
            if name.startswith("__"):
                continue
            key = f"{module}.{name}"
            if key in ALLOWED:
                continue
            if _references(name, production, skip=path) > 0:
                continue
            in_tests = _references(name, tests, skip=None)
            where = "used only by tests" if in_tests else "referenced nowhere at all"
            unwired.append(f"{path.relative_to(ROOT).as_posix()}:{line} {key} — {where}")

    assert not unwired, (
        "These have no production caller. Wire them in, delete them, or add them to "
        "ALLOWED with the reason:\n  " + "\n  ".join(unwired)
    )


def test_the_allowlist_itself_stays_honest():
    """An entry that has since acquired a caller should leave the list.

    Otherwise the allowlist becomes the place stale exemptions accumulate, and
    the guard quietly stops guarding — which is the failure it exists to catch.
    """
    production = _sources("bugpilot")
    still_needed = []
    for key in ALLOWED:
        module, _, name = key.partition(".")
        defining = next(
            (path for path in production if path.stem == module and re.search(rf"^\s*(def|class)?\s*{re.escape(name)}\b", production[path], re.MULTILINE)),
            None,
        )
        if defining is None:
            still_needed.append(f"{key} is on the allowlist but no longer exists")
            continue
        if _references(name, production, skip=defining) > 0:
            still_needed.append(f"{key} now has a production caller and can leave ALLOWED")
    assert not still_needed, "\n  ".join(still_needed)
