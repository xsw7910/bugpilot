"""N10: fenced blocks in issue text, found in one linear pass (0.1.5, plan §44.19).

Stack-trace extraction (`jira_parse._extract_stack_traces`) found fenced blocks
with the pattern r"```[^\n]*\n(.*?)```" (DOTALL). On a long run of backticks
with no line break after it, the pattern tried every position of the run and
scanned from each to the end of the text: quadratic. 100,000 backticks in a
description took about 20 seconds to parse, and anyone who can write an issue's
text can write that. `jira_parse._fenced_blocks` replaced it with one pass of
`str.find`.

What these tests hold it to:

- **The same results.** The old pattern is kept in the tests
  (`intake_reference`), as the reference, and run only on inputs small
  enough for it. For every string over a small
  alphabet up to a length, for random mixes of fences, near-fences, line breaks
  and trace lines, and for the named shapes, the blocks found — spans and
  contents — and the stack traces extracted are exactly the reference's.
- **Linear time.** Growing an adversarial input eightfold grows the time about
  eightfold, never sixty-four-fold; a megabyte parses in well under a second.
  Bounds are generous for slow runners; the old pattern would take tens of
  minutes on the same input.

Nothing is cut and no limit is added: every block the pattern found is found,
and the existing cap on extracted traces (`_cap_stack_traces`, three of eighty
lines) is unchanged.
"""

from __future__ import annotations

import itertools
import random
import time

import intake_reference as reference
import prompt_boundary_corpus as corpus
import prompt_boundary_sources as sources
import pytest

from bugpilot.core import jira_parse
from bugpilot.core.jira_parse import _extract_stack_traces, _fenced_blocks

#: The pattern 0.1.4 used, as the reference for what a fenced block is (`intake_reference`). Small inputs only.
REFERENCE = reference.FENCE_RE
BT = chr(96)
FENCE = BT * 3

reference_blocks = reference.fenced_blocks
#: 0.1.4's `_extract_stack_traces` on 0.1.4's two patterns: the fence pattern and the trace-line pattern
#: (N11 replaced the second too, and is held to it in `test_intake_linear_patterns.py`).
reference_stack_traces = reference.stack_traces


def test_the_old_pattern_is_gone_from_the_product():
    assert not hasattr(jira_parse, "_FENCE_RE")
    source = open(jira_parse.__file__, encoding="utf-8").read()
    assert "re.compile(r\"```" not in source


# --- the same results ------------------------------------------------------------------------------


@pytest.mark.parametrize("alphabet, length", [((BT, "\n", "a"), 10), ((BT, "\n", "a", " "), 8), ((BT, "\n", "\r"), 9)])
def test_every_short_string_gives_the_reference_blocks_and_traces(alphabet, length):
    """Exhaustive: every string over the alphabet up to the length (88,573 / 87,381 / 29,524 strings)."""
    mismatches = []
    for size in range(length + 1):
        for letters in itertools.product(alphabet, repeat=size):
            text = "".join(letters)
            if _fenced_blocks(text) != reference_blocks(text):
                mismatches.append(text)
                if len(mismatches) > 5:
                    break
    assert mismatches == []


#: What random texts are built from: fences, near-fences, line breaks, words and trace lines.
_PIECES = (FENCE, FENCE, BT * 2, BT, BT * 4, "\n", "\n", "\r\n", "\r", " ", "a", "py", "text", FENCE + "py\n",
           "Traceback (most recent call last):\n", '  File "export.py", line 12, in save\n', "    at Widget.run(Widget.java:42)\n",
           "ValueError: bad format\n", "0xDEADBEEF ", "crash.cpp:17 ", "## Steps\n")


def test_random_mixes_of_fences_and_trace_lines_give_the_reference_results():
    rng = random.Random(20261013)
    mismatches = []
    for _ in range(20_000):
        text = "".join(rng.choice(_PIECES) for _ in range(rng.randint(0, 40)))
        if _fenced_blocks(text) != reference_blocks(text) or _extract_stack_traces(text) != reference_stack_traces(text):
            mismatches.append(text)
    assert mismatches[:3] == []


#: The shapes the N10 brief names, each small enough for the reference.
NAMED_SHAPES = {
    "empty": "",
    "long-unmatched-backtick-run": BT * 2_000,
    "backtick-runs-of-every-length": "\n".join(BT * n for n in range(1, 30)),
    "valid-fenced-python-trace": "The export fails.\n\n" + FENCE + "text\nTraceback (most recent call last):\n"
                                 '  File "export.py", line 12, in save\n    writer.write(rows)\nValueError: unsupported format\n'
                                 + FENCE + "\n\nAfter the trace.",
    "valid-fenced-java-trace": FENCE + "\nException in thread main\n    at Widget.run(Widget.java:42)\n    at Main.main(Main.java:7)\n" + FENCE,
    "two-blocks-one-trace": FENCE + "\nplain text\n" + FENCE + "\n" + FENCE + "py\n  File \"a.py\", line 1\n" + FENCE,
    "unclosed-fence": "Log:\n" + FENCE + "\nTraceback (most recent call last):\n  File \"a.py\", line 3\n",
    "opener-without-line-break": "inline " + FENCE + "code" + FENCE + " only",
    "closer-inside-a-line": FENCE + "\nfirst line ends ``" + "`here and continues",
    "info-string-holding-backticks": FENCE + "py" + FENCE + "\n  File \"a.py\", line 2\n" + FENCE,
    "nested-longer-fence": BT * 4 + "md\n" + FENCE + "\n## inner\n" + FENCE + "\n" + BT * 4,
    "repeated-near-matches": (BT * 2 + " ") * 500 + (BT * 2 + "\n") * 500,
    "openers-each-followed-by-a-line-break": (FENCE + "x\n") * 400,
    "mixed-text-and-delimiters": "a" + FENCE + "\nb" + BT + "c" + BT * 2 + "d" + FENCE + "e\n" + FENCE + "f" * 50 + "\n" + FENCE,
    "crlf-line-breaks": FENCE + "text\r\n  File \"a.py\", line 9\r\n" + FENCE + "\r\nafter",
    "trace-lines-without-fences": '  File "a.py", line 1\n  File "b.py", line 2\nnot a trace\n    at X.y(X.java:3)\n    at Y.z(Y.java:4)\n',
}


@pytest.mark.parametrize("name", sorted(NAMED_SHAPES))
def test_each_named_shape_gives_the_reference_blocks_and_traces(name):
    text = NAMED_SHAPES[name]
    assert _fenced_blocks(text) == reference_blocks(text)
    assert _extract_stack_traces(text) == reference_stack_traces(text)


def test_legitimate_stack_traces_are_still_extracted():
    traces = _extract_stack_traces(NAMED_SHAPES["valid-fenced-python-trace"])
    assert traces == ['Traceback (most recent call last):\n  File "export.py", line 12, in save\n'
                      "    writer.write(rows)\nValueError: unsupported format"]
    assert _extract_stack_traces(NAMED_SHAPES["valid-fenced-java-trace"]) == [
        "Exception in thread main\n    at Widget.run(Widget.java:42)\n    at Main.main(Main.java:7)"
    ]
    # An unclosed fence is no block: its trace lines are read as ordinary lines, as before.
    assert _extract_stack_traces(NAMED_SHAPES["unclosed-fence"]) == [
        'Traceback (most recent call last):\n  File "a.py", line 3'
    ]


def _parsed(text: str) -> list[object]:
    """Everything the Jira adapter makes of ``text`` as a description, and as a comment."""
    comment = {"comments": [{"created": "2026-05-10T09:00:00.000+0000", "body": text}]}
    return [(issue.signals, issue.details) for issue in (sources.jira_issue(description=text), sources.jira_issue(comment=comment))]


@pytest.mark.parametrize("case_id", [case.id for case in corpus.matrix_cases()])
def test_every_corpus_case_parses_exactly_as_before_as_a_description_and_as_a_comment(case_id, monkeypatch):
    """Normal and hostile issue text, end to end through the Jira adapter: every signal and parsed detail is
    the same as with the reference extractor in its place."""
    text = corpus.BY_ID[case_id].text
    now = _parsed(text)
    monkeypatch.setattr(jira_parse, "_extract_stack_traces", reference_stack_traces)
    assert now == _parsed(text)


# --- linear time ---------------------------------------------------------------------------------------


def _per_call(action, minimum: float = 0.03) -> float:
    """Seconds per call, from enough calls to take ``minimum`` seconds — the best of three such rounds."""
    calls = 1
    while True:
        start = time.perf_counter()
        for _ in range(calls):
            action()
        elapsed = time.perf_counter() - start
        if elapsed >= minimum:
            break
        calls *= 2
    best = elapsed / calls
    for _ in range(2):
        start = time.perf_counter()
        for _ in range(calls):
            action()
        best = min(best, (time.perf_counter() - start) / calls)
    return best


#: Adversarial shapes, by size. The first is N10's own; the rest are the near-misses around it.
ADVERSARIAL = {
    "backtick-run": lambda n: BT * n,
    "opener-then-text-without-a-closer": lambda n: FENCE + "\n" + "a" * n,
    "openers-without-line-breaks": lambda n: (FENCE + "a") * (n // 4),
    "double-backticks": lambda n: (BT * 2 + "a") * (n // 3),
    "openers-each-with-a-line-break": lambda n: (FENCE + "\n") * (n // 4),
    "valid-blocks": lambda n: (FENCE + "text\n  File \"a.py\", line 1\n" + FENCE + "\n") * (n // 35),
}


@pytest.mark.parametrize("shape", sorted(ADVERSARIAL))
def test_eight_times_the_input_takes_about_eight_times_as_long_never_sixty_four(shape):
    """Linear, not quadratic: from 125,000 to 1,000,000 characters the time grows about 8x (64x if quadratic).
    The bound, 24x, leaves room for noise and slow runners."""
    make = ADVERSARIAL[shape]
    small, large = make(125_000), make(1_000_000)
    ratio = _per_call(lambda: _extract_stack_traces(large)) / _per_call(lambda: _extract_stack_traces(small))
    assert ratio < 24, f"{shape}: {ratio:.1f}x for 8x the input"


@pytest.mark.parametrize("shape", sorted(ADVERSARIAL))
def test_a_megabyte_of_each_shape_is_parsed_quickly(shape):
    text = ADVERSARIAL[shape](1_000_000)
    start = time.perf_counter()
    _extract_stack_traces(text)
    # Milliseconds here; the old pattern took tens of minutes on the backtick run.
    assert time.perf_counter() - start < 2.0


def test_a_megabyte_of_backticks_through_the_whole_jira_intake_is_practical():
    """N10's reproduction end to end, at ten times the size that took 20 seconds: description and comment."""
    run = BT * 1_000_000
    start = time.perf_counter()
    issue = sources.jira_issue(description=run, comment={"comments": [
        {"created": "2026-05-10T09:00:00.000+0000", "body": run}]})
    assert time.perf_counter() - start < 10.0
    assert issue.description == run, "nothing cut"
    assert issue.signals.stack_traces == ()


def test_large_valid_input_keeps_every_block_and_the_existing_trace_cap():
    """Thousands of fenced traces: every block is found; extraction keeps three, as `_cap_stack_traces` always has."""
    block = FENCE + 'text\nTraceback (most recent call last):\n  File "a.py", line {n}\n' + FENCE + "\n"
    text = "".join(block.format(n=n) for n in range(5_000))
    start = time.perf_counter()
    blocks = _fenced_blocks(text)
    traces = _extract_stack_traces(text)
    assert time.perf_counter() - start < 2.0
    assert len(blocks) == 5_000
    assert [trace.splitlines()[1] for trace in traces] == ['  File "a.py", line 0', '  File "a.py", line 1',
                                                         '  File "a.py", line 2']
