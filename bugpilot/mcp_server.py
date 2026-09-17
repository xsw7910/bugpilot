"""BugPilot as an MCP server: the agent-facing entry point.

Design: ``docs/adapter_design.md`` section 5.2.

Three properties shape this file, and each one exists because of a mistake made
somewhere else first:

1. **Nothing writes to stdout.** stdout is the JSON-RPC frame channel; a stray
   ``print`` silently corrupts the connection. ``bugpilot/core`` was cleaned of
   prints in phase 1.4 precisely so this module could exist.
2. **The repo root is bound at startup, not passed by the model.** A tool
   argument the model fills in freely is a tool argument the model can get
   wrong, and getting it wrong here means writing artifacts into someone else's
   checkout.
3. **Seven coarse tools, no more.** Every tool schema sits in the model's
   context on every turn, so the 25 CLI subcommands are not mirrored one-to-one.
   Tools express intent (``refine_investigation``) rather than implementation
   steps (``run ripgrep again``).

Deliberately **not** exposed: posting a Jira comment, sending mail, committing,
pushing, ``clean`` and ``setup``. The first four are outward or destructive
actions that must stay human-triggered (requirement R5); the last two should not
be model-driven. There is also **no retry tool** — retry is fed by a developer's
written feedback, so making it callable would let the model decide it failed and
start over on its own.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from mcp.server.mcpserver import MCPServer
# The SDK's own ToolError is what marks a failure as anticipated: the model
# receives the message. Any other exception is treated as a crash and the model
# sees only "Error executing tool <name>", losing every actionable hint.
from mcp.server.mcpserver.exceptions import ToolError

from bugpilot.core import errors, handoff, workflow
from bugpilot.core.config import issue_dir
from bugpilot.core.identity import is_known_work_item_id, validate_work_item_id
from bugpilot.core.input_adapters import bug_spec_from_description, load_bug_spec
# Aliased on import: the tool below is also called search_memory, and a bare
# import would be shadowed by it inside build_server.
from bugpilot.core.memory import search_memory as search_memory_impl
from bugpilot.core.models import InvestigationOptions, InvestigationRequest

REPO_ROOT_ENV = "BUGPILOT_MCP_REPO_ROOT"

INSTRUCTIONS = """\
BugPilot turns a bug report into focused code context before you search the repository.

When the user references a Jira issue key (for example JR-12345) or describes a bug
and asks to fix, investigate or analyse it, call prepare_jira_bug or
prepare_bug_description first. Then read the returned bug_context.md and
agent_task.md and work from those instead of searching the codebase from scratch.

BugPilot prepares and hands off. It never commits, pushes, or posts to Jira, and
neither should you without the developer asking.
"""


@dataclass(frozen=True)
class _Bound:
    """The single repository this server instance serves, plus its write lock.

    Sync tool functions run in anyio worker threads, so two tool calls really do
    overlap. Everything that mutates a work item takes the lock: the status file
    is a read-modify-write, and two interleaved runs would mix artifacts from
    different investigations.
    """

    repo_root: Path
    lock: threading.Lock = field(default_factory=threading.Lock)


def resolve_repo_root(explicit: str | None = None) -> Path:
    """Where artifacts are written, decided once at startup.

    Precedence: an explicit argument (tests, embedding), then
    ``BUGPILOT_MCP_REPO_ROOT``, then the process working directory — which is
    what an MCP client sets to the workspace it launched the server in.
    """
    candidate = explicit or os.getenv(REPO_ROOT_ENV) or os.getcwd()
    return Path(candidate).resolve()


def _checked(work_item_id: str) -> str:
    """Validate a model-supplied id before it becomes a path segment.

    Without this the id flows straight into ``issue_dir()``, and
    ``"../../elsewhere/evil-1"`` writes outside the bound repository — defeating
    the point of binding a root at startup. ``run_investigation`` validates only
    on a fresh run, so the tool boundary has to do it for every call.
    """
    candidate = (work_item_id or "").strip()
    try:
        validate_work_item_id(candidate)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    return candidate


def _existing(repo_root: Path, work_item_id: str) -> str:
    """A validated id that names a work item already on disk.

    Steps happily create their own directory, so without this a tool called with
    any plausible id conjures a phantom work item instead of saying it was never
    prepared — the same failure mode an id-shaped memory query used to have.
    """
    item = _checked(work_item_id)
    if not issue_dir(repo_root, item).is_dir():
        raise ToolError(
            f"{item} has not been prepared. Run prepare_jira_bug or "
            "prepare_bug_description first."
        )
    return item


def _run(what: str, repo_root: Path, request: InvestigationRequest) -> workflow.WorkflowResult:
    """Run a preparation without ever cleaning, and report failures usefully.

    ``fresh=False`` is the load-bearing part: a fresh run calls
    ``clean_issue_artifacts``, which would let a second ``prepare`` delete the
    agent's own ``fix_summary.md`` and the developer's hint. Deleting artifacts
    is not a model-callable operation.

    The error carries the stable code from ``errors.error_code_for`` so a Jira
    auth failure reads differently from a bug in this codebase.
    """
    try:
        return workflow.run_investigation(repo_root, request, fresh=False)
    except Exception as exc:
        raise ToolError(f"Could not {what} [{errors.error_code_for(exc)}]: {exc}") from exc


def _read_artifact(root: Path, work_item_id: str, name: str, limit: int = 4000) -> str | None:
    """Return an artifact excerpt verbatim.

    Deliberately **not** run through ``sanitize_comment_text``. That redactor is
    built for outbound Jira comments and mangles code: it turns
    ``def load(key, secret_path)`` into ``def load(key, <redacted>`` and
    ``token = compute_token()`` into ``token = <redacted>``, so the model would
    read signatures that do not exist. It also protects nothing here — the agent
    can open the same file with its own tools. Redaction belongs on text leaving
    the machine, which is where ``jira.py`` and ``email_notify.py`` apply it.
    """
    path = issue_dir(root, work_item_id) / name
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return text if len(text) <= limit else text[:limit] + "\n…(truncated)"


def _package(root: Path, work_item_id: str, result: workflow.WorkflowResult) -> dict[str, object]:
    """What a prepare/refine tool hands back.

    Paths and a short context excerpt, not the whole package: the model reads the
    files it needs with its own tools, and returning everything would burn the
    context the preparation exists to protect.
    """
    spec = load_bug_spec(root, work_item_id)
    task_path = issue_dir(root, work_item_id) / "agent_task.md"
    return {
        "work_item_id": work_item_id,
        "source": spec.source if spec else None,
        "title": spec.title if spec else None,
        "issue_dir": f".ai/{work_item_id}",
        "agent_task": f".ai/{work_item_id}/agent_task.md" if task_path.exists() else None,
        "generated_files": result.generated_files,
        "next_step": (
            f"Read .ai/{work_item_id}/agent_task.md and .ai/{work_item_id}/bug_context.md, "
            "then implement the smallest safe fix. Stop before committing."
        ),
        "context_excerpt": _read_artifact(root, work_item_id, "bug_context.md"),
    }


def _options(
    hint: str | None,
    keywords: list[str] | None,
    focus_files: list[str] | None,
    ignore_paths: list[str] | None,
) -> InvestigationOptions:
    return InvestigationOptions(
        hint=hint,
        keywords=list(keywords or []),
        focus_files=list(focus_files or []),
        ignore_paths=list(ignore_paths or []),
    )


def build_server(repo_root: Path | None = None) -> MCPServer:
    """Create the server bound to one repository."""
    bound = _Bound(repo_root=resolve_repo_root(str(repo_root) if repo_root else None))
    server: MCPServer = MCPServer(
        name="bugpilot",
        version="0.1.0",
        instructions=INSTRUCTIONS,
    )

    @server.tool()
    def prepare_jira_bug(
        issue_key: str,
        hint: str | None = None,
        keywords: list[str] | None = None,
        focus_files: list[str] | None = None,
        ignore_paths: list[str] | None = None,
    ) -> dict[str, object]:
        """Fetch a Jira bug and build focused code context for fixing it.

        Use this when the user names a Jira issue key — an uppercase project
        prefix, a dash and digits, such as JR-12345 — and asks to
        fix, investigate, analyse or look at that bug. Call it before searching
        the repository yourself: it writes the issue description, reproduction
        steps, ranked candidate files and relevant git history into
        .ai/<issue_key>/, which is what you should read instead.

        For a bug that only exists as a description with no issue key, use
        prepare_bug_description instead.

        Args:
            issue_key: The Jira issue key, e.g. "JR-12345".
            hint: Optional pointer to where the fix likely belongs.
            keywords: Extra search terms the report may not have spelled out.
            focus_files: Files or directories to rank higher.
            ignore_paths: Files or directories to exclude from the search.
        """
        key = _checked(issue_key)
        request = workflow.jira_request(
            key, _options(hint, keywords, focus_files, ignore_paths)
        )
        with bound.lock:
            result = _run(f"prepare {key}", bound.repo_root, request)
        return _package(bound.repo_root, key, result)

    @server.tool()
    def prepare_bug_description(
        description: str,
        title: str | None = None,
        hint: str | None = None,
        keywords: list[str] | None = None,
        focus_files: list[str] | None = None,
        ignore_paths: list[str] | None = None,
    ) -> dict[str, object]:
        """Build focused code context from a bug described in prose.

        Use this when the user describes a bug in their own words, pastes a log
        or a stack trace, and gives no issue key. It does the same code search,
        history and context work as prepare_jira_bug, without touching Jira.

        If the user did name a Jira issue key, use prepare_jira_bug instead so
        the issue's own description and comments are included.

        Each call creates a new work item with its own id — it is not idempotent.
        To re-investigate one you already prepared, call refine_investigation with
        its work_item_id instead of preparing the same bug twice.

        Args:
            description: The bug report, log or stack trace.
            title: Optional short title; derived from the description otherwise.
            hint: Optional pointer to where the fix likely belongs.
            keywords: Extra search terms.
            focus_files: Files or directories to rank higher.
            ignore_paths: Files or directories to exclude from the search.
        """
        try:
            spec = bug_spec_from_description(
                description, title=title, repo_root=bound.repo_root
            )
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
        request = InvestigationRequest(
            spec=spec, options=_options(hint, keywords, focus_files, ignore_paths)
        )
        with bound.lock:
            result = _run("prepare the bug", bound.repo_root, request)
        return _package(bound.repo_root, spec.work_item_id, result)

    @server.tool()
    def refine_investigation(
        work_item_id: str,
        hint: str | None = None,
        keywords: list[str] | None = None,
        focus_files: list[str] | None = None,
        ignore_paths: list[str] | None = None,
    ) -> dict[str, object]:
        """Re-investigate a prepared bug around a new clue.

        Use this when you have learned something the first pass did not know —
        a likely subsystem, a symbol name, a directory to ignore — and want the
        code search, git history and context rebuilt around it. Cheaper and more
        accurate than searching the repository by hand with the new term.

        The issue data is reused, so this never re-contacts Jira.

        Args:
            work_item_id: The id returned by a prepare tool, e.g. "JR-12345".
            hint: Where you now think the fix belongs.
            keywords: Terms to search for, e.g. a class or function name.
            focus_files: Files or directories to rank higher.
            ignore_paths: Files or directories to exclude.
        """
        item = _existing(bound.repo_root, work_item_id)
        try:
            with bound.lock:
                result = workflow.refine_investigation(
                    bound.repo_root,
                    item,
                    _options(hint, keywords, focus_files, ignore_paths),
                )
        except FileNotFoundError as exc:
            raise ToolError(str(exc)) from exc
        except Exception as exc:
            raise ToolError(f"Could not refine {item} [{errors.error_code_for(exc)}]: {exc}") from exc
        return _package(bound.repo_root, item, result)

    @server.tool()
    def check_results(work_item_id: str) -> dict[str, object]:
        """List which result files a fix attempt has not written yet.

        Call this after implementing a fix to see what is still missing before
        the developer reviews it.

        Args:
            work_item_id: The id returned by a prepare tool.
        """
        item = _existing(bound.repo_root, work_item_id)
        try:
            missing = workflow.check_result_files(bound.repo_root, item)
        except Exception as exc:
            raise ToolError(f"Could not check {item}: {exc}") from exc
        return {
            "work_item_id": item,
            "missing": missing,
            "complete": not missing,
        }

    @server.tool()
    def summarize_results(work_item_id: str) -> dict[str, object]:
        """Roll the result files into a summary the developer can review.

        Writes result_summary.md and manual_validation.md. It never posts to
        Jira or sends mail — those stay with the developer.

        Args:
            work_item_id: The id returned by a prepare tool.
        """
        item = _existing(bound.repo_root, work_item_id)
        try:
            with bound.lock:
                workflow.summarize_results_step(bound.repo_root, item)
        except Exception as exc:
            raise ToolError(f"Could not summarize {item} [{errors.error_code_for(exc)}]: {exc}") from exc
        return {
            "work_item_id": item,
            "result_summary": f".ai/{item}/result_summary.md",
            "manual_validation": f".ai/{item}/manual_validation.md",
            "summary_excerpt": _read_artifact(bound.repo_root, item, "result_summary.md"),
        }

    @server.tool()
    def search_memory(query: str) -> dict[str, object]:
        """Search past bug investigations for similar problems.

        Covers both Jira and locally described bugs. Use it before starting an
        investigation: a similar bug may already record the cause and the fix.

        Args:
            query: A work item id, or free text such as a symptom or symbol name.
        """
        try:
            # write_report=False keeps this read-only: an id-shaped query would
            # otherwise mkdir .ai/<id>/ and create a phantom work item.
            _matched_id, markdown, results = search_memory_impl(
                bound.repo_root, query, write_report=False
            )
        except Exception as exc:
            raise ToolError(f"Memory search failed: {exc}") from exc
        return {
            "query": query,
            "matches": results,
            "report": markdown,
        }

    @server.tool()
    def get_status(work_item_id: str) -> dict[str, object]:
        """Report which preparation steps ran for a work item, and what exists.

        Read-only.

        Args:
            work_item_id: The id returned by a prepare tool.
        """
        item = _checked(work_item_id)
        path = issue_dir(bound.repo_root, item) / "workflow_status.json"
        if not path.exists():
            raise ToolError(
                f"No workflow status for {item}. Prepare it first with "
                "prepare_jira_bug or prepare_bug_description."
            )
        try:
            status = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
            raise ToolError(f"workflow_status.json is unreadable: {exc}") from exc
        spec = load_bug_spec(bound.repo_root, item)
        return {
            "work_item_id": item,
            "source": spec.source if spec else None,
            "title": spec.title if spec else None,
            "steps": status.get("steps", {}),
            "generated_files": status.get("generated_files", []),
        }

    @server.prompt(name="fix_bug", title="Prepare and fix a bug with BugPilot")
    def fix_bug(work_item: str) -> str:
        """Deterministic path: prepare a bug and work the resulting task package.

        For when a developer would rather not rely on the model choosing to call
        a tool. The wording comes from ``core.handoff``, which is also what the
        CLI's launch prompt and the Claude Code skill render — one source, so
        the three cannot drift apart (design 5.5).
        """
        # Reuses the one predicate that answers "did the user type an id?".
        # A local re-implementation routed "crash in openvds-2" to the Jira tool.
        looks_like_key = is_known_work_item_id(work_item.strip())
        tool = "prepare_jira_bug" if looks_like_key else "prepare_bug_description"
        argument = f'issue_key="{work_item}"' if looks_like_key else f'description="{work_item}"'
        return handoff.mcp_prompt(tool, argument)

    return server



def main() -> None:
    """Entry point for ``bugpilot-mcp``. stdio transport, so stdout is the wire."""
    build_server().run(transport="stdio")


if __name__ == "__main__":
    main()
