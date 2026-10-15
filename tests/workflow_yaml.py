"""A strict reader for the YAML subset this repository's GitHub workflows are written in.

The release-workflow tests (`test_release_workflow.py`) need the workflows'
structure, and the test environment has no YAML library: none is a dependency,
and two small files are not worth adding one. This reads block mappings and
sequences (a sequence may sit at its key's indentation), plain and quoted
scalars, flow sequences of scalars, comments, and `|` / `>` block scalars. It
raises `WorkflowYamlError` on anything else — anchors, aliases, tags, flow
mappings, multi-line plain scalars, tabs, duplicate keys, documents markers, and
a plain scalar holding `": "` (which YAML reads as a mapping, and GitHub rejects)
— so a workflow written outside the subset fails the tests instead of being
misread. Scalars stay strings: `true` is `"true"`.
"""

from __future__ import annotations

import re
from typing import NamedTuple

_KEY = re.compile(r"""(?P<key>"[^"]*"|'[^']*'|[A-Za-z0-9_][A-Za-z0-9_./-]*)[ ]*:(?:[ ]+(?P<rest>.*))?""")
_BLOCK_SCALAR = re.compile(r"[|>][+-]?")


class WorkflowYamlError(ValueError):
    """The text is not in the subset this reader understands."""


class _Line(NamedTuple):
    index: int
    indent: int
    content: str


def load(text: str):
    """The document as dicts, lists and strings."""
    if "\t" in text:
        raise WorkflowYamlError("tabs are not allowed")
    parser = _Parser(text.splitlines())
    start = parser.peek()
    if start is None:
        return None
    value = parser.block(start.indent)
    left = parser.peek()
    if left is not None:
        raise WorkflowYamlError(f"line {left.index + 1}: unexpected content at indentation {left.indent}")
    return value


def _unquote(token: str, line: int) -> str:
    if token.startswith("'"):
        return token[1:-1].replace("''", "'")
    if token.startswith('"'):
        if "\\" in token:
            raise WorkflowYamlError(f"line {line}: escapes in double-quoted scalars are not supported")
        return token[1:-1]
    return token


class _Parser:
    def __init__(self, lines: list[str]) -> None:
        self.lines = list(lines)
        self.i = 0

    def peek(self) -> _Line | None:
        """The next line with content (not blank, not a comment), without consuming it."""
        j = self.i
        while j < len(self.lines):
            raw = self.lines[j].rstrip(" ")
            content = raw.lstrip(" ")
            if content and not content.startswith("#"):
                if content in ("---", "...") or content.startswith("%"):
                    raise WorkflowYamlError(f"line {j + 1}: document markers and directives are not supported")
                return _Line(j, len(raw) - len(content), content)
            j += 1
        return None

    def block(self, indent: int):
        line = self.peek()
        if line is None or line.indent != indent:
            raise WorkflowYamlError(f"line {(line.index + 1) if line else 'end'}: expected a block at indentation {indent}")
        if line.content == "-" or line.content.startswith("- "):
            return self.sequence(indent)
        return self.mapping(indent)

    def mapping(self, indent: int) -> dict:
        result: dict = {}
        while True:
            line = self.peek()
            if line is None or line.indent < indent:
                return result
            if line.indent > indent:
                raise WorkflowYamlError(f"line {line.index + 1}: unexpected indentation")
            if line.content == "-" or line.content.startswith("- "):
                return result  # a sequence at the parent key's indentation ends here
            match = _KEY.fullmatch(line.content)
            if match is None:
                raise WorkflowYamlError(f"line {line.index + 1}: not a `key: value` line: {line.content!r}")
            key = _unquote(match.group("key"), line.index + 1)
            if key in result:
                raise WorkflowYamlError(f"line {line.index + 1}: duplicate key {key!r}")
            self.i = line.index + 1
            rest = match.group("rest")
            if rest is None or rest.startswith("#"):
                child = self.peek()
                if child is not None and (child.indent > indent or (child.indent == indent and (child.content == "-" or child.content.startswith("- ")))):
                    result[key] = self.block(child.indent)
                else:
                    result[key] = None
            else:
                result[key] = self.inline(rest, indent, line.index + 1)

    def sequence(self, indent: int) -> list:
        items: list = []
        while True:
            line = self.peek()
            if line is None or line.indent < indent:
                return items
            if line.indent > indent:
                raise WorkflowYamlError(f"line {line.index + 1}: unexpected indentation")
            if not (line.content == "-" or line.content.startswith("- ")):
                return items
            rest = line.content[1:].lstrip(" ")
            offset = len(line.content) - len(rest)
            if not rest or rest.startswith("#"):
                self.i = line.index + 1
                child = self.peek()
                if child is None or child.indent <= indent:
                    raise WorkflowYamlError(f"line {line.index + 1}: empty sequence items are not supported")
                items.append(self.block(child.indent))
            elif _KEY.fullmatch(rest):
                # `- key: value` opens a mapping whose keys line up with `key`.
                self.lines[line.index] = " " * (indent + offset) + rest
                items.append(self.mapping(indent + offset))
            else:
                self.i = line.index + 1
                items.append(self.inline(rest, indent, line.index + 1))

    def inline(self, rest: str, indent: int, number: int):
        """A value written after `key:` or `- `."""
        if _BLOCK_SCALAR.fullmatch(rest):
            return self.block_scalar(rest, indent)
        if rest[0] in "&*!?%@`":
            raise WorkflowYamlError(f"line {number}: {rest[0]!r} (anchors, aliases, tags) is not supported")
        if rest[0] == "{":
            value = self.flow_mapping(rest, number)
        elif rest[0] == "[":
            end = rest.find("]")
            tail = rest[end + 1:].strip() if end >= 0 else "x"
            if end < 0 or (tail and not tail.startswith("#")):
                raise WorkflowYamlError(f"line {number}: a flow sequence must end on its line")
            items = [item.strip() for item in rest[1:end].split(",") if item.strip()]
            value = [self.scalar(item, number) for item in items]
        else:
            value = self.scalar(rest, number)
        following = self.peek()
        if following is not None and following.indent > indent and not (following.content == "-" or following.content.startswith("- ")):
            raise WorkflowYamlError(f"line {following.index + 1}: multi-line plain scalars are not supported")
        return value

    def scalar(self, token: str, number: int) -> str:
        if token[0] in "'\"":
            close = token.find(token[0], 1)
            while token[0] == "'" and close >= 0 and token[close + 1:close + 2] == "'":
                close = token.find("'", close + 2)
            if close < 0:
                raise WorkflowYamlError(f"line {number}: unterminated quoted scalar")
            tail = token[close + 1:].strip()
            if tail and not tail.startswith("#"):
                raise WorkflowYamlError(f"line {number}: text after a quoted scalar")
            return _unquote(token[:close + 1], number)
        comment = token.find(" #")
        value = (token[:comment] if comment >= 0 else token).strip()
        if ": " in value or value.endswith(":"):
            raise WorkflowYamlError(f"line {number}: a plain scalar holding ': ' is read as a mapping: {value!r}")
        return value

    def flow_mapping(self, token: str, number: int) -> dict:
        """`{ key: scalar, key: scalar }` on one line — no nesting, no comma inside a value."""
        end = token.find("}")
        tail = token[end + 1:].strip() if end >= 0 else "x"
        if end < 0 or (tail and not tail.startswith("#")) or "{" in token[1:end] or "[" in token[1:end]:
            raise WorkflowYamlError(f"line {number}: only a one-line flow mapping of scalars is supported")
        result: dict = {}
        for pair in (part.strip() for part in token[1:end].split(",")):
            if not pair:
                continue
            match = _KEY.fullmatch(pair)
            if match is None or match.group("rest") is None:
                raise WorkflowYamlError(f"line {number}: not a `key: value` pair in a flow mapping: {pair!r}")
            key = _unquote(match.group("key"), number)
            if key in result:
                raise WorkflowYamlError(f"line {number}: duplicate key {key!r}")
            result[key] = self.scalar(match.group("rest"), number)
        return result

    def block_scalar(self, indicator: str, indent: int) -> str:
        """`|` keeps line breaks, `>` folds lines into spaces; either way, the text without its indentation."""
        start = self.i
        j = start
        body: list[str] = []
        content_indent = None
        while j < len(self.lines):
            raw = self.lines[j].rstrip(" ")
            stripped = raw.lstrip(" ")
            if stripped:
                this = len(raw) - len(stripped)
                if this <= indent:
                    break
                if content_indent is None:
                    content_indent = this
                elif this < content_indent:
                    raise WorkflowYamlError(f"line {j + 1}: a block scalar's line is less indented than its first")
                body.append(raw[content_indent:])
            else:
                body.append("")
            j += 1
        while body and not body[-1]:
            body.pop()
        self.i = j
        if indicator.startswith(">"):
            paragraphs, current = [], []
            for line in body:
                if line:
                    current.append(line)
                else:
                    paragraphs.append(" ".join(current))
                    current = []
            paragraphs.append(" ".join(current))
            return "\n".join(p for p in paragraphs)
        return "\n".join(body)


def check_names(workflow: dict) -> list[str]:
    """Every check name a workflow's jobs report: each job's `name`, once per matrix combination."""
    names = []
    for job_id, job in workflow["jobs"].items():
        template = job.get("name") or job_id
        matrix = ((job.get("strategy") or {}).get("matrix")) or {}
        combos: list[dict] = [{}]
        if "include" in matrix:
            combos = list(matrix["include"])
        else:
            for key, values in matrix.items():
                combos = [{**combo, key: value} for combo in combos for value in values]
        for combo in combos:
            name = template
            for key, value in combo.items():
                name = name.replace("${{ matrix.%s }}" % key, value)
            if "${{" in name:
                raise WorkflowYamlError(f"job {job_id}: unresolved expression in its name: {name}")
            names.append(name)
    return names
