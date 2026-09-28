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
