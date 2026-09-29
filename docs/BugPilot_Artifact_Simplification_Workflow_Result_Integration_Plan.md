# BugPilot Artifact Simplification + Workflow Result Integration Plan

> **Purpose:** 作为后续每次 BugPilot 开发与 review 的统一参考文档。
> **Status:** Active plan
> **Design principle:** **Workflow step owns its result, its artifact, and its actions.**
> **Compatibility policy:** BugPilot 尚未发布，因此本阶段允许 breaking cleanup；不保留 legacy artifact contract。

---

## 1. 目标

本阶段同时解决两个问题：

1. 将当前 20+ 个 BugPilot 生成文件简化为 **5 个核心 artifact + 1 个可选报告**。
2. 将工作状态、结果、artifact、Relevant Files、Search Details 和操作放回 `Investigation & AI Fix` 中对应的 workflow step。

最终目标：

```text
Issue details
    ↓
issue.json

Code search / Investigation
    ↓
retrieval.json

Build context
    ↓
context.md

Fix with AI
    ↓
task.md

Overall runtime
    ↓
run.json

Future Fix Verification
    ↓
fix_report.md
```

用户应能够直接从 workflow 看懂：

```text
BugPilot 做了什么
↓
每一步是否完成
↓
每一步产生了什么结果
↓
每一步对应哪个 artifact
↓
有哪些可执行操作
```

---

# 2. 新 Artifact Contract

最终标准目录：

```text
.ai/<work-item>/
├── issue.json
├── retrieval.json
├── context.md
├── task.md
├── run.json
└── fix_report.md       # optional
```

正常 `prepare-only`：

```text
issue.json
retrieval.json
context.md
task.md
run.json
```

明确要求：

```text
NO dual write
NO legacy fallback
NO compatibility aliases
NO old artifact readers
NO migration layer
```

BugPilot 尚未发布，因此本阶段不为旧 artifact layout 保留兼容代码。

---

# 3. Canonical Artifact Ownership

| Workflow Step | 用户看到的内容 | Canonical Artifact |
|---|---|---|
| Issue details | Jira/manual issue、title、summary、guidance | `issue.json` |
| Code search | Search terms、Relevant Files、Search Details | `retrieval.json` |
| Git history | Related changes | `retrieval.json` |
| Similar fixes | Similar issues / fixes | `retrieval.json` |
| Build context | Context ready、Open、Copy | `context.md` |
| Fix with AI | Ready / Starting / Started / Error | `task.md` |
| Overall runtime | workflow state | `run.json` |
| Future verification | diff / tests / review | `fix_report.md` |

`run.json` 是 machine-state source of truth，不作为普通 workflow artifact row 展示。

---

# 4. 旧 Artifact → 新 Artifact 映射

## 4.1 Issue 类

以下内容统一进入：

```text
issue.json
```

旧内容包括：

```text
jira
jira_parsed
jira_summary
bug_spec
developer_hint
fix_mode
```

不再默认生成多个 Jira / bug metadata 文件。

### `issue.json` 示例

```json
{
  "schema_version": 1,
  "id": "JR-12345",
  "source": "jira",
  "title": "Example issue",
  "description": "Example description",
  "comments": [],
  "signals": {
    "stack_traces": [],
    "error_messages": [],
    "log_signals": []
  },
  "guidance": {
    "hint": "Investigate output validation.",
    "fix_mode": "standard"
  }
}
```

Manual description 使用同一个 schema。

---

## 4.2 Retrieval 类

以下内容统一进入：

```text
retrieval.json
```

旧内容包括：

```text
extracted_keywords
code_search
search_quality
related_files
```

同时 Git History 与 Similar Fixes 的结构化结果也放入 `retrieval.json`，不要再额外产生：

```text
git_history.json
similar_fixes.json
```

### `retrieval.json` 概念结构

```json
{
  "schema_version": 1,

  "confidence": "medium",

  "terms": [
    {
      "value": "WidgetController",
      "source": "user",
      "weight": 8,
      "effective_weight": 8,
      "match_count": 18,
      "classification": "specific",
      "derived_from": "",
      "status": "retained"
    }
  ],

  "related_files": [
    {
      "file": "src/widgets/WidgetController.cpp",
      "documentation": false,
      "matched_keywords": [
        "WidgetController"
      ]
    }
  ],

  "git_history": {
    "changes": []
  },

  "similar_fixes": {
    "items": []
  },

  "noise_indicators": [],
  "reasons": []
}
```

不要为了 UI 重复生成多个 retrieval artifacts。

### Confirmed decisions (Batch 2)

The conceptual structure above was checked against the real pipeline. What
`retrieval.json` actually is:

1. **`retrieval.json` is the only persisted retrieval contract.** Written once,
   atomically, when the search completes; version 1 only, no reader for any
   older layout.
2. **`extracted_keywords` is internal pipeline state, not an artifact.** It is a
   pure function of `issue.json` plus the per-run `--keywords`, passed in memory
   and recomputed by a step run on its own. `terms` records what was searched.
3. **`related_files` keeps every field the ranker produces** (`score`,
   `confidence`, `match_count`, `reasons`, `noise_flags` as well as `file`,
   `documentation`, `matched_keywords`) plus **`snippets`** (`line`, `text`): the
   bounded matched-line evidence the context and the agent read, selected by the
   same `max_search_lines` budget the old report used.
4. **Raw search output is not persisted**, and neither is the Markdown report;
   the per-confidence file lists are dropped as a filter of `related_files`.
5. **Relevant Files, Search Details and the Context Ready counts are projections
   of the same file**, read and parsed once on the host.
6. **Retrieval semantics are unchanged**: identical terms, ranking and evidence
   on a frozen tree.
7. **No `git_history` / `similar_fixes` yet.** Git history renders Markdown and
   similar-fixes search keeps its results in memory only; neither has structured
   data to persist, so §9 and §10's `retrieval.json.git_history` /
   `.similar_fixes` wait until one does. Nothing is fabricated for the UI.

---

## 4.3 Context 类

以下内容统一进入：

```text
context.md
```

旧内容：

```text
bug_analysis
bug_context
```

建议结构：

```markdown
# Bug Context

## Issue

...

## Guidance

...

## Analysis

...

## Relevant Code

...

## Supporting Context

...
```

`Open Context` 与 `Copy` 只使用 `context.md`。

### Confirmed decisions (Batch 3)

1. **`context.md` is the only persisted context.** Written once, atomically,
   from in-memory inputs: the issue, the extracted keywords, the retrieval, git
   history and similar fixes. Its sections are the ones the pipeline has content
   for before an agent runs — Issue, Guidance, Context Quality, Issue Details,
   Code Search (Search Quality, Search Terms, Relevant Files, Relevant Snippets),
   Similar Fixes, Git History. No analysis is written ahead of the agent.
2. **Git history and similar fixes are not artifacts.** They are computed in
   memory and rendered into `context.md`; `git_context.md` and
   `memory_search.md` are no longer written.
3. **Relevant Files in `context.md` lists every ranked file.** `--max-files`
   bounds the list at retrieval; a panel's row limit is presentation only.
4. **Copy copies the content of `context.md`.** §11's "behaviour unchanged"
   covers placement and messages: the old Copy copied the handoff prompt, which
   stays available through "BugPilot: Copy Handoff Prompt" and Fix with AI's
   no-agent path.
5. **`bug_analysis` is not part of Batch 3.** The agent writes it as a result
   file after the handoff; BugPilot does not prepare it. It stays with the
   result files §19 consolidates.

---

## 4.4 Agent Task / Handoff 类

以下内容统一进入：

```text
task.md
```

旧内容：

```text
agent_task
agent_handoff
agent_team_instructions
```

`task.md` 表示 BugPilot 真正准备给 coding agent 的任务包。

建议结构：

```markdown
# BugPilot Task

## Objective

...

## Strategy

...

## Constraints

...

## Context

...

## Expected Work

...
```

稳定的 team/project instructions 不再每个 bug 单独生成文件。

如果 coding agent 需要 effective instructions，把它们合并进 `task.md`。

### Confirmed decisions (Batch 3)

1. **`task.md` is the only persisted task.** It keeps the existing task's
   sections, which the suggested outline maps onto: Objective → the AI Fix
   Mode's Objective; Strategy → Developer Hint and AI Fix Mode; Constraints →
   evidence rules, editing guardrails, Forbidden Actions, delivery safety;
   Context → Required Input Files; Expected Work → Required Output Files and the
   delivery offer or investigation handoff.
2. **`task.md` references `context.md`; it does not inline it.**
3. **The team instructions are a section of `task.md`**, rendered from the same
   source as before (`docs/agent_team_instructions.md`, else the bundled
   fallback). No per-work-item copy.
4. **`agent_handoff` is dropped.** Everything it said was already in the task.
   The handoff is one sentence, "Read .ai/<id>/task.md and complete the
   workflow.", used by the CLI, the MCP prompt, the skill and the extension,
   which no longer reads a file for it.

---

## 4.5 Runtime State

以下内容统一进入：

```text
run.json
```

旧内容：

```text
execution
workflow_status
```

概念结构：

```json
{
  "schema_version": 1,
  "status": "context_ready",
  "steps": {
    "issue": "completed",
    "retrieval": "completed",
    "context": "completed",
    "handoff": "not_started"
  },
  "agent": {
    "selection": "auto",
    "resolved": null
  }
}
```

使用已有 atomic-write infrastructure。

不要把同一 runtime state 写进多个 artifact。

### Confirmed decisions (Batch 4)

1. **`run.json` is the only persisted runtime state**, written atomically on
   every transition, version 1 only, no reader for `workflow_status.json` or
   any other layout. Fields: `schema_version`, `work_item_id`, `status`
   (`running` / `prepared` / `failed` — the product's own vocabulary; a
   prepare run ends `prepared`), `steps` (the real `WORKFLOW_STEPS` names with
   pass/fail/skipped marks, which is what the extension's checklist and
   history outcome read), `generated_files` (a directory snapshot, `run.json`
   itself included), `fix_mode`, and on a run-level failure `error`
   (`step`, `message`).
2. **No `agent` block yet.** Nothing persists agent selection or handoff state
   today — the extension's Fix with AI state is in-memory and its success only
   means a terminal started — so no field is invented for it (§20's rule).
   `steps.agent_fix` stays `skipped` in prepare-only runs, as before.
3. **`execution.log` is deleted, not moved.** It was an append-only trace no
   code read; its one useful fact (which step failed, and why) is `error`.
   The trace itself goes through stdlib logging (`bugpilot.execution`),
   unpersisted.
4. **Dropped fields** from the old status file: `mode` (a constant),
   `fresh` / `allow_mock` (no readers; mock provenance is `issue.json`'s
   `details.mock`).
5. **The lifecycle is owned by runs** (`run_investigation`, refine): first
   write `running`, terminal write `prepared` / `failed`. Standalone step
   commands update their step mark and the snapshots in the existing file and
   leave the lifecycle alone. A corrupt `run.json` is an error to every
   reader; a fresh run replaces it, which is the sanctioned recovery.

---

## 4.6 Fix / Review / Test

以下内容最终统一进入：

```text
fix_report.md
```

旧内容：

```text
diff_summary
fix_summary
review_notes
test_result
```

建议结构：

```markdown
# Fix Report

## Summary

...

## Changes

...

## Tests

...

## Review Notes

...

## Remaining Concerns

...
```

只有真正存在有意义的 post-fix 信息时才生成。

`prepare-only` 不生成空的 `fix_report.md`。

### Confirmed decisions (Batch 5)

1. **`fix_report.md` is the one post-agent report**, human-readable, with the
   fixed sections `## Summary`, `## Analysis`, `## Changes` (the old fix and
   diff summaries told one story), `## Tests`, `## Review Notes`. Its name
   means "post-agent workflow report", not "confirmed fix": an
   investigation-only mode fills the same sections with investigation state and
   an honest Summary.
2. **The agent owns it** (ownership model A): the coding agent writes and
   updates it per `task.md`; BugPilot only reads it (`core/fix_report.py`),
   except the `manual-result` template for hand-made fixes. Nothing overwrites
   the agent's text.
3. **Every derivation renders in memory** from the report:
   the Jira comment draft's sections, the notification email body, the memory
   entry's Final Result, the validation checklist and Result Overview
   (`summarize-results`), the retry prompt's previous-attempt summary, the
   commit plan's suggested message. `result_summary.md` and
   `manual_validation.md` are gone.
4. **Prompt and plan files stopped being files**: `final_review_prompt.md`,
   `commit_plan.md` and `push_plan.md` are printed by their commands
   (approval stays manual and explicit); `jira_comment_post_summary.md` is
   gone (the JSON result is the audit record). `agent_retry_prompt.md` is
   deliberately kept: an external agent process reads it by path, exactly like
   `task.md`.
5. **Deliberately separate, each with its own responsibility**:
   `user_feedback.md` (user-authored), `jira_comment_draft.md` (the approval
   artifact the execute step reads back), `jira_comment_post_result.json`
   (action audit), `email_draft.md` / `notification.eml` (delivery),
   `jira_field_report.md` (a `jira-validate` diagnostic), `attachments/`
   (source material), and the `.ai_memory/` entry.
6. **The core contract**: prepare-only stays exactly the five artifacts; a
   post-agent workflow adds at most `fix_report.md` — five plus one.

---

# 5. Bug-Specific Free-Form Files

类似：

```text
*_common_cause
*_fix_plan
```

不得属于标准 BugPilot artifact contract。

如果是 coding agent 自己产生的自由输出，不要让 BugPilot 将它们视为 canonical artifacts。

标准目录的目标始终是：

```text
5 core artifacts
+ optional fix_report.md
```

---

# 6. WorkflowStepResult Model

新增统一、typed 的 workflow result model。

概念结构：

```ts
type WorkflowStepResult = {
  id:
    | "issue"
    | "codeSearch"
    | "gitHistory"
    | "similarFixes"
    | "buildContext"
    | "fixWithAI";

  state:
    | "pending"
    | "running"
    | "completed"
    | "ready"
    | "failed"
    | "skipped";

  summary?: string;
  detail?: string;

  artifact?: {
    name: string;
  };

  actions?: ...;
  content?: ...;
};
```

职责：

```text
Host/controller
→ 理解 workflow/artifacts
→ 生成 typed step result

Webview
→ 只负责 render
```

不要让 `panel.js` 自己重新解释 workflow/artifact 语义。

---

# 7. Issue Details Step

## Pending

```text
□ Issue details
  Fetch Jira issue information
```

Manual description 时显示对应任务说明。

## Running

```text
◌ Issue details
  Loading JR-12345…
```

## Completed

```text
✓ Issue details
  JR-12345 · Jira issue
  Output type cannot select VDS volume

  issue.json
  [Open]
```

Manual description：

```text
✓ Issue details
  Manual bug description
  Crash after changing output type
```

完成后不要继续把：

```text
Fetch Jira issue information
```

作为主要 summary。

---

# 8. Code Search Step

这是 UI 重组的核心。

完成后：

```text
✓ Code search
  11 search terms · 6 relevant files
```

可以显示少量摘要，例如：

```text
11 terms · 6 relevant files · 2 broad
```

但不要把 summary 变成 debug dump。

---

## 8.1 Relevant Files 移入 Code Search

现在外部独立的：

```text
Relevant Files
```

移入：

```text
Code search
```

内部：

```text
▸ Relevant files
```

展开：

```text
IMPLEMENTATION

WidgetController.cpp
src/widgets/...
Matched: VDS · outputType

WidgetController.h
src/widgets/...
Matched: WidgetController

SUPPORTING

architecture.md
docs/architecture.md
```

保持：

```text
click file
→ open in VS Code
```

保持现有 path validation / repository-boundary security。

---

## 8.2 Retrieval Details 移入 Code Search

现在独立：

```text
Retrieval Details
```

移动到 Code Search 内，名称可简化为：

```text
▸ Search details
```

例如：

```text
WidgetController
User keyword · 18 lines

outputType
Shape expansion · 7 lines
From: output type

validation
Hint · 821 lines · Broad
```

保持：

- read-only
- artifact ordering
- `Broad` 来自 artifact
- `match_count` 表示 ripgrep matching lines
- UI 使用 `18 lines`，不是 `18 matches`
- 不显示 weight / effective_weight
- 不提供 tuning controls

---

# 9. Git History Step

## Pending

```text
□ Git history
  Find recent related changes
```

## Completed

```text
✓ Git history
  4 related changes found
```

展开：

```text
▸ Details

abc1234
Fix output selection validation
3 months ago

def5678
Update widget output handling
8 months ago
```

无结果：

```text
✓ Git history
  No related changes found
```

不要继续显示 action description 作为完成后的主要文本。

结构化结果放入：

```text
retrieval.json.git_history
```

---

# 10. Similar Fixes Step

## Completed

```text
✓ Similar fixes
  2 related fixes found
```

展开：

```text
▸ Details

JR-23456
Output selector rejected another volume type

JR-34567
Validation filtered a supported output
```

如果现阶段没有可靠的结构化结果：

```text
✓ Similar fixes
  Completed
```

即可。

不要为了漂亮 UI 伪造数据。

结构化结果放入：

```text
retrieval.json.similar_fixes
```

---

# 11. Build Context Step

`Build context` 是：

```text
context.md
```

的 owner。

完成后：

```text
✓ Build context
  Context ready · 6 relevant files

  context.md

  [Open Context] [Copy]
```

当前外部：

```text
Open Context
Copy
```

迁入这个 step。

消息和行为保持不变。

---

## Open Folder

`Open Folder` 是整个 work-item/run 级操作。

不要将其与 `Open Context / Copy` 混为一类。

可放：

- `Investigation & AI Fix` section header 附近，或
- section 底部 secondary action

---

# 12. Fix with AI Step

这个 step 是：

```text
task.md
```

的 owner。

> **Superseded in part (Next action, after `647f24d`):** the row keeps its
> states below, but no longer carries the `[Fix with AI]` button — handing the
> task over is the panel's primary action. See "Confirmed decisions (Next
> action)" at the end of §19.

## Ready

```text
○ Fix with AI
  Ready to start

  task.md

  [Fix with AI]
```

不要在尚未执行时显示绿色完成勾。

## Starting

```text
◌ Fix with AI
  Starting AI fix…
```

## Success

```text
✓ Fix with AI
  AI fix started
  Handed to Claude Code in a terminal.

  task.md
```

Success 只表示 handoff/terminal 已启动。

不得声称：

```text
Bug fixed
Tests passed
Files changed
Issue resolved
```

## Failure

```text
! Fix with AI
  AI agent unavailable

  [Open Settings]

  ▸ Details
```

Context、Relevant Files、Search Details 必须保留。

---

# 13. Investigation & AI Fix 成为主要结果视图

当前 workflow 主要表现为：

```text
计划 + checkboxes
```

修改后：

```text
计划
+
实时状态
+
结果摘要
+
artifact
+
actions
```

目标界面：

```text
▼ Investigation & AI Fix                 Context ready

✓ Issue details
  JR-12345 · Output type cannot select VDS

✓ Code search
  11 terms · 6 relevant files
  ▸ Relevant files
  ▸ Search details

✓ Git history
  4 related changes
  ▸ Details

✓ Similar fixes
  2 related fixes
  ▸ Details

✓ Build context
  Context ready
  [Open Context] [Copy]

○ Fix with AI
  Ready
  [Fix with AI]
```

用户不需要离开 workflow section 才能理解结果。

---

# 14. Workflow Disclosure Lifecycle

当前 UI-V1：

```text
Run starts
→ open

Run completes
→ auto-fold
```

新的结果已经位于 workflow 内，因此改为：

```text
Run starts
→ automatically open

Run completes
→ KEEP OPEN
```

用户可以自己折叠。

一旦用户完成后手动切换 disclosure，不要反复覆盖其选择。

---

# 15. 外部重复 UI 清理

分两步进行。

## Phase 1：先迁移

先将以下内容迁入 workflow：

```text
Relevant Files
Retrieval Details
Open Context
Copy
Fix with AI
handoff status/error
```

验证行为正确。

## Phase 2：删除外部重复区域

迁移稳定后删除：

```text
standalone Relevant Files
standalone Retrieval Details
external Open Context
external Copy
external Fix with AI
```

不要留下两套 source of truth。

---

# 16. Context Ready 外层区域

不要一开始完全删除：

```text
✓ Context Ready
```

先保留一个极简全局状态。

例如：

```text
✓ Context Ready

▼ Investigation & AI Fix
...
```

逐步删除外部重复的：

```text
3 relevant files · 11 search terms
Strategy
Fix with AI
Open Context
Copy
Relevant Files
Retrieval Details
```

完成 visual review 后再决定：

```text
Context Ready
```

是否最终并入：

```text
Investigation & AI Fix    Context ready
```

### Confirmed decisions (Batch 6)

1. **A step owns its result.** Each workflow row is a typed
   `WorkflowStepResult` computed by the host (`extension/src/app/workflow.ts`):
   status, a summary line for the state it is in, an optional detail line, the
   canonical artifact it produced, its actions, its nested content and a
   row-owned error. `panel.js` only renders it, through `textContent`.
2. **Every word comes from real state**: step marks (the live stream, or
   `run.json` for a reopened work item), the directory listing, `issue.json`
   (`id`, `source`, `title`; read by `issue.ts`) and `retrieval.json` (counts,
   files, terms). Git history and Similar fixes say only "Completed" or
   "Skipped" — their results stay inside `context.md` and are never parsed out
   of Markdown; there is no `git_history.json` / `similar_fixes.json`.
3. **A row reports only once its own step finished.** A mid-run row never
   offers the previous run's artifact or actions.
4. **Relevant files and Search details** (renamed from Retrieval Details) are
   collapsed disclosures under Code search, whose summary line is
   "11 terms · 6 relevant files".
5. **Open Context / Copy belong to Build context** ("Context ready",
   `context.md`). **Open Folder is work-item level**, at the foot of the
   workflow, because it reveals every artifact rather than one.
6. **Fix with AI lives on its row**: waiting ("Waiting for task…"), ready
   ("Ready", the button, the Strategy line, `task.md`), starting ("Starting AI
   fix…", no button), started ("AI fix started" + "Handed to X in a
   terminal."), failed ("Did not start", the row's card with Open Settings and
   Details, the button back for a retry). **Ready is not completed**: no green
   tick until a handoff actually started.
7. **A run failure sits on the row whose step was in flight**; the rows before
   it keep their results. Only a failure no row owns gets the standalone card,
   at the top of the workflow.
8. **The workflow stays open after Run** and opens once when a different work
   item with results arrives; a developer's collapse is never overruled.
9. **Option B**: the outer Context Ready card is removed entirely. The
   workflow header's status ("Context ready" / "AI fix started" / "AI fix did
   not start" / "Run failed") is the one global status; a separate line
   repeated it, or contradicted it after a failed handoff.
10. **Security unchanged**: row artifacts open through the existing
    constrained `openArtifact` message (a plain file name the host re-checks);
    the controller still accepts only commands a rendered card currently
    offers.

### Confirmed decisions (Batch 7): Fix Mode placement

> **Superseded in part (Workflow Settings Navigation):** Advanced settings is
> now the Workflow Settings page, and the Fix Mode selector sits in its Fix with
> AI section; the collapsed-summary label (decision 6) is now the line beside
> the Workflow Settings entry. See "Confirmed decisions (Workflow Settings
> Navigation)" at the end of §19.

1. **Fix Mode is an Advanced settings → Strategy input.** The primary form is
   the Issue field and Run; Strategy is the first group inside Advanced
   settings, and it holds the one Fix Mode selector, the selected mode's
   description (including "Investigation only") and the Manage Fix Modes gear.
2. **Standard Fix remains the default.** The selection is still
   `FormState.fixModeId`, restored and normalized by the host against the CLI's
   catalog (a missing or removed mode falls back to the declared default); the
   section being collapsed never changes it, and Run sends the same
   `--fix-mode` either way.
3. **Placement only.** No Fix Mode semantics, built-in definitions, custom-mode
   storage, run payload, `issue.json` `guidance.fix_mode` record or `task.md`
   AI Fix Mode section changed.
4. **Input and result stay separate.** Fix Mode is chosen in Strategy; what a
   package was prepared with is reported by the Fix with AI row's Strategy
   line. The workflow rows carry no selector.
5. **A closed section never hides a problem.** A problem with the chosen mode
   opens Advanced settings once and focuses the selector, like a problem in any
   field there; returning from Manage Fix Modes reopens it so focus lands back
   on the gear.

6. **Advanced settings exposes the active non-default Fix Mode in its
   collapsed summary**, so restored strategy changes remain visible without
   returning the selector to the primary form. The host re-selects the mode a
   work item was prepared with when it is reopened or its key is typed, and the
   default for a new one; while the section is closed, its title line names any
   mode other than the CLI's declared default (Standard Fix adds nothing, a
   custom mode shows its display name, a long one is cut with an ellipsis). It
   is presentation only — read from the selector, never a second control — it
   never opens the section, and the disclosure's accessible name is unchanged:
   the mode reaches assistive technology as the summary's description.

---

# 17. Artifact Label 显示原则

不要让每一个 step 都充斥：

```text
Artifact: xxx
```

可以低调显示：

```text
issue.json
retrieval.json
context.md
task.md
```

或仅显示：

```text
[Open]
```

并在 tooltip 中体现 filename。

核心原则：

> Artifact 与产生它的 workflow step 必须有明确归属，但 filename 不应抢占 UI 主层级。

---

# 18. run.json

`run.json` 不属于某一个普通 workflow row。

负责：

```text
overall status
step lifecycle
agent state
runtime state
```

UI 可以消费它的数据，但不用把：

```text
run.json
```

作为普通结果显示。

高级用户可通过：

```text
Open Folder
Diagnostics
```

查看。

---

# 19. fix_report.md

未来实现 Fix Verification 后增加：

```text
Review / Verify Fix
```

step。

再把：

```text
fix_report.md
```

归属给这个 step。

当前阶段不要为了它额外添加一个空 row。

### Confirmed decisions (Batch 8): Fix result

1. **Fix result is optional and appears exactly when `fix_report.md` exists**
   — a seventh workflow row straight after Fix with AI, owning the file, a run
   in flight included. No report, no row: the prepare workflow is still the six
   steps, a prepare still writes exactly five files, and the row never counts
   towards "Running n/m…".
2. **It is report availability, not fix success.** The row is `ready` (no
   status glyph, announced as "report available"); the workflow header says
   "Fix report available" when nothing newer is known. An investigation-only
   pass, a no-op and an attempt whose tests still fail all write the same file,
   and nothing claims the bug is fixed, the tests passed or the agent finished.
3. **Summary and Tests are bounded projections, not classification**: the
   first meaningful line of `## Summary` and of `## Tests`, in the agent's own
   words, read with the CLI's own section rules (`section_of`). A report with
   no Summary, or one that cannot be read, still gets its row: "Fix report
   available", "Preview unavailable".
4. **Full detail remains in `fix_report.md`**, which Open Fix Report opens in
   the editor through the same constrained `openArtifact` message as every row's
   file link. Only the two bounded lines reach the panel.
5. **No agent-completion tracking**: no polling, no file watcher, no process
   watcher. BugPilot knows a handoff started, never that an agent finished.
6. **Existing reads decide when an externally written report becomes
   visible**: the end of a run, reopening a work item (History, a window
   reload), and the Artifacts / History views' Refresh command. The row is
   rebuilt from the file on disk alone, with no handoff state.
7. **A re-run shows a report the CLI keeps, and says no more about it.** A
   non-Fresh re-prepare of the same work item leaves `fix_report.md` on disk
   (the retry flow reads it), so its row stays through the run and after it.
   Until an agent writes a new one it describes the previous attempt; nothing
   on the row or in the header claims it belongs to the run in flight, that
   this run completed, or that an agent finished. A Fresh run, another key or a
   hand-written bug starts without the previous report.

A future Review / Verify Fix step stays separate from this row; `run.json`
carries no Fix result step.

### Confirmed decisions (Batch 9): review aids on Fix result

1. **Post-fix review and validation aids belong to Fix result** and exist only
   with it: Open Fix Report, then **Copy Review Prompt**, then a collapsed
   **Validation checklist**. No Verify Fix row.
2. **The review prompt is generated on demand and kept in memory**, from the
   CLI's own builder, and goes to the clipboard. The label says what happens —
   a prompt is copied; no review runs, and nothing records that one did. The
   prompt is source-, outcome- and provider-neutral: "Review the BugPilot result
   for work item <id>", with the outcome left to `fix_report.md`.
3. **The validation checklist is read-only guidance** from the canonical
   builder (`summarize-results` renders the same checklist): five steps to try
   by hand, related files, the report's Review Notes (at most eight shown). No
   checkboxes, no pass/fail, nothing persisted. Loaded when first opened.
4. **Neither aid changes run or fix status.** Both come from
   `review-package --json`, a read-only query: no directory created, no step
   mark in `run.json`, nothing posted — safe during a same-item re-run, and a
   failure is the aid's own (a notice, or the disclosure's message), never the
   row's, the run's or History's.
5. **No review or verification artifact is persisted**: no
   `final_review_prompt.md`, no checklist file, no verification record.
6. **Delivery stays separate**: Jira posting, commit and push are not offered
   on the row.
7. **No automatic tests, no agent-completion tracking**: the aids prepare and
   inform; the developer stays in control.

### Confirmed decisions (Batch 10): Review with AI

1. **Review with AI is a secondary action of Fix result**, third after Open Fix
   Report and Copy Review Prompt, in the same quiet style, offered with any
   report. No AI Review row, and the workflow header is untouched: it stays the
   run's, the report's and Fix with AI's.
2. **It hands over the canonical prompt**: `review-package --json`'s, byte for
   byte, asked for on the press, held in memory, never rebuilt in the extension
   and never written.
3. **It uses the current AI-agent selection** — auto-detect, Claude Code or the
   custom command — through the same resolver as Fix with AI, so the two cannot
   disagree about the agent. No review-agent setting; a custom command takes the
   review prompt through its one `{prompt}` template.
4. **In a terminal at the repository root**, by the same mechanism as Fix with
   AI, with the prompt on one line and quoted as every handoff prompt is.
   Because this prompt comes from the CLI, a prompt holding anything a shell
   could act on, or starting like an option, is refused rather than quoted —
   with Copy Review Prompt still there; the pre-release quoting redesign stays
   in the backlog.
5. **Its state is transient and its own**: starting, then started or failed —
   never Fix with AI's, never written, never restored. Another work item, a
   reopen, a run or the report going clears it; a same-item refresh does not.
   No second press while one starts or once one started; a reopen or a run
   offers it again. The host refuses on the same condition the row shows.
6. **Started means a terminal was opened with the prompt**, and no more: "AI
   review started · Handed to <agent> in a terminal." No completion tracking,
   no output read, no review artifact, no change to `fix_report.md` or
   `run.json`.
7. **No agent is a card, not a fallback**: "AI review did not start", with Open
   Settings. The clipboard is Copy Review Prompt's, which stays beside it,
   independent.
8. **No delivery, no verification**: nothing is posted, committed, pushed or
   mailed; nothing says reviewed, passed or verified; the Validation checklist
   is untouched.

### Confirmed decisions (stabilization after Batch 10)

1. **Every page message is one the host parses.** `PANEL_MESSAGE_TYPES` is the
   host's list; a test routes what the page actually posts through the parser
   into the controller.
2. **One work item id rule, in both languages.** `WORK_ITEM_ID_RE`, matched in
   full; ids arriving from outside a form — History, the saved work item, a
   command argument, the CLI's stream — are checked at the extension boundary,
   and `bugpilot list` names only work item folders.
3. **One prompt gate for every terminal handoff**, in `resolveAgent`: plain
   characters only, refused otherwise. A mitigation, not argv: command lines
   are still shell text, and that redesign stays deferred.
4. **Fix with AI hands over at most one package at a time**, refused by the
   host, and drops a handoff when a work item is opened (another, or the same
   one again) or a run starts — as Review with AI does, with separate state.
5. **`run.json` steps record steps that ran.** No `manual_validation` or
   `final_review_prompt` step: a printed checklist is not a validation and a
   printed prompt is not a review. `result_summary` means the Result Overview
   was rendered.

### Confirmed decisions (Batch 11): Review Result Capture

1. **One optional post-review artifact, `review_report.md`**, beside the
   optional `fix_report.md`. Its existence means exactly one thing: somebody
   explicitly recorded the result of a review. Not that the review passed,
   that the fix is correct, that tests ran or passed, that recommendations were
   applied, or that any review finished by itself. No `review_report.json`, no
   review status file, and nothing about reviews in `run.json`.
2. **Recorded, never inferred.** Review with AI still means a terminal was
   opened with the prompt; nothing watches it, polls it or reads its output,
   and a review result exists only once the developer records one. The review
   may come from any AI, a person, or a session outside BugPilot, recorded now
   or after a reopen.
3. **The format is fixed and provider-neutral**:

   ```text
   # Review Report: <work-item>

   ## Summary
   ## Findings
   ## Validation Notes
   ## Recommendations
   ## Source
   Recorded from an external review.
   ```

   Every heading is always written. A section left empty reads
   `Not recorded.`; at least one of the four must have content, and a section
   over 50,000 characters is refused, never cut short. Entered text is kept as
   entered, except that a line starting `# ` or `## ` (up to three spaces in)
   becomes `### ` so the sections stay the file's own; lines inside a code
   fence are left as they are. No verdict field, no provider metadata,
   no prompt, transcript, terminal output, token or command is stored. The
   Source line says "external review", not "AI review": BugPilot cannot know
   who reviewed.
4. **One writer: `bugpilot record-review <id>`** (`core/review_report.py`).
   It validates the id with the shared rule, needs the work item folder (it
   never creates one), writes UTF-8 atomically, and has no other effect — no
   step mark, no Jira post, no email, no memory entry. An existing report is
   kept: recording again fails with `ARTIFACT_EXISTS` unless `--replace` is
   given. Text arrives as `--summary`, `--findings`, `--validation-notes` and
   `--recommendations`, or as one JSON object in `--from-file` — how the
   extension sends it, through a temporary file outside the repository that is
   removed afterwards, so review text is never on a command line. Importing a
   free-form Markdown review is future work.
5. **One reader, bounded.** The panel gets the first meaningful line of
   Summary and of Findings, and whether Validation Notes and Recommendations
   were recorded — no verdict, no "approved", "clean" or "tests passed" read
   out of the text. A missing section is absent; an unreadable report is still
   a report to open, with "Preview unavailable".
6. **Review Result belongs to Fix result**, below its review aids: not a
   workflow row, never counted in "Running n/m", present exactly while
   `review_report.md` is listed. It says "Review result recorded", the summary
   line and the findings line, and offers **Open Review Report** — an action,
   not a path: the host opens the canonical file of the work item on screen,
   and only while it is listed.
7. **Record Review Result** is offered while Fix result is — a work item with
   `fix_report.md` listed — no run is in flight and no recording is. It opens
   four text areas under the row; Save sends the text to the host, which runs
   `record-review`. With a report already recorded the button reads **Replace
   Review Result**, and the host asks before passing `--replace`. The words
   say what the developer does: never "Complete Review", "Mark Reviewed",
   "Review Passed" or "Accept Review".
8. **Host-side state, one recording at a time.** The host refuses a second
   recording while one is in flight, whatever the page shows. Another work
   item, a reopen, a run starting or the report going drops a recording in
   flight — its outcome is never shown, least of all under another work item;
   a same-item refresh does not. Success is the host's explicit word
   (`recorded`), and only that closes and empties the form: a recording that
   was dropped is not taken for one that succeeded, and what was typed stays.
   A report recorded elsewhere meanwhile (`ARTIFACT_EXISTS`) makes the row read
   the folder again, so it offers that report's Open and Replace. No run of any
   kind — Run, Fresh, Resume, a re-prepare — begins while a recording is in
   flight: the host refuses it with "Wait for the review result recording to
   finish before starting a run.", because a Fresh run would otherwise delete
   the folder and the late write put the report back. No recording starts
   during a run either.
9. **Failures are the recording's own**: "Review result was not recorded",
   with the reason, under the form, text kept. Never the row's, the run's or
   History's, and never worded as the review having failed.
10. **Fresh, Resume, Retry follow `fix_report.md`.** A Fresh run deletes the
    work item folder, the review with it; a resume and a non-Fresh re-prepare
    of the same work item keep both reports, and the row keeps showing them
    through the run. Retry neither creates, changes nor deletes
    `review_report.md`: a review recorded before a retry describes the earlier
    attempt until it is replaced. There is no Retry Review.
11. **Unchanged**: Review with AI (outcome-neutral, transient), Copy Review
    Prompt (canonical prompt, never persisted), the Validation checklist
    (guidance, no checkboxes, never ticked by a review), History (no new
    outcome; a review report changes none) and `run.json`.

### Confirmed decisions (Batch 12): Verification Evidence

1. **One optional artifact, `verification_report.md`**, beside the two
   reports. Its existence means only that verification evidence was
   explicitly recorded — not that the fix is correct, that every relevant
   behaviour was tested, that the repository's tests pass, that review
   recommendations were applied, or that the work item is ready to merge. No
   JSON sidecar, no flag files, nothing in `run.json`.
2. **Evidence, scoped per check.** Each check has a name and a recorded status
   — Passed, Failed or Not Run — plus a type (Automated, Manual, Other) and
   optional Command / Procedure, Evidence and Notes. A status is what the user
   recorded for that one check; BugPilot did not run or observe it. All
   recorded checks passing is not proof that no defect remains. No confidence
   score, no "skipped", no execution-source field yet.
3. **The format is BugPilot's and fully round-trips**:

   ```text
   # Verification Report: <work-item>

   ## Summary
   <n> checks recorded: <counts>.

   ## Checks

   ### Check 1: <name>

   Status: Passed | Failed | Not Run
   Type: Automated | Manual | Other

   Command / Procedure:

   > <text>   (or: Not recorded.)

   Evidence:

   > <text>   (or: Not recorded.)

   Notes:

   > <text>   (or: Not recorded.)

   ## Overall Recorded Status
   <one scoped phrase>

   ## Source
   Verification evidence explicitly recorded by the user.
   ```

   Entered field text is stored as a Markdown quote, every line prefixed
   `> `, so nothing a user types can open a heading, a check or a field of the
   report's own; the name is one line. The overall phrase is generated from the
   counts and is always one of: "All recorded checks passed.", "Recorded checks
   include failures.", "No recorded check has been run.", "Recorded checks have
   mixed or incomplete status." — never "verified", "correct", "approved" or
   "safe to merge". The writer parses what it rendered before writing, so a
   report it cannot read back is never written.
4. **One writer: `bugpilot record-verification <id> --from-file <json>`**
   (`core/verification_report.py`), with `--replace` and `--json`. The JSON —
   `{"checks": [{name, status, type, procedure, evidence, notes}]}` — is
   transport only and never stored. The writer validates the id, needs the work
   item folder, requires at least one check, a name for each, a known status and
   type, bounded fields (25 checks; 200 characters for a name, 20,000 for each
   text), writes atomically, keeps an existing report unless `--replace`
   (`ARTIFACT_EXISTS`), and has no other effect. It never runs a command. A
   check sent without a type is recorded as Other — the CLI does not guess
   Automated for it.
5. **Readers, bounded.** The panel gets the counts, the overall phrase and up to
   five checks (name, recorded status, type), "+N more in
   verification_report.md" beyond that. A report that is not in the canonical
   shape still previews as far as it can and opens, but is not turned into
   structured checks: Edit then starts from one new check, says that saving
   replaces the report, and saving does.
6. **Verification Evidence belongs to Fix result**, after Review Result: not a
   workflow row, never in "Running n/m", present exactly while the file is
   listed. It reads "Recorded checks: 2 passed, 1 failed" — counts of recorded
   statuses, no global badge — with the checks and **Open Verification Report**
   (an action; the host opens the canonical file, only while listed).
7. **Record Verification Evidence / Edit Verification Evidence** is offered
   while Fix result is on screen and nothing is in flight — no run, no review
   recording, no verification recording. It does not need a review. The form
   has one row per check (Add Check, Remove Check); a new row defaults to Not
   Run and Automated, never Passed. Edit fills the form from the report the host
   parsed; saving an edit replaces the report, which the host passes as
   `--replace` because the developer chose Edit — and only over the report that
   Edit was filled from: one changed since (a terminal, an agent, another
   window) is kept and said, never overwritten unseen. Closing the form keeps
   what was typed; checks typed into a Record form that met a report recorded
   meanwhile are kept, after the recorded ones, when Edit loads it. Plain Enter
   in a check's name never runs the panel.
8. **One artifact write at a time, host-side.** Recording a review result and
   recording verification evidence are both artifact mutations; while either is
   in flight no run of any kind starts (checked before setup and again at the
   door), neither recording starts, and Clean is refused — "Wait for artifact
   recording to finish before cleaning this work item." In-flight state is the
   operation's own, cleared only when it ends; another work item or a reopen
   drops only the displayed outcome. The guards are per window; across
   processes the CLI's atomic write and keep-unless-replace are the protection,
   and a real lock is future work. Clean holds the same guard while it runs —
   no recording and no run start until it ends ("Wait for the clean to finish
   before starting a run.") — so the controller, not the command, confirms and
   runs it.
9. **Failures are the recording's own**: "Verification evidence was not
   recorded", with the reason — never worded as a check failing, which only a
   recorded Failed status says.
10. **Fresh, Resume, Retry follow the other reports.** Fresh deletes it with the
    folder; a resume and a non-Fresh re-prepare keep it and it stays on screen
    through the run; Retry neither creates, changes nor deletes it, so after a
    retry the evidence may describe the earlier attempt until it is edited.
11. **Unchanged**: History (a verification report changes no outcome; the
    existing "verified" icon for a work item with `fix_report.md` is known
    semantic debt, not extended here), `run.json`, the Validation checklist
    (guidance, never turned into Passed), Review Result (never converted into
    checks), Review with AI and Copy Review Prompt.

### Confirmed decisions (release stabilization, after `cb434ca`)

Found in a real VS Code window; each is the smallest correction of an existing
contract, not a new concept.

1. **Reopening a Jira work item names it in the Issue field** (amends Batch 7,
   decision 6). The host re-selected the reopened item's prepared mode while
   the field still named another key, so Run re-prepared that key with the
   reopened item's mode — an investigate-only package could silently become a
   fixing one. Now, while the field holds a key or nothing, a reopened Jira
   item's key replaces it, Fresh is cleared (the next Run is about another
   item), a hint suggestion made for the previous item is dropped, and the
   item's prepared mode is selected again. A bug description being typed is
   never replaced, and its selection stays its own. A hand-written bug's text
   cannot come back from its `local_…` id, so its mode is re-selected only while
   the field is empty. A form the host replaces also drops a change the page had
   not yet sent, so the host and the page cannot disagree about the key.
2. **Retry takes its turn with the other artifact writes** (amends Batch 12,
   decision 8). It writes `user_feedback.md` and `agent_retry_prompt.md` into
   the work item folder, so it is refused while a recording or a clean is in
   flight ("Wait for the clean to finish before retrying."), and while it is
   being prepared no clean, no recording and no run start. Its credentials are
   read inside the guarded block, so a keyring that fails releases the guard (a
   run's likewise no longer stays "running").
3. **History's icon for a work item with `fix_report.md` is a document**
   (`file-text`), not the check-badge `verified` (closes the semantic debt in
   Batch 12, decision 11). The outcome and its sentence — "An agent wrote its
   report in fix_report.md." — are unchanged; a report is not a verified fix.
4. **The manifest has no comment keys inside `contributes.menus`**: VS Code
   reads every key there as a menu id and logged "submenu items must be an
   array" at every start. The comments moved to a top-level `//menus` key.

### Confirmed decisions (Next action): one primary CTA that follows the work item

The problem: after **Build Context** with **Fix with AI** unticked, nothing on
the screen said how to start the fix. The top button still read **Run** — which
now meant "prepare it all again" — **Retry** sat beside it asking the developer
to know what `bug --retry` does, and the handoff button was a second primary
button inside the Fix with AI row, under a disclosure that starts collapsed.

1. **One primary action, directly under the Issue field, that is always the
   next step.** It is computed by the host (`extension/src/app/nextAction.ts`,
   `primaryView`) on every push, like the workflow rows, and the page only
   renders it:

   ```text
   nothing prepared                         → Run
   task.md ready, no attempt                → Fix with AI
   an attempt exists                        → Open AI Session
   the form changed since it was prepared   → Rebuild Context
   a run, handoff or artifact write in flight → Running…   (disabled)
   ```

   Precedence is top to bottom after *busy*, which wins over everything.
   *Prepared* is the Fix with AI row's own Ready condition: `task.md` listed,
   from a Build context that finished, no run in flight. *An attempt exists*
   means this window started a handoff for the work item, or an agent wrote
   `fix_report.md` (a reopened item after a reload). One line under the button
   says why it reads what it reads; it is Run's old sentence until a run has
   finished or failed.

2. **Everything else is behind a ⋯ menu beside it**, never a second primary
   button: **Rebuild Context** once there is a context, **Start New Attempt**
   once an attempt exists (and never before the first handoff), and **Open AI
   Session** while the context is stale but a session exists. The menu is empty
   — and its button absent — while anything is in flight.

3. **What each action means.**

   | Action | Meaning |
   | --- | --- |
   | **Run** | Initial preparation. Honors the plan boxes; with **Fix with AI** ticked it hands over at the end, as before. |
   | **Fix with AI** | The first handoff of the prepared `task.md`: no Jira fetch, no search, no preparation — the same one-sentence prompt and terminal as before. "AI fix started" still means only that the terminal started. |
   | **Open AI Session** | Continue the existing interaction: bring forward the terminal the last handoff opened (the newest still-open one with that name). If it is gone, say so in a neutral notice and start nothing — BugPilot never claims to have restored a session. |
   | **Start New Attempt** | A new AI session on the existing context, with optional feedback (decision 5). Not the way to continue a conversation. |
   | **Rebuild Context** | Regenerate the preparation after a change: the same `bug … --resume --prepare-only --json-lines` a Run sends, from the current form, and never a handoff at the end of it. Non-Fresh: `fix_report.md`, `review_report.md` and `verification_report.md` survive as they do for any re-prepare. |
   | **Fresh / Resume** | Advanced and recovery, unchanged: Fresh is still the *Delete previous artifacts first* box, and a Rebuild Context with it ticked asks before deleting, as Run does — never silently. The CLI's two-step **Retry** stays in the command palette and the History menu. |

4. **Staleness is decided by the host, from the form it is given.** The
   baseline is a fingerprint of every preparation input
   (`preparationFingerprint` in `form.ts`: issue key or description and title,
   hint, keywords, focus files, ignore paths, both limits, attachments, Fix
   Mode, the effective plan), normalized the way `buildPrepareArgs` reads them,
   so whitespace a run ignores changes nothing. The agent, its command, the Fix
   with AI box, Fresh and *Use issue details* are not inputs. It is taken when a
   run starts (from that run's form — so no push after it can compare against an
   older one) and when a work item is opened (from the form then shown; what
   built a package on disk is not recorded). A form naming another work item is
   stale regardless. A stale context is never handed over: the primary action
   becomes Rebuild Context, Start New Attempt is withdrawn, and `fixWithAI()`
   itself refuses — so the command palette and History cannot bypass it.

5. **Start New Attempt's feedback is optional, and only typed text is written.**
   The menu item opens an inline form under Fix with AI (not a modal): *Optional
   feedback*, placeholder *What should the new attempt do differently?*, an
   example, Cancel and Start Attempt. Empty: nothing is written and `bug
   --retry` is not run — it would write the placeholder template — and the new
   session gets the same `task.md` handoff. Typed: the host writes
   `user_feedback.md` (the template's heading, `## Required Next Attempt`, and
   the text; replacing earlier feedback, which the form says), runs `bug <id>
   --retry --prepare-only --json` to build `agent_retry_prompt.md`, and hands
   over `Read .ai/<id>/agent_retry_prompt.md and continue the workflow.` — the
   CLI's own `retry_handoff_prompt`. No `attempts/` directory; artifact storage
   is unchanged. The write takes the one-artifact-write-at-a-time guard
   (`attempt`): no run, clean or recording starts while it is in progress. Each
   handoff's terminal is numbered from the second, `Fix with AI · <id> (2)`, so
   Open AI Session goes to the newest.

6. **The feedback helpers copy text in only when pressed.** **Use Review
   Findings** is listed while `review_report.md` is, and adds its Findings and
   Recommendations verbatim. **Use Verification Evidence** is listed while
   `verification_report.md` records a check as Failed or Not Run, and adds those
   checks as recorded. Both are read from the file when pressed and sent once;
   nothing is written or handed over until Start Attempt, and neither says
   reviewed, approved or verified.

7. **Fix with AI's row is a status and result area.** It says Ready, Starting
   AI fix… / Starting a new attempt…, AI fix started (with which agent, and
   whether the attempt carried feedback), Did not start (with its card), or
   *Fix report available* for an attempt this window did not see start — never
   the green tick for that. It keeps Strategy and the task link, and holds
   Start New Attempt's form. A session this window started survives a Rebuild
   Context of the same work item, so the row and the button stay "started" /
   Open AI Session rather than inviting a second agent onto a package one is
   working on. Sessions are kept per work item for the window's life; Clean and
   a Fresh run drop them.

8. **The host stays authoritative; the webview is presentation and intent.**
   The page posts `nextAction` with the action it showed and its whole form, or
   `startAttempt` with the feedback and the form. The host re-derives its answer
   from that form and acts only if it still offers that action; otherwise it
   corrects the button and says "Nothing was started: the form changed before
   the panel caught up." A press also cancels the page's pending debounced
   `formChanged`, whose older snapshot would otherwise overwrite the host's copy
   after it. The existing guards hold unchanged — one handoff at a time, one
   artifact write at a time, no run over a recording or a clean — and gain two:
   no handoff while a run is in flight or an artifact write is, and no second
   run while the first is still being set up (the Fresh question, a long
   description's file).

9. **Protocol.** `PanelState.primary` replaces `canRetry`; the Retry button is
   gone. New messages `nextAction` and `startAttempt`; new actions
   `useReviewFindings` and `useVerificationEvidence`. `run`, `retry` and the
   `fixWithAI` action are still accepted, for the CLI-facing commands and older
   callers. `UiPort.revealTerminal` is the one new port. No Python change.


### Confirmed decisions (Workflow Settings Navigation)

The problem: "Advanced Settings (Optional)" grouped its controls by kind —
Strategy, Guidance, Retrieval Overrides, Run Options — so "what does Code
search use?" had no single place to look, and the disclosure sat below a
workflow list that did not point at it.

1. **A gear on each workflow row that has settings, and only there.** Issue
   details, Code search, Build context and Fix with AI each end with a codicon
   gear named for the step — "Configure Code Search", as tooltip and accessible
   name, never "Settings". Git history and Similar fixes have nothing beyond
   their checkbox and get no gear. The gear is a real button outside the row's
   label (it never ticks the checkbox), visible at rest at reduced opacity, full
   strength on hover or focus, with a focus ring, and `flex: none` so it never
   squeezes the label at 200px.

2. **One shared Workflow Settings page**, a panel view like the Fix Mode views
   (a sibling of the main view, outside the form, never a modal): Back, the
   title, a lede, one section per step that has settings in the workflow's
   order, and Cancel / Apply kept on screen at its foot. The model is
   `extension/src/app/workflowSettings.ts`: `WorkflowSettingsSection` is
   `issue-details | code-search | build-context | fix-with-ai`, and
   `SETTINGS_SECTION_OF_STEP` maps rows to sections. The page script carries a
   copy of the section list, compared with the model by a test.

3. **The settings moved; none was added, renamed or copied.** Advanced settings
   is gone; a "Workflow Settings" entry under the workflow opens the page at
   its top, with the non-default-Fix-Mode line beside it.

   | Section | Settings |
   | --- | --- |
   | Issue details | Title (manual bugs only, as before), Attachments |
   | Code search | Keywords, Focus files, Ignore paths, Max files, Max search lines |
   | Build context | Delete previous artifacts first (Fresh) |
   | Fix with AI | AI agent, custom agent command, Fix Mode (+ Manage Fix Modes), Hint (+ Improve, Use issue details) |

   The Issue field, the plan checkboxes and the Fix with AI box stay on the main
   form. Every settings field has exactly one home (tested).

4. **Navigation.** A gear shows the page, scrolls its section into view
   (`scrollIntoView({ block: "start" })`, in the same turn as un-hiding the
   view, so the section has a position), outlines it briefly
   (`settings-section-target`, an outline so high-contrast themes keep it, no
   transition under reduced motion), and focuses the section's first control on
   screen — Title for a hand-written bug, otherwise Attachments; Keywords; the
   Fresh box; the AI agent. During a run the fields are disabled, so the
   section heading takes focus. A validation problem in a settings field opens
   the page at its section and lands on the field, once per problem. Back
   returns to the form with its scroll position and focus on the control that
   opened the page. Manage Fix Modes returns to the page, draft intact.

5. **Apply / Cancel is an explicit draft.** While the page is open its controls
   are a draft; the page reads the form from the *applied* settings, so nothing
   typed there reaches a run, a form change or a primary-action press. Apply
   (or Ctrl+Enter) copies the draft into the applied settings and sends
   `applySettings { form }` with the whole form, then returns to the form.
   Cancel, Back and Escape write the applied settings back over the draft. Two
   host paths that used to write the form behind the page were changed to fit:
   the attachment dialog now answers the draft (`pickAttachments` →
   `PanelState.attachmentPick`, merged, de-duplicated and capped by the host,
   sent once) instead of replacing the host's form, and the hint improver reads
   the draft without keeping it — Use Improved puts the suggestion into the
   draft Hint, and the host only clears its suggestion. A form the host itself
   replaces while the page is open (another work item, a restored mode)
   supersedes the draft. `addAttachments` stays in the protocol, unused by the
   page.

6. **Stale context only after Apply, by the host's rules.** `applySettings`
   goes through `#formChanged`, the path every form change takes, so
   `preparationFingerprint` alone decides staleness: applied Title (manual),
   Attachments, Keywords, Focus files, Ignore paths, both limits, Fix Mode or
   Hint make the primary action Rebuild Context; the AI agent, its command,
   Fresh and Use issue details do not. The page states this per section from
   `SETTING_REQUIRES_REBUILD` — "Changes here require rebuilding context.", or,
   in Fix with AI's mixed section, "Requires context rebuild" beside Fix Mode
   and Hint — and a test changes each field and checks the fingerprint moves
   exactly when the table says so.

7. **Summaries on the rows** (`settingsSummaries`, host-computed from the
   applied form): "2 attachments"; "4 keywords · 2 focus paths · 1 ignored
   path · max 10 files · max 300 search lines"; "Deletes previous artifacts
   first"; "Claude Code · Standard Fix · hint added". Counts and names only —
   never a keyword, a path, the hint's text, a title or a custom command
   (tested with planted values). A row whose settings are at their defaults has
   none and keeps its description; Fix with AI always names its agent.

8. **Host authority and concurrency.** Opening the page asks the host nothing
   and starts nothing. Apply is `aria-disabled`, with a line saying why, while
   the primary action is busy (a run, a handoff, a new attempt, an artifact
   write); the host refuses an `applySettings` that races it, says so, and bumps
   the revision so the page shows the host's form again. Applying settings
   never starts Run, Rebuild Context, a handoff or an attempt, and the
   next-action states are unchanged.

9. **Use Improved is no longer a primary button**: on the settings page, Apply
   is the page's one primary action.

10. **Found in the real VS Code window, and corrected** (§37.78):
    - the arrival highlight is an outline only — a fill with the find-match
      colour painted the whole section, inputs included, in a loud orange;
    - while the settings page is shown, `scroll-padding-bottom` keeps anything
      scrolled into view or focused above the sticky Cancel / Apply footer — a
      hint suggestion's Use Improved and Keep Original had arrived under it;
    - every press of the primary action resets the "open once per problem"
      guard, so a second press refused for the same settings problem opens the
      page at the field again instead of looking ignored;
    - disabled fields on the settings page dim like the selects already did;
    - a workflow row's head may wrap: the label keeps a 5em floor and the
      duration, status and gear move under it at the right, where at 200px after
      a run the label had been squeezed to one letter per line.

### Confirmed decisions (Review / Verification UX Clarification)

The problem: after a fix the row offered Review with AI, Record Review Result
and Record Verification Evidence side by side with nothing saying how they
differ, and a reviewer's answer — asked for as `Verdict: PASS / PASS WITH MINOR
COMMENTS / NEEDS CHANGES` plus five free-form headings — had to be retyped into
four blank boxes whose names matched none of them.

1. **Three acts, three words.** *Review with AI* starts a reviewer. *Review
   Result* is the saved record of what a reviewer said. *Verification Evidence*
   is the checks the developer actually performed and what they observed. They
   are never merged: a review observation is not verification evidence, and
   the verification form says so. The normal flow reads Fix with AI → Review
   with AI → Review Result → Verification Evidence.

2. **User-facing wording; ids and files unchanged.** The buttons read **Paste
   Review Output**, **Add Review Result** (the empty form, for any review typed
   by hand), **Save Review Result** (the form's submit), **Replace Review
   Result**, and **Add Verification Evidence**. "Record Review Result" and
   "Record Verification Evidence" are no longer on screen. The element ids
   (`record-review-result`, `record-verification`), the step action ids
   (`recordReviewResult`, `recordVerification`), the CLI commands
   (`record-review`, `record-verification`) and the artifacts
   (`review_report.md`, `verification_report.md`) are unchanged; there are no
   command-palette entries for either. The saved-review wording follows the
   button: "Review result saved", "Saving review result…", "Review result was
   not saved: …". Verification keeps "recorded" — evidence is recorded.

3. **Review with AI semantics are unchanged: "AI review started" means a
   terminal was opened with the prompt, and nothing more** — not finished,
   passed, correct, approved, verified or safe to merge. Under it the row now
   says how the reply gets back: "When the reviewer replies, use Paste Review
   Output to fill in the review result, then check it and save it."
   (`REVIEW_NEXT_STEP`).

4. **The canonical review prompt asks for review_report.md's own four
   sections and no verdict** (`_build_final_review_prompt`, served by
   `review-package`; a Python change, approved for this batch). It keeps the
   work item, the files to read and the review focus — adding missing edge
   cases and unrelated changes — and adds rules: say which conclusions come from
   reading code and which from commands actually run; do not claim a test ran
   unless it was run and its result seen; do not call the result verified
   without naming the evidence; do not approve or call it safe to merge; write
   "Nothing to report." in an empty section. It asks for exactly `## Summary`,
   `## Findings`, `## Validation Notes`, `## Recommendations`, in that order.
   The whole prompt stays inside `isPlainPrompt`'s character class, so the
   terminal handoff still accepts it; Python, extension and integration tests
   pin that, and that a reply in the asked-for shape parses.

5. **Capture is an explicit paste, never terminal reading.** BugPilot still
   does not read, poll or scrape the reviewer's terminal, and a review having
   started is never taken to mean a reply exists. **Paste Review Output** opens
   a text box under the row; **Parse** sends the text to the host
   (`parseReviewOutput { text }`, clamped one past the cap), which parses it and
   answers once (`reviewPrefill { token, entry | error }`, one push, like
   Edit Verification's answer). No agent result file exists in the architecture
   to read instead, and none was added.

6. **One deterministic parser** (`extension/src/app/reviewOutput.ts`). A
   section starts at a level-two heading whose text, case-insensitive and with
   runs of whitespace as one, is one of the four names (optional closing
   hashes, up to three spaces in), and runs to the next of the four. Headings
   inside a backtick or tilde fence are code. Any other `## ` heading stays as
   text of its section (the writer demotes it). Text before the first section
   is left out, and the answer says so. Each line loses trailing whitespace and
   each section its outer blank lines; nothing else changes. Refused, with the
   reason: empty input; more than 208,192 characters in all (four capped
   sections plus 8 KiB); a section over record-review's 50,000; a heading that
   appears twice; any of the four missing (with a note when an unclosed fence
   swallowed the rest); all four empty. No fuzzy matching, no `#`, `###`,
   bold or `Summary:` forms, no provider-specific behaviour, and no verdict or
   status extraction: "PASS", "Approved" and "Verified" stay as the reviewer's
   text.

7. **Prefill, then the developer saves.** A successful parse fills the four
   fields, replacing what they held, opens the form (in Add or Replace mode as
   the row stands) at Summary, and shows "Prefilled from structured review
   output — review before saving." — neutral about the source, since BugPilot
   only knows the text was pasted in the review's shape; with a lead-in, it adds
   "Text before the first section was left out." The live status says "Review
   result ready to save." Every field stays editable, a repeated push of the
   same answer does not refill it, and only **Save Review Result** records,
   through `record-review` exactly as for typed text — the existing Replace
   confirmation included. A failed parse is shown under the paste, which keeps
   its text; the form stays closed. Cancel empties the form and the "ready"
   status; another work item empties both the form and the paste. Parse waits
   while a save is in flight, and the host refuses a parse whenever a recording
   could not start. No auto-save exists; an opt-in setting to save completed
   structured reviews automatically stays deferred until completion,
   completeness and "no intermediate reply" could all be proven, which they
   cannot while the reply comes from a paste.

8. **Transient draft only.** The parsed review lives in the page's form until
   saved or discarded: no `review.json`, transcript, prompt copy or verdict file,
   nothing in `run.json`, and the saved `review_report.md` keeps its format
   (Source line "Recorded from an external review.").

9. **Form help.** Each review field has one line under its label, tied by
   `aria-describedby`: Summary — overall review conclusion in the reviewer's own
   words; Findings — specific problems, risks, omissions, or observations;
   Validation Notes — what the reviewer actually inspected or ran, not implying
   tests ran if they did not; Recommendations — suggested next actions. The
   label is "Validation Notes", matching the section.

10. **Verification form help.** Above the checks: "Record checks you actually
    performed and what you observed. BugPilot does not run these checks or
    infer the result. What a reviewer noticed while reading the change belongs
    in Review Result." Each field of each check has a described line — Name:
    what was checked; Status: the status you are recording for this check;
    Type: Automated, Manual or Other; Command / Procedure: the command you ran
    or the manual steps you followed; Evidence: the observed output or result
    supporting the recorded status; Notes: optional limitations or context.
    Examples are placeholders only (*Targeted unit tests*, *npm test*, *1285
    passed, 0 failed*; *Original bug reproduction*, *Repeat the reported
    workflow manually*, *The issue no longer reproduces*) and are never saved.
    A new check is still Not Run; statuses and types are unchanged.

11. **No verdict, anywhere.** No PASS / FAIL / Approved / Rejected / Safe to
    merge / Verified / Correct state for a review result, and every check
    Passed still reads only "All recorded checks passed." with the row and the
    header unchanged.

12. **Start New Attempt reads only saved records.** Use Review Findings is
    offered only while `review_report.md` is listed; a pasted review that was
    not saved offers nothing and is never used as feedback. Use Verification
    Evidence is unchanged (a check recorded as Failed or Not Run). Both copy
    text only when pressed.

### Confirmed decisions (Captured AI Review and Review with AI per fix)

The problem: Review with AI opened an interactive terminal, the reviewer's
structured answer existed only there, and the developer had to copy it, open
Paste Review Output and Parse before the form was anything but blank. And
"hidden after a start" had no answer to "which fix was reviewed?".

1. **A captured one-shot review for agents that have one.** `KnownAgent` in
   `extension/src/app/agents.ts` gains `capturedReview`, a
   `CapturedReviewInvocation` (fixed argv, how stdout is read); `resolveReviewer`
   picks it for the selected agent, otherwise the terminal plan `resolveAgent`
   made before. Claude Code has one, measured on 2.1.214:
   `claude -p --output-format json --no-session-persistence --setting-sources ""
   --strict-mcp-config --permission-mode dontAsk --tools Read Grep Glob Bash
   --allowedTools Read Grep Glob "Bash(git diff)" "Bash(git diff *)"
   "Bash(git status)" "Bash(git status *)" "Bash(git log *)" "Bash(git show *)"`.
   The canonical prompt (`review-package --json`, unchanged, never rebuilt in
   TypeScript) goes on stdin; cwd is the repository root; no shell, no terminal.

2. **The reviewer is read-only, and that is enforced, not asked.** Measured:
   `--allowedTools` alone is not a restriction — under the developer's own
   `auto` permission mode a probe with Write disallowed created a file through
   Bash. With the flags above the same probe's writes were all denied and
   `git diff` ran. `--setting-sources ""` and `--strict-mcp-config` keep the
   developer's and the repository's allow rules and MCP servers out of it.

3. **No terminal scraping, ever.** The reply is the process's own stdout:
   `--output-format json`'s one `type: "result"` object, whose `result` is the
   final answer only — tool logs and progress are not in it. Nothing reads a
   terminal buffer.

4. **Success needs all three** (`extension/src/app/reviewRun.ts`,
   `capturedReviewOutcome`): the process finished (not cancelled or timed out,
   exit code 0), the object is a success result (`is_error` false, `subtype`
   `success`), and the parser read the four sections. Exit code 0 alone is not
   success; a started process is not a finished review. Two neutral failures:
   *Review result could not be captured automatically.* (it finished, but the
   output was empty, not the result object, or did not parse) and *AI review did
   not produce a usable structured result.* (a non-zero exit, a timeout, an
   error result). Neither says the review or the fix failed.

5. **One parser for both paths.** The captured reply goes through
   `parseReviewOutput` exactly as a paste does; a test gives both the same text
   and compares the drafts. Leading chatter is left out and said. Two complete
   blocks, or a section repeated (the real transcript's doubled
   Recommendations), are refused as duplicates — never one picked. Headings in
   a code fence stay code. A reply that did not parse is kept, transiently, in
   Paste Review Output's box so a heading can be fixed and parsed.

6. **Prefill, never save.** A parsed reply is the host's draft
   (`ReviewPrefill` with `source: "ai"`), shown as *Prefilled from AI review —
   review before saving.* with *Review result ready to save.*; the form opens
   without taking the keyboard, since the reply arrives on its own. Every
   field is editable; only **Save Review Result** records, through
   `record-review`, with the existing Replace confirmation when a review is
   already saved. No auto-save, no `review_draft.json`.

7. **Draft lifetime.** The draft — captured or pasted — rides on every push
   until saved, discarded (Cancel sends `discardReviewDraft`) or no longer
   about the work item on screen (another work item, a run). A recreated
   webview fills its form again from it; a reload of the window loses it — the
   reply is not persisted anywhere. This replaces the one-push prefill of the
   Review / Verification UX Clarification block, decision 5; the paste path is
   otherwise unchanged.

8. **While it runs it is an operation.** `#mutation` gains `aiReview`: no run,
   Retry, Rebuild Context, handoff, Start New Attempt, Clean, recording or paste
   starts until the process exits, each told why; Review with AI cannot be
   pressed twice. A 15-minute timeout ends a reviewer that never answers.

9. **Custom agents are never captured.** A custom command is a shell template
   written for a terminal; running it for stdout would put the prompt into
   shell text. It gets the terminal and *When the reviewer replies, use Paste
   Review Output…*. Codex is reached only that way today, so it is not
   captured either; `HINT_PROVIDERS`' `codex exec -` is the hint improver's,
   not measured as a reviewer.

10. **Review with AI is offered once per fix.** The fix is `fix_report.md` by
    content (`fixReportIdentity`: SHA-256 of its text, line endings unified; an
    unreadable listed report is `unreadable`). A review attempt that *started*
    — a terminal opened, or the captured process launched — marks that identity
    for the work item. The button shows only while the current identity is
    unmarked and no attempt is starting or running. So it stays hidden through
    capture failure, parse failure, Save / Replace Review Result, Open Review
    Report, Paste Review Output, verification evidence, settings changes,
    Rebuild Context, and Start New Attempt on its own; it comes back when a new
    `fix_report.md` with different content is read. The same report written
    again, even with other line endings, is the same fix. A launch that never
    started — no agent, a refused prompt, a failed spawn — marks nothing, and
    the button stays.

11. **Where "reviewed" lives.** The host, never the webview and never the
    repository: VS Code's workspace state, key `bugpilot.reviewedFixes`, a map
    of work item → identity, the oldest forgotten after 200
    (`reviewedFixStore`). A reload, a restart or a reopen keeps the button
    hidden for a reviewed fix, and the row says *AI review already started for
    this fix* — the attempt's own progress and reply are session-only. No
    `review_state.json`.

12. **Review Again is not built.** A second review of the same fix is Paste
    Review Output (any reviewer) or a new fix. Arbitrary manual source edits are
    not detected: only a changed `fix_report.md` is a new fix.

### Confirmed decisions (Automatic Artifact Refresh)

The problem: an agent's `fix_report.md` was on disk while the Artifacts view
still said "not written yet" and Review with AI stayed hidden, until the window
was reloaded. Batch 8's decisions 5 and 6 (no file watcher; the existing reads
decide when a report becomes visible) are what caused it, and are replaced by
these for the artifact folder. Decision 5's other half stands: BugPilot still
never tracks an agent's process or terminal, and knows only what the files say.

1. **The artifact folder is the truth, and the panel follows it.** A change on
   disk in the shown work item's `.ai/<id>/` is re-read and re-rendered without
   a reload.

2. **One read path.** `Controller.refreshActiveWorkItem` re-reads the listing
   and the small files the rows use (`issue.json`, `retrieval.json`,
   `fix_report.md`, `review_report.md`, `verification_report.md`), recomputes the
   workflow — the fix report's content identity and so Review with AI — pushes
   the panel and refreshes the Artifacts and History trees. Every trigger goes
   through it: the watcher, the panel being shown again, an operation ending with
   an event pending, and the Refresh command.

3. **A scoped watcher.** The host's `watchArtifactDirectory` is a VS Code
   `FileSystemWatcher` on `RelativePattern(.ai/<id>/, "*")`: that directory's
   files, create, change and delete; not recursive, not the repository, nothing
   under `.git` or `node_modules`. The controller keeps exactly one: replaced
   when the shown work item or the repository changes (checked on every push),
   rebuilt after a run or a clean (which may delete and recreate the folder),
   disposed with the extension. An event from a replaced watcher, or about a
   work item no longer shown, changes nothing.

4. **Debounced.** Events closer than 250 ms (`ARTIFACT_REFRESH_DEBOUNCE_MS`)
   are one refresh.

5. **Never under an operation.** While a run, a handoff, a new attempt, an
   artifact write or a captured review is in flight, a scheduled refresh is held
   and remembered; the first push after it ends reads once. Nothing is started,
   cancelled or reset by a refresh, and a refresh writes nothing — so the files
   BugPilot writes itself (`record-review`, `record-verification`) cause one
   more read and no loop. `bugpilot list`, which the History tree runs, only
   reads.

6. **Missing is not unreadable.** A file the listing names that cannot be read
   while a reading of it was known (mid-write, locked), or a folder that cannot
   be listed while a listing was shown, keeps the last known state and is read
   once more 750 ms later (`ARTIFACT_REFRESH_RETRY_MS`); only a second failure
   is shown as one. A failed read is never a new fix.

7. **Review with AI follows content, not events.** A refresh recomputes the
   SHA-256 identity of `fix_report.md`: a changed report is a new fix and offers
   Review with AI again; the same report written again — any number of events,
   any mtime — keeps its reviewed state; a deleted one takes the row away. The
   Validation checklist, too, is dropped only when the report changed.

8. **Drafts survive.** A refresh pushes state; it does not rebuild the page. The
   page keeps what is being typed — the Review Result form and its host-held
   draft, Paste Review Output's text, verification rows, Start New Attempt's
   feedback, an unapplied Workflow Settings draft — and the focus. The host drops
   a review draft only when its fix report is gone.

9. **The safety net.** The webview is destroyed when hidden, and sends `ready`
   when shown again; that schedules a refresh, for an event the watcher missed.
   Nothing refreshes while the panel is hidden.

10. **No terminal lifecycle.** There is no hook for "the agent finished": the
    files changing are the signal. No new persisted file — no
    `artifact_state.json` or `watcher_state.json`.

11. **Diagnostics without content.** The output channel says when a watcher
    starts and is disposed, a refresh is scheduled (with the file name),
    deferred, retried and completed, and when the fix report became a new fix or
    went away. No file content, hint, review text or command is logged.

### Confirmed decisions (AI Review Progress Visibility)

The problem: after Review with AI the row said only "Reviewing…", with no
terminal, no agent named, no sign it was still alive and no way to stop it.

1. **Starting, then running, from the operating system.** The captured review
   is `starting` from the press until the child process has actually started
   (Node's `spawn` event, surfaced as `RunOptions.onSpawn` / the port's
   `onStarted`), and only then `reviewing`, with `startedAt`. The button reads
   *Starting AI review…* meanwhile; a command that never starts goes back to
   the button, and only a started process marks the fix as having had its
   attempt.

2. **The progress card.** While `reviewing`: *Reviewing with <agent>…* — the
   label the host resolved (`KNOWN_AGENTS`' `label`), or *Reviewing with AI…*
   when none is known — with an indeterminate codicon spinner; *BugPilot is
   running a read-only AI review in the background. This may take a minute.*;
   *Elapsed: 00:18* (h:mm:ss past an hour); **Show details** and **Cancel
   Review**. No percentage, no progress bar, no streamed tool output, no
   terminal: the agent exposes no meaningful progress, and inventing steps
   would be a claim BugPilot cannot back.

3. **The clock is presentation only.** The page ticks one interval, once a
   second, from the host's `startedAt` — so a recreated panel resumes rather
   than restarting at 00:00 — and clears it on any other state. It decides
   nothing: the host's 15-minute timeout (`CAPTURED_REVIEW_TIMEOUT_MS`) is the
   only one, and timer ticks cause no push and no artifact refresh.

4. **Details** (in place, not a modal; kept open across ticks and pushes,
   closed with the card): Agent, Mode (*Read-only background review*), Status
   (*Running*), Started (local time), Output format (the four sections). Never
   the prompt, the command line, the environment, credentials or file
   contents. Viewing the prompt is not added: Copy Review Prompt already gives
   it.

5. **Cancel Review** is a host action (`cancelReview`), offered only while
   `reviewing`. The host asks with the existing modal confirmation, both
   choices named — *Cancel current AI review? The current review result will
   be discarded.*, **Cancel Review** / **Keep Reviewing**, the latter the close
   affordance so Escape keeps the review — and on Cancel Review aborts the run:
   `Runner` ends the tree it started (`taskkill /pid <its pid> /T /F` on
   Windows, the process group elsewhere), never another Claude process.
   Output is discarded, no draft is made, nothing is saved; the row says
   *Review cancelled*, neutrally. A review that finished while the question was
   open is kept as it finished.

6. **Cancellation gives the button back; nothing else after a start does.**
   A cancel takes back the "reviewed" mark this attempt set, so Review with AI
   is offered again for the same fix. A launch that never started keeps it
   offered; a process failure, a parse failure, an empty result and a timeout
   — *AI review did not finish within the allowed time.* — keep it hidden, with
   Paste Review Output as the way on.

7. **Accessibility.** The status is the live region and changes only on a
   transition — started, result ready, cancelled, could not be captured — so it
   is announced once. The clock is outside it and never announced. The card
   carries `aria-busy` while running; the spinner is `aria-hidden`; Show /
   Hide details is a button with `aria-expanded`; everything is reachable by
   Tab.

8. **Narrow panels.** Buttons wrap; at 380px and below the details stack each
   label above its value, so no value is squeezed to a few letters a line.

9. **Diagnostics**: starting, process started, cancelled by the developer,
   completed with the result parsed, completed without a usable result, timed
   out — never the prompt or the reply.

### Confirmed decisions (Verification Evidence Auto-Save)

1. **Review Result keeps its Save; Verification Evidence saves itself.** A
   review result is a reviewer's conclusion, recorded when the developer says
   so. Verification evidence is structured data the developer is entering — the
   checks actually performed — and is written as it is entered.
   `verification_report.md` remains the one persisted record, written only by
   `bugpilot record-verification`; the Save Verification Evidence button is
   gone, and Cancel became **Done**.

2. **The host owns the draft and the save.** Every edit in the form — a field,
   a status, a type, Remove Check — sends the rows to the host
   (`verificationDraft { checks }`, bounded and validated like
   `recordVerification`). The host holds the latest draft for the work item it
   was typed for and saves it `VERIFICATION_AUTOSAVE_MS` (750 ms) after the last
   edit — one debounce, so a burst of typing is one write. Because the draft is
   the host's, a panel hidden mid-edit (its webview destroyed) still saves it.
   The page writes nothing and decides nothing.

3. **Only a valid draft is written.** Blank rows — an Add Check not yet used —
   are left out. No check at all writes nothing: no empty report is ever
   created, and a saved report is kept, never deleted, when every check is
   removed (the status says so). A check that cannot be recorded as it stands
   (no name; past the CLI's caps) is said — *Not saved yet: check 2 needs a
   name.* — and the draft stays, saved as soon as it is complete. A draft equal
   to what was last saved writes nothing.

4. **Save states** (`VerificationAutosave`, host-authoritative): absent
   (clean), `dirty` (*Unsaved changes*), `saving` (*Saving…*), `saved`
   (*Saved*), `incomplete` (why not, not an error), `error` (*Could not save
   verification evidence*, the reason, **Retry Save**), `conflict` (auto-save
   stopped). Edits made while a save is written are saved after it. The live
   region says only *Verification evidence saved.* and *…could not be saved.*;
   the reason is an alert; Saving… is never announced. A save neither closes
   nor resets the form, nor moves the keyboard.

5. **Replace only over the version the form last read or wrote.** The first
   save of a new form is a plain record (the CLI refuses if a report appeared
   meanwhile); after it, and after Edit loads a report, each save replaces the
   report only if its text is still the one the form last read or wrote — the
   existing Edit basis check. A report changed outside the form, or written
   meanwhile, is a `conflict`: nothing is written, the draft and the file on
   disk are both kept, and the developer chooses **Reload Saved Version** (Edit
   again) or **Overwrite Saved Version** (the form's checks, over the version
   there now).

6. **The watcher only confirms.** BugPilot's own write is seen by the artifact
   watcher and read back — a read-only refresh that changes no draft, no dirty
   state and no focus — and that text becomes the version the next save
   replaces. No save follows a refresh, so there is no loop.

7. **Nothing typed is dropped silently.** Opening another work item and
   starting a run save the draft first; if it cannot be saved, the developer is
   asked (*… could not be saved. Open the other work item anyway? They will be
   lost.* — the action / **Keep Editing**). A save held back by another write in
   flight is tried when that ends. A save still waiting when the extension
   itself shuts down is not started (a CLI spawned then may be cut off half-way).

8. **Done** saves anything still waiting and closes the form once it is saved;
   after a failure, a conflict or an incomplete check it stays open with the
   reason. A form nothing was typed into closes and the host drops its draft.

9. **Unchanged:** Not Run is the default status; statuses and types; the
   artifact format; no verdict — every check Passed is still only *All recorded
   checks passed.*; Use Verification Evidence reads only the saved
   `verification_report.md`, never the unsaved form.

10. **No Review Validation prefill exists** in this codebase; auto-save is
    draft-first (nothing is written until the debounce), so a future prefill
    would appear as unsaved changes the developer can edit before the first
    save.

### Confirmed decisions (Issue, Fix Mode and Hint as the problem's definition)

This revises the Workflow Settings Navigation decisions (§37.77), which had
moved Fix Mode and Hint onto the settings page.

1. **Issue, Fix Mode and Hint are the primary problem-definition controls on
   the main page**, together above the primary action, in reading and tab order:
   Issue (placeholder *Enter a Jira ticket (e.g. JR-12345) or describe the
   bug*, helper *Use a Jira issue ID, or describe the problem directly.*, tied by
   `aria-describedby`), Fix Mode (with its Manage Fix Modes gear and the mode's
   description), Hint (with Use issue details, Improve and the suggestion). Then
   Run, then the workflow rows.

2. **One place for each setting.** Fix Mode, Hint and Use issue details left
   the settings page; `SettingsField` excludes them, and Fix with AI's section
   is the AI agent and the custom agent command only. Its note is now *Changes
   here apply to the next run and do not require rebuilding context.* — no
   section is mixed, so no setting carries its own "Requires context rebuild"
   label. The Fix with AI row's summary is the agent alone ("Claude Code"); the
   line beside the Workflow Settings entry that named a non-default Fix Mode is
   gone, since the selector is in plain view.

3. **Form fields, not a draft.** They are read from their controls like the
   Issue and sent with every form change (`formChanged`); the settings page's
   Apply / Cancel draft no longer covers them, and an Apply sends them as they
   stand on the form. Use Improved puts the suggestion into the Hint and sends
   the form, as typing would. Nothing starts a run.

4. **Staleness is unchanged.** `preparationFingerprint` still includes the Fix
   Mode and the Hint and not Use issue details, so an edit of either makes a
   prepared context stale — the button becomes Rebuild Context — exactly as
   before, and reverting it makes the context current again.

5. **Where focus goes.** A problem with the chosen mode lands on the selector
   on the form (once per problem, again after a refused press); returning from
   Manage Fix Modes lands on its gear beside the selector.

### Confirmed decisions (Repository Files quick fix)

1. **Repository Files diagnostics provides a one-click quick fix to add `.ai/`
   and `.ai_memory/` to the repository `.gitignore`.** A secondary button, *Add
   to .gitignore* (accessible name *Add .ai and .ai_memory to .gitignore*), on
   the existing card; the warning's text is unchanged.

2. **One answer about what is ignored: git's.** `doctor` reports, beside
   `ai_artifacts_ignored`, `ai_artifacts_ignored_paths` — `{".ai": bool,
   ".ai_memory": bool}` from the same `git check-ignore` probe — and the fix
   adds a rule only for a directory it says is not ignored. `.ai`, `/.ai/`, a
   rule in `.git/info/exclude` or a global excludes file count as they do for
   git. A CLI without the per-directory field gets the warning and no button:
   the extension does not guess from the file's text.

3. **Only `<repository root>/.gitignore`, only appended.** The root the
   diagnostics ran in; never a global, parent or nested ignore file, and never
   through a symbolic link. A missing file is created with exactly `.ai/` and
   `.ai_memory/`. An existing one keeps every byte; the new lines start on a line
   of their own, in the file's line ending (its first), with no comment — BugPilot
   has no convention of generated comments. A rule already a line of the file is
   not written again, so the fix is idempotent. No shell: VS Code's file system
   and editor APIs.

4. **Never behind unsaved edits.** An open `.gitignore` is edited through a
   `WorkspaceEdit`. A clean one is then saved (the save writes the disk's text
   plus the lines); a dirty one keeps the developer's edits in its buffer with
   the lines after them, is not saved, and the card says to save it. Saving the
   root `.gitignore` re-checks the diagnostics.

5. **The warning goes when git says so.** After a write the host runs `doctor`
   again — a probe that starts after the write — and the card disappears only if
   git now ignores both. Otherwise it stays, with *The rules are in .gitignore,
   but Git still does not ignore …* and no button. A failed write keeps the card
   with *Could not update .gitignore.* and the button, and logs the reason and the
   path to the BugPilot output — never the file's contents.

6. **Host authoritative.** The page sends `{ type: "action", id:
   "addArtifactsToGitignore" }` and renders what comes back: the card's action
   (busy while it runs, `aria-disabled` so the focus stays) and status, and on
   success a line under the notices that takes the focus if the button had it.

### Confirmed decisions (Investigation & AI Fix visual simplification)

This refines the row design of §16 and the Batch 6 result rows; it changes how
workflow state is shown, not the state.

1. **The left checkbox represents workflow enablement**, and only that: ticked,
   the step runs; unticked, it is skipped. Its behaviour is unchanged, and it is
   the row's only check-mark control.

2. **The right-side completion check icon is removed.** The filled check
   (`codicon-pass-filled`) on finished rows and the prohibition circle on
   skipped ones are gone; the glyph is no longer vendored.

3. **Workflow state uses status text and a small dot.** The host sets one
   `statusText` per row — Completed, Skipped, Running, Failed, Context ready;
   Ready for a task to hand over, Started for a handoff, Report available for
   Fix result — and the page draws it after the duration, with a 6px dot in the
   status's theme tone (success, accent, muted, error) or, while running, the
   spinner instead of the dot. The words are authoritative and are in the row's
   accessible name; the mark is `aria-hidden`. High Contrast rings the dot.

4. **Each row shows its status only once.** `summary` no longer restates the
   status: the model blanks it when it would say the same thing (Completed,
   Skipped, Context ready, Ready, "AI fix started", "Fix report available").

5. **The second line is reserved for additional useful information** — what a
   pending step does, what a running one is doing, what a finished one produced
   ("Manual bug description", "11 terms · 6 relevant files"), a failure's reason
   ("Did not start") — and is omitted when there is none. The artifact link is
   its own line under the row's text, never in the metadata.

6. **First line: choice, then metadata.** Checkbox and name, then duration,
   status and gear as one cluster that wraps under the name when the row is
   narrow; the name keeps an 8em floor and never breaks between letters. Gears
   only on rows with settings (not Git history or Similar fixes). Rows are
   separated by a lighter rule (the panel border at 55%, full strength in High
   Contrast) and a little more padding.

7. **The context-ready hint is short:** *Context ready. Next: Fix with AI.*

### Confirmed decisions (Open AI Session acknowledgement)

1. **Open AI Session focuses an existing BugPilot-owned session and provides
   visible acknowledgement even when the session is already open.** The lookup
   is unchanged — the newest open terminal this panel named for the work item's
   handoff — and nothing is started, relaunched, restored or recreated.

2. **The host answers; the page shows.** The page sends the intent
   (`nextAction: openSession`); the controller reveals the terminal and sets
   `PanelState.sessionFeedback {kind, message, seq}`:
   - `focused` — *AI session focused*, for 1.8s (`SESSION_FEEDBACK_MS`);
   - `unavailable` — *AI session is no longer available — its terminal was
     closed. To continue, use ⋯ → Start New Attempt.*, or *…no longer available
     in this window…* for an attempt this window never saw start;
   - `failed` — *Could not open the existing AI session.* when the reveal
     throws; logged, and nothing else changes.
   The latter two stay until the next press. The notification toasts they
   replace are gone.

3. **No "already open" variant.** VS Code's `activeTerminal` is the terminal
   panel's current tab whether or not the panel is shown, so it cannot tell
   "brought forward" from "already in front"; every successful reveal says
   *AI session focused*.

4. **One acknowledgement, one timer.** A press replaces the last message and
   cancels its timer; the timer is cancelled on dispose; the message goes when
   a new session is opened, the work item changes, or Open AI Session is no
   longer offered (a run, a rebuild). Presentation only: never persisted, never
   an artifact, never a change to the attempt or the rows.

5. **Accessible without moving focus.** `#session-feedback` is a polite live
   region always in the document (empty, so no height, until answered), under
   the button; its text changes only when a new press is answered, so a redraw
   does not announce it again. The page never moves the keyboard focus; the
   terminal takes it because focusing it is the action.

### Confirmed decisions (Flat Artifacts list)

1. **Artifacts uses one flat user-facing list.** The files are the view's
   direct children, under the view's own title and the work item beside it.

2. **Internal generation categories are not exposed as second-level tree
   nodes.** "Hand off to an agent", "Agent results", "Investigation", "Run
   state" (and the phase-era "Second attempt", "Copilot handoff") are gone; the
   canonical / side-band distinction stays in the model, never in the tree.

3. **Each artifact has a clear plain-language purpose description**, from one
   map, `ARTIFACTS` in `src/app/artifacts.ts` — order, description, whether it
   is canonical, and what writes it (for the tooltip of a file not written
   yet). A file it does not know is an *Additional BugPilot artifact*.

4. **Known artifacts use workflow-oriented ordering:** `issue.json`,
   `context.md`, `task.md`, `fix_report.md`, `review_report.md`,
   `verification_report.md`, `retrieval.json`, `run.json`; then side-band
   files once present (`user_feedback.md`, `agent_retry_prompt.md`,
   `jira_comment_draft.md`, `jira_comment_post_result.json`, `email_draft.md`,
   `notification.eml`, `jira_field_report.md`); then unknown files by name.

5. **Availability once per row.** The eight canonical files are always listed,
   *Written* or *Not written yet* — never "missing"; the review and the
   verification reports included, which the grouped tree left out until saved.
   A row's description is `<status> · <purpose>` (status first, so a narrow
   sidebar keeps it), its tooltip the name, the purpose, `Status: …` and what
   writes it; its accessible name `<name> — <purpose> — <status>`. Only a
   written file has a click command; the file type is the icon.

6. **The contract is checked, not copied.** The canonical set is compared with
   every `*_ARTIFACT` constant in `bugpilot/core/artifacts.py`; the Copilot-era
   `RESULT_FILES` list is gone, and Python's required result files are checked
   to be canonical instead.

### Confirmed decisions (Fix result Show more / Show less)

1. **Fix result summaries use a bounded collapsed preview with explicit Show
   more / Show less for long content.** Collapsed, the summary is clamped to
   three lines and the Tests line to two; **Show more** — a link-style button
   on its own line under them, above `fix_report.md` — appears only when one of
   them is actually cut short (measured: `scrollHeight > clientHeight`). Short
   results show whole, with no control. The clamp is a class set only while
   collapsed; no rule clips the lines otherwise.

2. **Expanded shows everything and says Show less**; collapsing keeps the button
   in view and the focus on it. Nothing opens and nothing is sent to the host.

3. **Presentation only, keyed by the result.** The page holds it, keyed by the
   work item and the report's summary and Tests lines: any other update and any
   artifact refresh keep it; a new result, another work item or a recreated
   panel start collapsed. Never persisted.

4. **Width.** A `ResizeObserver` on the two lines re-checks only while
   collapsed — so the control appears when a narrower panel starts cutting the
   text, a row first shown hidden is measured when it appears, an expanded
   result stays expanded across a resize, and the toggle's own change cannot
   loop. Prose wraps between words; `overflow-wrap: anywhere` breaks only a
   token too long for the line.

5. **Accessible.** A real button, `aria-expanded`, `aria-controls` both lines,
   accessible names *Show full Fix result* / *Collapse Fix result*. The clamp is
   visual: the full text is the elements' text (and title) either way.

### Confirmed decisions (Artifacts tooltips and the tooltip audit)

This revises decision 5 of "Confirmed decisions (Flat Artifacts list)".

1. **Artifacts shows only filename + availability inline.** A row's
   description is *Written* or *Not written yet* and nothing else.

2. **Artifact purpose moves to tooltip/accessibility metadata.** The tooltip is
   the full file name (which a narrow sidebar may cut), the purpose,
   `Status: …`, and for a file not written yet what writes it; the accessible
   name stays `<name> — <purpose> — <status>`. The purposes are shorter now:
   *Prepared context used by the AI*, *Summary of the AI fix and changes*,
   *Saved review findings*, *Recorded verification checks*, *Investigation and
   retrieval details*, *Workflow execution metadata* (the rest unchanged).

3. **Tooltips are added selectively to compact/ambiguous controls across the
   extension**, as `title` on the page and `TreeItem.tooltip` in the trees —
   never a custom framework, never the only accessible name, sentence case, one
   line:
   - icon-only controls keep a tooltip equal to their `aria-label`; the Fix with
     AI gear is *Configure AI Agent* (its section is the agent's alone since
     §37.84);
   - the primary button has one only when its label is shorter than its
     meaning — *Focus the existing BugPilot AI terminal* for Open AI Session,
     *Rebuild prepared context from the current settings* for Rebuild Context —
     and the ⋯ menu items use the same words, Start New Attempt *Start a new AI
     session using the current prepared context*; Run and Fix with AI have none;
   - *Open context*, *Copy context*, *Improve this hint with AI*, *Stop the
     current background AI review*, *Show / Hide AI review details*, *Show full
     / Collapse Fix result*, *Remove this verification check*, *Remove
     <file>* for an attachment, and the quick fix's accessible name;
   - values an ellipsis can cut carry their whole text: a row's settings
     summary, the chosen Fix Mode's name, the chosen agent's name (never a
     custom command line).
   Controls whose label or helper text already says it — Issue, Fix Mode,
   Hint, Use issue details, Workflow Settings, Save / Cancel / Apply, Run, Fix
   with AI — get none.

### Confirmed decisions (Advanced Settings)

This renames and moves the entry of "Confirmed decisions (Workflow Settings
Navigation)" (§37.77); the page and what it edits are unchanged.

1. **Workflow Settings is now Advanced Settings** — the entry's label, the
   page's heading, and every message that sends the developer there ("…in
   Advanced Settings → Fix with AI"). Most settings are reached from the step
   gears; what the entry opens is the rest. Ids (`open-settings`,
   `workflow-settings-view`) and the module name stay.

2. **With the inputs, not the results.** The entry sits under Run and its hint,
   above the Investigation & AI Fix disclosure — after Issue, Fix Mode and Hint,
   before the workflow — and no longer between Open Folder / Fix result and
   Diagnostics, where it read as part of the review. Not beside Run: at 200px
   the button row has no room for it.

3. **Quiet.** A link-style gear and label in the description colour, underlined
   on hover — no border, no fill, never primary. Its accessible name is its
   visible text, *Advanced Settings*; its tooltip *Open advanced workflow
   settings*. It wraps between words at 200px, never inside one.

### Confirmed decisions (Hint actions)

1. **Hint actions use explicit user-facing wording: Improve with AI, Include
   issue details** (were *Improve* and *Use issue details*). The busy label
   stays *Improving…*.

2. **Improve with AI is shown before Include issue details** because it is the
   immediate action, while Include issue details is a persistent input option.
   The order is the markup's, so the tab order is Hint → Improve with AI →
   Include issue details; no CSS reordering.

3. **The helper belongs to the checkbox.** *Includes only the issue title and
   description. Repository files and history are not read.* sits under the
   checkbox in one group (`.hint-include`, a 14em floor), tied by
   `aria-describedby`; at 200px the group wraps whole under Improve with AI.

4. **Tooltips and names.** Improve with AI: *Improve this guidance with AI while
   preserving your intent*, its visible text its accessible name. Include issue
   details: *Include the current issue title and description in the AI
   guidance* on its label, the label text its accessible name. The Hint field
   gains none.

5. **No behaviour change.** The same `improveHint` request with the form as it
   stands; `useIssueDetails` stored and sent as before; neither control changes
   the other.

---

# 20. Step Secondary Text 状态原则

每个 step 的 secondary text 必须随 state 改变。

例如：

```text
PENDING
Code search
Search relevant code in the repository
```

↓

```text
RUNNING
Code search
Searching repository…
```

↓

```text
COMPLETED
Code search
11 terms · 6 relevant files
```

适用于：

```text
Issue details
Code search
Git history
Similar fixes
Build context
Fix with AI
```

完成后显示结果，不再持续显示“准备做什么”。

---

# 21. Extension 对新 Artifact Contract 的使用

最终必须变成：

```text
Context Ready
→ context.md + retrieval.json

Relevant Files
→ retrieval.json.related_files

Search Details
→ retrieval.json.terms

Open Context
→ context.md

Copy
→ context.md

Fix with AI
→ task.md
```

删除 Extension 对旧文件的 live references：

```text
bug_context.md
related_files.json
search_quality.json
agent_task.md
agent_handoff.md
workflow_status.json
execution.json
```

不保留 fallback。

---

# 22. Legacy Artifact Removal

生产代码中不再生成或读取：

```text
jira*
jira_parsed*
jira_summary*
bug_spec*
developer_hint*
fix_mode*

extracted_keywords*
code_search*
search_quality*
related_files*

bug_analysis*
bug_context*

agent_task*
agent_handoff*
agent_team_instructions*

execution*
workflow_status*

diff_summary*
fix_summary*
review_notes*
test_result*
```

根据真实 suffix/filename 精确处理。

历史 development plan 中可以提到旧名字，但 live production code 不应保留旧 contract。

---

# 23. Resume

Resume 仅支持新 artifact contract。

依据：

```text
run.json
issue.json
retrieval.json
context.md
task.md
```

更新 resume tests。

删除只为 legacy artifact compatibility 存在的 tests。

---

# 24. Atomic Writes

继续使用已有 atomic-write infrastructure。

特别是：

```text
issue.json
retrieval.json
run.json
```

不要因为 consolidation 退化 crash safety。

---

# 25. JSON Schema Version

所有 canonical JSON artifact 包含：

```json
{
  "schema_version": 1
}
```

这是新 contract 的显式内部版本号。

当前阶段不实现 migration。

---

# 26. 实施顺序

严格按以下顺序：

```text
1. Inventory current artifact writers/readers

2. Define canonical 5+1 artifact contract

3. issue.json consolidation

4. retrieval.json consolidation

5. context.md consolidation

6. task.md consolidation

7. run.json consolidation

8. fix_report.md consolidation

9. Remove all legacy writers/readers

10. Update resume to new contract

11. Migrate Extension to canonical artifacts

12. Introduce WorkflowStepResult model

13. Issue Details result integration

14. Code Search integration
    - summary
    - Relevant Files
    - Search Details

15. Git History integration

16. Similar Fixes integration

17. Build Context integration
    - context.md
    - Open Context
    - Copy

18. Fix with AI integration
    - task.md
    - Ready
    - Busy
    - Success
    - Error

19. Change workflow disclosure lifecycle
    - open while Run is executing
    - remain open after Run

20. Remove standalone duplicate UI
    - Relevant Files
    - Retrieval Details
    - external Context actions
    - external Fix with AI

21. Simplify outer Context Ready area

22. Visual review
    - 200 / 300 / 400
    - Dark / Light

23. Full regression verification

24. Real scratch prepare-only E2E

25. Final whole-diff review

26. Freeze + commit
```

---

# 27. Acceptance Criteria

本阶段完成必须满足：

1. Normal prepare-only 标准 BugPilot artifact = **5 files**。
2. Post-fix 最多额外有 `fix_report.md`。
3. 没有 legacy artifact 被生成。
4. 没有 legacy reader/fallback/dual-write。
5. 每个主要 artifact 有明确 workflow owner。
6. `Relevant Files` 只显示在 `Code search` 中。
7. `Search Details` 只显示在 `Code search` 中。
8. `Open Context / Copy` 位于 `Build context` 中。
9. `Fix with AI` action/status 位于 `Fix with AI` step。
10. `run.json` 只承担 runtime state，不作为普通结果 row。
11. Run 开始后 workflow 自动展开。
12. Run 完成后 workflow **保持展开**。
13. 外部不再有重复 Relevant Files / Retrieval Details / Fix with AI。
14. Context Ready 只承担整体状态，不重复 step details。
15. Existing click-to-open security 不退化。
16. Existing Better Error UX 不退化。
17. Handoff success 仍只表示 terminal/handoff started。
18. Extension UI 不再依赖旧 artifact filenames。
19. Resume 只理解新 artifact contract。
20. Artifact root 不再增长成 20+ 个 BugPilot 标准文件。

---

# 28. Artifact Contract Regression Test

必须增加高层 E2E 测试：

正常 prepare-only 最终目录**精确**包含：

```text
issue.json
retrieval.json
context.md
task.md
run.json
```

并明确断言代表性旧文件不存在。

这是产品级 requirement，而不只是 implementation detail。

---

# 29. Workflow UI Regression Tests

至少覆盖：

```text
Issue details
→ 完成后显示 issue result

Code search
→ summary
→ Relevant Files
→ Search Details

Git history
→ completion summary/details

Similar fixes
→ completion summary/details

Build context
→ Open Context
→ Copy

Fix with AI
→ Ready
→ Busy
→ Success / Error
```

并验证 standalone duplicate sections 已删除。

---

# 30. Visual Review

使用现有 ignored：

```text
extension/.review/
```

仅作为本地 visual harness。

不要 productize / commit harness。

至少检查：

```text
Initial
Running
Context Ready
Code Search expanded
Relevant Files expanded
Search Details expanded
Build Context
Fix Ready
Fix Busy
Fix Success
Fix Error
```

×：

```text
Dark / Light
200 / 300 / 400
```

目标：

```text
0 horizontal overflow
```

重点观察：

- workflow 是否过长
- nested disclosures 是否清晰
- relevant file path wrapping
- Search Details density
- Build Context actions
- Fix with AI CTA hierarchy

---

# 31. Verification

最终运行：

```text
Python full test suite
Extension full test suite
npx tsc --noEmit
npm run smoke
python -m pytest -q tests/test_publishable.py
git diff --check
```

并运行真实/scratch：

```text
bugpilot ... --prepare-only
```

人工检查最终 artifact 目录和内容。

---

# 32. Final Review

最终 whole-diff review 分类：

```text
BLOCKER
IMPORTANT
MINOR
```

重点检查：

- no old writers
- no old readers
- no dual-write
- no fallback
- no duplicate UI
- resume coherent
- new artifact schema complete
- workflow result lifecycle coherent
- Extension artifact reads coherent
- no publishability leakage
- no security regression

只修 correctness / security / clear UX regressions。

不要在 final review 阶段再扩 scope。

---

# 33. Final Freeze State

完成后记录：

```text
Artifact Simplification + Workflow Result Integration
Status: COMPLETE / FROZEN
```

明确记录：

```text
Before:
20+ standard artifacts

After:
5 core artifacts
+ optional fix_report.md
```

并明确：

```text
No backward compatibility intentionally provided because BugPilot is pre-release.
```

---

# 34. Suggested Commit

完成 full verification 后：

```text
refactor: simplify BugPilot artifacts and workflow results
```

不要 amend 之前的 UI commit。

不要 push，除非明确要求。

---

# 35. Design Rule for Future Work

以后增加任何 workflow capability 时，都遵循：

```text
Workflow step
    ↓
owns a canonical artifact or typed result
    ↓
shows its own result
    ↓
owns its own actions
```

避免重新出现：

```text
step 在一个位置
结果在另一个位置
artifact 在第三个位置
action 在第四个位置
```

这条原则是后续 BugPilot UI 和 artifact architecture 的长期参考。
