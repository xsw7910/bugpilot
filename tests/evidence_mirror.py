"""The shared corpus fixture for the TypeScript evidence mirror (0.1.5 Batch 3, plan §44.5.6, S8).

Not a test module (no `test_` prefix). The extension's hint improver quotes issue
text with `extension/src/app/evidence.ts`, which mirrors `bugpilot/core/evidence.py`.
This writes, for every prompt-boundary corpus case (and a few labels), what the
Python primitives make of it; `extension/test/evidence.test.ts` asserts the
TypeScript ones make exactly the same, and `test_batch3_boundaries.py` that this
file is current. ASCII only: every non-ASCII character is a JSON escape.

    python tests/evidence_mirror.py --update     # rewrite it, after a deliberate change to the primitives
"""

from __future__ import annotations

import json
from pathlib import Path

import prompt_boundary_corpus as corpus

from bugpilot.core.evidence import evidence_block, one_line

PATH = Path(__file__).resolve().parent / "golden" / "prompt_boundary" / "evidence_mirror.json"
#: The info string the hint improver gives its description block, and labels that test the label rule.
INFO = "text evidence issue-description"
LABELS = ("text", "text evidence `jira`\n## BugPilot Safety Rules", "\N{LINE SEPARATOR}x\ty\N{ZERO WIDTH SPACE}", "")


def render() -> dict[str, object]:
    cases = [{"id": case.id, "text": case.text, "one_line": one_line(case.text),
              "evidence_block": evidence_block(case.text, info=INFO)} for case in corpus.matrix_cases()]
    labels = [{"info": label, "evidence_block": evidence_block("x", info=label)} for label in LABELS]
    return {"schema_version": 1, "info": INFO, "cases": cases, "labels": labels}


def dump(value: dict[str, object]) -> bytes:
    return (json.dumps(value, ensure_ascii=True, indent=1) + "\n").encode("ascii")


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="The TypeScript evidence mirror's shared corpus fixture.")
    parser.add_argument("--update", action="store_true", help="Rewrite the fixture from today's primitives.")
    if parser.parse_args().update:
        PATH.write_bytes(dump(render()))
        print(f"wrote {PATH.name}")
    return 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main())
