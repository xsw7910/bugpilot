# Workflow Overview

```text
Jira Issue
  |
  v
bugpilot jira-validate
  |
  v
bugpilot bug
  |
  v
fetch / parse / keywords
  |
  v
Code Search + Memory Search + Git Context
  |
  v
bug_context.md
  |
  v
agent_task.md + agent_handoff.md + agent_team_instructions.md
  |
  v
The AI agent manual handoff
  |
  v
bug_analysis.md / fix_summary.md / test_result.md / diff_summary.md / review_notes.md
  |
  +-- optional retry-prompt + user_feedback.md
  |
  +-- optional manual-result templates
  |
  v
check-results / summarize-results
  |
  v
memory update
  |
  v
review-package
  |
  v
jira-comment-draft
  |
  v
jira-comment preview
  |
  v
jira-comment --execute
  |
  v
delivery-check / commit-plan / push-plan
```

## Stages

### Jira Issue
The workflow starts from a Jira issue key such as `JR-12345`. The default workflow requires real Jira and does not fall back to mock data. If Jira is not configured or fetch fails, the command stops clearly. Use `--allow-mock` only for demo/testing fallback with clearly marked mock/demo data.

### Jira Validate
`jira-validate` checks real Jira field mapping before the full workflow. It does not run code search, generate the agent tasks, or write Jira.

### Bug Workflow
`bug` runs the main fresh prepare workflow by default. It fetches real Jira, parses context, searches code and memory, builds the agent package, and writes generated artifacts under `.ai/<issue>/`.

### Fetch, Parse, Keywords
bugpilot collects Jira content, converts Jira Cloud ADF descriptions/comments into readable Markdown, writes summary files, and extracts high-value and normal keywords for search. Jira integration remains read-only. The recommended real Jira path is `bugpilot bug REAL-ISSUE`; the equivalent explicit form is `bugpilot bug REAL-ISSUE --fresh --no-mock`. Use `bugpilot jira-validate REAL-ISSUE` to validate Jira field mapping before running the full workflow; it writes `jira_summary.md`, `jira_parsed.md`, and `jira_field_report.md` without running code search or generating agent tasks.

### Code Search, Memory Search, Git Context
The tool searches source files with ripgrep, ranks related files, assesses search confidence, searches prior issue memory under `.ai_memory`, and captures branch/status/history information with read-only git commands.

### Bug Context
`bug_context.md` combines Jira details, keywords, related files, search quality, snippets, historical issues, and git context into one file for AI-assisted investigation.

### Agent Task And Handoff
`agent_task.md` gives the agent strict instructions, required inputs, search-confidence cautions, safety rules, and expected output files. `agent_team_instructions.md` gives stable team rules for legacy C++/Qt work. `agent_handoff.md` is the short instruction a developer can paste into their AI agent.

### Agent Manual Handoff
The developer runs the AI agent manually from the target repo root. bugpilot does not invoke an agent automatically. Generated the agent instructions can optionally ask the developer whether to commit and push after the result files and delivery summary are complete; the agent may do so only after explicit approval and must never push main/master, force push, commit `.ai/` or `.ai_memory/`, or update Jira.

### Result Files
After the agent completes the work, it should write `bug_analysis.md`, `fix_summary.md`, `test_result.md`, `diff_summary.md`, and `review_notes.md` under `.ai/<issue>/`.

### Retry Or Manual Result
If the first attempt is incomplete, `retry-prompt` creates `user_feedback.md` when needed and generates `agent_retry_prompt.md` for a manual second agent attempt. If the developer fixes the bug manually, `manual-result` creates result templates so the same summary, memory, review, and Jira comment draft workflow can continue.

### Check And Summarize Results
`check-results` verifies the expected agent result files. `summarize-results` creates `result_summary.md` and `manual_validation.md` from those files.

### Memory Update
`memory update` records the final result in `.ai_memory/bugs/<issue>.md` so future similar issues can reuse the investigation.

### Review Package
`review-package` creates a final review prompt for an AI or human reviewer to inspect the current git diff and result package.

### Jira Comment Draft
`jira-comment-draft` creates a local markdown draft for a Jira update from existing bugpilot artifacts. It is reviewable text only and does not post to Jira.

### Jira Comment
`jira-comment` previews the local draft by default. `jira-comment --execute` posts exactly one Jira comment when Jira credentials are configured; it does not update Jira fields, transition status, assign the issue, upload or download attachments, call an agent, or run git commands.

### Delivery Planning
`delivery-check`, `commit-plan`, and `push-plan` help prepare manual delivery. bugpilot itself does not commit, push, merge, or create PRs.
