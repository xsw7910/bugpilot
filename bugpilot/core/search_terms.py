"""What the repository is searched for, and how much each term is worth.

The defect this replaces was one line: ``high_value_keywords = keywords[:5]``.
The top five of the ranking became the top tier whatever they were, and
``search.py`` gave that tier weight 6. On a bug written in prose the five are
prose. Measured, before this existed:

    "The data process output is wrong and the volume is not updated correctly."
      high: ['correctly', 'data', 'process', 'output', 'volume']

    "CSV cannot be selected as the export format."
      high: ['selected', 'CSV', 'export', 'format']

``selected`` outranked ``CSV`` because length >= 8 scores a point and an
all-caps acronym scores none. Both then searched at weight 6, so the ranker was
told a filler word mattered as much as the only real term in the sentence.

A term's weight is now decided by two things it actually has — where it came
from, and whether it looks like code — and never by its position in a list.

The model is three fields because the ranker reads three fields. `kind`,
`confidence` and provenance chains were considered and left out: nothing would
have branched on them, and an unused field in a scoring path is a future
argument about what it was supposed to mean.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from .keywords import STOP_WORDS, _identifier_score, _is_identifier_shaped

TermSource = Literal[
    "issue", "hint", "user", "identifier", "phrase", "expanded", "shape_expansion"
]

# Weights. The scale is the one `search._match_weight` already used — phrase 12,
# qualified name 10, high 6, medium 2, low 1 — so the ranker's existing
# arithmetic keeps its meaning and only the *assignment* changes.
WEIGHT_PHRASE = 12
#: A stack-trace identifier or an explicit `--keywords`: the developer or the
#: crash said this, and neither is guessing.
WEIGHT_STRONG = 8
#: Looks like code — a hump, a qualifier, an underscore, a file name.
WEIGHT_IDENTIFIER = 6
#: An identifier shape built from adjacent words and then *confirmed* to exist in
#: the repository (§33.7B). Below a name somebody actually wrote, because it was
#: still assembled by a rule; above a hint, because the codebase agreed with it.
WEIGHT_SHAPE = 5
#: Hint prose. Above ordinary issue prose because the developer chose to write
#: it; below identifiers and user keywords because it is still a hypothesis.
WEIGHT_HINT = 4
#: Ordinary words from the issue that carry no code signal.
WEIGHT_PROSE = 2
#: Sub-tokens split out of compound identifiers, and anything generic.
WEIGHT_WEAK = 1

#: Words that are real English and real code at once, so they cannot be dropped
#: — but must not be mistaken for evidence. `search.MEDIUM_VALUE_KEYWORDS` has
#: carried a shorter version of this list for the ranker; this is the extraction
#: side of the same judgement.
GENERIC_PROSE = frozenset(
    {
        "data", "process", "output", "input", "value", "values", "type", "types",
        "state", "status", "name", "names", "item", "items", "list", "lists",
        "file", "files", "selected", "selection", "changing", "changed", "change",
        "correctly", "properly", "available", "enabled", "disabled", "default",
        "support", "supported", "option", "options", "setting", "settings",
        "content", "contents", "number", "count", "size", "time", "times",
        "good", "better", "useful", "needed", "related",
        # Hedges. A hint is written quickly and starts with one of these more
        # often than not; they carry none of its meaning.
        "maybe", "perhaps", "possibly", "probably", "likely", "seems", "think",
        "look", "looks", "check", "checking", "investigate", "around", "somewhere",
    }
)

#: Longest all-caps run still read as an acronym rather than shouting.
MAX_ACRONYM_LENGTH = 6


def _is_acronym(value: str) -> bool:
    """`CSV`, `OCSV`, `TIFF`, `API` — a name, with no lowercase to prove it.

    `_is_identifier_shaped` cannot see these: it looks for a camelCase hump, and
    an acronym has no lowercase at all. Measured cost of missing them: in
    "CSV cannot be selected as the export format", `CSV` weighed the same as
    `selected`. Bounded by length so a shouted sentence does not become a pile
    of identifiers.
    """
    if not (3 <= len(value) <= MAX_ACRONYM_LENGTH):
        return False
    if not value.isupper() or not value.isalnum():
        return False
    return value.lower() not in STOP_WORDS


@dataclass(frozen=True)
class SearchTerm:
    """One thing to search the repository for, and what it is worth."""

    value: str
    source: TermSource
    weight: int
    #: The phrase a shape was built from, for diagnostics. Empty for everything
    #: else: a term that was simply present in the text is its own explanation.
    derived_from: str = ""

    @property
    def key(self) -> str:
        """Case-insensitive identity. rg matches case-insensitively too."""
        return self.value.lower()


def weigh(value: str, source: TermSource, *, is_priority: bool = False) -> SearchTerm:
    """Decide what one term is worth from what it is, not where it sat.

    `is_priority` means the term came out of a stack trace or an error message —
    the highest-signal text in a bug report, because it contains names the
    software itself printed.
    """
    if source == "phrase":
        return SearchTerm(value, source, WEIGHT_PHRASE)
    if source == "expanded":
        return SearchTerm(value, source, WEIGHT_WEAK)
    if source == "user":
        # An explicit --keywords is the developer naming the term the report
        # never spelled out. It outranks anything mined from the text.
        return SearchTerm(value, source, WEIGHT_STRONG)

    identifier = _is_identifier_shaped(value) or _identifier_score(value) >= 5 or _is_acronym(value)
    if is_priority and identifier:
        return SearchTerm(value, "identifier", WEIGHT_STRONG)
    if identifier:
        return SearchTerm(value, "identifier", WEIGHT_IDENTIFIER)

    lower = value.lower()
    generic = lower in GENERIC_PROSE or lower in STOP_WORDS
    if source == "hint":
        # A hint is a hypothesis: its prose helps, but never as much as a term
        # the code or the developer's own keyword list named.
        return SearchTerm(value, source, WEIGHT_WEAK if generic else WEIGHT_HINT)
    return SearchTerm(value, source, WEIGHT_WEAK if generic else WEIGHT_PROSE)


def merge(*groups: list[SearchTerm]) -> list[SearchTerm]:
    """One term per spelling, keeping the strongest claim made for it.

    A word can arrive from the issue and the hint and the developer's own list.
    Searching it three times would spend three ripgrep invocations to learn the
    same thing, and weighting it as prose because the issue mentioned it first
    would throw away the fact that the developer typed it too.
    """
    best: dict[str, SearchTerm] = {}
    for group in groups:
        for term in group:
            current = best.get(term.key)
            if current is None or term.weight > current.weight:
                best[term.key] = term
    return sorted(best.values(), key=lambda term: (-term.weight, term.key))


#: How many terms may reach ripgrep. Each is one process with its own 20-second
#: timeout, so this is the worst-case latency bound, not a quality judgement.
#:
#: This is a deliberate *reduction*. The previous pipeline searched phrases plus
#: high-value plus normal plus expanded, and supplied keywords were prepended to
#: the high-value list — so its worst case was 5 + (20 + 5) + 10 + 8 = 48
#: invocations, up to sixteen minutes against the 20-second per-term timeout.
#: 28 is a little over half that.
MAX_SEARCHED_TERMS = 28
#: How many of that budget generated shapes may spend (§33.7B).
#:
#: Taken *out* of the total rather than added to it, so the worst case — terms
#: times the 20-second per-term timeout — is exactly what it was before this
#: feature existed. A probe that finds nothing still costs a process, so the
#: budget counts attempts, not survivors.
MAX_EXPANSION_PROBES = 8
#: How much of the base budget is held for terms bugpilot found itself.
#:
#: Eight is enough for the shapes that matter — a couple of stack-trace
#: identifiers, a file name, a quoted phrase — without meaningfully limiting a
#: developer who supplies keywords: `MAX_SUPPLIED_KEYWORDS` is 20 and the base
#: budget is 20, so this caps their contribution at 12 only when they also have
#: eight automatic terms competing for the space.
AUTOMATIC_TERM_RESERVE = 8


def terms_from_extraction(
    extracted: dict[str, object],
    *,
    user_keywords: list[str] | None = None,
    hint: str = "",
) -> list[SearchTerm]:
    """Everything worth searching for, weighed and deduplicated.

    Reads the extractor's lists rather than replacing them, because the context
    and the memory search still read them: this is a second reading of the same
    data — one that asks what each term *is* instead of which list it landed in.
    """
    from .keywords import extract_keywords  # local: keywords imports code_files, not this

    def listed(key: str) -> list[str]:
        value = extracted.get(key, [])
        return [str(item) for item in value if str(item).strip()] if isinstance(value, list) else []

    priority = {value.lower() for value in listed("priority_keywords")}

    issue_terms = [
        weigh(value, "issue", is_priority=value.lower() in priority)
        # `dropped_keywords` is deliberately not here: it is what the extractor
        # already decided not to search, and §33.3 is about weighting what is
        # searched, not widening it.
        for value in listed("high_value_keywords") + listed("normal_keywords")
    ]
    phrase_terms = [weigh(value, "phrase") for value in listed("phrase_keywords")]
    expanded_terms = [weigh(value, "expanded") for value in listed("expanded_keywords")]
    user_terms = [weigh(value.strip(), "user") for value in (user_keywords or []) if value.strip()]

    hint_terms: list[SearchTerm] = []
    if hint.strip():
        # The same extractor, deliberately: a second parser for hints would drift
        # from this one and be wrong in a different way.
        hint_extracted = extract_keywords(hint)
        hint_values = [
            str(item)
            for key in ("high_value_keywords", "normal_keywords")
            for item in hint_extracted.get(key, [])  # type: ignore[union-attr]
            if str(item).strip()
        ]
        hint_terms = [weigh(value, "hint") for value in hint_values]

    merged = merge(user_terms, phrase_terms, issue_terms, hint_terms, expanded_terms)
    return _allocate(merged, MAX_SEARCHED_TERMS - MAX_EXPANSION_PROBES)


def _allocate(merged: list[SearchTerm], budget: int) -> list[SearchTerm]:
    """Fill the base budget without letting one source empty it.

    User keywords weigh 8 and therefore sort first, so a straight truncation
    handed the whole budget to them: twenty `--keywords` left room for nothing
    else, and a `WidgetFoo::bar` from the stack trace was dropped in favour of the
    twentieth word the developer typed. That inverts what the field is for —
    Keywords is an expert *boost*, not a replacement for the automatic search.

    So automatic terms keep a reserve. It is a reserve, not a quota: when there
    are few automatic terms to hold it, the space goes back to the user rather
    than being wasted.
    """
    user = [term for term in merged if term.source == "user"]
    automatic = [term for term in merged if term.source != "user"]

    reserve = min(AUTOMATIC_TERM_RESERVE, len(automatic), budget)
    kept_user = user[: max(0, budget - reserve)]
    remaining = budget - len(kept_user)
    kept_automatic = automatic[:remaining]

    # Back into weight order, so the strongest term is still searched first and
    # the result does not depend on which bucket a term came out of.
    return sorted(kept_user + kept_automatic, key=lambda term: (-term.weight, term.key))


def shape_candidates(
    extracted: dict[str, object], *, hint: str = "", already: set[str] | None = None
) -> list[SearchTerm]:
    """Identifier shapes worth *probing*. None of them is evidence yet.

    Returned unweighted-but-typed so the caller can probe each one and admit only
    what the repository confirms. A shape nothing matches is a string this module
    made up, and must not reach a ranking.
    """
    from .keywords import extract_keywords, shape_expansions

    seen = set(already or set())
    out: list[SearchTerm] = []
    sources: list[str] = []
    value = extracted.get("shape_candidates", [])
    if isinstance(value, list):
        sources.extend(str(item) for item in value)
    if hint.strip():
        sources.extend(shape_expansions(hint))

    for candidate in sources:
        key = candidate.lower()
        if key in seen:
            # Either the text already contained it, or a case-only twin was
            # generated: the search is case-insensitive, so both would find the
            # same lines and score the same evidence twice.
            continue
        seen.add(key)
        out.append(
            SearchTerm(
                value=candidate,
                source="shape_expansion",
                weight=WEIGHT_SHAPE,
                derived_from=_phrase_for(candidate),
            )
        )
        if len(out) >= MAX_EXPANSION_PROBES:
            break
    return out


def _phrase_for(candidate: str) -> str:
    """The words a shape was built from, recovered for the diagnostics."""
    if "_" in candidate:
        return " ".join(candidate.split("_"))
    return " ".join(re.findall(r"[A-Z]?[a-z]+|[A-Z]+", candidate)).lower()
