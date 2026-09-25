"""Keyword extraction for code search.

Ranks candidate tokens by how much they look like a *code identifier*
(camelCase, PascalCase, snake_case, qualified names like ``Foo::bar`` / ``a.b``,
and file names like ``widget.cpp``) rather than by raw frequency. In a bug
report the most *frequent* words are usually generic prose ("when", "click",
"should"), while the genuinely useful token — a class in a stack trace, a
function name, a file — often appears only once. Scoring by identifier shape
floats those specific tokens into ``high_value_keywords``.

Original case is preserved so the downstream ranker in ``search.py``
(``_looks_like_specific_identifier``) can still recognise identifiers; ripgrep
matches case-insensitively regardless.
"""

from __future__ import annotations

import re
from collections import Counter

from .code_files import CODE_SUFFIXES


# Generic English + bug-report boilerplate that is never a useful search term.
# Domain nouns (button, list, tab, filter, dialog, widget, selection, ...) are
# deliberately NOT here — in a UI codebase they often match real code.
STOP_WORDS = {
    "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "from",
    "into", "of", "on", "in", "to", "with", "without", "about", "after",
    "before", "until", "while", "as", "at", "by", "per", "via",
    "be", "is", "are", "was", "were", "been", "being", "am",
    "have", "has", "had", "do", "does", "did", "done",
    "i", "it", "its", "this", "that", "these", "those", "they", "them",
    "their", "we", "our", "you", "your", "he", "she", "his", "her", "who",
    "some", "any", "all", "each", "every", "both", "either", "neither",
    "one", "two", "more", "most", "other", "another", "such", "same",
    "not", "no", "can", "cannot", "could", "would", "should", "will", "shall",
    "may", "might", "must",
    "click", "clicks", "clicked", "clicking", "open", "opens", "close",
    "closes", "show", "shows", "showing", "see", "seen", "get", "gets", "got",
    "use", "uses", "used", "using", "make", "makes", "made", "need", "needs",
    "want", "wants", "try", "tried", "run", "runs", "working",
    "happen", "happens", "happened", "appear", "appears", "occur", "occurs",
    "bug", "crash", "crashes", "error", "errors", "fail", "fails", "failed",
    "failure", "issue", "issues", "problem", "wrong", "broken", "expected",
    "actual", "reproduce", "repro", "steps", "step", "behavior", "behaviour",
    "result", "results", "description", "summary", "note", "notes", "please",
    "thanks", "following", "below", "above", "current", "currently", "version",
    "environment", "screenshot", "attached", "attachment",
    "when", "where", "what", "which", "how", "why", "also", "still", "than",
    "very", "just", "only", "there", "here", "again",
    # stack-trace / log framing words (never a useful search term)
    "traceback", "stacktrace", "exception", "raised", "caused", "recent",
    "call", "called", "calls", "line", "trace", "warning", "info", "debug",
    "last", "most", "first", "next",
}

#: The same set the search uses, so a bug naming `reader.ts` cannot produce a
#: keyword for a file the search would never open.
_CODE_EXT = CODE_SUFFIXES

# Structural / framework parts of compound identifiers that are too generic to
# search on their own (they'd match half the codebase). Used only to filter the
# lower-tier "expanded" sub-tokens, never the primary keywords.
#
# Tuned against a large Qt/C++ codebase, which is why the framework prefixes are
# here. `sample` is one such product prefix: harmless anywhere else — it only means
# an identifier part spelled "sample" is not searched on alone — and worth keeping
# rather than quietly changing the ranking of the repository this was built for.
# A per-project list belongs in configuration; that is a feature, not a fix.
_GENERIC_PARTS = {
    "qt", "widget", "dialog", "window", "view", "model", "base", "impl",
    "item", "data", "info", "util", "utils", "helper", "manager", "controller",
    "handler", "factory", "service", "object", "page", "panel", "form", "list",
    "table", "tree", "button", "label", "edit", "box", "bar", "menu", "action",
    "event", "type", "name", "value", "index", "count", "size", "flag", "mode",
    "state", "node", "proxy", "wrapper", "class", "struct", "enum", "config",
}

# Split a compound identifier into words: on . :: _ - and camelCase humps.
_SPLIT_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")

# Rank boost for tokens found in stack traces / error messages (the highest-
# signal source of real class/function/file names).
_PRIORITY_BOOST = 8

# A token: a qualified/scope-resolved/file name (Foo::bar, module.func,
# widget.cpp) OR a plain word (length >= 3).
_TOKEN_RE = re.compile(
    r"[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)+"
    r"|[A-Za-z][A-Za-z0-9_-]{2,}"
)

# Quoted strings — UI labels, messages, exact error text — searched verbatim.
# Straight single quotes are intentionally excluded (they collide with
# contractions/possessives like don't, user's); smart quotes are safe.
_PHRASE_RE = re.compile(
    r'"([^"\n]{3,80})"'
    r"|“([^”\n]{3,80})”"
    r"|‘([^’\n]{3,80})’"
)


def _identifier_score(token: str) -> int:
    """Higher = more likely a useful, specific code identifier (0 = plain prose)."""
    score = 0
    if "::" in token and all(len(part) >= 2 for part in token.split("::") if part):
        score += 6
    if "." in token:
        head, _, tail = token.rpartition(".")
        if tail.lower() in _CODE_EXT and len(head) >= 2:
            score += 6  # file name, e.g. widget.cpp
        elif len(head) >= 2 and len(tail) >= 2:
            score += 4  # qualified name, e.g. module.func
    # camelCase / PascalCase needs an *internal* capital (a hump); a single
    # leading capital ("When", "Selection") is just a sentence-initial word.
    if any(c.isupper() for c in token[1:]) and any(c.islower() for c in token):
        score += 5
    if "_" in token and any(c.isalpha() for c in token):
        score += 4  # snake_case
    if any(c.isdigit() for c in token) and any(c.isalpha() for c in token):
        score += 1
    if len(token) >= 8:
        score += 1
    return score


def _extract_phrases(text: str, max_phrases: int = 5) -> list[str]:
    """Quoted UI/error strings, deduped, in first-seen order — searched verbatim."""
    seen: dict[str, str] = {}
    for match in _PHRASE_RE.finditer(text):
        raw = match.group(1) or match.group(2) or match.group(3) or ""
        phrase = " ".join(raw.split())  # collapse internal whitespace
        if len(phrase) < 4 or not any(c.isalnum() for c in phrase):
            continue
        seen.setdefault(phrase.lower(), phrase)
        if len(seen) >= max_phrases:
            break
    return list(seen.values())


def _is_identifier_shaped(token: str) -> bool:
    """True if the token has a *structural* code signal (not merely length):
    a qualifier/scope/underscore, or an internal camelCase hump."""
    if "::" in token or "." in token or "_" in token:
        return True
    return any(c.isupper() for c in token[1:]) and any(c.islower() for c in token)


def _file_stem(token: str) -> str | None:
    """For a file-name token (widget.cpp) return its stem (widget), else None."""
    if "." in token:
        head, _, tail = token.rpartition(".")
        if tail.lower() in _CODE_EXT and len(head) >= 2:
            return head
    return None


def _split_identifier(token: str) -> list[str]:
    parts: list[str] = []
    for chunk in re.split(r"[.:_\-]+", token):
        parts.extend(_SPLIT_RE.findall(chunk))
    return parts


def _expanded_keywords(compounds: list[str], existing: set[str], max_expanded: int = 8) -> list[str]:
    """Lower-tier sub-tokens split out of compound identifiers, for recall.

    E.g. AcmeQtExportDialog -> Acme, Export (Qt/Dialog are dropped as generic).
    Excludes anything already a primary keyword, generic structural parts, and
    stop words; kept short so it broadens recall without swamping precision.
    """
    picked: dict[str, str] = {}
    for token in compounds:
        parts = _split_identifier(token)
        if len(parts) < 2:
            continue
        for part in parts:
            low = part.lower()
            if len(part) < 4 or not part.isalpha():
                continue
            if low in _GENERIC_PARTS or low in STOP_WORDS or low in existing or low in picked:
                continue
            picked[low] = part
            if len(picked) >= max_expanded:
                return list(picked.values())
    return list(picked.values())


# --- bridging prose to identifier shape ---------------------------------------
#
# The gap §33.7 measured and could not close. A report says "issue details are
# loaded" and the code says `loadIssueDetails`; a report says "output type" and
# the code says `outputType`. The words are all present and no weighting reaches
# across, because what differs is the *shape*.
#
# This bridges shape and nothing else:
#
#     issue details  ->  issueDetails, IssueDetails, issue_details
#
# and deliberately not:
#
#     issue details  ->  loadIssueDetails, IssueDetailsLoader, refreshIssueDetails
#
# Those invent a verb the report never used. A generated string is a guess, so
# every one of them has to be confirmed against the repository before it can
# affect ranking — which is what makes the guessing safe.

#: How many source phrases may be expanded. Each produces up to three shapes,
#: and each surviving shape is one more ripgrep invocation.
MAX_EXPANDED_PHRASES = 6
#: Words per phrase. Two and three cover `outputType` and
#: `processOutputSelection`; four produces strings no codebase contains.
PHRASE_MIN_WORDS = 2
PHRASE_MAX_WORDS = 3


#: Grammar, which never appears inside an identifier.
#:
#: Deliberately *not* `STOP_WORDS` or `GENERIC_PROSE`. Those lists exist to stop
#: a word being treated as evidence on its own, and the words a compound
#: identifier is made of are exactly that kind: `issue`, `output`, `type`,
#: `details`, `selection` are all in one list or the other, and
#: `issueDetails` / `outputType` are the identifiers this phase exists to find.
#: Excluding them here would have made the feature unable to do its one job.
#:
#: So only function words are blocked — enough to keep "does not work" and
#: "when using" from becoming candidates. Everything else is allowed through and
#: killed by the repository probe if the codebase does not actually use it,
#: which is a better filter than any word list.
_PHRASE_FUNCTION_WORDS = frozenset(
    {
        "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "from",
        "into", "of", "on", "in", "to", "with", "without", "about", "after",
        "before", "until", "while", "as", "at", "by", "per", "via", "than",
        "be", "is", "are", "was", "were", "been", "being", "am", "not", "no",
        "have", "has", "had", "do", "does", "did", "done", "can", "cannot",
        "could", "would", "should", "will", "shall", "may", "might", "must",
        "it", "its", "this", "that", "these", "those", "they", "them", "their",
        "we", "our", "you", "your", "he", "she", "his", "her", "who", "which",
        "when", "where", "what", "how", "why", "there", "here", "also", "still",
        "very", "just", "only", "some", "any", "all", "each", "every", "both",
        "using", "used", "please", "again", "such", "same", "other", "another",
    }
)


def _is_phrase_word(value: str) -> bool:
    """Whether a token may take part in a phrase.

    Already-compound tokens are excluded: `VolumeDescriptor` is a shape, not a
    word to build one from.
    """
    if len(value) < 3 or not value.isalpha():
        return False
    if value.lower() in _PHRASE_FUNCTION_WORDS:
        return False
    return not _is_identifier_shaped(value)


def candidate_phrases(text: str) -> list[list[str]]:
    """Adjacent runs of meaningful words, longest first.

    Adjacency is the whole heuristic, and it is enough: `outputType` comes from
    "output type" being next to each other in the sentence. Anything cleverer
    would be a parser, and the repository probe is the real filter.
    """
    phrases: list[list[str]] = []
    for sentence in re.split(r"[.!?;:\n]", text):
        words = [word for word in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", sentence)]
        run: list[str] = []
        for word in words:
            if _is_phrase_word(word):
                run.append(word)
                continue
            phrases.extend(_windows(run))
            run = []
        phrases.extend(_windows(run))
    # Longest first: `processOutputSelection` is a better lead than `outputType`,
    # and the budget should be spent on the more specific one.
    seen: set[tuple[str, ...]] = set()
    ordered: list[list[str]] = []
    for phrase in sorted(phrases, key=len, reverse=True):
        key = tuple(word.lower() for word in phrase)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(phrase)
    return ordered[:MAX_EXPANDED_PHRASES]


def _windows(run: list[str]) -> list[list[str]]:
    out: list[list[str]] = []
    for size in range(PHRASE_MIN_WORDS, PHRASE_MAX_WORDS + 1):
        for start in range(len(run) - size + 1):
            out.append(run[start : start + size])
    return out


def identifier_shapes(words: list[str]) -> list[str]:
    """camelCase, PascalCase and snake_case, and nothing invented.

    Case-only variants are not both returned: the search is case-insensitive, so
    `outputType` and `OutputType` find exactly the same lines, and searching both
    would spend two processes to score one piece of evidence twice.
    """
    parts = [word.lower() for word in words]
    camel = parts[0] + "".join(part.capitalize() for part in parts[1:])
    snake = "_".join(parts)
    return [camel, snake]


def shape_expansions(text: str) -> list[str]:
    """Every identifier shape worth trying for one piece of text."""
    shapes: list[str] = []
    seen: set[str] = set()
    for phrase in candidate_phrases(text):
        for shape in identifier_shapes(phrase):
            if shape.lower() in seen:
                continue
            seen.add(shape.lower())
            shapes.append(shape)
    return shapes


def extract_keywords(text: str, max_keywords: int = 15, priority_text: str = "") -> dict[str, object]:
    """Rank keywords from ``text``. Tokens that also appear in ``priority_text``
    (stack traces / error messages) are boosted so they lead the ranking."""
    best: dict[str, str] = {}   # lowercased key -> best original casing seen
    freq: Counter[str] = Counter()
    priority: set[str] = set()

    def add(token: str, is_priority: bool = False) -> None:
        base = token.strip("._:-")
        if len(base) < 3:
            return
        low = base.lower()
        if low in STOP_WORDS and not _is_identifier_shaped(base):
            return
        freq[low] += 1
        prev = best.get(low)
        # Prefer a variant that carries case information (an identifier signal).
        if prev is None or (any(c.isupper() for c in base) and not any(c.isupper() for c in prev)):
            best[low] = base
        if is_priority:
            priority.add(low)

    for token in _TOKEN_RE.findall(text):
        add(token)
        stem = _file_stem(token)
        if stem:
            add(stem)  # also search the class/name, not just the file reference
    # Identifiers from stack traces / error messages are the strongest signal.
    for token in _TOKEN_RE.findall(priority_text):
        add(token, is_priority=True)
        stem = _file_stem(token)
        if stem:
            add(stem, is_priority=True)

    def sort_key(low: str) -> tuple[int, int]:
        boost = _PRIORITY_BOOST if low in priority else 0
        return (_identifier_score(best[low]) + boost, freq[low])

    ranked = sorted(best, key=sort_key, reverse=True)
    keywords = [best[low] for low in ranked]
    compounds = [best[low] for low in ranked if _identifier_score(best[low]) >= 5]
    return {
        # The five original lists, unchanged: the context prints them and the
        # memory search scores with them. The tiering here is still positional,
        # and §33.3 is why nothing downstream weights by it any more —
        # `search_terms.py` decides worth from the term itself.
        "high_value_keywords": keywords[:5],
        "normal_keywords": keywords[5:max_keywords],
        "dropped_keywords": keywords[max_keywords:],
        "phrase_keywords": _extract_phrases(text),
        "expanded_keywords": _expanded_keywords(compounds, existing=set(best)),
        # Which of them the software itself printed, in a stack trace or an
        # error message. The strongest signal a report carries, and the one
        # thing the five lists above cannot express.
        "priority_keywords": [best[low] for low in ranked if low in priority],
        # Identifier shapes built from adjacent words (§33.7B). Candidates only:
        # each is a guess until the repository confirms it, which `search.py`
        # does before any of them can affect a ranking.
        "shape_candidates": shape_expansions(text),
    }
