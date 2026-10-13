"""N11 and N12: the trace-line and keyword patterns, in linear time (0.1.5, plan §44.20).

Two more intake patterns were quadratic on text anyone who writes an issue can
write:

- **N11** — `jira_parse`'s trace-line pattern. Its `File ".*?"` alternative
  scanned to the end of the line from every `File "` on it; its `^\\s+at`
  alternative scanned to the end of the whitespace from every line start inside
  a run of blank lines. Replaced by `jira_parse._looks_like_trace`.
- **N12** — `keywords`' token pattern, on a long run of `_` (and digits), and
  its e-mail pattern, on long runs like `a-a-a-…` or `a.a.a.…`. Each gained an
  alternative that steps over, as one match, exactly the stretch where the
  pattern would have failed at every position; the matches it makes are
  dropped (`keywords._tokens`, `keywords._without_emails`).

What these tests hold them to, judged by the 0.1.4 patterns themselves
(`intake_reference`, run only on inputs small enough for them):

- **The same answers.** Exhaustively, over small alphabets of the characters
  and pieces that matter; on random mixes; on the named shapes; and end to end
  — every prompt-boundary corpus case and every retrieval corpus issue through
  the Jira and hand-written adapters and keyword extraction, compared with the
  0.1.4 functions put back in place.
- **Linear time.** Eight times the adversarial input takes about eight times as
  long (64 if quadratic; the bound is 24); a megabyte is quick; ordinary text
  is no slower than before.

No limit or cut was added: every token, address and trace line is found as
before; the three-trace, 80-line cap is unchanged.
"""

from __future__ import annotations

import itertools
import random
import time

import intake_reference as reference
import prompt_boundary_corpus as corpus
import prompt_boundary_sources as sources
import pytest
import retrieval_corpus

from bugpilot.core import jira_parse, keywords
from bugpilot.core.jira_parse import _extract_stack_traces, _looks_like_trace
from bugpilot.core.keywords import _tokens, _without_emails, extract_keywords, remove_noise, text_tokens
from bugpilot.core.workflow import extract_issue_keywords

LS, NEL, NBSP, VT = "\N{LINE SEPARATOR}", chr(0x85), chr(0xA0), chr(0x0B)
BT = chr(96)


def _exhaustive(alphabet, length):
    for size in range(length + 1):
        for letters in itertools.product(alphabet, repeat=size):
            yield "".join(letters)


def test_the_old_patterns_are_gone_from_the_product():
    assert not hasattr(jira_parse, "_TRACE_LINE_RE")
    assert keywords._TOKEN_RE.pattern != reference.TOKEN_RE.pattern
    assert keywords._EMAIL_RE.pattern != reference.EMAIL_RE.pattern


# --- N11: the trace-line test ---------------------------------------------------------------------------

#: Exhaustive alphabets for the trace-line test: pieces of a Python frame, and the characters of `^\s+at`.
TRACE_ALPHABETS = {
    "python-frame-pieces": (('File "', '",', '"', ",", " ", "\n", "line ", "1", "at", "x", "\t", LS), 4),
    # Whole tails as one piece, so a second `",` after a failing one, and a tail across a line break, both fit.
    "python-frame-structure": (('File "', '",', "line 1", " ", "\n", "x", LS, '"', ","), 5),
    "at-frame-characters": ((" ", "\n", "a", "t", "x", "\t", "\r", NEL), 6),
    "marks": ((".", "py", "hpp", ":", "1", "0x", "f", "Tr", "aceback", " "), 4),
}


@pytest.mark.parametrize("name", sorted(TRACE_ALPHABETS))
def test_every_short_text_is_a_trace_line_exactly_when_it_was(name):
    alphabet, length = TRACE_ALPHABETS[name]
    mismatches = [text for text in _exhaustive(alphabet, length) if _looks_like_trace(text) != reference.looks_like_trace(text)]
    assert mismatches[:5] == []


_TRACE_PIECES = ('File "', 'File "export.py", line 12, in save', '",', ' line 3', "line ", "Traceback (most recent call last):",
                 "    at Widget.run(Widget.java:42)", "at ", " at", "\n", "\n", "\r\n", " ", "  ", "\t", LS, NBSP, "x", "text",
                 "crash.cpp:17", ".h:2", "0x1F2E3D", "0x12", BT * 3, BT * 3 + "text\n", "ValueError: bad", '"', ",")


def test_random_mixes_give_the_trace_lines_and_traces_they_gave():
    rng = random.Random(20261013)
    mismatches = []
    for _ in range(30_000):
        text = "".join(rng.choice(_TRACE_PIECES) for _ in range(rng.randint(0, 30)))
        if _looks_like_trace(text) != reference.looks_like_trace(text) or \
                _extract_stack_traces(text) != reference.stack_traces(text):
            mismatches.append(text)
    assert mismatches[:3] == []


#: The shapes the N11 brief names, with what the old pattern said of each.
TRACE_SHAPES = {
    "valid-python-frame": ('  File "export.py", line 12, in save', True),
    "frame-without-space-before-line": ('File "a.py",line 3', True),
    "frame-line-on-the-next-line": ('File "a.py",\n    line 3', True),
    "file-name-holding-a-quote": ('File "a"b.py", line 3', True),
    "file-name-across-lines": ('File "a\nb.py", line 3', False),
    "no-comma": ('File "a.py" line 3', False),
    "no-line-number": ('File "a.py", line x', False),
    "unclosed-quote": ('File "a.py, line 3', False),
    "repeated-file-quote": ('File "' * 500, False),
    "repeated-file-quote-comma": ('File "a", ' * 300, False),
    "java-frame": ("    at Widget.run(Widget.java:42)", True),
    "at-frame-after-blank-lines": ("\n\n   at Widget.run(x)", True),
    "at-without-indent": ("at Widget.run(x)", False),
    "at-inside-prose": ("we looked at it", False),
    "at-after-a-line-ending-in-space": ("text \nat x", False),
    "blank-lines": ("\n" * 2_000, False),
    "spaces-and-line-breaks": (" \n" * 1_000, False),
    "traceback-word": ("Traceback (most recent call last):", True),
    "source-and-line": ("crash in widget.cpp:17", True),
    "hex-address": ("fault at 0x7FFE12", True),
    "short-hex": ("0x12", False),
    "ordinary-text": ("Export dialog forgets the chosen output format after reopening.", False),
    "line-separator-as-whitespace": (f"x{LS}   at Widget.run(x)", False),
    "crlf": ('  File "a.py",\r\n line 2', True),
}


@pytest.mark.parametrize("name", sorted(TRACE_SHAPES))
def test_each_named_shape_is_a_trace_line_exactly_when_it_was(name):
    text, was = TRACE_SHAPES[name]
    assert reference.looks_like_trace(text) is was, "the expectation is the old pattern's"
    assert _looks_like_trace(text) is was
    assert _extract_stack_traces(text) == reference.stack_traces(text)


def test_legitimate_tracebacks_are_extracted_as_before():
    python = ('The export fails:\nTraceback (most recent call last):\n  File "export.py", line 12, in save\n'
              '    writer.write(rows)\n  File "writer.py", line 40, in write\nValueError: unsupported format\nThanks.')
    java = "Crash:\n    at Widget.run(Widget.java:42)\n    at Main.main(Main.java:7)\nThat is all."
    for text in (python, java, python + "\n\n" + java):
        assert _extract_stack_traces(text) == reference.stack_traces(text)
    assert _extract_stack_traces(java) == ["at Widget.run(Widget.java:42)\n    at Main.main(Main.java:7)"]


# --- N12: tokens and e-mail addresses -------------------------------------------------------------------

#: Exhaustive alphabets: the characters the token and e-mail patterns turn on, ASCII and not.
KEYWORD_ALPHABETS = {
    "token-characters": (("_", "a", "1", ".", ":", "-", " "), 6),
    "qualified-names": (("_", "Ab", "9", ".", "::", "x-"), 5),
    "email-characters": (("a", "@", ".", "-", "+", "_", " ", "1"), 6),
    "unicode-word-characters": (("_", "é", "@", ".", "-", "A", "ж"), 5),
}


@pytest.mark.parametrize("name", sorted(KEYWORD_ALPHABETS))
def test_every_short_text_gives_the_tokens_and_drops_the_addresses_it_did(name):
    alphabet, length = KEYWORD_ALPHABETS[name]
    token_mismatches, email_mismatches = [], []
    for text in _exhaustive(alphabet, length):
        if _tokens(text) != reference.tokens(text):
            token_mismatches.append(text)
        if _without_emails(text) != reference.without_emails(text):
            email_mismatches.append(text)
    assert token_mismatches[:5] == [] and email_mismatches[:5] == []


_KEYWORD_PIECES = ("WidgetController", "Foo::bar", "module.func", "widget.cpp", "__init__", "_private", "snake_case",
                   "x86_64", "utf-8", "a-b-c", "jane.doe+tag@mail.example.invalid", "ops@build-host-01.example.invalid", "@", "a@b",
                   "https://docs.example.invalid/x?y=1", "build-host-01", "api.example.invalid", "self.test", "_", "__", "_1",
                   "-", ".", "..", "::", "+", " ", " ", "\n", "é", "Ошибка", "导出", "1.2.3", "v2026.1", "0x7f", "a.", "a-")


@pytest.mark.parametrize("seed", range(3))
def test_random_mixes_give_the_tokens_noise_and_keywords_they_gave(seed, monkeypatch):
    rng = random.Random(20261013 + seed)
    texts = ["".join(rng.choice(_KEYWORD_PIECES) for _ in range(rng.randint(0, 40))) for _ in range(4_000)]
    for text in texts:
        assert _tokens(text) == reference.tokens(text), text
        assert _without_emails(text) == reference.without_emails(text), text
    now = [(remove_noise(text), text_tokens(text), extract_keywords(text, secondary_text=text[::-1])) for text in texts[:800]]
    monkeypatch.setattr(keywords, "_tokens", reference.tokens)
    monkeypatch.setattr(keywords, "_without_emails", reference.without_emails)
    before = [(remove_noise(text), text_tokens(text), extract_keywords(text, secondary_text=text[::-1])) for text in texts[:800]]
    assert now == before


def test_addresses_and_tokens_read_as_before():
    text = ("Mail jane.doe+tag@mail.example.invalid or ops@build-host-01.example.invalid; a@b stays. See Foo::bar, module.func, "
            "widget.cpp, __init__, _private and snake_case_name; also ___ and _1_2 and x86_64.")
    assert _without_emails(text) == reference.without_emails(text)
    assert "jane.doe" not in _without_emails(text) and "a@b" in _without_emails(text)
    assert _tokens(text) == reference.tokens(text)
    assert "Foo::bar" in _tokens(text) and "module.func" in _tokens(text) and "widget.cpp" in _tokens(text)
    # As in 0.1.4: a leading `_` never starts a plain word, so `__init__` is read as `init__`, `_private` as
    # `private`, and a run of only `_` and digits gives nothing.
    assert "init__" in _tokens(text) and "private" in _tokens(text)
    assert not any(token.strip("_0123456789") == "" for token in _tokens(text))


# --- end to end: N10, N11 and N12 together, on real issue texts ----------------------------------------------


def _put_0_1_4_back(monkeypatch) -> None:
    monkeypatch.setattr(jira_parse, "_extract_stack_traces", reference.stack_traces)
    monkeypatch.setattr(keywords, "_tokens", reference.tokens)
    monkeypatch.setattr(keywords, "_without_emails", reference.without_emails)


def _corpus_reading(text: str) -> list[object]:
    comment = {"comments": [{"created": "2026-05-10T09:00:00.000+0000", "body": text}]}
    out = []
    for issue in (sources.jira_issue(description=text), sources.jira_issue(comment=comment), sources.manual_issue(text)):
        out.append((issue.signals, issue.details, extract_issue_keywords(issue, None)))
    return out


def test_every_corpus_case_reads_exactly_as_with_the_0_1_4_patterns(monkeypatch):
    """Every prompt-boundary corpus case as a Jira description, a Jira comment and a hand-written report: the
    issue's signals and details, and the keywords extracted from it, are those of the 0.1.4 patterns."""
    texts = [case.text for case in corpus.matrix_cases()]
    now = [_corpus_reading(text) for text in texts]
    _put_0_1_4_back(monkeypatch)
    assert now == [_corpus_reading(text) for text in texts]


def test_every_retrieval_corpus_issue_reads_exactly_as_with_the_0_1_4_patterns(monkeypatch):
    """The retrieval corpus's issues, through the production builders, with the keywords each case supplies:
    the search inputs (and so Recall@5 and MRR) cannot have moved."""
    cases = [*retrieval_corpus.CORPUS, *retrieval_corpus.SYNTHETIC_CORPUS]

    def reading():
        out = []
        for case in cases:
            issue = retrieval_corpus.issue_for(case)
            out.append((issue.signals, issue.details, extract_issue_keywords(issue, list(retrieval_corpus.case_options(case).keywords or []))))
        return out

    now = reading()
    _put_0_1_4_back(monkeypatch)
    assert now == reading()


# --- linear time ------------------------------------------------------------------------------------------


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


#: Adversarial shapes by size, and what reads them. An `@` is added where the e-mail pattern needs one to run.
ADVERSARIAL = {
    "N11 repeated File quote": (_looks_like_trace, lambda n: 'File "' * (n // 6)),
    "N11 repeated File quote comma": (_looks_like_trace, lambda n: 'File "a", ' * (n // 10)),
    "N11 blank lines": (_looks_like_trace, lambda n: "\n" * n),
    "N11 space and line feed": (_looks_like_trace, lambda n: " \n" * (n // 2)),
    "N11 line feed and space": (_looks_like_trace, lambda n: "\n " * (n // 2)),
    "N11 whole extraction, File quote": (_extract_stack_traces, lambda n: 'File "' * (n // 6)),
    "N12 underscores": (_tokens, lambda n: "_" * n),
    "N12 underscore digit": (_tokens, lambda n: "_1" * (n // 2)),
    "N12 a hyphen": (_without_emails, lambda n: "a-" * (n // 2) + "@"),
    "N12 a dot": (_without_emails, lambda n: "a." * (n // 2) + "@"),
    "N12 a plus": (_without_emails, lambda n: "a+" * (n // 2) + "@"),
    "N12 digit dot": (_without_emails, lambda n: "1." * (n // 2) + "@"),
    "N12 hyphen a": (_without_emails, lambda n: "-a" * (n // 2) + "@"),
    "N12 dotted hyphenated": (_without_emails, lambda n: "x.y-" * (n // 4) + "@"),
    "N12 whole extraction, underscores": (extract_keywords, lambda n: "_" * n),
}


@pytest.mark.parametrize("shape", sorted(ADVERSARIAL))
def test_eight_times_the_input_takes_about_eight_times_as_long_never_sixty_four(shape):
    """From 125,000 to 1,000,000 characters: about 8x if linear, 64x if quadratic. The bound, 24x, leaves room for
    noise and slow runners."""
    read, make = ADVERSARIAL[shape]
    small, large = make(125_000), make(1_000_000)
    ratio = _per_call(lambda: read(large)) / _per_call(lambda: read(small))
    assert ratio < 24, f"{shape}: {ratio:.1f}x for 8x the input"


@pytest.mark.parametrize("shape", sorted(ADVERSARIAL))
def test_a_megabyte_of_each_shape_is_read_quickly(shape):
    read, make = ADVERSARIAL[shape]
    text = make(1_000_000)
    start = time.perf_counter()
    read(text)
    # About 0.1 s at most on the development machine; the 0.1.4 patterns would take minutes to hours.
    assert time.perf_counter() - start < 5.0


def test_the_whole_preparation_of_hostile_text_stays_responsive():
    """N10, N11 and N12's shapes together in one issue, a quarter of a megabyte each, through the Jira adapter and
    keyword extraction: seconds at most, where 0.1.4 would take hours."""
    text = "\n".join([BT * 250_000, 'File "' * 40_000, "\n" * 250_000, "_" * 250_000, "a-" * 125_000 + "@x"])
    start = time.perf_counter()
    issue = sources.jira_issue(description=text, comment={"comments": [
        {"created": "2026-05-10T09:00:00.000+0000", "body": BT * 3 + "\n" + "\n" * 100_000 + BT * 3}]})
    extract_issue_keywords(issue, None)
    assert time.perf_counter() - start < 20.0
    # Nothing cut (the adapter folds the blank lines, as it always has): each hostile run is all there.
    for part in (BT * 250_000, 'File "' * 40_000, "_" * 250_000, "a-" * 125_000 + "@x"):
        assert part in issue.description


def test_ordinary_text_is_read_no_slower_than_with_the_0_1_4_patterns(monkeypatch):
    """The 1 MB ordinary description of the prompt-boundary corpus, through keyword extraction and the trace
    extractor: the new readers are within a small factor of the old ones on text that never troubled them."""
    text = corpus.one_megabyte_description().text

    def read():
        extract_keywords(text)
        _extract_stack_traces(text)

    now = _per_call(read, minimum=0.2)
    monkeypatch.setattr(keywords, "_tokens", reference.tokens)
    monkeypatch.setattr(keywords, "_without_emails", reference.without_emails)
    before = _per_call(lambda: (extract_keywords(text), reference.stack_traces(text)), minimum=0.2)
    assert now < before * 2 + 0.05, f"{now:.3f}s now, {before:.3f}s with the 0.1.4 patterns"
