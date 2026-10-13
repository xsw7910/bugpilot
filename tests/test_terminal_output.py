"""Text mode never hands a terminal a control sequence (`bugpilot.core.terminal`).

An issue's words, a hand-written bug, a hint or a policy file can carry ESC
sequences (colour, cursor moves, a window title, OSC 52 clipboard writes), a
carriage return or backspace that overprints a line, or a bidirectional
override. Printed in text mode they are shown escaped; the stored files and the
JSON output stay exactly as written.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core.terminal import terminal_safe

HOSTILE = (
    "Saving crashes \x1b[31mRED\x1b[0m, title \x1b]0;pwned\x07, clipboard \x1b]52;c;ZXZpbA==\x07, "
    "CSI \x9b2J, back\x08\x08\x08space, bell\x07, nul\x00, del\x7f, form\x0cfeed, "
    "reversed ‮gnp.exe‬, isolate ⁦x⁩, then\rOVERWRITE"
)
#: What a terminal would act on — none of it may reach one.
CONTROLS = [chr(code) for code in (*range(0x00, 0x09), *range(0x0B, 0x20), *range(0x7F, 0xA0))] + [
    "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩",
]


def _raw_controls(text: str) -> list[str]:
    return sorted({f"U+{ord(c):04X}" for c in text if c in CONTROLS})


@pytest.mark.parametrize(
    ("text", "shown"),
    [
        ("\x1b[31mred\x1b[0m", "\\x1b[31mred\\x1b[0m"),
        ("\x1b]52;c;ZXZpbA==\x07", "\\x1b]52;c;ZXZpbA==\\x07"),
        ("\x9b2J", "\\x9b2J"),
        ("safe\rEVIL", "safe\\x0dEVIL"),
        ("abc\x08\x08x", "abc\\x08\\x08x"),
        ("a\x00b\x7fc", "a\\x00b\\x7fc"),
        ("file‮gnp.exe", "file\\u202egnp.exe"),
        ("x⁦y⁩", "x\\u2066y\\u2069"),
        # A Windows line ending is a line ending, not a stray carriage return.
        ("one\r\ntwo\r\n", "one\ntwo\n"),
    ],
)
def test_control_characters_are_shown_escaped(text, shown):
    assert terminal_safe(text) == shown


def test_ordinary_text_in_any_script_passes_untouched():
    ordinary = (
        "Tabs\tand\nnewlines; café and café; 保存失败；"
        " العربية עברית; Ελληνικά; emoji 👩‍💻 🇨🇦; marks ‎‏; nbsp ; € → ✓ — “quotes”"
    )
    assert terminal_safe(ordinary) == ordinary


def _prepare(monkeypatch, capsys, root: Path, *argv: str) -> str:
    monkeypatch.chdir(root)
    code = main(["bug", *argv, "--prepare-only", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 0, payload
    return payload["work_item_id"]


@pytest.fixture
def repo(tmp_path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    (root / "app.py").write_text("def save(record):\n    return record['id']\n", encoding="utf-8")
    return root


def test_context_preview_text_mode_escapes_the_issues_words_and_keeps_the_file(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo, "--description", HOSTILE, "--hint", "Look at \x1b[2Jsave")
    stored = (repo / ".ai" / work_item / "context.md").read_bytes()
    # The authoritative context keeps the issue's own characters: since 0.1.5 its evidence writes each control
    # character as a visible escape, never dropping it (D2). The hint in Guidance is the developer's, on one line
    # as typed (unchanged), so a raw control character still reaches the file — and the terminal filter below.
    assert b"<U+001B>[31mRED<U+001B>[0m" in stored and b"<U+001B>]52;c;ZXZpbA==<U+0007>" in stored
    assert b"Look at \x1b[2Jsave" in stored

    assert main(["context-preview", work_item]) == 0
    out = capsys.readouterr().out
    assert _raw_controls(out) == []
    assert "<U+001B>[31mRED<U+001B>[0m" in out and "<U+202E>gnp.exe" in out and "Look at \\x1b[2Jsave" in out
    # Presentation only: the file is untouched, and JSON still carries the text exactly.
    assert (repo / ".ai" / work_item / "context.md").read_bytes() == stored
    assert main(["context-preview", work_item, "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["text"] == stored.decode("utf-8").replace("\r\n", "\n")
    assert "<U+001B>[31mRED" in payload["text"] and "Look at \x1b[2Jsave" in payload["text"]


def test_task_preview_text_mode_escapes_a_hint_and_a_policy(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo, "--description", "Saving a record crashes", "--hint", "Look at \x1b]0;x\x07save\rEVIL")
    (repo / ".bugpilot").mkdir(exist_ok=True)
    (repo / ".bugpilot" / "instructions.md").write_text("Keep \x1b[5mblinking\x1b[0m out.\n", encoding="utf-8")
    assert main(["task-preview", work_item]) == 0
    out = capsys.readouterr().out
    assert _raw_controls(out) == []
    # The task itself carries the hint normalized — control characters dropped, a lone
    # carriage return a line break (contained, so it cannot start a section) — and the
    # instructions' own control characters are dropped as the file is read.
    assert "Look at ]0;xsave\nEVIL" in out and "Keep [5mblinking[0m out." in out


def test_every_text_command_is_covered_not_only_the_previews(repo, monkeypatch, capsys):
    """`list` prints each work item's title, taken from the issue's own words: escaped as well."""
    _prepare(monkeypatch, capsys, repo, "--description", HOSTILE)
    assert main(["list"]) == 0
    out = capsys.readouterr().out
    assert "Saving crashes" in out
    assert _raw_controls(out) == []


def test_an_error_on_stderr_is_escaped_too(repo, monkeypatch, capsys):
    monkeypatch.chdir(repo)
    assert main(["context-preview", "JR-1\x1b[2J"]) != 0
    captured = capsys.readouterr()
    assert _raw_controls(captured.out + captured.err) == []


def test_the_streams_are_put_back_after_a_command(repo, monkeypatch, capsys):
    monkeypatch.chdir(repo)
    stdout, stderr = sys.stdout, sys.stderr
    main(["context-preview"])
    assert sys.stdout is stdout and sys.stderr is stderr
    capsys.readouterr()
