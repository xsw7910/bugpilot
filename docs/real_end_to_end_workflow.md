# Real End-to-End Workflow

This workflow is for a real Jira-backed trial from the target product repository root. It keeps bugpilot as the deterministic context and workflow tool, while the AI agent remains the manually launched coding agent.

## Step 1: Run From Target Product Repo Root

```powershell
cd C:\path\to\your\product\repo
```

Generated `.ai` and `.ai_memory` files are written relative to this directory.

## Step 2: Check Environment

```powershell
bugpilot doctor
```

Confirm Python, git, ripgrep, Jira environment variables, and Copilot CLI availability.

## Step 3: Validate Jira

```powershell
bugpilot jira-validate JR-23110
```

This validates real Jira field mapping and generates Jira summary/parsing diagnostics without running code search or agent task generation.

## Step 4: Prepare Workflow Package

```powershell
bugpilot bug JR-23110
```

Real Jira is the default. Mock fallback requires `--allow-mock`. The `bug` command is fresh by default; use `--resume` only when continuing existing artifacts.

## Step 5: Inspect Generated Context

Review the generated files:

```text
.ai/JR-23110/jira_summary.md
.ai/JR-23110/jira_parsed.md
.ai/JR-23110/code_search.md
.ai/JR-23110/search_quality.json
.ai/JR-23110/bug_context.md
.ai/JR-23110/agent_task.md
```

Confirm the data source is Jira, the parsed details are useful, and search confidence makes sense before handing work to the agent.

## Step 6: Optional Agent Handoff

Open your AI agent from the same target repo root:

```powershell
copilot
```

Paste:

```text
Read .ai/JR-23110/agent_task.md and complete the workflow.
```

The agent should generate:

```text
.ai/JR-23110/bug_analysis.md
.ai/JR-23110/fix_summary.md
.ai/JR-23110/test_result.md
.ai/JR-23110/diff_summary.md
.ai/JR-23110/review_notes.md
```

After completing the workflow, the agent may show a delivery summary and ask:

```text
Do you want me to commit and push this branch to origin?
```

Only approve this if the branch is safe to deliver. The agent must not push `main` or `master`, must not force push, must not commit `.ai/` or `.ai_memory/`, and must not update Jira.

## Step 7: Result Processing

If the agent needs another attempt, add feedback and generate a retry prompt:

```powershell
bugpilot retry-prompt JR-23110
```

Edit:

```text
.ai/JR-23110/user_feedback.md
```

Then run the agent manually from the target repo root and paste:

```text
Read .ai/JR-23110/agent_retry_prompt.md and continue the workflow.
```

If the developer fixed the issue manually, generate result templates instead:

```powershell
bugpilot manual-result JR-23110
```

Existing result files are preserved unless `--overwrite` is explicitly used.

```powershell
bugpilot check-results JR-23110
bugpilot summarize-results JR-23110
bugpilot memory update JR-23110
bugpilot review-package JR-23110
```

Review generated result and validation files before preparing any Jira comment.

## Step 8: Jira Comment Draft

```powershell
bugpilot jira-comment-draft JR-23110
```

This creates a local draft only:

```text
.ai/JR-23110/jira_comment_draft.md
```

## Step 9: Preview Jira Comment

```powershell
bugpilot jira-comment JR-23110
```

Preview mode does not call Jira and does not write a comment.

## Step 10: Execute Jira Comment Write-Back

Only after reviewing the draft:

```powershell
bugpilot jira-comment JR-23110 --execute
```

This posts exactly one Jira comment from the local draft. It does not update status, assignee, priority, fields, or attachments.

## Step 11: Confirm Jira Safety

Confirm manually:

- Exactly one comment was added.
- Status is unchanged.
- Assignee is unchanged.
- Priority is unchanged.
- Fields are unchanged.
- No attachments were uploaded or downloaded.
