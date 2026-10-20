"""Every text source BugPilot hands an agent, classified, and how to place a string in it (0.1.5 Batch 0).

Not a test module (no `test_` prefix). The source classification matrix of plan
§44.2.A and §44.3, written down for the tests: for each source, its trust
class, the documents it enters (`task.md`, `context.md`, the retry prompt, the
handoff, the MCP path), the 0.1.4 code that puts it there and what that code
does to it today. It decides nothing in the product: it is for the tests and
the plan.

Each source that outside text can reach has an *injector*: a function that
renders the documents the source enters with a given string in that source,
through the product's own code — the Jira and hand-written adapters,
`build_context`, `generate_task`, the retry prompt builder — and nothing else.
`prompt_boundary_baseline` places every corpus case in every source and asks
the oracles what became of it.

The trust classes are the plan's: `protected` (BugPilot's own rules),
`editable` (instructions the developer or team give on purpose; they instruct),
`evidence` (material about the bug; it never instructs, whoever wrote it),
`ai-output` (what an agent wrote before; a claim to check) and `metadata`.
"""

from __future__ import annotations

import copy
import os
import shutil
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import _isolation
from bugpilot.core.ai_behavior import render_document as render_ai_behavior
from bugpilot.core.ai_behavior import resolve_ai_behavior
from bugpilot.core.context import build_context
from bugpilot.core.fix_modes import STANDARD_FIX, FixMode
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.instructions import load_instructions
from bugpilot.core.issue import IssueArtifact, IssueGuidance, issue_from_jira, issue_from_spec
from bugpilot.core.memory import search_memory
from bugpilot.core.project_settings import resolve_project_settings
from bugpilot.core.prompts import generate_task
from bugpilot.core.repository_profile import resolve_repository_context
from bugpilot.core.retrieval import RelatedFile, RetrievalArtifact, Snippet
from bugpilot.core.user_config import CONFIG_DIR_ENV
from bugpilot.core.verification import render_document as render_verification
from bugpilot.core.workflow import _build_retry_prompt, extract_issue_keywords

ISSUE_KEY = "JR-12345"
TASK_TITLE = "Export dialog forgets the chosen output format"
#: The documents a source can enter, as the matrix names them.
DOCUMENTS = ("task.md", "context.md", "retry", "handoff", "mcp")
TRUST_CLASSES = ("protected", "editable", "evidence", "ai-output", "metadata")

#: A Jira issue as the fetch step records it: ordinary, synthetic.
BASE_PAYLOAD: dict[str, object] = {
    "key": ISSUE_KEY,
    "fields": {
        "summary": TASK_TITLE,
        "description": "Export dialog forgets the chosen output format after reopening.",
        "issuetype": {"name": "Bug"},
        "status": {"name": "Open"},
        "priority": {"name": "High"},
        "labels": ["export"],
        "environment": "Windows 11, build 2026.1",
        "comment": {"comments": [{"created": "2026-05-10T09:00:00.000+0000", "body": "Still broken on 2026.1."}]},
        "attachment": [
            {"filename": "export.log", "mimeType": "text/plain", "size": 120, "created": "2026-05-10T09:00:00.000+0000"}
        ],
    },
}

#: Code search as `retrieval.json` records it: one ranked file with two matched lines.
TYPICAL_RETRIEVAL = RetrievalArtifact(
    confidence="medium",
    reasons=("The top file matches two issue terms.",),
    related_files=(
        RelatedFile(
            file="src/export/format_selector.py",
            documentation=False,
            score=42,
            confidence="medium",
            match_count=2,
            matched_keywords=("format", "export"),
            snippets=(Snippet(12, "def remember_format(dialog, fmt):"), Snippet(18, "    dialog.format = fmt")),
        ),
    ),
)

_REPOSITORY_FILES = {
    "pyproject.toml": '[project]\nname = "sample-export"\nversion = "0.1.0"\n',
    "src/export/format_selector.py": '"""The export dialog\'s output format selector."""\n',
}
_FIX_REPORT = (
    "# Fix Report: JR-12345\n\n## Summary\n\nThe selector reset the format on reopen.\n\n"
    "## Analysis\n\nThe dialog rebuilt its state.\n\n## Changes\n\n- Kept the chosen format.\n\n"
    "## Verification\n\n- Ran the export tests.\n\n## Review Notes\n\n- None.\n"
)
_FEEDBACK = "# User Feedback: JR-12345\n\n## Required Next Attempt\n\nKeep the change, and add a test for it.\n"


class Workspace:
    """A synthetic repository and user configuration, and the product's renderers over them.

    Every renderer runs inside `configured()`, and the workspace refuses to
    exist outside the test isolation (plan §11.1): module-scoped fixtures build
    it before any per-test fixture runs.
    """

    def __init__(self, base: Path) -> None:
        _isolation.require_isolated()
        self.root = base / "repo"
        self.config = base / "config"
        self.config.mkdir(parents=True, exist_ok=True)
        for relative, text in _REPOSITORY_FILES.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8", newline="\n")
        with self.configured():
            self.repository = resolve_repository_context(self.root)

    @contextmanager
    def configured(self) -> Iterator[None]:
        """BugPilot's data folder pointed at this workspace's own, for the duration.

        Since 0.1.6 Batch 2B-2 the user configuration is ``config/`` in the data
        folder (``BUGPILOT_HOME``), so the workspace's is ``<base>/data/config``.
        """
        previous = os.environ.get("BUGPILOT_HOME")
        os.environ["BUGPILOT_HOME"] = str(self.root.parent / "data")
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("BUGPILOT_HOME", None)
            else:
                os.environ["BUGPILOT_HOME"] = previous

    def reset(self) -> None:
        for path in (self.root / ".bugpilot", self.root / ".ai", self.root / ".ai_memory"):
            shutil.rmtree(path, ignore_errors=True)
        (self.root.parent / "data" / "config" / "instructions.md").unlink(missing_ok=True)

    def _write(self, path: Path, text: str) -> None:
        """Bytes as given: a CR or a U+2028 reaches the product as the file holds it."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))

    # --- task.md ------------------------------------------------------------------------------

    def task(
        self,
        *,
        hint: str | None = None,
        fix_mode: FixMode = STANDARD_FIX,
        attachments: tuple[str, ...] = (),
        notes: dict[str, str] | None = None,
        project: str | None = None,
        user: str | None = None,
        ai_behavior: str | None = None,
        verification: str | None = None,
    ) -> str:
        """`task.md` through `generate_task`, with each layer read from its file as a run reads it."""
        self.reset()
        if project is not None:
            self._write(self.root / ".bugpilot" / "instructions.md", project)
        if user is not None:
            self._write(self.root.parent / "data" / "config" / "instructions.md", user)
        if ai_behavior is not None:
            self._write(self.root / ".bugpilot" / "ai_behavior.md", render_ai_behavior(ai_behavior))
        if verification is not None:
            self._write(self.root / ".bugpilot" / "verification.md", render_verification(verification))
        with self.configured():
            return generate_task(
                ISSUE_KEY,
                TASK_TITLE,
                hint=hint,
                attachments=list(attachments),
                fix_mode=fix_mode,
                attachment_notes=notes or {},
                repository=self.repository,
                instructions=load_instructions(self.root),
                project_settings=resolve_project_settings(self.root),
                ai_behavior=resolve_ai_behavior(self.root),
            )

    # --- context.md ---------------------------------------------------------------------------

    def context(
        self,
        issue: IssueArtifact,
        *,
        supplied_keywords: list[str] | None = None,
        retrieval: RetrievalArtifact | None = TYPICAL_RETRIEVAL,
        similar_fixes: str | None = None,
    ) -> str:
        """`context.md` through `build_context`, with the keywords a run extracts (and any supplied)."""
        keywords = extract_issue_keywords(issue, supplied_keywords)
        return build_context(issue, keywords, retrieval, similar_fixes=similar_fixes)

    def similar_fixes(self, heading: str) -> str:
        """The Similar fixes report `memory.search_memory` renders, over one stored memory."""
        self.reset()
        self._write(
            self.root / ".ai_memory" / "bugs" / "JR-11111.md",
            f"# JR-11111: {heading}\n\nFixed in src/export/format_selector.py: the format was reset.\n",
        )
        with self.configured():
            _matched, report, _results = search_memory(self.root, "export format", terms=["export", "format"])
        return report

    # --- the retry prompt ---------------------------------------------------------------------

    def retry(self, *, feedback: str = _FEEDBACK, report: str = _FIX_REPORT, fix_mode: FixMode = STANDARD_FIX) -> str:
        """`agent_retry_prompt.md` through the retry builder, from the two files it reads."""
        self.reset()
        target = self.root / ".ai" / ISSUE_KEY
        self._write(target / "user_feedback.md", feedback)
        self._write(target / "fix_report.md", report)
        # Inside the workspace's configuration: the builder resolves Fix Modes,
        # which reads the user configuration folder (plan §11.1).
        with self.configured():
            return _build_retry_prompt(self.root, ISSUE_KEY, fix_mode=fix_mode)


def jira_issue(**fields: object) -> IssueArtifact:
    """The base Jira issue with some fields replaced, normalized as the fetch step normalizes it."""
    payload = copy.deepcopy(BASE_PAYLOAD)
    payload["fields"].update(fields)  # type: ignore[union-attr]
    return issue_from_jira(payload, ISSUE_KEY, IssueGuidance())


def manual_issue(description: str, title: str | None = "Chosen format is lost on reopen", hint: str | None = None) -> IssueArtifact:
    """A hand-written bug through the same adapter a run uses, with a fixed id."""
    spec = bug_spec_from_description(description, title=title, now=datetime(2026, 1, 1, 9, 0, 0))
    return issue_from_spec(spec, IssueGuidance(hint=hint))


def _custom_mode(**fields: str) -> FixMode:
    base = dict(
        id="team-mode", name="Team Mode", description="A team's own mode.", objective="Fix the bug.",
        investigation="Read the code.", implementation="Change the selector.", verification="Run the tests.",
        constraints="Stay small.", completion="Write the report.", source="project",
    )
    base.update(fields)
    return FixMode(**base)  # type: ignore[arg-type]


#: An injector renders the documents a source enters with ``text`` in that source.
Injector = Callable[[Workspace, str], dict[str, str]]


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    trust_class: str
    #: Where it enters (`DOCUMENTS`).
    enters: tuple[str, ...]
    #: The 0.1.4 code that puts it there.
    product_path: str
    #: What that code does to it today.
    treatment: str
    #: The plan's finding ids (§44.2.A).
    findings: tuple[str, ...] = ()
    #: None: outside text cannot reach it, or a dedicated test covers it (`covered_by`).
    inject: Injector | None = None
    covered_by: str = ""
    #: The text the clean reference render uses, when the placeholder sentence does not fit.
    placeholder: str = ""

    def applies(self, text: str) -> bool:
        """Whether a corpus string can occur in this source at all."""
        if self.id == "attachment_name":
            # A file name: no separator or NUL can be part of one.
            return not any(character in text for character in "/\\\x00") and len(text) < 255
        return True


def _task(**kwargs: object) -> Injector:
    def inject(workspace: Workspace, text: str) -> dict[str, str]:
        return {"task.md": workspace.task(**{key: (text if value is _TEXT else value) for key, value in kwargs.items()})}  # type: ignore[arg-type]
    return inject


_TEXT = object()


def _hint(workspace: Workspace, text: str) -> dict[str, str]:
    return {
        "task.md": workspace.task(hint=text),
        "context.md": workspace.context(manual_issue("The export dialog forgets the format.", hint=text)),
    }


def _fix_mode_sections(workspace: Workspace, text: str) -> dict[str, str]:
    return {"task.md": workspace.task(fix_mode=_custom_mode(implementation=text))}


def _fix_mode_name(workspace: Workspace, text: str) -> dict[str, str]:
    mode = _custom_mode(name=text)
    return {"task.md": workspace.task(fix_mode=mode), "retry": workspace.retry(fix_mode=mode)}


def _attachment_name(workspace: Workspace, text: str) -> dict[str, str]:
    # The names as a folder listing returns them (`attachments.attachment_names`):
    # what a POSIX checkout can hold. test_file_safety_baseline makes the real file.
    return {"task.md": workspace.task(attachments=(text,))}


def _attachment_note(workspace: Workspace, text: str) -> dict[str, str]:
    return {"task.md": workspace.task(attachments=("export.log",), notes={"export.log": text})}


def _context_of(issue_factory: Callable[[str], IssueArtifact]) -> Injector:
    def inject(workspace: Workspace, text: str) -> dict[str, str]:
        return {"context.md": workspace.context(issue_factory(text))}
    return inject


def _keyword(workspace: Workspace, text: str) -> dict[str, str]:
    return {"context.md": workspace.context(jira_issue(), supplied_keywords=[text])}


def _snippet(workspace: Workspace, text: str) -> dict[str, str]:
    # Ripgrep reports one match per `\n` line, keeping any CR or U+2028 inside it.
    snippets = tuple(Snippet(10 + index, line) for index, line in enumerate(text.split("\n")))
    retrieval = RetrievalArtifact(
        confidence="medium",
        reasons=("The top file matches two issue terms.",),
        related_files=(
            RelatedFile(file="src/export/format_selector.py", documentation=False, score=42, confidence="medium",
                        match_count=len(snippets), snippets=snippets),
        ),
    )
    return {"context.md": workspace.context(jira_issue(), retrieval=retrieval)}


def _search_reason(workspace: Workspace, text: str) -> dict[str, str]:
    # A failed search's reason quotes ripgrep's error output (search.py), which can run over lines.
    retrieval = RetrievalArtifact(
        confidence="low", reasons=(f"Search failed for keyword `Widget`: {text}",), related_files=()
    )
    return {"context.md": workspace.context(jira_issue(), retrieval=retrieval)}


def _similar_fix(workspace: Workspace, text: str) -> dict[str, str]:
    return {"context.md": workspace.context(jira_issue(), similar_fixes=workspace.similar_fixes(text))}


def _user_feedback(workspace: Workspace, text: str) -> dict[str, str]:
    return {"retry": workspace.retry(feedback=text)}


def _fix_report(workspace: Workspace, text: str) -> dict[str, str]:
    return {"retry": workspace.retry(report=text)}


def _adf(text: str) -> dict[str, object]:
    """Jira Cloud's description shape: one paragraph, one text node."""
    return {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


def _comment(text: str) -> IssueArtifact:
    return jira_issue(comment={"comments": [{"created": "2026-05-10T09:00:00.000+0000", "body": text}]})


def _jira_attachment(text: str) -> IssueArtifact:
    return jira_issue(attachment=[{"filename": text, "mimeType": "text/plain", "size": 120,
                                   "created": "2026-05-10T09:00:00.000+0000"}])


SOURCES: tuple[Source, ...] = (
    # --- protected ----------------------------------------------------------------------------
    Source("protected_rules", "BugPilot protected rules", "protected", ("task.md", "retry"),
           "protected_rules.py, prompts.generate_task, workflow._build_retry_prompt",
           "fixed text, each rule stated once", covered_by="test_protected_rules.py"),
    Source("handoff", "Handoff sentences, review prompt, MCP next_step", "protected", ("handoff", "mcp"),
           "handoff.py, agent_runner.py, mcp_server._next_step", "fixed text plus a validated id",
           covered_by="test_handoff.py"),
    # --- editable instructions ----------------------------------------------------------------
    Source("project_instructions", "Project / Team Instructions", "editable", ("task.md",),
           "instructions.load_instructions -> instruction_section", "normalized and contained (contained_markdown)",
           ("N1",), _task(project=_TEXT)),
    Source("user_instructions", "User Instructions", "editable", ("task.md",),
           "instructions.load_instructions -> instruction_section", "normalized and contained", ("N1",),
           _task(user=_TEXT)),
    Source("ai_behavior", "AI Behavior additions", "editable", ("task.md",),
           "ai_behavior.resolve_ai_behavior -> prompts", "front matter parsed; additions normalized and contained",
           ("N1",), _task(ai_behavior=_TEXT)),
    Source("verification_policy", "Verification Policy file", "editable", ("task.md",),
           "verification.resolve -> prompts", "body normalized and contained", ("N1",), _task(verification=_TEXT)),
    Source("fix_mode_sections", "Fix Mode sections (custom)", "editable", ("task.md",),
           "fix_modes validation -> prompts._fix_mode_section", "headings refused by validation; normalized and contained",
           ("N1",), _fix_mode_sections),
    Source("fix_mode_name", "Fix Mode name (custom)", "editable", ("task.md", "retry", "context.md"),
           "prompts, workflow._build_retry_prompt", "collapsed to one line", (), _fix_mode_name,
           placeholder="Placeholder Mode"),
    Source("developer_hint", "Developer Hint", "editable", ("task.md", "context.md"),
           "prompts (Developer Hint), context.py (Guidance)", "task.md: normalized and contained; context.md: one line",
           ("N1",), _hint),
    Source("user_feedback", "user_feedback.md", "editable", ("retry",),
           "workflow._build_retry_prompt (Developer Feedback)", "raw, cut at 3,000", (), _user_feedback),
    # --- evidence -----------------------------------------------------------------------------
    Source("jira_title", "Jira summary", "evidence", ("context.md", "mcp"),
           "issue.issue_from_jira -> context.py (- Summary:)", "raw; strip() only", ("N2",),
           _context_of(lambda text: jira_issue(summary=text)), placeholder=TASK_TITLE),
    Source("jira_description", "Jira description (plain text)", "evidence", ("context.md", "mcp"),
           "jira.parse_issue (adf_to_markdown) -> context.py ### Description", "raw, no cap",
           (), _context_of(lambda text: jira_issue(description=text))),
    Source("jira_description_adf", "Jira description (ADF)", "evidence", ("context.md", "mcp"),
           "jira_adf.adf_to_markdown -> context.py ### Description", "converted; line separators become LF; raw",
           (), _context_of(lambda text: jira_issue(description=_adf(text)))),
    Source("jira_comment", "Jira comment", "evidence", ("context.md", "mcp"),
           "jira.normalize_comments -> context.py #### Comment N", "raw body, latest 10", (), _context_of(_comment)),
    Source("jira_environment", "Jira Environment field", "evidence", ("context.md", "mcp"),
           "jira.parse_issue -> context.py ### Environment / Version", "raw, uncapped", (),
           _context_of(lambda text: jira_issue(environment=text))),
    Source("manual_description", "Hand-written bug report", "evidence", ("context.md", "mcp"),
           "input_adapters.bug_spec_from_description -> issue_from_spec -> context.py", "raw", (),
           _context_of(lambda text: manual_issue(text))),
    Source("manual_title", "Hand-written title (CLI --title, MCP title)", "evidence", ("context.md", "mcp"),
           "input_adapters.bug_spec_from_description -> context.py (- Summary:)", "strip() only", ("N2",),
           _context_of(lambda text: manual_issue("The export dialog forgets the format.", title=text)),
           placeholder="Chosen format is lost on reopen"),
    Source("attachment_note", "Developer attachment description", "evidence", ("task.md",),
           "prompts._attachments_section", "collapsed to one line", (), _attachment_note),
    Source("attachment_name", "Developer attachment file name", "evidence", ("task.md",),
           "attachments.attachment_names -> prompts._attachments_section", "sanitized when copied, not when rendered",
           ("N3",), _attachment_name, placeholder="placeholder.log"),
    Source("jira_attachment_filename", "Jira attachment file name", "evidence", ("context.md",),
           "jira.normalize_attachments -> context.py table and log signals", "| escaped only", (),
           _context_of(_jira_attachment), placeholder="placeholder.log"),
    Source("code_search_keyword", "Supplied keyword (CLI --keywords, MCP keywords)", "evidence", ("context.md",),
           "workflow.extract_issue_keywords -> context.py Search Terms", "strip() only", ("N4",), _keyword,
           placeholder="PlaceholderWidget"),
    Source("code_search_snippet", "Code Search snippet line", "evidence", ("context.md",),
           "retrieval.json snippets -> context.py Relevant Snippets", "inline code, one line each, no cap", (),
           _snippet),
    Source("code_search_reason", "Code Search reason (ripgrep error text)", "evidence", ("context.md",),
           "search.py reasons -> context.py Search Quality", "raw bullet", ("N4",), _search_reason),
    Source("git_history", "Git History: commit subjects and paths", "evidence", ("context.md",),
           "git_history.render_git_context -> context.py", "subjects on one line, demoted; paths raw",
           covered_by="test_prompt_boundary_baseline.py::test_git_history_subjects_and_paths_baseline"),
    Source("repository_profile", "Repository Profile facts", "evidence", ("task.md",),
           "repository_profile.clean_fact -> prompts", "one line, capped (clean_fact)",
           covered_by="test_repository_profile.py"),
    # --- earlier AI output --------------------------------------------------------------------
    Source("fix_report", "Previous fix report", "ai-output", ("retry", "mcp"),
           "workflow._previous_attempt_summary; mcp summarize_results", "raw, cut at 2,400 (retry) / 4,000 (MCP)", (),
           _fix_report),
    Source("similar_fix_memory", "Similar-fix memory (name and first heading)", "ai-output", ("context.md", "mcp"),
           "memory.search_memory -> context.py Similar Fixes", "names and first headings only", (), _similar_fix),
    # --- metadata -----------------------------------------------------------------------------
    Source("jira_status", "Jira status, type, priority", "metadata", ("context.md",),
           "jira.parse_issue -> context.py ## Issue", "raw", (),
           _context_of(lambda text: jira_issue(status={"name": text})), placeholder="Open"),
    Source("issue_id", "Issue id / work item id", "metadata", ("task.md", "context.md", "retry", "handoff", "mcp"),
           "identity.validate_work_item_id", "validated by regex everywhere", covered_by="test_work_item_id_contract.py"),
    Source("branch_label", "Branch name and template", "metadata", ("task.md", "retry"),
           "branch_policy.py, git_ops.py", "validated by regex; slug [a-z0-9-]", covered_by="test_branch_policy.py"),
)

BY_ID: dict[str, Source] = {source.id: source for source in SOURCES}


def injectable() -> tuple[Source, ...]:
    return tuple(source for source in SOURCES if source.inject is not None)
