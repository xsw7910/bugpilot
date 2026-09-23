# bugpilot Prototype Development Plan

## 1. Overview

This document defines a prototype development and implementation plan for **bugpilot**, an internal AI-assisted development workflow tool.

The goal of this prototype is to demonstrate an end-to-end workflow that connects:

```text
Jira issue → code search → shared AI memory search → AI-ready context →
The AI agent task → git branch → bug analysis → code fix → test/review notes →
shared AI memory update
```

This prototype is not intended to be a final production-quality platform. The main goal is to make the workflow runnable, explainable, safe, and demo-ready.

---

## 2. Prototype Name

The tool name is:

```bash
bugpilot
```

Example command:

```bash
bugpilot bug JR-12345
```

---

## 3. Demo Jira Item

The prototype demo Jira item is:

```text
JR-12345
```

All generated output should use this Jira key in paths, prompts, branch names, and memory entries.

---

## 4. Branch Naming Convention

The branch name should use this format:

```text
feature/JR-12345-<description>
```

Demo branch:

```bash
feature/JR-12345-<summary-slug>
```

Rules:

```text
- Use the Jira key as the first part after feature/.
- Convert description to lowercase.
- Replace spaces and special characters with hyphens.
- Keep the branch name reasonably short.
- Do not create branch from a dirty working tree.
- Do not directly modify main/master.
```

---

## 5. Prototype Goal

The prototype should prove that a developer can run a single command and produce a useful AI-assisted development package.

Default safe command:

```bash
bugpilot bug JR-12345
```

Expected result:

```text
1. Fetch Jira issue content.
2. Extract useful keywords.
3. Search related code.
4. Search shared AI memory.
5. Build AI-ready bug context.
6. Generate the AI agent task prompt.
7. Generate analysis/fix/review/test prompts.
8. Save workflow status and execution log.
9. Save investigation result to shared AI memory.
10. Print the next agent instruction for the developer.
```

Optional experimental command:

```bash
bugpilot bug JR-12345 --agent-fix
```

Expected behavior:

```text
1. Run the same preparation workflow.
2. Try to invoke an agent CLI if supported.
3. If automatic invocation fails, fall back to prepare-only mode.
4. Ask developer to manually run the AI agent with .ai/JR-12345/agent_task.md.
```

---

## 6. Core Design Principle

The prototype should preserve a clean boundary between deterministic automation and AI-driven work.

```text
bugpilot responsibilities:
- deterministic workflow orchestration
- Jira fetching
- Jira parsing
- keyword extraction
- code search
- memory search
- context generation
- prompt generation
- execution logging
- workflow status tracking
- memory storage

The AI agent responsibilities:
- git status inspection
- branch creation or branch switching
- bug analysis
- source code inspection
- source code editing
- focused test execution
- diff summary generation
- fix summary generation
- review notes generation
```

This keeps `bugpilot` predictable and auditable while allowing the AI agent to perform AI coding tasks.

---

## 7. High-Level Architecture

```text
Developer
   |
   | bugpilot bug JR-12345
   v
bugpilot CLI
   |
   |-- Doctor / Environment Check
   |
   |-- Jira Client
   |     Fetch Jira issue, comments, metadata
   |
   |-- Jira Parser
   |     Extract summary, reproduction info, missing info
   |
   |-- Keyword Extractor
   |     Extract capped and ranked keywords
   |
   |-- Code Search
   |     Use ripgrep to find related files and snippets
   |
   |-- Memory Search
   |     Search previous AI bug investigations
   |
   |-- Context Builder
   |     Build bug_context.md with context quality score
   |
   |-- Prompt Builder
   |     Build agent task prompt and review/test prompts
   |
   |-- Workflow Logger
   |     Write execution.log and workflow_status.json
   |
   |-- Memory Store
   |     Save bug investigation to shared markdown memory
   |
   |-- Optional Agent Runner
         Try to invoke an agent CLI, otherwise fall back to prepare-only
```

---

## 8. Recommended Repository Structure

Use a moderate modular structure from the beginning. Avoid both extremes: do not create a large overdesigned framework on day one, but also avoid a single large script that becomes hard to maintain.

Recommended structure:

```text
tools/bugpilot/
  README.md
  pyproject.toml

  bugpilot/
    __init__.py
    __main__.py
    cli.py

    core/
      config.py
      doctor.py
      jira.py
      keywords.py
      search.py
      memory.py
      git_ops.py
      context.py
      prompts.py
      copilot.py
      workflow.py
      logging_utils.py

    templates/
      bug_context_template.md
      copilot_task_template.md
      copilot_analysis_prompt.md
      agent_fix_prompt.md
      review_prompt.md
      test_plan_template.md
      memory_entry_template.md
```

Optional temporary Phase 1 shortcut:

```text
tools/bugpilot/
  bugpilot.py
  templates/
  README.md
```

The recommended implementation should move quickly to the modular structure above.

---

## 9. Output Directory Structure

For Jira issue `JR-12345`, generate:

```text
.ai/
  JR-12345/
    execution.log
    workflow_status.json

    jira.json
    jira_summary.md
    jira_parsed.md
    extracted_keywords.json

    code_search.md
    related_files.json
    memory_search.md
    git_context.md
    bug_context.md

    agent_task.md
    copilot_analysis_prompt.md
    agent_fix_prompt.md
    review_prompt.md
    test_plan.md

    bug_analysis.md
    fix_summary.md
    test_result.md
    diff_summary.md
    review_notes.md
    copilot_output.md

    memory_entry.md

.ai_memory/
  bugs/
    JR-12345.md
  index.json
```

No PR description file is generated in this prototype.

---

## 10. Configuration

### 10.1 Environment Variables

PowerShell:

```powershell
$env:JIRA_BASE_URL="https://yourcompany.atlassian.net"
$env:JIRA_EMAIL="your.email@example.com"
$env:JIRA_TOKEN="your_jira_api_token"
$env:BUGPILOT_COPILOT_COMMAND="copilot"
```

Linux/macOS:

```bash
export JIRA_BASE_URL="https://yourcompany.atlassian.net"
export JIRA_EMAIL="your.email@example.com"
export JIRA_TOKEN="your_jira_api_token"
export BUGPILOT_COPILOT_COMMAND="copilot"
```

### 10.2 Optional `.bugpilot.yml`

The Jira key must be provided at runtime. It should not be hardcoded in config.

```yaml
jira:
  base_url_env: JIRA_BASE_URL
  email_env: JIRA_EMAIL
  token_env: JIRA_TOKEN
  timeout_seconds: 30

git:
  default_base_branch: main
  branch_prefix: feature
  branch_description_max_length: 50
  require_clean_working_tree: true

code_search:
  include_extensions:
    - .cpp
    - .cxx
    - .cc
    - .h
    - .hpp
    - .ui
    - .qrc
    - .py
    - .cmake
    - .md
  exclude_dirs:
    - .git
    - build
    - out
    - node_modules
    - vcpkg
    - third_party
    - external
  max_high_value_keywords: 5
  max_normal_keywords: 10
  max_total_keywords: 15
  max_matches_per_keyword: 20
  max_snippets_per_file: 5
  max_total_related_files: 10
  max_files_in_bug_context: 5
  max_lines_per_snippet: 30
  max_total_code_search_lines: 300

copilot:
  command: copilot
  default_mode: prepare-only
  experimental_auto_invocation: false

memory:
  path: .ai_memory/bugs
  max_memory_results: 5
```

---

---

## 11. Working Directory and Execution Location

`bugpilot` and GitHub Copilot CLI should be run from the **target repository root directory**, not from the `bugpilot` tool source directory.

This is important because both `bugpilot` and the AI agent need to operate against the repository being analyzed and modified.

### 11.1 Recommended Directory Layout

Example:

```text
bugpilot tool source:
C:\tools\bugpilot\

target product repository:
C:\path\to\your\repo\
```

The developer should run commands from the target product repository:

```powershell
cd C:\path\to\your\repo

bugpilot doctor
bugpilot bug JR-12345
copilot
```

Inside the AI agent, the developer can then run:

```text
Read .ai/JR-12345/agent_task.md and complete the workflow.
```

### 11.2 Why Your AI Agent Must Run from the Target Repository

The AI agent uses the current working directory as its project context.

If the AI agent is run from the `bugpilot` tool directory:

```powershell
cd C:\tools\bugpilot
copilot
```

then the agent will see and operate on the `bugpilot` tool code, not the target product repository.

This may cause incorrect behavior such as:

```text
- reading the wrong files
- checking the wrong git status
- creating branches in the wrong repo
- editing the bugpilot tool instead of the product code
- running tests in the wrong project
```

### 11.3 Where Generated Files Should Be Written

All generated workflow files should be written inside the target repository:

```text
<target-repo>/.ai/JR-12345/
<target-repo>/.ai_memory/bugs/
```

Example:

```text
C:\path\to\your\repo\.ai\JR-12345\
C:\path\to\your\repo\.ai_memory\bugs\
```

This allows the AI agent to read files using relative paths:

```text
.ai/JR-12345/agent_task.md
.ai/JR-12345/bug_context.md
.ai/JR-12345/code_search.md
```

### 11.4 How bugpilot Should Be Installed or Invoked

`bugpilot` can be installed as a command-line tool:

```powershell
cd C:\tools\bugpilot
pip install -e .
```

After installation, it can be run from any target repository:

```powershell
cd C:\path\to\your\repo
bugpilot bug JR-12345
```

If not installed, it can be invoked by full path:

```powershell
cd C:\path\to\your\repo
python C:\tools\bugpilot\bugpilot.py bug JR-12345
```

For a modular package, it can also be run as:

```powershell
cd C:\path\to\your\repo
python -m bugpilot bug JR-12345
```

### 11.5 Execution Rule

The general rule is:

```text
bugpilot source code location:
- can be anywhere, such as C:\tools\bugpilot

bugpilot execution location:
- target repository root

The AI agent execution location:
- target repository root

.ai output location:
- target repository root

source code modified by the agent:
- target repository
```


## 12. Default Execution Mode

### 11.1 Prepare-only is the Default

Default command:

```bash
bugpilot bug JR-12345
```

Equivalent behavior:

```text
bugpilot bug JR-12345 --prepare-only
```

This mode:

```text
- generates all Jira/code/memory/context/prompt artifacts
- does not automatically invoke an agent CLI
- does not modify source code
- does not create commit
- does not push
- prints clear next-step instructions for the agent
```

Final message should include:

```text
Next step:
Open the AI agent and run:

Read .ai/JR-12345/agent_task.md and complete the workflow.
```

### 11.2 Experimental Agent Fix Mode

Command:

```bash
bugpilot bug JR-12345 --agent-fix
```

Behavior:

```text
- runs the preparation workflow first
- tries to invoke an agent CLI only if the local Copilot command supports it
- writes agent output to .ai/JR-12345/copilot_output.md
- falls back to prepare-only mode if invocation fails
```

Important:

```text
--agent-fix is experimental until the team validates the exact Copilot CLI invocation method in the company environment.
```

---

## 13. Copilot CLI Compatibility Spike

Before relying on `--agent-fix`, implement and run a small validation command.

Command:

```bash
bugpilot agent-check
```

Purpose:

```text
Validate whether the current company Copilot CLI can be used programmatically.
```

Checks:

```text
- Is `copilot` available?
- Is `gh copilot` available?
- Does the command support non-interactive prompt input?
- Can it read or consume a markdown task file?
- Can output be redirected or captured?
- Does it require interactive confirmation before running shell commands?
- Does it support the intended repo workflow?
```

Output:

```text
[OK] copilot command found
[WARN] non-interactive prompt mode not confirmed
[INFO] Using prepare-only mode by default
```

If unsupported:

```text
- Keep bugpilot useful by generating agent_task.md.
- Ask the developer to manually open their AI agent.
- Do not block the rest of the workflow.
```

---

## 14. Main Commands

### 13.1 Doctor

```bash
bugpilot doctor
```

Purpose:

```text
Check whether the local environment is ready.
```

Checks:

```text
- Python version
- required Python packages
- git available
- ripgrep / rg available
- current directory is a git repo
- Jira environment variables exist
- Jira base URL is reachable if possible
- The AI agent is available
- current branch
- working tree status
- configured paths exist
```

Important git cleanliness check:

```bash
git diff-index --quiet HEAD --
```

If this exits with non-zero status:

```text
Halt branch creation unless an explicit override flag is provided.
```

### 13.2 Status

```bash
bugpilot status JR-12345
```

Purpose:

```text
Show current workflow progress for a Jira issue.
```

Reads:

```text
.ai/JR-12345/workflow_status.json
.ai/JR-12345/execution.log
```

Example output:

```text
Issue: JR-12345
Mode: prepare-only

Steps:
[PASS] doctor
[PASS] fetch
[PASS] parse
[PASS] keywords
[PASS] memory_search
[PASS] code_search
[PASS] context
[PASS] prompt
[SKIP] agent_fix
[PASS] memory_add

Generated:
.ai/JR-12345/bug_context.md
.ai/JR-12345/agent_task.md
```

### 13.3 Fetch Jira

```bash
bugpilot fetch JR-12345
```

Purpose:

```text
Fetch Jira issue content and save raw plus summarized data.
```

Outputs:

```text
.ai/JR-12345/jira.json
.ai/JR-12345/jira_summary.md
```

Fields to fetch:

```text
- key
- summary/title
- description
- status
- priority
- issue type
- components
- labels
- affected versions
- fix versions
- comments
- attachment metadata
```

Prototype simplification:

```text
First version only needs summary, description, status, priority, labels, components, and comments.
```

### 13.4 Jira Error Handling

The Jira client must handle common real-world failures gracefully.

Required handling:

```text
401 / 403:
- authentication failed
- permission denied
- invalid token
- wrong Jira email/token

404:
- Jira issue not found
- wrong Jira key
- missing project permission

429:
- Jira rate limited
- suggest retry later

timeout:
- network issue
- VPN/proxy issue
- Jira not reachable

ADF parse failure:
- Jira description is Atlassian Document Format and cannot be rendered cleanly
- save raw JSON and continue with a simplified text summary if possible
```

Example output:

```text
[ERROR] Jira issue JR-12345 not found.
Please check the Jira key and project access.

[ERROR] Jira authentication failed.
Please check JIRA_BASE_URL, JIRA_EMAIL, and JIRA_TOKEN.

[WARN] Jira description could not be fully converted to plain text.
Raw data is still saved in .ai/JR-12345/jira.json.
```

### 13.5 Parse Jira

```bash
bugpilot parse JR-12345
```

Purpose:

```text
Extract structured bug information from Jira content.
```

Extract:

```text
- reproduction steps
- actual result
- expected result
- environment
- product version
- error messages
- stack trace fragments
- missing information checklist
```

Output:

```text
.ai/JR-12345/jira_parsed.md
```

### 13.6 Extract Keywords

```bash
bugpilot keywords JR-12345
```

Purpose:

```text
Extract capped and ranked search keywords from Jira content.
```

Keyword tiers:

```text
Tier 1: high-value code-like terms
- CamelCase class names
- quoted strings
- file paths
- file extensions
- exact error messages
- component names

Tier 2: domain terms
- product/module names
- workflow names
- data format names

Tier 3: low-value generic terms
- crash
- error
- failed
- issue
- problem
```

Hard limits:

```text
- max_high_value_keywords: 5
- max_normal_keywords: 10
- max_total_keywords: 15
```

Output:

```text
.ai/JR-12345/extracted_keywords.json
```

Example:

```json
{
  "high_value_keywords": [
    "VdsImportDialog",
    "OpenVDS",
    ".vds"
  ],
  "normal_keywords": [
    "import",
    "volume",
    "crash"
  ],
  "dropped_keywords": [
    "error",
    "failed",
    "problem"
  ]
}
```

### 13.7 Code Search

```bash
bugpilot search JR-12345
```

Purpose:

```text
Search related source code using ripgrep with strict output limits.
```

Search file types:

```text
*.cpp
*.cxx
*.cc
*.h
*.hpp
*.ui
*.qrc
*.py
*.cmake
CMakeLists.txt
*.md
```

Exclude:

```text
.git
build
out
node_modules
vcpkg
third_party
external
```

Output limits:

```text
- max_matches_per_keyword: 20
- max_snippets_per_file: 5
- max_total_related_files: 10
- max_files_in_bug_context: 5
- max_lines_per_snippet: 30
- max_total_code_search_lines: 300
```

Outputs:

```text
.ai/JR-12345/code_search.md
.ai/JR-12345/related_files.json
```

`code_search.md` should contain:

```text
- search keywords
- top related files
- relative file paths from repo root
- matched line numbers
- small snippets around matches
```

Important:

```text
code_search.md must include enough file path and line-number information for the agent to inspect the correct files.
```

### 13.8 Related File Ranking

Can be part of `bugpilot search`.

Purpose:

```text
Rank candidate files based on keyword matches and path relevance.
```

Simple scoring:

```text
Score =
  5 * HighValueMatch
+ 3 * PathMatch
+ 3 * ComponentMatch
+ 2 * StandardMatch
+ 2 * HeaderImplementationPairBonus
```

Drop noisy files:

```text
- Drop files with score < 3.
- Keep only top 10 related files in related_files.json.
- Keep only top 5 files in bug_context.md.
```

Output:

```text
.ai/JR-12345/related_files.json
```

### 13.9 Memory Search

```bash
bugpilot memory search JR-12345
```

or:

```bash
bugpilot memory search "VDS import crash"
```

Purpose:

```text
Search previous AI bug investigations from shared memory.
```

First version:

```text
Use markdown files and keyword search.
No vector database required.
```

Limits:

```text
- max_memory_results: 5
- prefer matches on Jira title, tags, root cause, fix summary, related files
```

Output:

```text
.ai/JR-12345/memory_search.md
```

### 13.10 Git Context

```bash
bugpilot git-context JR-12345
```

Purpose:

```text
Collect useful git context before asking the agent to work.
```

Collect:

```text
- current branch
- git status
- working tree clean/dirty
- recent commits for related files
- git log for related files
```

Output:

```text
.ai/JR-12345/git_context.md
```

### 13.11 Build Bug Context

```bash
bugpilot context JR-12345
```

Purpose:

```text
Build a single AI-ready context file for the AI agent.
```

Inputs:

```text
- jira_summary.md
- jira_parsed.md
- extracted_keywords.json
- code_search.md
- related_files.json
- memory_search.md
- git_context.md
```

Output:

```text
.ai/JR-12345/bug_context.md
```

Suggested structure:

```markdown
# Bug Context

## Issue

JR-12345

## Context Quality

Confidence: Medium

Signals:
- Jira description found: Yes
- Reproduction steps found: No
- High-value code keywords found: 4
- Related files found: 7
- Similar memory entries found: 2
- Stack trace found: No

Context risks:
- Jira ticket is missing clear reproduction steps.
- Code search found many generic matches.

## Jira Summary

...

## Parsed Reproduction Information

...

## Missing Information

...

## Extracted Keywords

...

## Code Search Summary

...

## Top Related Files

...

## Relevant Snippets

...

## Git Context

...

## Similar Historical Issues

...
```

### 13.12 Generate Agent Task and Prompts

```bash
bugpilot prompt JR-12345
```

Purpose:

```text
Generate prompts for the AI agent and review/testing.
```

Outputs:

```text
.ai/JR-12345/agent_task.md
.ai/JR-12345/copilot_analysis_prompt.md
.ai/JR-12345/agent_fix_prompt.md
.ai/JR-12345/review_prompt.md
.ai/JR-12345/test_plan.md
```

---

## 15. Agent Task Design

The most important file is:

```text
.ai/JR-12345/agent_task.md
```

Recommended content:

```markdown
# Agent Task

You are an expert in legacy C++/Qt desktop application development.

Your task is to analyze and fix Jira issue JR-12345.

## Branch

Create or switch to this branch:

feature/JR-12345-<summary-slug>

## Safety Rules

- Do not work directly on main or master.
- Create a dedicated branch before editing files.
- Do not refactor unrelated code.
- Do not rename public APIs unless required.
- Do not make broad formatting-only changes.
- Do not delete files.
- Keep the fix minimal and targeted.
- After editing, show git diff summary.
- Do not merge.
- Do not commit or push automatically; only commit and push after explicit developer approval.

## Forbidden Actions

- Do not run git reset --hard.
- Do not run git clean -fd.
- Do not delete source files.
- Do not mass-format unrelated files.
- Do not change unrelated product behavior.
- Do not update Jira status.
- Do not create or merge pull requests.

## Required Workflow

1. Check current git status.
2. Create or switch to branch:
   feature/JR-12345-<summary-slug>
3. Read:
   .ai/JR-12345/bug_context.md
4. Inspect related files listed in:
   .ai/JR-12345/code_search.md
5. Analyze likely root cause.
6. Implement the smallest safe fix.
7. Run focused tests if available.
8. Generate:
   - .ai/JR-12345/bug_analysis.md
   - .ai/JR-12345/fix_summary.md
   - .ai/JR-12345/test_result.md
   - .ai/JR-12345/diff_summary.md
   - .ai/JR-12345/review_notes.md

## Expected Summary

Please summarize:

1. Root cause
2. Files changed
3. Fix explanation
4. Tests run
5. Risks
6. Follow-up questions
```

---

## 16. The AI agent Responsibilities

The AI agent should be responsible for:

```text
- git status
- branch creation or branch switching
- reading bug_context.md
- reading code_search.md
- inspecting related files
- bug analysis
- implementing code fix
- running focused tests
- generating diff summary
- generating review notes
```

The AI agent should not do by default:

```text
- merge branch
- delete branch
- push branch unless explicitly requested
- update Jira status
- create PR
- make broad refactors
- modify unrelated files
```

---

## 17. Branch Creation

Branch name for this prototype:

```bash
feature/JR-12345-<summary-slug>
```

Command:

```bash
bugpilot branch JR-12345 --description "<jira-summary>"
```

Expected git operations:

```bash
git status --porcelain
git diff-index --quiet HEAD --
git checkout -b feature/JR-12345-<summary-slug>
```

Optional:

```bash
git fetch
git checkout main
git pull
```

Prototype recommendation:

```text
For safety, first version should only create a branch from the current clean working tree.
Do not force checkout or reset.
```

---

## 18. Optional Auto Fix

Command:

```bash
bugpilot bug JR-12345 --agent-fix
```

Implementation:

```text
1. bugpilot prepares context and task prompt.
2. bugpilot checks whether Copilot CLI automatic invocation is supported.
3. If supported, the AI agent reads agent_task.md.
4. The AI agent creates branch.
5. The AI agent analyzes issue.
6. The AI agent edits source code.
7. The AI agent runs tests if available.
8. The AI agent writes summary files.
9. If unsupported, bugpilot prints manual agent instructions.
```

Generated files after the agent fix:

```text
.ai/JR-12345/bug_analysis.md
.ai/JR-12345/fix_summary.md
.ai/JR-12345/test_result.md
.ai/JR-12345/diff_summary.md
.ai/JR-12345/review_notes.md
.ai/JR-12345/copilot_output.md
```

---

## 19. Test Plan

Command:

```bash
bugpilot test-plan JR-12345
```

Purpose:

```text
Generate focused test suggestions.
```

First prototype can use rule-based output:

```text
- If UI files are related, recommend manual UI validation.
- If importer/parser files are related, recommend import-related tests.
- If model/repository files are related, recommend unit tests.
- If crash is mentioned, recommend invalid input and null/error-path tests.
```

Output:

```text
.ai/JR-12345/test_plan.md
```

Example:

```markdown
# Test Plan

## Focused Automated Tests

- Run focused tests related to files listed in code_search.md.
- Run importer/parser tests if related files are found.

## Manual Validation

1. Reproduce the original issue.
2. Confirm the crash or failure no longer happens.
3. Confirm no unrelated UI behavior changed.
4. Validate on the same platform/build mentioned in Jira.

## Regression Areas

- Import workflow
- Error handling
- Related UI dialog
- Existing project loading workflow
```

---

## 20. Diff Summary

Command:

```bash
bugpilot diff JR-12345
```

Purpose:

```text
Summarize current git diff after the agent changes.
```

Run:

```bash
git diff --stat
git diff --name-only
```

Output:

```text
.ai/JR-12345/diff_summary.md
```

---

## 21. Review Prompt

Generated by:

```bash
bugpilot prompt JR-12345
```

Output:

```text
.ai/JR-12345/review_prompt.md
```

Content should ask Copilot/Claude/Codex to review:

```text
- correctness
- regression risk
- legacy C++/Qt ownership/lifetime issues
- UI behavior
- error handling
- test coverage
- whether the fix is too broad
```

Expected review result:

```text
PASS
PASS WITH MINOR COMMENTS
NEEDS CHANGES
```

---

## 22. Shared AI Memory

### 21.1 Memory Add

Command:

```bash
bugpilot memory add JR-12345
```

Purpose:

```text
Save the investigation result into shared markdown memory.
```

Output:

```text
.ai_memory/bugs/JR-12345.md
```

Memory entry:

```markdown
# JR-12345 - <Jira title>

## Tags

- generated-from-jira
- prototype
- ai-assisted-debugging

## Jira Summary

...

## Code Search Summary

...

## Related Files

...

## Bug Analysis

...

## Fix Plan

...

## Final Root Cause

TBD

## Final Fix

TBD

## Tests

TBD

## Notes

Created by bugpilot prototype.
```

### 21.2 Memory Search

Command:

```bash
bugpilot memory search JR-12345
```

Purpose:

```text
Search similar historical issues.
```

First implementation:

```text
Simple keyword search over .ai_memory/bugs/*.md
```

Output:

```text
.ai/JR-12345/memory_search.md
```

### 21.3 Memory Update

Command:

```bash
bugpilot memory update JR-12345
```

Purpose:

```text
Update memory after the fix is done.
```

Add:

```text
- final root cause
- final fix summary
- tests run
- commit hash
```

Prototype can leave TODO sections for manual update.

---

## 23. Workflow Logging and Status

Each workflow run should write:

```text
.ai/JR-12345/execution.log
.ai/JR-12345/workflow_status.json
```

`execution.log` should include:

```text
- timestamp
- command
- step start/end
- warnings
- errors
- generated files
- fallback decisions
```

`workflow_status.json` example:

```json
{
  "issue_key": "JR-12345",
  "mode": "prepare-only",
  "steps": {
    "doctor": "pass",
    "fetch": "pass",
    "parse": "pass",
    "keywords": "pass",
    "memory_search": "pass",
    "code_search": "pass",
    "context": "pass",
    "prompt": "pass",
    "agent_fix": "skipped",
    "memory_add": "pass"
  },
  "generated_files": [
    ".ai/JR-12345/bug_context.md",
    ".ai/JR-12345/agent_task.md",
    ".ai_memory/bugs/JR-12345.md"
  ]
}
```

---

## 24. Main Workflow

Command:

```bash
bugpilot bug JR-12345
```

Default mode:

```text
prepare-only
```

Recommended steps:

```text
[1/13] Run doctor checks
[2/13] Fetch Jira issue
[3/13] Parse Jira content
[4/13] Extract keywords
[5/13] Search shared AI memory
[6/13] Search code
[7/13] Rank related files
[8/13] Collect git context
[9/13] Build bug context
[10/13] Generate agent prompts
[11/13] Generate test plan
[12/13] Save memory entry
[13/13] Print agent next-step instruction
```

If using `--agent-fix`:

```text
Try to invoke an agent CLI with agent_task.md.
If invocation fails, fall back to prepare-only instruction.
```

---

## 25. Safety Rules

### 24.1 Git Safety

```text
- Do not work directly on main/master.
- Do not modify files before branch creation.
- Do not create branch if working tree is dirty.
- Do not run git reset --hard.
- Do not run git clean -fd.
- Do not delete branch.
- Do not merge.
```

### 24.2 Agent Safety

```text
- Keep fixes small and targeted.
- Avoid unrelated refactoring.
- Avoid public API changes unless required.
- Avoid broad formatting-only changes.
- Always summarize changed files.
- Always generate diff summary.
```

### 24.3 Push Safety

```text
- Do not push by default.
- Push only when --push is explicitly provided in a later phase.
- Do not push main/master.
- Do not push if tests failed.
```

### 24.4 Jira Safety

```text
- Do not update Jira status in prototype.
- Do not add Jira comments automatically in prototype.
- Do not assign or close tickets automatically.
```

---

## 26. Development Phases

### Phase 0: Copilot CLI Invocation Validation

Goal:

```text
Validate what the company Copilot CLI can actually do from a script.
```

Implement:

```text
- bugpilot agent-check
- detect copilot command
- detect gh copilot command
- test whether markdown task prompt can be passed programmatically
- document supported mode
```

Completion criteria:

```text
The team knows whether --agent-fix can auto-invoke an agent CLI or must remain prepare-only/manual.
```

### Phase 1: End-to-End Prepare-only Skeleton

Goal:

```text
Run a complete workflow without code modification.
```

Implement:

```text
- bugpilot doctor
- bugpilot fetch JR-12345
- bugpilot parse JR-12345
- bugpilot keywords JR-12345
- bugpilot context JR-12345
- bugpilot prompt JR-12345
- bugpilot memory add JR-12345
- bugpilot status JR-12345
- bugpilot bug JR-12345
```

Completion criteria:

```text
Running bugpilot bug JR-12345 creates .ai/JR-12345 and .ai_memory/bugs/JR-12345.md.
```

### Phase 2: Code Search and Memory Search

Goal:

```text
Make the context useful for the agent.
```

Implement:

```text
- ripgrep-based code search
- hard limits for keyword and rg output
- related file ranking
- memory search
- context quality score
- include search results in bug_context.md
```

Completion criteria:

```text
bug_context.md includes Jira summary, context quality, related files, code snippets, and similar historical issues.
```

### Phase 3: Agent Task Workflow

Goal:

```text
Let the AI agent handle git operations, analysis, and implementation.
```

Implement:

```text
- agent_task.md generation
- prepare-only mode as default
- experimental --agent-fix mode
- fallback if agent invocation fails
```

Completion criteria:

```text
The AI agent can manually or automatically read agent_task.md, create feature/JR-12345-..., analyze the bug, and implement a small fix.
```

### Phase 4: Test, Diff, Review, Memory Update

Goal:

```text
Generate useful development artifacts after fix.
```

Implement:

```text
- test_plan.md
- diff_summary.md
- review_prompt.md
- memory update
```

Completion criteria:

```text
After the agent fix, bugpilot can generate test/review artifacts and update the shared memory entry.
```

### Phase 5: Optional Commit and Push

Goal:

```text
Demonstrate complete branch delivery if the team is comfortable.
```

Implement:

```text
- --commit
- --push
- commit message generation
- push branch to remote
```

Completion criteria:

```text
Only with explicit --push, branch can be pushed to remote.
```

Note:

```text
This phase is optional and should not be part of the default prototype demo.
```

---

## 27. MVP Scope

### Must Have

```text
1. bugpilot doctor
2. bugpilot agent-check
3. bugpilot fetch JR-12345
4. bugpilot keywords JR-12345
5. bugpilot search JR-12345
6. bugpilot memory search JR-12345
7. bugpilot context JR-12345
8. bugpilot prompt JR-12345
9. bugpilot status JR-12345
10. bugpilot bug JR-12345
11. bugpilot memory add JR-12345
```

### Should Have

```text
1. related file ranking
2. git context
3. test plan
4. diff summary
5. review prompt
6. context quality score
7. execution.log
8. workflow_status.json
```

### Could Have

```text
1. automatic Copilot CLI invocation
2. run tests
3. commit
4. push
5. memory update
```

### Not Needed for Prototype

```text
1. web UI
2. vector database
3. production RAG service
4. Jira write-back
5. automatic PR creation
6. PR description generation
7. automatic merge
8. full dependency graph
9. full AST analysis
10. permission system
```

---

## 28. Demo Flow

### Demo Command

```bash
bugpilot bug JR-12345
```

Default behavior:

```text
prepare-only
```

### Expected Generated Files

```text
.ai/JR-12345/execution.log
.ai/JR-12345/workflow_status.json
.ai/JR-12345/bug_context.md
.ai/JR-12345/code_search.md
.ai/JR-12345/memory_search.md
.ai/JR-12345/agent_task.md
.ai/JR-12345/agent_fix_prompt.md
.ai/JR-12345/review_prompt.md
.ai/JR-12345/test_plan.md
.ai_memory/bugs/JR-12345.md
```

### Agent Instruction

```text
Read .ai/JR-12345/agent_task.md and complete the workflow.
```

### Expected Branch

```bash
feature/JR-12345-<summary-slug>
```

### Demo Message

```text
This prototype shows how an AI-assisted workflow can turn a Jira issue into a structured development package: code search results, AI-ready context, the AI agent task, test plan, review prompt, branch guidance, execution status, and shared AI memory.
```

---

## 29. Success Criteria

The prototype is successful if it can demonstrate:

```text
1. Jira issue JR-12345 can be fetched automatically.
2. bugpilot can generate structured Jira summary.
3. bugpilot can extract useful capped keywords.
4. bugpilot can search related code with strict output limits.
5. bugpilot can search previous AI memory.
6. bugpilot can build bug_context.md with context quality score.
7. bugpilot can generate an agent task prompt.
8. bugpilot can log execution and show workflow status.
9. The AI agent can use the task prompt manually or automatically to perform git/code/test work.
10. bugpilot can save memory entry for future reuse.
11. The workflow can guide creation of branch:
    feature/JR-12345-<summary-slug>
```

---

## 30. Summary

The purpose of **bugpilot** is to demonstrate a practical AI-assisted development workflow:

```text
Jira issue → context builder → code search → shared memory → the AI agent task →
branch → fix → test/review artifacts → memory update
```

For this prototype:

```text
bugpilot prepares the context.
The AI agent performs git/code/test work.
Shared AI memory preserves useful investigation results.
```

The most important demo command is:

```bash
bugpilot bug JR-12345
```

The most important generated file is:

```text
.ai/JR-12345/agent_task.md
```

The expected branch is:

```bash
feature/JR-12345-<summary-slug>
```

`--agent-fix` remains experimental until Copilot CLI automatic invocation is validated in the company environment.



---

## 31. AI Fix Mode Feature

**Status:** In Progress

**Implementation branch:** `feature/fix-modes`

**Started:** 2026-09-21

### 31.1 Goal

BugPilot currently controls most of the context supplied to an AI agent, while much of the AI bug-fixing workflow is still hard-coded in `agent_task.md`.

AI Fix Mode separates these two concerns:

```text
Context = what the AI needs to know
Fix Mode = how the AI should approach the work
```

Target flow:

```text
Jira / Manual Bug Description
Developer Hint / Keywords
Code Search / Git Context / Existing BugPilot Context
                    +
             Selected Fix Mode
                    |
                    v
              agent_task.md
                    |
                    v
       Claude / Codex / Copilot / Gemini
```

Fix Mode must remain repository- and domain-independent. It must not contain product volume types, OpenVDS, geophysical, or other product-specific knowledge. Product/domain evidence continues to come through the normal BugPilot context inputs.

### 31.2 V1 Built-in Fix Modes

V1 provides five built-in modes:

| Mode | Purpose |
| --- | --- |
| `standard` | Default workflow for most bugs: analyze, make the smallest correct fix, verify, summarize. |
| `conservative` | Legacy/high-risk code: preserve behavior, minimize changed files/lines, avoid speculative changes and unrelated refactoring. |
| `investigate-first` | Root cause is unclear: diagnose and produce an evidence-backed fix plan before source modification. |
| `test-driven` | Reproducible bugs: establish/update a focused failing test, implement the fix, rerun verification. |
| `deep-analysis` | Complex crashes/regressions/cross-module issues: deeper execution-path/history/evidence review before editing. |

`standard` is the deterministic default when the caller does not explicitly select a Fix Mode.

### 31.3 Core Model

Fix Mode is a first-class core concept and is deliberately separate from `BugSpec`, Jira data, and BugPilot safety policy.

Core model:

```python
@dataclass(frozen=True)
class FixMode:
    id: str
    name: str
    description: str
    objective: str
    investigation: str
    implementation: str
    verification: str
    constraints: str
    completion: str
    source: Literal["builtin", "user", "project"] = "builtin"
    based_on: str | None = None
    based_on_version: int | None = None
    version: int = 1
    execution_kind: Literal["fix", "investigate"] = "fix"
```

Editable workflow sections:

```text
Objective
Investigation
Implementation
Verification
Constraints
Completion
```

`execution_kind` is the one structured workflow semantic, and it exists because prose cannot be acted on: a renderer cannot read "do not modify source code in the initial pass" out of an instruction section and know to withhold the commit/push offer. It is deliberately two values and not the start of a workflow DSL.

```text
standard          -> fix
conservative      -> fix
investigate-first -> investigate
test-driven       -> fix
deep-analysis     -> fix
```

`based_on_version` records which version of a built-in a custom mode was copied from. If `based_on` is unset, `based_on_version` must also be unset; when set it must be >= 1. `based_on` must not equal the mode's own id. Whether `based_on` names a mode that *exists* is deliberately not checked here: that needs the whole mode set, which belongs to the registry/loader.

Editable instruction text (`description` and the six sections) is contained, because it is interpolated into `agent_task.md` as Markdown and BugPilot owns that document's structure:

```text
- no Markdown heading at the start of a line (^#{1,6}\s), so a mode cannot forge
  "## Forbidden Actions" or "## BugPilot Rule Precedence" above the real one
- MAX_FIX_MODE_TEXT_LENGTH = 12000 characters per field
- '#' inside prose ("issue #4102", "C#") and indented '#' comment lines stay legal
```

Containment is in the model rather than the renderer because `validate()` is the trust boundary a Phase 5 loader will call.

Safety policy is intentionally not editable through Fix Mode. Git/Jira/destructive-action safeguards remain BugPilot-owned invariants.

Validation is the trust boundary for custom modes that will later be read from a file, so every field is type-checked before content: a bad type leaves as `FixModeError` naming the field, never as `AttributeError` or `TypeError` from inside a `strip()` call.

### 31.4 Core Registry

All entry points must share one core registry rather than maintain separate lists in CLI, MCP, and VS Code.

Planned API:

```text
FixModeRegistry
- register(mode)
- resolve(mode_id)
- list_modes(source=None)
- default
```

Rules:

```text
- duplicate IDs are rejected
- invalid definitions are rejected
- only an omitted mode selects the default
- an unknown explicit mode is an error, never a silent fallback
- built-in definitions are immutable
```

### 31.5 Custom Mode Direction

Later phases support two scopes:

```text
User scope:
~/.bugpilot/fix_modes/

Project scope:
<repo>/.bugpilot/fix_modes/
```

Built-in modes are read-only. Customizing a built-in mode means duplicating it and retaining origin metadata:

```text
based_on: conservative
based_on_version: 1
```

Do not add a heavy persistence dependency solely for Fix Mode. Prefer a simple dependency-free format compatible with BugPilot's current packaging goals.

### 31.6 Task Package Contract

`agent_task.md` must keep three concepts visibly separate:

```text
1. Evidence / issue-specific context
2. Selected Fix Mode instructions
3. BugPilot-owned safety and delivery rules
```

A future custom Fix Mode can change investigation/implementation/verification guidance but cannot remove or weaken BugPilot safety rules.

The task package states that precedence itself, outside editable mode content:

```text
## BugPilot Rule Precedence

Fix Mode controls workflow strategy only.

If any Fix Mode instruction conflicts with BugPilot safety, evidence-integrity,
branch, Jira, or delivery rules, the BugPilot rule wins.
```

Resolution boundary: an ID becomes a `FixMode` in `FixModeRegistry`, and task generation consumes the resolved object.

```text
caller (CLI / VS Code / MCP / workflow)
  -> FixModeRegistry.resolve(id)
    -> FixMode
      -> generate_prompts(..., fix_mode=<FixMode>)
```

`prompts.py` therefore has no repo root, user config, or scope precedence logic, and passing an ID string to task generation is an error rather than a builtin-only shortcut that would silently ignore user/project modes.

Delivery is two separate blocks, because only one of them depends on the mode:

```text
delivery SAFETY (BugPilot-owned, rendered in EVERY Fix Mode)
  branch is not main/master, is a feature branch, contains the issue key
  git add only intended source/test/doc files
  never stage .ai/, .ai_memory/, jira.json, jira_field_report.md
  never stage files containing JIRA_TOKEN/password/api_key/secret/
    access_token/refresh_token/key=...
  no push to main/master, no force push, no merge/PR/Jira mutation

delivery OFFER (only for execution_kind="fix")
  delivery summary, proposed commit message,
  "Do you want me to commit and push this branch to origin?", commit/push commands
```

```text
fix         -> delivery safety + Optional Assisted Delivery
investigate -> delivery safety + Investigation Handoff: no commit/push offer, no
               delivery summary, state that no source changes were applied, then
               ask the developer whether to continue with implementation
```

An investigation withholds the offer only. The safety gate still applies, including to the implementation pass a developer starts by answering "yes" to the continuation question.

The five required output file names are unchanged in both cases; in an investigation the task explains that `fix_summary.md` is a proposed plan, `test_result.md` records tests not run, and `diff_summary.md` states that no source changes were made.

### 31.7 Planned CLI / VS Code / MCP Support

CLI:

```text
bugpilot bug JR-12345 --fix-mode standard
bugpilot bug JR-12345 --fix-mode conservative
bugpilot fix-mode list
bugpilot fix-mode show <id>
```

VS Code:

```text
Fix mode
[ Standard Fix ▼ ] [settings]

[ Fix with AI ]
```

MCP:

```text
prepare_jira_bug(..., fix_mode="conservative")
prepare_bug_description(..., fix_mode="investigate-first")
list_fix_modes()
```

MCP V1 may read/select modes but must not create, edit, or delete developer/team Fix Mode policy.

### 31.8 Implementation Phases

#### Fix Mode Phase 1 — Core Model and Registry

**Status:** Completed. 11 targeted Fix Mode tests passed; full Python suite: 562 passed.

Implement:

```text
- FixMode frozen core model
- validation
- FixModeRegistry
- deterministic default = standard
- five built-in modes
- exact unknown-mode failure
- duplicate ID handling
- stable instruction section ordering
- tests for loading/validation/default/immutability/domain independence
```

Completion criteria:

```text
Core can list and resolve all five built-in modes without depending on VS Code, CLI, MCP, Jira, or product-specific/domain-specific knowledge.
```

Phase 1 corrections (pre-Phase-3 review):

```text
- execution_kind: Literal["fix", "investigate"] added, default "fix";
  investigate-first is the only built-in with "investigate".
  FixMode.is_investigation exposes it to the renderer.
- based_on_version: int | None added, with validation that it requires based_on
  and must be >= 1, so a custom mode can record which built-in version it copied.
- defensive validation: every text field must be a str and non-empty after strip;
  version and based_on_version must be non-bool ints >= 1; source and
  execution_kind must be one of their allowed values. All failures raise
  FixModeError naming the field instead of leaking AttributeError/TypeError.
  FixModeRegistry.register rejects non-FixMode input and resolve() rejects a
  non-string id.
- Git-history wording in Conservative Fix and Deep Analysis now points at the
  Git/history evidence BugPilot supplied, and asks the agent to report missing
  evidence rather than perform broad exploration. "inspect relevant history" is
  gone from every built-in, so no mode widens the retrieval boundary.
- Investigate First also states that verification is proposed rather than
  performed, and that the pass ends by asking the developer whether to implement.
- fix_modes.py lost its UTF-8 BOM, which had made the module unparseable to
  tests/test_no_unwired_symbols.py and so invisible to that guard.
```

#### Fix Mode Phase 2 — Task Package Integration

**Status:** Implemented and validated. `tests/test_fix_modes.py` + `tests/test_fix_mode_prompts.py`: 48 passed; full Python suite: 599 passed (562 pre-existing tests still green, 37 added).

Implement:

```text
- refactor mode-specific workflow text out of prompts.py
- render selected Fix Mode into agent_task.md
- keep BugPilot safety rules outside editable mode content
- preserve current behavior through Standard Fix
- add task-generation tests
```

Delivered:

```text
- generate_prompts(..., fix_mode=None) and generate_copilot_task_files(..., fix_mode=None)
  accept None | FixMode ID string | FixMode object
- prompts._resolve_fix_mode(): None => Standard Fix; explicit unknown ID raises
  FixModeNotFoundError; an explicitly passed FixMode object is validated, never
  silently replaced. The Phase 1 FixModeRegistry stays the single source of truth.
- agent_task.md gained "## AI Fix Mode" (Mode / Mode ID / Version / Source /
  Based on when present) followed by the six sections in FixMode order:
  Objective, Investigation, Implementation, Verification, Constraints,
  Completion Requirements.
- the hard-coded "## Analysis Workflow" and "## Implementation Workflow" sections
  were split: mode-owned workflow text was removed, and the invariant rules became
  "## BugPilot Evidence Rules" and "## BugPilot Editing Guardrails", both rendered
  after the mode with an explicit statement that the mode cannot relax them.
- Developer Hint is still high-priority evidence but no longer says "implement the
  fix there": it now names the location to inspect first and defers to the selected
  mode on whether and when source editing is allowed.
- agent_handoff.md points the agent at the mode selected in agent_task.md.
```

Moved out of `prompts.py` into Fix Mode (mode-owned):

```text
- Identify likely root cause hypotheses.
- Implement the smallest safe fix.
- Avoid unrelated refactoring.
- Avoid public API changes unless necessary.
- Avoid formatting-only changes.
- Run focused tests if available.
- "go straight to the location and implement the fix there" (hint wording)
```

Kept in `prompts.py` as BugPilot-owned invariants (identical in every mode):

```text
- evidence correctness: no invented reproduction steps or error messages, read the
  supplied artifacts, treat Low search confidence carefully, no edits from weak
  keyword matches, no-op analysis when no implementation is found, ask when
  evidence is insufficient, do not edit before reviewing context/related files
- execution safety: inline Read/Grep/Glob only and no background or sub-agents,
  feature-branch-only editing, no git reset --hard, no git clean -fd, no force
  push, no main/master push, no merge, no PR creation, no Jira mutation beyond the
  one optional status comment, no commit/push without explicit developer approval,
  never stage .ai/ or .ai_memory/, no false claims about tests that were not run
- the five required result files, required even when the mode changes no source
```

Deferred by design (not in this change set): CLI `--fix-mode`, VS Code selection,
MCP, custom-mode persistence. `workflow.py` was not modified, so `prompt_step` and
`copilot_task_step` continue to generate Standard Fix until Phase 3 threads a
selection through.

Phase 2 corrections (pre-Phase-3 review):

```text
- the prompt renderer consumes a resolved FixMode. generate_prompts /
  generate_copilot_task_files take fix_mode: FixMode | None; None is the packaged
  STANDARD_FIX object rather than a registry lookup, and prompts.py no longer
  instantiates a builtin-only registry. A mode id string now raises FixModeError
  pointing the caller at FixModeRegistry.resolve().
- Investigate First has investigation-only delivery semantics. For
  execution_kind == "investigate" the task renders "## Investigation Handoff"
  instead of "## Optional Assisted Delivery": no commit/push offer, no delivery
  summary, no fixed/resolved/verified wording, an explicit "Investigation
  complete. No source changes have been applied.", and the question "Do you want
  me to continue with implementation?". The opt-in Jira status comment is kept but
  reworded off its commit framing. agent_handoff.md carries the same stop.
  For execution_kind == "fix", assisted delivery is unchanged.
- Required Output Files keeps the same five names and, in an investigation,
  describes each one as investigation state rather than a completed fix.
- Developer Hint wording changed from "Trust this hint" to "Treat this hint as
  high-priority developer guidance", with "verify it against the available
  evidence", "If the evidence contradicts the hint, say so", and an explicit note
  that the selected Fix Mode still controls whether and when editing is allowed.
- "## BugPilot Rule Precedence" added between the mode block and the invariant
  rules, stating that Fix Mode controls workflow strategy only and that a BugPilot
  rule wins any conflict. It is outside editable mode content.
- Fix Mode metadata now also renders Execution and, for a derived mode,
  "Based on" and "Based on version".
- stable section-order test added (string positions for the six headings, in every
  built-in mode and for a custom mode).
```

Second-review corrections (independent review, pre-Phase-3):

```text
- delivery safety preserved in investigation mode. delivery_instructions.py was
  split into delivery_safety_block() and assisted_delivery_block();
  delivery_instructions_block() remains as the composition for the retry prompt.
  agent_task.md now renders "## BugPilot Delivery Safety" in every Fix Mode and
  withholds only the offer for an investigation. The previous behavior dropped
  the whole block, which also dropped the staging restrictions, the secret-file
  list and the branch checks -- a BugPilot-owned safety rule removed as a side
  effect of a workflow change.
- Deep Analysis regained a general exploration bound ("Prefer evidence over broad
  repository exploration; expand only when the supplied evidence identifies a
  concrete dependency or missing link"), which the earlier Git-history rewording
  had narrowed to history alone. The history-specific boundary is unchanged.
- agent_team_instructions.md (and its mirrored fallback) gained a "Task and Fix
  Mode Precedence" section, and its commit/push and testing rules now say they
  apply to a pass that may change source code. Previously the team document
  re-offered commit/push to an investigation-only pass that the task had
  deliberately withheld it from. Kept generic: it speaks of investigation-only
  modes, never of a mode id.
- FixMode.validate() now rejects Markdown headings and text over
  MAX_FIX_MODE_TEXT_LENGTH in editable fields, and rejects based_on == id.
- agent_handoff.md for an investigation no longer says "after a delivery summary",
  a summary that pass does not produce.
- the vacuous `assert not isinstance(excinfo.value, (AttributeError, TypeError))`
  was replaced by an assertion that the error names the offending field.
- retry_prompt_step recorded as a Phase 3 requirement (see Phase 3 above). Not
  changed here: it is consistent while every run is Standard Fix, and fixing it
  properly needs the persisted selection Phase 3 introduces.
```

Validation for the second-review corrections:

```text
python -m pytest tests/test_fix_modes.py tests/test_fix_mode_prompts.py -q   -> 193 passed
python -m pytest tests/test_workflow.py tests/test_no_unwired_symbols.py -q  -> 198 passed
python -m pytest -q                                                          -> 746 passed
git diff --check                                                             -> clean
```

#### Fix Mode Phase 3 — CLI

**Status:** Implemented and validated. Fix Mode tests: 236 passed; workflow/CLI/MCP/unwired: 335 passed; full Python suite: 789 passed.

Implement:

```text
- --fix-mode <id>
- default standard
- fix-mode list
- fix-mode show
- stable unknown-mode error
- selected mode metadata in machine output
```

Delivered:

```text
- `bugpilot bug <work item> --fix-mode <id>`, and the default-command shorthand
  `bugpilot <work item> --fix-mode <id>`. No argparse choices=: the list comes
  from the registry, which a later phase widens.
- `bugpilot fix-mode list` (id / name / execution kind) and
  `bugpilot fix-mode show <id>` (metadata plus all six sections, and the origin
  lines for a derived mode). Unknown id exits 1 with the registry's message.
- selection persisted at .ai/<work item>/fix_mode.json (schema_version 1, id,
  name, version, source, execution_kind, based_on, based_on_version; stdlib json,
  indent=2, sort_keys=True, trailing newline, written through the shared atomic
  writer).
- precedence: explicit --fix-mode > persisted selection > Standard Fix.
- InvestigationRequest.fix_mode_id carries the caller's choice as an id;
  run_investigation resolves it once per run, before the fresh-run clean, and
  passes the resolved FixMode to prompt_step. prompts.py still refuses ids.
- resume, refine, `bugpilot prompt`, `bugpilot agent-task` and `bugpilot
  retry-prompt` all go through workflow._selected_fix_mode, so none of them can
  regenerate a package as Standard Fix by omission.
- retry prompt integration (the Phase 1/2 review finding): the retry renderer now
  follows execution_kind. A fix-kind retry is unchanged; an investigate-kind retry
  drops the implementation language and the delivery offer, keeps BugPilot
  Delivery Safety, and ends on the investigation continuation gate.
- workflow_status.json gained an additive "fix_mode" object; no schema bump,
  since that file has no schema_version and consumers ignore unknown keys.
- `bugpilot bug --json` and `bugpilot status --json` expose the same "fix_mode"
  object. cli_json.SCHEMA_VERSION is unchanged: the envelope contract is additive.
- fix_mode.json appears in generated_files, which lists every file in the work
  item directory; it is runtime state like workflow_status.json.
- the temporary ALLOWED entry for builtin_fix_mode_registry was removed from
  tests/test_no_unwired_symbols.py: fix_mode_state.fix_mode_registry is now its
  production caller.
```

Decisions recorded:

```text
- Persisted state is not authority. Only the id selects a mode, and the id is
  re-resolved through the registry on every read; name/kind/source in the file are
  audit metadata. A stored id that cannot be resolved is an error naming the file
  and --fix-mode, never a silent fall back to Standard Fix.
- Version drift: when the recorded version differs from the installed definition,
  the run warns, regenerates with the installed definition and updates the
  recorded metadata. This matches how BugPilot treats every other artifact — it
  regenerates rather than replays — and historical mode snapshots are deliberately
  not built.
- Persistence timing: once the selection resolves, `run_investigation` writes
  `fix_mode.json` *before* the pipeline steps run, not after they succeed. The
  file records the execution policy the work item is now under, so that every
  later path — resume, refine, `prompt`, `agent-task`, `retry-prompt` —
  regenerates under the same mode even when this run fails halfway. The
  consequence is stated rather than hidden: after a partial failure the
  persisted selection (and the `fix_mode` object `workflow_status.json` derives
  from it) can be ahead of `agent_task.md`, which still reflects the last
  successful regeneration. Nothing is transactional here; the next regeneration
  rebuilds the task file from the persisted id and the current effective
  definition, and a drift warning is emitted only when the recorded metadata
  and the resolved mode differ at that time. `workflow_status.fix_mode` is the
  selected/persisted policy, not proof that a task file was written under it.
- A fresh run ignores the persisted selection: it is about to delete the package
  that recorded it. Only --resume (or a regeneration command) inherits a mode.
- Investigation -> implementation continuation needs no state machine. The
  developer reviews the investigation and runs again under a fix mode
  (`--resume --fix-mode standard`), which replaces the persisted selection.
- A rejected mode costs no artifacts: the id is resolved before the fresh-run
  clean deletes anything.
- Unknown/unusable modes reuse the existing INVALID_INPUT code, because
  FixModeError is a ValueError and errors.error_code_for already maps it. No new
  error code was added to the contract.
```

Retry prompt integration (required in Phase 3):

`workflow.retry_prompt_step` / `_build_retry_prompt` is a second task-like renderer. It currently hard-codes implementation language ("Re-check the implementation location", "If the previous change is wrong, explain whether to revert or adjust it") and renders the assisted-delivery offer unconditionally. That is consistent today because every run is Standard Fix, and becomes a contradiction the moment a mode can be selected: an Investigate First retry would offer to commit a fix that was never written.

```text
- retry_prompt_step must load and reuse the persisted selected Fix Mode
- retry prompt behavior must respect execution_kind
- an investigate-kind retry must not offer commit/push and must not assume a
  previous implementation exists
- retry must not silently regenerate as Standard Fix
- BugPilot Delivery Safety and the Fix Mode precedence rule must still be rendered
```

Persistence / regeneration checklist — every path that must carry the selection rather than fall back to Standard (`jira_comment_on.flag` is the existing precedent for per-issue persistence):

```text
- initial run:            run_investigation -> prompt_step
- resume:                 run_investigation(fresh=False) -> prompt_step
- refine:                 refine_investigation -> prompt_step
- standalone regeneration: copilot_task_step (bugpilot agent-task)
- retry:                  retry_prompt_step -> _build_retry_prompt
- MCP preparation:        prepare_jira_bug / prepare_bug_description
- MCP refinement:         refine_investigation
- VS Code rerun:          inherits the CLI path
```

Resolve an id exactly once per run, through `FixModeRegistry`, and pass the resolved `FixMode` onward; `prompts.py` must keep refusing ids. `manual_result_step` templates describe a developer's own manual fix and need no Fix Mode awareness.

All of the above is implemented. Every row of that checklist has a test in `tests/test_fix_mode_selection.py`, except the two that belong to later phases: MCP preparation/refinement still pass no mode (Phase 6), and the VS Code rerun inherits whatever the CLI does (Phase 4).

Phase 3 test coverage — `tests/test_fix_mode_selection.py`:

```text
selection:  default Standard; explicit beats persisted; persisted used when
            nothing is asked for; a fresh run does not inherit; unknown id raises
file:       exact schema and deterministic formatting; one metadata shape
            everywhere; unreadable file, missing/blank/non-string id, and an
            unresolvable id each fail clearly; only the id selects the mode;
            version drift warns and uses the installed definition
run:        mode reaches agent_task.md, fix_mode.json and workflow_status.json;
            resume keeps it; resume --fix-mode switches it; a fresh re-run returns
            to Standard; refine, `prompt` and `agent-task` keep it; fix_mode.json
            is reported as a generated artifact; a rejected mode costs no artifacts
retry:      a fix retry keeps the assisted-delivery offer; an investigate retry
            drops the offer and the implementation language, keeps Delivery Safety
            and the continuation gate, and asks for evidence and revised
            hypotheses instead; retry never changes the selected mode
CLI:        fix-mode list; fix-mode show (full text, no repr, investigation note);
            show with an unknown id and with no id; an unknown --fix-mode;
            an unusable stored selection reported without a traceback;
            the default-command shorthand
JSON:       bug --json and status --json carry the fix_mode object, with the
            pre-existing keys unchanged
```

#### Fix Mode Phase 4 — VS Code Selection

**Status:** Implemented and validated. Extension: 441 tests passed, `tsc --noEmit` clean. Python: 794 passed.

Implement:

```text
- Fix Mode dropdown
- concise description
- pass selected mode through the existing BugPilot process runner
- no duplicate workflow implementation in TypeScript
```

Delivered:

```text
- `bugpilot fix-mode list --json` added as the structured discovery surface, in
  the existing --json envelope, carrying default_mode_id plus one entry per mode
  (id, name, description, version, source, execution_kind, based_on,
  based_on_version). The instruction sections are deliberately absent: they drive
  an agent, and a UI carrying them would be a second definition of a Fix Mode.
  `fix-mode show --json` is refused with a stable INVALID_INPUT envelope pointing
  at the list command; the human `fix-mode list` output is unchanged.
- extension/src/app/fixModes.ts: the catalog model (loading / ready /
  unavailable), payload parsing, selection resolution and the prepared-mode
  reader. Pure, so what a payload means is testable without a process.
- extension/src/host/ports.ts: `loadFixModes(runJson)`, mirroring `loadHistory` —
  one place in the extension knows the discovery command.
- controller: a `listFixModes` port, read once per environment resolution (which
  is also when the executable can change), the catalog and the prepared mode on
  `PanelState`, and normalization of a selection the registry no longer offers.
- form: `FormState.fixModeId`, shape-checked at the webview boundary against the
  same pattern as `bugpilot/core/fix_modes.py`, rendered as `--fix-mode=<id>`.
  The panel always sends what it shows, so the CLI's persisted selection can
  never disagree with the dropdown.
- panel: a "Fix Mode" selector above the run button (not in Advanced Settings),
  the selected mode's description beneath it, an "Investigation only — no source
  changes in this pass" prefix driven by execution_kind, and a "Prepared with Fix
  Mode: …" line fed by workflow_status.fix_mode.
```

Decisions recorded:

```text
- The extension holds no list of modes and no default. Both come from the CLI,
  and two tests read every shipped source file to prove it — one for built-in
  ids, one for the string "standard". Comments may name a mode; code may not.
- Selected mode vs prepared mode are different things and are rendered
  separately: the selector is what the next run would use, the prepared line is
  what produced the package on disk.
- A mode whose execution_kind this client does not understand is dropped rather
  than guessed at, because that field is what the panel uses to promise the
  developer that no source will change.
- A prepared mode the catalog no longer offers is shown by id and marked
  unavailable, never silently relabelled as the default. It is also not inherited
  into the form, so the next run cannot be started with a mode that is gone.
- Discovery failure is surfaced, never substituted: the selector stays disabled
  with the reason beneath it, and the run proceeds with no --fix-mode flag so
  core applies its own default.
- Investigate First gets one sentence before the run and nothing else: no second
  confirmation dialog, no dynamic button naming, no workflow state machine.
  "Fix with AI" is unchanged.
```

Extension test coverage (`extension/test/fixModes.test.ts`, plus additions to
form/controller/page/panel tests):

```text
discovery: the structured call is used; metadata survives; the default comes
           from the payload; an unknown default falls back; a mode with an
           unreadable execution kind is dropped; failure envelopes, older
           bugpilots and malformed payloads all become "unavailable" with a
           reason; no source file names a built-in mode or the default id
form:      one --fix-mode flag; the default is passed explicitly; no selection
           sends no flag; a malformed id is a field problem; nothing else on the
           command line changes; the id pattern matches the Python source
controller: discovery runs once per environment resolution and not at all when
           blocked; a new form takes the declared default; a stale selection is
           normalized; the developer's choice survives a refresh; the selected
           mode reaches argv; opening a prepared work item restores its mode;
           switching work items does not leak the previous one; an unavailable
           prepared mode is reported honestly; prepared ≠ selected; a bugpilot
           without Fix Modes still prepares
page:      options come from the host; the description follows the selection
           immediately; investigation is stated in words; the selector is
           disabled while loading and when unavailable; the run message carries
           the id; the prepared line is separate and hidden when there is none
panel:     the selector is outside Advanced Settings and above the run button,
           is labelled and described, names no mode in markup, and a hostile
           fixModeId from the page cannot become a flag
```

Python test coverage added to `tests/test_fix_mode_selection.py`: envelope shape,
`default_mode_id`, the five modes with exactly the expected metadata keys and no
instruction text, the `show --json` refusal, and the unchanged human listing.

Post-review cleanup (independent Phase 4 review, verdict "ready after minor cleanup"):

```text
- A Fix Mode belongs to a work item, not to the panel. The tree-driven switch
  re-derived the selection; typing a different issue key did not, so a new bug
  could be prepared under the previous bug's mode. Both paths now go through
  Controller.#deriveFixModeFor: the target's prepared mode when it is still
  available, otherwise the CLI's declared default. Identity comes from one
  shared rule, form.workItemScopeOf — the same trim()/toUpperCase() a run
  applies, plus "manual" for a hand-written bug (whose id the CLI mints later)
  and `undefined` for a half-typed key, which is not yet another work item and
  so never triggers a re-derivation.
- Editing a hint, a keyword or a focus file does not re-derive: the work item
  did not change. A deliberate choice made *after* naming the bug therefore
  stands. The accepted trade-off is the other order — choosing a mode and then
  typing a new issue key discards the choice, because at that point the panel
  cannot tell a deliberate pick from one inherited from the previous bug.
- fixModesFromPayload rejects a discovery payload containing two modes with the
  same id, rather than rendering two identical option values. Core never emits
  duplicates, so this is malformed data, not a choice to make for the developer.
```

Known Phase 4 limitations, carried into Phase 5 deliberately:

```text
1. preparedFixMode availability is binary, and should be a tri-state.
   Today: PreparedFixMode.available is false only when the catalog loaded and
   does not contain the recorded id; when the catalog itself could not be read,
   availability cannot be known and the flag is set true. That is harmless while
   only built-ins exist (an unreadable catalog is the single cause, and the panel
   shows the catalog error beside it) and wrong once a mode can genuinely
   disappear. Phase 5 should carry:
       available   - catalog loaded and contains the recorded mode
       unavailable - catalog loaded and the mode is missing
       unknown     - the catalog itself could not be read
   `extension/test/fixModes.test.ts` currently pins the collapsed behavior, so
   that test changes with it.

2. The prepared line shows the *current* catalog's name for a mode that still
   exists, and the recorded name only for one that does not. With immutable
   built-ins the two are identical. Once a custom mode can be renamed, this
   rewrites history: a package prepared under "My Safe Fix" would be labelled
   with whatever the mode is called today. Phase 5 decision: prepared display
   should use the recorded name/id as historical truth, and evaluate
   availability separately against the current catalog.

3. `bugpilot fix-mode` is the only command in cli._dispatch that is not handed
   `repo_root`, because Phase 4 modes are built-in only and the command needs no
   repository context. Project-scoped modes make it repository-dependent. When
   Phase 5 lands, pass an explicit `repo_root` into Fix Mode discovery and
   management rather than relying on `Path.cwd()`, matching the convention every
   other command follows and keeping the CLI testable from a temp directory. The
   extension already spawns discovery with the workspace root as cwd, so no
   extension change is needed for this.
```

#### Fix Mode Phase 5 — Custom Mode Editor

**Status:** Implemented and validated. Python: 874 passed (80 added). Extension: 486 passed (38 added), `tsc --noEmit` clean.

Implement:

```text
- user/project mode loading
- create
- duplicate built-in
- edit custom
- delete custom
- user/project scope
- preview final instructions
- validation/error UX
```

Storage:

```text
~/.bugpilot/fix_modes/<id>.json          one developer's own workflows
<repo>/.bugpilot/fix_modes/<id>.json     a team's, committed with the code
```

The user directory follows `user_config_dir()`, so `BUGPILOT_CONFIG_DIR` relocates
custom modes with the rest of the user's config and keeps tests hermetic. The
project directory belongs to the *target* repository, passed as an explicit
`repo_root` rather than taken from the process's directory.

File schema (`schema_version: 1`), and what it deliberately does not contain:

```text
schema_version, id, name, description,
objective, investigation, implementation, verification, constraints, completion,
execution_kind, based_on, based_on_version, version

- `source` is never stored. Scope comes from the directory the file was found
  in, so a file cannot claim to be built-in or to be more trusted than where it
  lives. A payload containing `source` is refused outright.
- the file name must be `<id>.json` and must match the id inside.
- unknown keys are refused rather than ignored: the realistic way to lose a
  section is to misspell it, and a tolerant reader would take "verfication" as
  "no verification given" and run the mode without it.
- every definition passes FixMode.validate(), so custom text inherits the
  Markdown-heading containment and the length cap from Phase 1.
```

Precedence, and what is reserved:

```text
project custom  >  user custom            for a custom id
built-in ids are reserved everywhere      loading, create, duplicate, update, delete
```

A file claiming a built-in id is refused with the reason ("Built-in Fix Mode
'standard' is reserved and cannot be overridden. Duplicate it under a different
custom id.") rather than a generic duplicate error, at load time and at every
mutation. Effective order is deterministic: built-ins in packaged order, then
custom ids alphabetically — never directory enumeration order.

Two views, deliberately kept apart:

```text
effective registry   one definition per id, what a run resolves
                     bugpilot fix-mode list [--json]

scoped catalog       every physical definition, including one another scope
                     shadows, so management can still address it
                     bugpilot fix-mode list --all-scopes [--json]
```

Management would be unable to edit or delete `user/my-safe` while
`project/my-safe` exists if it resolved through the effective registry, which is
why the second view exists at all.

CRUD, all through `FixModeStore`:

```text
bugpilot fix-mode duplicate <source-id> <new-id> --scope user|project [--name TEXT]
bugpilot fix-mode create <id> --scope user|project --from-file <json>
bugpilot fix-mode update <id> --scope user|project --expected-version N --from-file <json>
bugpilot fix-mode delete <id> --scope user|project --expected-version N
bugpilot fix-mode show <id> [--scope user|project] [--json]
bugpilot fix-mode list [--all-scopes] [--json]
```

- create writes version 1 and refuses an incomplete definition: a mode assembled
  half from a payload and half from a built-in is one nobody wrote.
- duplicate copies every section, sets `version=1`, `based_on=<source id>`,
  `based_on_version=<source version>`, and `source` from the target scope. The
  copy is independent: the original may be edited or deleted afterwards.
  `based_on` is audit metadata, never inheritance — nothing is resolved through it.
- update requires `--expected-version` and increments by exactly one. The id,
  the scope and the origin metadata are not the payload's to change; a rename
  would orphan every work item that recorded the id.
- delete requires `--expected-version` too, so a stale list cannot remove a mode
  somebody has since edited.
- everything — payload, expected version, validated definition — is checked
  before the file on disk is touched, so a refused mutation leaves exactly what
  was there.

Optimistic concurrency, stated precisely:

```text
BugPilot-managed writes are conflict-safe: an editor that saves against a stale
expected_version is refused with "Fix Mode 'x' changed since this editor was
opened (expected version N, found M). Reload it before saving."

Manual edits to the JSON file are not. A developer who edits a file by hand
without incrementing `version` bypasses the check — these files are meant to be
edited and committed, and V1 does not hash their content to detect it.
```

Source/version drift (the case custom modes introduce):

```text
Only the id is authority, so a work item prepared under user/my-safe correctly
resolves to project/my-safe once the team defines one. Doing that silently would
swap a personal workflow for a team one with nothing on screen to say so, so a
resume compares the persisted audit metadata against the resolved mode and warns:

  Fix Mode 'my-safe' changed since this work item was prepared: source: user ->
  project. Regenerating with the current effective definition.

Then the Phase 3 policy applies unchanged: use the current definition, record
it, regenerate. The recording happens once the selection resolves — before the
regeneration steps, not after them (see the Phase 3 decision on persistence
timing) — so a resume that fails halfway still leaves the next command on the
current definition. No snapshots, no pinning.
```

Malformed custom files are diagnostics, not a disappearing catalog: the valid
modes still load and each unreadable file is reported with its scope, path and
reason, in `fix-mode list` (stderr), in the `--json` envelope (`issues`), and in
the VS Code management view.

VS Code:

```text
- a gear beside the Fix Mode selector opens Manage Fix Modes
- modes grouped Built-in / User / Project, each row naming its version, its
  investigation kind, and whether another scope overrides it
- built-in: View, Duplicate & Customize. No Edit, no Delete.
- custom: Edit, Duplicate, Delete
- the editor holds name, id, description, execution kind, the six sections and
  scope; id and scope are fixed once the mode exists, version/based_on are shown
  read-only, and source is never editable
- Preview shows the mode's own six sections under the heading "Fix Mode
  Instructions Preview" — never BugPilot's precedence, delivery safety,
  forbidden actions or Jira rules, which are not the developer's to edit
- delete asks once, warning that prepared work items using the mode may no
  longer regenerate until another mode is selected
- a refused save keeps the editor open with what was typed and the reason beside
  it; losing a developer's text is the worst possible answer to "someone else
  saved first"
- definitions travel to the CLI in a temporary JSON file outside the repository,
  uniquely named, removed on success and on failure. Mode text never reaches argv.
- both catalogs refresh after every create/update/duplicate/delete
```

Phase 4 hand-off items, both closed here:

```text
- availability is now a tri-state: available (catalog loaded, mode present),
  unavailable (catalog loaded, mode absent), unknown (catalog unreadable). The
  panel says "availability unknown" rather than claiming a mode is fine because
  BugPilot failed to check.
- the prepared line shows the name the status file recorded, because that is
  what the agent was handed; the catalog is consulted separately, only for
  availability. A renamed custom mode no longer rewrites the history of a
  package prepared before the rename.
- `fix-mode` now receives an explicit `repo_root` through `_dispatch`.
```

Phase 5 test coverage:

```text
tests/test_fix_mode_store.py (54)
  scopes and lazy directories; project scope without a repository; source from
  the directory; a file that tries to declare a source; malformed JSON,
  unsupported schema_version, unknown/misspelled field, missing section, invalid
  execution kind, Markdown headings, bad version; file-name/id mismatch;
  reserved ids in both scopes; project-over-user precedence; the shadowed
  definition staying addressable; deterministic order; one broken file not
  taking the others down; dangerous ids never becoming paths; containment;
  symlinked file rejected; a directory named like a mode; create/duplicate/
  update/delete semantics; expected_version type safety (True, 1.0, "1", 0);
  refused mutations leaving the file intact; built-ins refused on every path

tests/test_fix_mode_custom.py (26)
  the CLI: duplicate/list/--all-scopes/show --json/create/update/delete round
  trips, refusals without tracebacks, JSON error envelopes, a broken file
  reported as an issue; running under user and project custom modes; a custom
  investigate mode getting every structural investigation rule including an
  investigative retry; every regeneration path keeping a custom mode; a deleted
  persisted mode failing loudly; a mode edited between runs being reloaded;
  version drift; the required end-to-end precedence flow; the selection record
  staying audit metadata; project modes coming from the target repository

extension (38 added)
  the management catalog keeping both definitions of a shadowed id; issues
  carried with scope and path; older-bugpilot and failure envelopes; drafts,
  payloads and argv (mode text never on a command line); the temp payload file's
  whole lifecycle, including concurrent saves and failure cleanup; opening a
  shadowed mode from the scope that owns it; built-in read-only and duplicate;
  save refreshing both catalogs; a refused save keeping the editor open; delete
  confirmation, stale delete, declined delete; the tri-state; the historical
  prepared name; the preview showing only mode-owned sections
```

Post-review cleanup (independent Phase 5 review, verdict "ready after minor cleanup"):

```text
- Scope-directory symlink escape closed. The containment check resolved both the
  base directory and the candidate file, so a symlinked `fix_modes` directory
  (or a symlinked `.bugpilot`) satisfied it: both sides followed the same link
  and agreed, while the file landed outside the repository. A cloned repository
  can ship such a link. The store now refuses to treat a directory that
  redirects elsewhere as a scope:
    read      the scope is skipped and reported as an issue with its path;
              built-ins and the other scope stay usable
    mutation  create, duplicate, update, delete and read-by-id all refuse,
              before anything is written
  What the guard covers, stated rather than claimed: symbolic links everywhere,
  plus Windows directory junctions where the interpreter reports them
  (`Path.is_junction`, 3.12+). Other reparse-point types are not classified.
- The extension's Fix Mode CRUD port no longer falls back to `process.cwd()`.
  Without a workspace root it runs nothing and returns a failure envelope, the
  way the two discovery calls already did — `--scope project` decides which
  repository gets a `.bugpilot/` directory, and the extension host's own
  directory is not one the developer chose.
- `asManagedMode` now treats `effective` as a claim Core makes rather than a
  default: a missing field reads as false. The management list exists to say
  which of two same-id definitions runs.
- A test now pins that `create` preserves `based_on` / `based_on_version` from
  its payload — the path "Duplicate & Customize" takes, since the editor saves a
  `create` carrying the origin rather than duplicating and then editing.
```

Project scope and the repository root:

```text
Project Fix Mode operations use BugPilot's explicit target repo root, which the
CLI takes from the directory the command runs in — the same rule `.ai/` follows.
BugPilot expects to be run from the target repository root; nested-directory
repository discovery is not part of Phase 5, and Fix Modes deliberately do not
introduce a discovery mechanism the rest of BugPilot does not have.
```

Deliberately not built in Phase 5: inheritance, a mode expression language,
per-section permissions, approval states, cloud sync, mode recommendation, MCP
mutation, Git automation, a marketplace, or a schema migration framework beyond
refusing an unsupported `schema_version`.

#### Fix Mode Phase 6 — MCP

**Status:** Implemented and validated. Python: 910 passed (30 added). Extension untouched.

Implement:

```text
- fix_mode selection on prepare tools
- list_fix_modes
- selected mode metadata
- read/select only; no MCP mutation of Fix Mode definitions
```

Delivered:

```text
- list_fix_modes: the effective modes for the bound repository, with
  default_mode_id and per-mode metadata (id, name, description, version, source,
  execution_kind, based_on, based_on_version), plus `issues` for any custom file
  BugPilot could not read. One definition per id — the scoped management view
  belongs to the CLI and the editor, because an agent asks which workflows it can
  run, not which files a developer can edit.
- show_fix_mode: one mode in full, including the six instruction sections, so a
  client can see what a mode would ask of it before selecting one.
- fix_mode_id, optional, on prepare_jira_bug and prepare_bug_description. Carried
  as InvestigationRequest.fix_mode_id, resolved once by core, with the CLI's
  precedence unchanged: explicit > persisted > default.
- prepare results gained `fix_mode` (the same metadata shape as
  workflow_status.json and the CLI's --json) and `warnings`, which is how core's
  source/version drift message reaches the client.
- get_status gained `fix_mode`, read back from the record rather than recomputed,
  so a rename or a deletion since the run does not rewrite what was prepared.
```

Boundaries, and why:

```text
- Read, inspect, select. No create, update, duplicate or delete through MCP:
  authoring a workflow is the developer's, in the CLI and the editor, and a test
  asserts those tool names are absent from the surface.
- No storage internals. No paths in the mode payloads, no schema knowledge, no
  expected_version; a test greps the responses for `.bugpilot`, `fix_modes` and
  the repository path.
- No registry logic in MCP: no built-in list, no default id, no project>user
  rule, no JSON parsing. The tools call fix_mode_registry(repo_root) and
  catalog_for(repo_root) and report what comes back — which is what makes a
  custom file claiming `standard` fail through MCP without MCP knowing why.
- No enum of the five built-ins in the tool schema. fix_mode_id is a plain
  optional string, so a mode a developer defines tomorrow works with no server
  change.
- Discovery is read-only: listing creates no directories, in either scope.
- The repository is the one bound at startup. Project modes come from that
  repository, never from BugPilot's own checkout, and two servers on two roots
  see different project modes.
```

Phase 6 test coverage (`tests/test_mcp_server.py`, plus the stdio tool-surface guard):

```text
discovery   built-ins and the declared default; metadata a client chooses by,
            without the six sections; custom user and project modes; a project
            mode shadowing a user mode exactly once; a custom file claiming a
            built-in id rejected with the built-in still authoritative; a broken
            custom file reported while the valid modes remain; no storage paths
            in any response; no directories created; repo A/B isolation; a
            symlinked scope directory unable to inject an external mode
inspection  all six sections plus the origin; unknown and blank ids as tool
            errors rather than a quiet default
selection   no mode uses the core default; built-ins, a custom project mode and
            a custom investigate mode (investigation handoff, no commit offer,
            delivery safety retained) all reach agent_task.md and
            workflow_status.json; a hostile custom mode gains no authority; an
            unknown or since-deleted id is refused by core rather than by a stale
            client list
state       get_status reports what was prepared; re-preparing without a mode
            keeps the persisted one; an explicit mode overrides it (which is how
            an investigation becomes an implementation pass); refine keeps it; a
            deleted persisted mode fails clearly and an explicit valid mode
            recovers; version drift and both directions of source drift surface
            as warnings; a mode edited between calls is reloaded
surface     the tool set is exactly the planned one, in-process and over stdio;
            no Fix Mode mutation tool exists
```

Known limitation, unchanged from earlier phases: a hand-written bug mints a new
work item id per `prepare_bug_description` call, so changing the Fix Mode of an
existing manual work item has no MCP path — `refine_investigation` preserves the
persisted mode and does not take a selection. A Jira work item re-prepares under
the same id, so continuation works there. Widening `refine` would need a core
signature change and was deliberately left out of Phase 6.

### 31.9 Fix Mode Test Coverage

Phase 1 adds `tests/test_fix_modes.py` covering:

```text
- exact five V1 built-in IDs
- Standard Fix default behavior
- complete non-empty instruction sections
- domain independence: no product volume type / OpenVDS / geophysical hard-coding
- frozen built-in definitions
- duplicate ID rejection
- unknown mode does not silently fall back
- future custom mode registration without overwriting built-ins
- validation of empty sections
- Investigate First remains non-editing in its initial pass
- built-in modes contain materially different guidance
```

The pre-Phase-3 review adds to `tests/test_fix_modes.py`:

```text
- execution_kind is "investigate" for investigate-first and "fix" for the other
  four; is_investigation agrees; an omitted execution_kind defaults to "fix"
- invalid execution_kind values are rejected (including "investigate-first", None, 1)
- execution_kind cannot be reassigned on a built-in
- based_on_version round-trips on a derived mode; 0, -1, "1", 1.0 and True are
  rejected; based_on_version without based_on is rejected; based_on without a
  version is allowed
- invalid based_on values are rejected
- every text field rejects None/int/float/list/dict/bool with FixModeError naming
  the field, not AttributeError or TypeError
- invalid version and source values raise FixModeError
- list_modes rejects an unknown source filter
- the registry rejects a non-FixMode entry, and resolve() rejects a non-string id
- no built-in says "inspect relevant history" or mentions git log; Conservative and
  Deep Analysis point at the supplied evidence and ask for missing evidence to be
  reported instead of broad exploration
```

Phase 2 adds `tests/test_fix_mode_prompts.py` covering:

```text
- no fix_mode renders Standard Fix (backward compatibility for existing callers)
- Standard metadata (Mode / Mode ID / Version / Source) appears; no empty "Based on"
- both generators render the identical task file for the same mode
- Conservative, Investigate First, Test-Driven and Deep Analysis each produce
  different guidance, and all five modes produce distinct task files
- Investigate First explicitly delays source editing
- the six mode sections render in a stable order in every mode
- invariant evidence/safety rules and the five required result files appear in
  every mode, and the task file states that the mode cannot relax them
- mode guidance is rendered before the BugPilot rules it cannot edit
- the old "## Analysis Workflow" / "## Implementation Workflow" text is gone rather
  than shadowing the selected mode
- an unknown or near-miss mode ID raises instead of falling back to Standard
- a custom FixMode object renders (including source/version/based_on) without being
  registered, and an invalid one is rejected at render time
- a hostile custom mode cannot remove the invariant sections or the output files
- Developer Hint appears, does not override Investigate First, and does not weaken
  the safety rules; no hint means no hint section
```

The pre-Phase-3 review adds to `tests/test_fix_mode_prompts.py`:

```text
- passing a mode id string is refused with a pointer to FixModeRegistry.resolve
- unknown and near-miss ids still fail at the registry, never by falling back
- the precedence statement appears in every mode, before the invariant rules
- Execution metadata renders; "Based on" / "Based on version" render for a derived
  mode and are omitted when absent
- Investigate First: no commit/push offer, no Optional Assisted Delivery section,
  no proposed commit message, no git push line
- Investigate First states "Investigation complete. No source changes have been
  applied.", forbids fixed/resolved/verified wording, asks "Do you want me to
  continue with implementation?", and describes the five artifacts as investigation
  state
- the four fix modes keep the Optional Assisted Delivery commit gate
- the opt-in Jira status block is honest for an investigation and unchanged for a fix
- agent_handoff.md carries the investigation stop, and names the mode otherwise
- a custom mode with execution_kind="investigate" gets the investigation handoff
  and still cannot remove the invariant sections
- a custom mode cannot reorder the six sections; a bad execution_kind is rejected
  at render time
- Developer Hint says "Treat", never "Trust", asks for verification against the
  evidence, and says to report a contradiction
- Conservative and Deep Analysis history wording stays inside the supplied evidence
```

The second review adds:

```text
tests/test_fix_modes.py
- Markdown headings rejected in every editable text field, including forged
  "## Forbidden Actions" and "## BugPilot Rule Precedence"
- '#' in ordinary prose and indented '#' comment lines still accepted
- text exactly at MAX_FIX_MODE_TEXT_LENGTH accepted, one character over rejected
- every built-in section is inside the limit
- based_on == id rejected
- every mode investigates from the supplied evidence, and the one mode that
  widens scope (deep-analysis) carries an explicit bound
- no mode mentions git log/git blame/repository-wide exploration

tests/test_fix_mode_prompts.py
- the delivery-safety rules are part of the shared invariant list, so every
  per-mode and hostile-custom-mode test now checks them
- investigate mode keeps delivery safety while dropping the offer, and states
  that the gate still applies to a continuation pass
- "## BugPilot Delivery Safety" renders exactly once in every execution kind
- each BugPilot heading appears exactly once per task, for built-in and custom modes
- deep-analysis renders the restored exploration bound
- the investigation handoff file no longer promises a delivery summary

tests/test_workflow.py
- team instructions defer to the task's Fix Mode
- the packaged team document and the in-code fallback are identical
```

`tests/test_workflow.py::test_bug_hint_is_injected_into_copilot_task` was updated to the new hint contract ("Treat", verify against the evidence, and no "Trust this hint"). `tests/test_no_unwired_symbols.py` gained an ALLOWED entry for `fix_modes.builtin_fix_mode_registry`, which is the id-resolution boundary and deliberately has no production caller until Phase 3; that guard's own honesty test will force the entry out once the CLI calls it.

Validation run for Phase 2 (initial):

```text
python -m pytest tests/test_fix_modes.py tests/test_fix_mode_prompts.py -q   -> 48 passed
python -m pytest -q                                                          -> 599 passed
git diff --check                                                             -> clean
```

Validation run for the pre-Phase-3 review:

```text
python -m pytest tests/test_fix_modes.py tests/test_fix_mode_prompts.py -q   -> 164 passed
python -m pytest -q                                                          -> 715 passed
git diff --check                                                             -> clean
```

### 31.10 V1 Definition of Done

```text
[x] Five built-in Fix Modes exist.
[x] Standard Fix is the default.
[x] Standard Fix preserves existing default workflow behavior.
[x] Core has one Fix Mode registry/source of truth.
[x] agent_task.md separates evidence, Fix Mode guidance, and invariant safety rules.
[x] CLI can select a Fix Mode.
[x] VS Code can select a Fix Mode.
[x] User can create custom modes.
[x] Custom modes support user and project scope.
[x] Built-in modes cannot be overwritten.
[x] Built-in modes can be duplicated and customized.
[x] Selected mode/version/source is recorded for auditability.
[x] MCP can read/select modes but cannot modify them.
[x] No VDS/geophysical-specific instructions are hard-coded into Fix Mode.
[x] Existing behavior remains backward compatible when no mode is explicitly selected.
[x] Existing tests remain green and new Core/CLI/Extension/MCP tests are added as phases land.
```

### 31.11 Explicit Non-Goals for V1

```text
- AI automatically creating or rewriting Fix Modes
- automatic mode selection without developer choice
- Fix Mode marketplace
- cloud synchronization
- mode analytics/scoring
- provider-specific mode forks
- complex inheritance or conditional workflow DSL
- Product-volume/OpenVDS/geophysical-specific memory or instructions
```

### 31.12 Implementation Log

| Date | Phase | Status | Implemented / Decision |
| --- | --- | --- | --- |
| 2026-09-21 | Planning | Completed | Defined the Fix Mode boundary: Context controls what AI knows; Fix Mode controls how AI works. Safety remains BugPilot-owned. |
| 2026-09-21 | Phase 1 | Completed | Added frozen `FixMode`, validation, `FixModeRegistry`, five domain-independent built-in modes, deterministic Standard default, exact unknown-mode failure, and focused core tests. 11 targeted Fix Mode tests passed; full Python suite: 562 passed. |
| 2026-09-21 | Phase 2 | Completed | `generate_prompts` / `generate_copilot_task_files` take `fix_mode` (None \| ID \| `FixMode`) resolved through `prompts._resolve_fix_mode` against the Phase 1 registry. `agent_task.md` now renders "## AI Fix Mode" (metadata + the six sections in model order) followed by the invariant "## BugPilot Evidence Rules" and "## BugPilot Editing Guardrails"; the hard-coded "## Analysis Workflow" / "## Implementation Workflow" sections were split so mode-owned guidance lives only in the mode. Developer Hint no longer tells the agent to implement immediately. `workflow.py`, the CLI, VS Code and MCP were deliberately untouched. Also removed the UTF-8 BOM from `fix_modes.py`, which had made the whole module invisible to `tests/test_no_unwired_symbols.py`. Fix Mode tests: 48 passed; full Python suite: 599 passed. |
| 2026-09-21 | Phase 1 / 2 review | Completed | Pre-Phase-3 corrections. Model: added `execution_kind` (`fix` \| `investigate`) and `based_on_version`, plus type-defensive validation that raises `FixModeError` naming the field instead of leaking `AttributeError`/`TypeError`; Conservative and Deep Analysis history wording now points at BugPilot-supplied evidence rather than broad exploration. Task package: the renderer takes a resolved `FixMode` (an id string is refused with a pointer to `FixModeRegistry.resolve`), investigation-only modes render "## Investigation Handoff" with no commit/push offer and the same five artifacts described as investigation state, the Developer Hint says "Treat" and asks for verification, and "## BugPilot Rule Precedence" states that a BugPilot rule wins any conflict with a mode. Fix Mode tests: 164 passed; full Python suite: 715 passed. |
| 2026-09-22 | Phase 1 / 2 second review | Completed | Independent architecture review, then its corrections. Split `delivery_instructions.py` into a BugPilot-owned safety gate rendered in every Fix Mode and an assisted-delivery offer withheld from investigations, closing a case where withholding the offer also withheld the staging/secret/branch rules. Restored Deep Analysis's general exploration bound. Gave `agent_team_instructions.md` and its fallback a Fix Mode precedence section so the team document stops re-offering commit/push to an investigation-only pass. Added Markdown-heading and length containment plus `based_on != id` to `FixMode.validate()`. Fixed the investigation handoff wording and removed a vacuous test assertion. Recorded `retry_prompt_step` as a Phase 3 requirement rather than changing it here. Fix Mode tests: 193 passed; workflow + unwired: 198 passed; full Python suite: 746 passed. |
| 2026-09-22 | Phase 3 | Completed | CLI selection, persistence and regeneration consistency. Added `--fix-mode <id>` (plus the default-command shorthand), `fix-mode list` and `fix-mode show`. `InvestigationRequest.fix_mode_id` carries the choice; `run_investigation` resolves it once through `FixModeRegistry` before the fresh-run clean and passes the resolved `FixMode` to `prompt_step`. The selection persists at `.ai/<work item>/fix_mode.json` and is re-resolved by id on every read, so resume, refine, `prompt`, `agent-task` and `retry-prompt` all regenerate under it and an unresolvable selection fails clearly instead of becoming Standard Fix. The retry renderer now follows `execution_kind`, closing the Phase 1/2 review finding. Mode metadata is exposed in `workflow_status.json`, `bug --json` and `status --json`. Removed the temporary `builtin_fix_mode_registry` exemption from the unwired-symbol guard. Fix Mode tests: 236 passed; workflow/CLI/MCP/unwired: 335 passed; full Python suite: 789 passed. |
| 2026-09-22 | Phase 4 | Completed | VS Code Fix Mode selection. Added `bugpilot fix-mode list --json` (envelope with `default_mode_id` and per-mode display metadata, no instruction text) as the one structured discovery surface; `fix-mode show --json` is refused with a pointer to it and the human listing is unchanged. The extension gained `src/app/fixModes.ts` (catalog model and payload parsing), `loadFixModes` in `host/ports.ts`, a `listFixModes` controller port read once per environment resolution, `FormState.fixModeId` rendered as `--fix-mode=<id>`, and a Fix Mode selector above the run button with the selected mode's description, an investigation-only sentence driven by `execution_kind`, and a separate "Prepared with Fix Mode" line from `workflow_status.fix_mode`. No mode list, default id, registry logic or instruction text was duplicated in TypeScript, and two tests read every shipped source file to keep it that way. Extension: 441 tests passed, typecheck clean. Python: 794 passed. |
| 2026-09-22 | Phase 4 cleanup | Completed | Independent Phase 4 review corrections. A Fix Mode now follows the work item through both ways of switching: `Controller.#deriveFixModeFor` is shared by `showWorkItem` and `formChanged`, with one identity rule in `form.workItemScopeOf`, so typing a different issue key no longer carries the previous bug's mode into a new run. Editing other fields still leaves a deliberate choice alone, and a half-typed key is not treated as another work item. `fixModesFromPayload` rejects a payload containing duplicate mode ids. Recorded the three Phase 5 hand-off items above: the availability tri-state, prepared-name-as-history, and the `repo_root` seam for `fix-mode`. Extension: 448 tests passed, typecheck clean. Python: 794 passed. |
| 2026-09-22 | Phase 5 | Completed | Custom Fix Modes at user and project scope. Added `bugpilot/core/fix_mode_store.py`: strict schema, scope-derived source, reserved built-in ids, project-over-user precedence, an effective registry kept separate from the scoped management catalog, path/symlink containment, atomic writes, and CRUD with `expected_version` optimistic concurrency. `fix_mode_state.fix_mode_registry(repo_root)` now resolves through built-ins plus custom modes, rebuilt per command, and drift detection covers source as well as version so a work item never switches silently between a personal and a team definition. CLI gained duplicate/create/update/delete, `show --json` and `list --all-scopes --json`, all with structured envelopes and an explicit `repo_root`. VS Code gained Manage Fix Modes: grouped list, editor with fixed id/scope and read-only origin, Duplicate & Customize, instructions-only preview, confirmed delete, payloads carried in temporary files, and both catalogs refreshed after every change. Closed the two Phase 4 hand-off items (availability tri-state, historical prepared name). Python: 874 passed; extension: 486 passed; typecheck clean. |
| 2026-09-22 | Phase 5 cleanup | Completed | Independent Phase 5 review corrections. Closed a path-containment escape: a symlinked `fix_modes` directory (or `.bugpilot`) passed the check because resolving both sides followed the same link, so project modes could be read from and written outside the repository. `FixModeStore` now refuses a redirecting scope directory — reported as an issue on the read path, refused before any write on every mutation — with the guard's coverage (symlinks, plus Windows junctions where the interpreter reports them) documented rather than overclaimed. The extension's CRUD port no longer falls back to `process.cwd()` when there is no workspace root, `asManagedMode` no longer assumes `effective`, and `create` preserving `based_on` is now pinned by a test. Python: 880 passed; extension: 489 passed; typecheck clean. |
| 2026-09-22 | Phase 6 | Completed | MCP Fix Mode support, read and select only. Added `list_fix_modes` (effective modes for the bound repository, `default_mode_id`, and diagnostics for unreadable custom files) and `show_fix_mode` (one mode including its six sections), plus an optional `fix_mode_id` on both prepare tools carried as `InvestigationRequest.fix_mode_id`. Prepare results now return the `fix_mode` metadata shape already used by `workflow_status.json` and `--json`, together with core's `warnings` so source/version drift reaches the client; `get_status` reports the recorded mode. No CRUD, no storage paths, no registry logic and no enum of built-ins in MCP — the tools call `fix_mode_registry(repo_root)` and `catalog_for(repo_root)` and report what comes back. Python: 910 passed; extension untouched. |
| 2026-09-22 | Final review cleanup | Completed | Pre-commit corrections from the final Phases 1–6 review. Caller text now follows `execution_kind`: the CLI launch lines, the MCP `next_step`, the MCP `fix_bug` prompt and the Claude Code skill no longer tell an agent to "implement the smallest safe fix" under an investigate-kind mode — the handoff points at `agent_task.md`, and the task file decides. `refine_investigation` resolves the persisted mode once and carries it on its result, so the MCP refine response reports `fix_mode` instead of `null`. `fix-mode list <id>` is refused with a pointer to `show`. The extension maps an older core's "invalid choice: 'fix-mode'" to the upgrade message. Persistence timing documented as implemented (recorded once the selection resolves, before the pipeline). README, extension README and CHANGELOG gained the feature. |
| 2026-09-23 | AI Hint Improvement | Completed | Optional AI rewrite of the developer's hint, in Advanced settings. New `bugpilot issue-details <KEY> --json`: the same Jira client and parser a run uses, read-only, writing nothing — `fetch` was not reused because it mints `.ai/<issue>/`. New `extension/src/app/hintImprovement.ts` holds the prompt, the response cleanup, the cache key and its own provider table (`claude -p`, `codex exec -`), separate from `KNOWN_AGENTS` because a terminal handoff and a one-shot text transform are different contracts. The prompt travels on stdin and the child runs in an empty temporary directory, so no hint reaches argv and no CLI with file tools has the repository within reach; a custom agent command is refused rather than shell-interpolated. Issue text is optional (`Use issue details`, on by default), falls back to hint-only with a notice when Jira cannot be read, and is cached per work item. A suggestion is shown beside the field and never replaces the hint until Use Improved. Extension: 581 passed; Python: 925 passed; typecheck clean. |
| 2026-09-22 | AI Fix Mode | Complete | Six phases: model and registry, prompt integration, CLI selection and persistence, VS Code selection, custom user/project modes, MCP discovery and selection. Remaining known limitations are recorded with their phases rather than closed: manual-edit version discipline, changing the mode of a hand-written work item, and nested-directory repository discovery. |

For every later Fix Mode phase, update this table in the same change set so the original development plan remains the source of truth for both planned and completed work.

## 32. AI Hint Improvement

**Status:** Implemented and validated. Extension: 581 tests passed, typecheck
clean, activation smoke ok. Python: 925 passed (6 added).

### 32.1 Goal

A hint is a pointer at where the fix belongs, and developers write them fast:
"maybe cache issue", "output validation? don't touch VolumeDescriptor". An agent
reading that gets tone and guesswork. This turns one of those into something an
agent can act on — and stops there.

It is a text rewrite, not a step of a run. Nothing is searched, nothing is
built, nothing is written, and the developer's own hint is never replaced
without them pressing a button.

The three rules the prompt exists to hold:

```text
- it rewrites, it never investigates — no repository, no git history, no files
- it never asserts a cause — "maybe cache" comes back as something to
  investigate, because a confident wrong hint stops the agent looking
- it never drops a constraint — "do not modify VolumeDescriptor" is the most
  valuable thing in a hint and the easiest thing for a rewrite to smooth away
```

### 32.2 UI

Under the hint field in Advanced settings, and nowhere else:

```text
Hint
[ maybe output validation, don't change VolumeDescriptor        ]
☑ Use issue details                            🤖 Improve with AI
The issue title and description only. No repository, history or files are read.
```

A suggestion arrives beside the field, never in it:

```text
AI Suggested Hint
Investigate whether output-type validation could be excluding the expected
volume type. Do not modify VolumeDescriptor while investigating or implementing
the fix.
[ Use Improved ]  [ Keep Original ]
```

`Use Improved` writes it into the editable hint, where it can still be edited.
`Keep Original` drops it. While a request is out, the action reads `Improving…`
with the theme's own spinner and is disabled; nothing else in the panel is.

### 32.3 Issue context

`Use issue details` is on by default and gates one thing: whether the improver
may read the issue's **title and description**. Never the repository.

```text
Jira issue      -> bugpilot issue-details <KEY> --json
Hand-written    -> the title and description already in the form; no Jira call
Box unticked    -> hint only, and the prompt says so out loud
Jira unreachable-> hint only, plus "Issue details unavailable — improving from
                   hint only." A fallback, not an error.
```

`issue-details` is a new read-only CLI command: the same `fetch_issue` and
`parse_issue` a run uses, and **no writes**. `fetch` was not reused because it
creates `.ai/<issue>/` — a run needs those artifacts, and minting a work item as
a side effect of improving a sentence would be a surprise. The extension has no
Jira client of its own and gains none here; credentials stay in the CLI.

Issue text is cached per work item for the session, so pressing Improve twice —
or running afterwards — does not ask Jira the same question again.

### 32.4 Provider

`HINT_PROVIDERS` in `app/hintImprovement.ts`, deliberately **not**
`KNOWN_AGENTS`:

```text
claude  ->  claude -p        prompt on stdin, answer on stdout
codex   ->  codex exec -     same
auto    ->  the first of those that is on PATH
custom  ->  refused, with a reason
```

`KNOWN_AGENTS` describes an agent being handed a repository in a terminal; this
describes a one-shot text transform whose answer is read from stdout. The
argument shapes differ and so do the stakes, so they are separate tables rather
than one table with a flag. A custom agent command is a shell template with
`{prompt}` in it: substituting a hint into one would put untrusted prose on a
command line, which is the thing this feature is built to avoid.

### 32.5 Security boundaries

```text
- the prompt travels on stdin; no hint ever reaches argv or a shell string
- argv is the provider's own fixed arguments, nothing interpolated
- the child runs in an empty temporary directory, not the repository, so a CLI
  with file tools has no project files within reach. Stronger than a permission
  flag this code would have to guess at, and true for every provider.
- no Jira credentials and no secrets are passed to the AI process
- issue text is marked in the prompt as context, not instructions
- the panel renders every suggestion with textContent
```

### 32.6 Caching

In memory, for the session. The key is everything that changes the answer:
provider, issue context (kind and text), and the hint itself. Editing the hint,
unticking the box or moving to another issue all miss rather than return a stale
suggestion, and a displayed suggestion is dropped outright when the hint or the
work item changes.

### 32.7 Tests

```text
prompt    role and rules present; hint-only says so; issue text marked as
          context; the hint arrives last and verbatim; long descriptions
          truncated
response  fences, labels and wrapping quotes removed; capped at HINT_LIMIT so an
          accepted suggestion can never be a hint the run refuses
cache     every input that changes the answer changes the key
provider  auto picks the first installed; a missing one is named; a custom
          command is refused and not even probed; no provider carries the prompt
          in argv
flow      hint-only, with Jira details, with a hand-written description, box
          unticked, Jira failure falling back with a notice, empty hint making
          no call, a duplicate press making no second call, provider missing,
          provider failing, the issue read once and reused
state     the hint is untouched until Use Improved; Keep Original leaves it;
          editing the hint or changing the issue drops the suggestion
panel     the form travels with the request; busy disables the one control;
          the suggestion renders beside the field; both answers post their
          message; no run is ever requested
cli       title and description reported; nothing written; human form; a Jira
          failure is a clean envelope; a hand-written work item refused; mock
          data still opt-in
```

### 32.8 Deferred

Named in the brief and deliberately not built: generating a hint when there is
none, repository-aware hints, rewrite styles, hint history, improvement while
typing, and anything that changes the hint without the developer accepting it.

Not deferred but worth recording: a custom agent command cannot improve hints,
because doing it safely needs that provider's non-interactive argument shape,
which only the developer who configured it knows.

## 33. Retrieval Quality

**Status:** 33.1-33.7 Complete and verified. 33.8 Deferred by design.

```text
33.1  Retrieval Regression Baseline   Complete   harness + corpus + baseline
33.2  Search Surface Correctness      Complete   one extension list; docs reserved out of the lead
33.3  Search Term Quality             Complete   weight from evidence, not position
33.4  Repository Term Probing         Complete   true counts; broad terms demoted
33.5  Hint-Aware Retrieval            Complete   hint is a weighted signal
33.6  Context Ranking                 Complete   verified; no production change needed
33.7  Regression Verification         Complete   top-5 recall 0/5 -> 3/5; docs 15/30 -> 9/30
33.7A Real Historical Corpus Support  Complete   loader, MRR, report — 0 real cases available
33.7B Identifier-Shape Expansion      Complete   prose -> camelCase/snake_case, probe-gated
33.7C Retrieval Metrics/Calibration   Complete   top-3 2/5 -> 3/5; MRR 0.307 -> 0.467
33.8  AI Semantic Expansion           Deferred   one measured case needs it; not yet justified
33.10 Pre-Commit Fix Pass             Complete   review findings closed; metrics held, 5.3s -> 4.0s
```

Cumulative, baseline (§33.1) to now:

```text
              baseline   now
top-3 recall       0/5   3/5
top-5 recall       0/5   3/5
MRR                  -   0.467
docs in top 5    15/30   9/30
```

Files changed: `bugpilot/core/code_files.py` (new), `search_terms.py` (new),
`search.py`, `keywords.py`, `workflow.py`. Tests added:
`tests/retrieval_corpus.py` (harness), `test_retrieval_regression.py`,
`test_search_surface.py`, `test_search_probing.py`, `test_hint_retrieval.py`,
`test_context_ranking.py`; four existing guards loosened from exact-shape to
contract assertions. Python 983 passed.

**C++/Qt validation: not done.** No historical target-repository corpus was
available locally, so every case is Python/TypeScript. The extension work in
§33.2 is verified by fixture for `.c`, `.hxx`, `.qml`, `.ts` and `.js`, but the
breadth threshold in particular was derived from this repository's term
distribution and will differ on a large Qt codebase. Recorded as the outstanding
validation for this section.

The objective is not better-looking keyword lists. It is:

```text
find the smallest set of search terms that retrieves the files most likely to
help fix the bug, while keeping irrelevant context out
```

### 33.0 What the investigation found

Measured against this repository, not inferred. The pipeline today is:

```text
issue/description -> parse_issue.combined_text -> extract_keywords
                  -> user keywords prepended -> one `rg` per term
                  -> _rank_related_files -> related_files.json -> bug_context.md (top 5)
```

Problems, ranked by effect on retrieval:

```text
1. The high-value tier is positional. `high_value_keywords = keywords[:5]` takes
   the top five of the ranking whatever they are, and search.py gives that tier
   weight 6. On a prose bug the five are prose:
     "The data process output is wrong and the volume is not updated correctly."
       high: ['correctly', 'data', 'process', 'output', 'volume']
   `selected` outranks `VDS` because length >= 8 scores +1 and an all-caps
   acronym scores 0.
2. Documentation competes with implementation. `*.md` is an include glob, and
   prose terms match prose files. Measured, for
   "Fix Mode selection is not persisted when the run fails halfway.":
       1 docs/bugpilot_prototype_development_plan.md
       2 bugpilot/cli.py
       3 README.md
       4 docs/architecture.md
       5 docs/adapter_design.md
   `bugpilot/core/fix_mode_state.py` — the file that implements the behaviour —
   does not appear at all. With identifier terms it ranks first.
3. Breadth is measured and thrown away. `_rg_keyword` reads all of rg's output
   and breaks at MAX_MATCHES_PER_KEYWORD, so a term matching 9,000 lines and one
   matching exactly 20 are indistinguishable downstream.
4. The Hint never reaches retrieval. It is written to developer_hint.md and read
   only by prompts.py.
5. Nine extensions the extractor recognises are never searched: .c .cs .go .hxx
   .java .js .qml .rs .ts
6. No bridge between identifier and prose spellings. `VolumeDescriptor` finds 4
   matches; `volume descriptor` finds 0, and vice versa.
```

### 33.1 Retrieval Regression Baseline

**Status:** Complete. Harness and corpus added; baseline measured and recorded
below. 8 tests passed.

Files: `tests/retrieval_corpus.py` (harness + corpus, not collected by pytest),
`tests/test_retrieval_regression.py` (mechanics and a loose floor).

`run_case` mirrors `workflow.keywords_step` rather than calling it: that step
reads and writes a work-item directory, and the harness wants the retrieval, not
the artifacts. The user-keyword merge is reproduced exactly.

**Baseline, measured 2026-09-23 against this repository at c767ddd:**

```text
case                            kind                     best  t3  t5 t10  docs@5  terms   sec
fix-mode-persistence            natural language            -   n   n   n       3      5   0.2
identifier-persist-fix-mode     strong identifier           7   n   n   Y       3     15   0.7
prose-heavy-keyword-extraction  prose heavy                 6   n   n   Y       2     14   0.6
generic-terms-only              generic terms               -   n   n   n       2      6   0.3
atomic-write-crash              natural language            -   n   n   n       3     10   0.5
hint-points-at-the-fix          hint carries direction      -   n   n   n       2      3   0.1

top-3 recall     0/5
top-5 recall     0/5
top-10 recall    2/5
docs in top 5    15/30 slots
total duration   2.5s
```

Read that table before reading anything else in §33. Retrieval does not merely
rank the right file low — on three of five cases it does not return it at all,
and half of every top-5 is documentation. `generic-terms-only` has no expected
file on purpose: it measures what a bug made only of generic words drags in.

Limitations, recorded rather than smoothed over:

```text
- ranks move as this repository moves, so the corpus is a floor, not a snapshot;
  exact numbers live here and the tests assert loose thresholds
- one real-world gap: no C++/Qt corpus. Every case is Python/TypeScript, which
  is the language mix this repository has. §33.2's extension work is therefore
  verified by fixture, not by a real Qt tree. Recorded as deferred validation.
- `hint-points-at-the-fix` carries a hint that currently cannot affect anything;
  it is in the corpus now so §33.5 has a before number to move.
```

Objective: measure retrieval before changing it, so every later claim is
evidence-based rather than plausible.

```text
- a harness that runs the real pipeline (extract -> search -> rank) over a case
- metrics: rank of each expected file, top-3/5/10 hit, docs in top 5, zero-match
  terms, broad terms, candidate term count, duration
- a corpus of at least five cases: natural-language, strong-identifier,
  prose-heavy, generic-terms, and one with a known implementation file
- fixture repositories where determinism matters; this repository where it is
  stable
- baseline recorded as data, not as assertions: a baseline test must not fail
  because retrieval is currently poor
```

Acceptance: baseline numbers recorded in this section before 33.2 begins.

### 33.2 Search Surface Correctness

**Status:** Complete. 30 focused tests passed; 231 existing search/workflow/
context tests still pass.

Files: new `bugpilot/core/code_files.py`; `bugpilot/core/search.py`,
`bugpilot/core/keywords.py`, `tests/test_core_robustness.py` changed; new
`tests/test_search_surface.py`.

**One list, where there were three.** `search.INCLUDE_GLOBS` built ripgrep's
`-g` flags, `search._is_included_path` re-stated the same suffixes inline to
filter rg's output, and `keywords._CODE_EXT` decided whether `widget.cpp` in a
report looked like a file name. The third had drifted nine extensions away from
the other two: `.c .cs .go .hxx .java .js .qml .rs .ts` were recognised and
unsearchable, so a bug naming `reader.ts` produced a keyword for a file the
search would never open. All three now derive from `code_files.CODE_SUFFIXES`.
Exclusion directories are unchanged.

**Documentation keeps its seat but not the front row.** Of the mechanisms
considered — separate scores, a penalty, bands, reserved slots — reserved slots
is the one that states the actual requirement: `RESERVED_IMPLEMENTATION_SLOTS =
3` of the files that survive the cap are kept for implementation when
implementation exists. Scores are untouched; this decides which files survive
the cap and in what order. Documentation is still searched and still returned,
because a design note naming the subsystem is a real lead. Focus Files are
exempt: a `--focus-file` is an instruction, and a reservation that could demote
one would be the ranker quietly overruling the developer — so pinned files lead
whatever their kind, including documentation.

**Interim measurement after 33.2, recorded because it got worse before it got
better:**

```text
                  baseline   after 33.2
top-3 recall           0/5          0/5
top-5 recall           0/5          0/5
top-10 recall          2/5          1/5   <-- regression
docs in top 5        15/30        11/30
```

Documentation dropped from half the top-5 slots to a third, as intended. But
`prose-heavy-keyword-extraction` fell out of the top 10 (was rank 6). Cause:
making `.ts`/`.js` searchable added the whole VS Code extension to the candidate
pool, and under the current flat prose weighting those files match generic terms
("keywords", "files", "good") as readily as `core/keywords.py` does. Recall went
up and precision went down.

This is the expected shape of the problem and the reason §33.3 and §33.4 follow:
more search surface is only useful once term weight reflects term evidence. Not
patched over here — it is re-measured in §33.7, and the acceptance criterion is
that this case recovers.

Coverage before semantics.

```text
- align the searched extensions with the extensions the extractor recognises,
  from one source of truth rather than two lists that drift
- keep the existing exclusion directories
- separate implementation candidates from supporting documentation so prose
  matches in docs cannot crowd source out of the top ranks — without declaring
  documentation useless
```

Acceptance: a file in each newly supported extension is findable; source
outranks a broadly-matching doc; docs still reachable as supporting context.

### 33.3 Search Term Quality

**Status:** Complete. 245 search/workflow/surface/robustness tests pass.

Files: new `bugpilot/core/search_terms.py`; `bugpilot/core/keywords.py`,
`bugpilot/core/search.py` changed; `tests/test_workflow.py` schema guard
loosened to the real contract.

**The model.** Three fields, because the ranker reads three:

```python
@dataclass(frozen=True)
class SearchTerm:
    value: str
    source: Literal["issue","hint","user","identifier","phrase","expanded"]
    weight: int
```

`kind`, `confidence` and provenance chains were considered and left out — nothing
would have branched on them, and an unused field in a scoring path becomes a
future argument about what it meant.

**Weights**, on the scale `search._match_weight` already used, so the ranker's
arithmetic keeps its meaning and only the assignment changes:

```text
12  quoted phrase            an exact UI/error string is near-unique
 8  user keyword, and        the developer or the crash said this;
    stack-trace identifier   neither is guessing
 6  code-shaped identifier   a hump, a qualifier, an underscore, a file name,
                             or an all-caps acronym of 3-6 characters
 4  hint prose               chosen by the developer, but still a hypothesis
 2  issue prose
 1  generic prose, hedges, and sub-tokens split from compounds
```

Two additions the measurements forced:

```text
- acronyms. `_is_identifier_shaped` looks for a camelCase hump, and an acronym
  has none, so `VDS` weighed exactly as much as `selected`. All-caps, 3-6
  characters, not a stop word -> identifier. Bounded by length so a shouted
  sentence does not become a pile of identifiers.
- hedges. A hint begins "maybe" or "possibly" more often than not, and those
  words carry none of its meaning.
```

**Backward compatibility.** `extract_keywords` still returns the five legacy
lists; `extracted_keywords.json` is written into every work item and printed by
the CLI. One key was added beside them — `priority_keywords`, which of the tokens
the software itself printed — because the five cannot express it and the
weighting needs it. The schema guard now asserts the five are present rather
than that nothing else is, which is the actual contract.

**Term budget.** `MAX_SEARCHED_TERMS = 28`, matching the old worst case
(5 + 10 + 5 + 8). Weight decides which survive, so the bound on
`terms x 20s timeout` is unchanged.

**Measured after 33.3:**

```text
                  baseline   after 33.2   after 33.3
top-3 recall           0/5          0/5          1/5
top-5 recall           0/5          0/5          1/5
top-10 recall          2/5          1/5          2/5
docs in top 5        15/30        11/30        11/30
```

`identifier-persist-fix-mode` moved 7 -> 3. `hint-points-at-the-fix` moved from
absent to 9, because wiring the weighted list into `run_code_search` also gave
`options.hint` a path into retrieval for the first time — §33.5's plumbing
arrived here as a side effect, and that section covers its semantics and tests
rather than its existence. The three cases still missing are prose bugs whose
terms match documentation as readily as implementation; §33.4 is the part that
addresses breadth.

Replace positional importance with evidence.

```text
- a term's weight comes from what it looks like and where it came from, never
  from its index in a list
- strongest: stack/error identifiers, explicit user keywords, strong code
  identifiers
- medium: quoted phrases, hint-derived technical terms
- lower: ordinary issue prose
- lowest: generic prose
- smallest model that the ranker actually uses; no unused metadata
- extracted_keywords.json keeps its five legacy lists
```

Acceptance: `correctly`/`selected`/`changing`/`data`/`process` no longer reach
the top weight by position; `OpenVDS`, `SamplePoststackReader`,
`VolumeDescriptor`, `mapSampleIndexToSampleValue`, `sample_volume_cache.cpp` still do.

### 33.4 Repository Term Probing

**Status:** Complete. 10 focused tests added; 261 search/workflow/context tests
pass.

Files: `bugpilot/core/search.py`; new `tests/test_search_probing.py`;
`tests/test_workflow.py` search-quality guard loosened to the real contract.

**Two ideas that were conflated, separated.** `TermSearchResult` holds
`total_match_count` (how much of the repository the term touched — decides what
it is worth) and `retained_matches` (bounded evidence shown downstream). The
count was always there: ripgrep prints every match and the collector discarded
the surplus. Counting costs one pass over output already in memory; no second
process.

**The threshold, derived rather than guessed.** Measured over the §33.1 corpus
against this repository: 58 terms, median 193 matches, deciles
`[12, 27, 40, 76, 193, 308, 512, 791, 2254]`. The two genuinely specific terms —
`persist_fix_mode` (12) and `fix_mode.json` (19) — sit in the bottom two deciles,
three orders of magnitude below `Fix` (3,472) and `Mode` (4,150).
`BROAD_MATCH_THRESHOLD = 500` is the ~70th percentile. One constant, one place;
re-derive it with `tests/retrieval_corpus.py` if the corpus changes.

A broad term is demoted to the weakest weight, not dropped: it is sometimes the
only thread connecting a file to the report, and dropping it would trade a
precision problem for a recall one.

**The defect this phase actually found.** The retained cap counted *lines*, and
ripgrep walks in directory order — so a term with 76 matches retained whatever
the walk reached first. `bugpilot/core/fix_mode_state.py` contains `persisted`
nine times and `FixMode` twenty-four, and was retained for neither: the budget
had been spent in `bugpilot/cli.py` before the walk arrived. This was invisible
from the outside and larger than the weighting problem.

The budget is now counted in files (`MAX_FILES_PER_TERM = 20`,
`MAX_MATCHES_PER_FILE_PER_TERM = 3`), so a term's evidence spans the repository.
And because spreading helps a term that names something while hurting one that
is everywhere, a broad term gets `BROAD_TERM_FILE_BUDGET = 4`. Both halves were
measured:

```text
                                    top-3   top-5   docs@5
after 33.3                            1/5     1/5    11/30
+ file-spread budget for all terms     0/5     0/5    11/30   <-- worse
+ smaller budget for broad terms       2/5     2/5     9/30
```

The middle row is why the second constant exists: sixty matches of `Mode` across
twenty files score twenty files. Recorded because it was a real wrong turn, not
a straight line.

**Diagnostics** go into `search_quality.json` — the file that already answers
"should I trust this search" — as a `terms` list of value, source, weight,
effective weight, match count and classification. No new artifact.

**Measured after 33.4:**

```text
                  baseline   33.2    33.3    33.4
top-3 recall           0/5    0/5     1/5     2/5
top-5 recall           0/5    0/5     1/5     2/5
top-10 recall          2/5    1/5     2/5     2/5
docs in top 5        15/30  11/30   11/30    9/30
```

Both Fix Mode cases now rank 3. `hint-points-at-the-fix` regressed from 9 to
absent and is picked up in §33.5, which owns that case.

Keep the breadth information the search already computes.

```text
- record each term's true repository match count, while still retaining only the
  bounded number of detailed matches downstream needs
- a term with zero matches does not influence ranking, and is recorded
- a very broad term influences ranking less than a specific one
- the breadth threshold is one named, documented constant, justified from the
  corpus numbers rather than guessed
```

Acceptance: zero-match terms excluded; a specific term outranks a broad one;
counts visible in the existing search-quality artifact.

### 33.5 Hint-Aware Retrieval

**Status:** Complete. 12 focused tests; 223 workflow/investigation tests pass.

Files: `bugpilot/core/workflow.py`; new `tests/test_hint_retrieval.py`. The term
plumbing itself landed with §33.3, which is where `run_code_search` began taking
`options.hint`.

**One extractor, not two.** Hint terms come from `extract_keywords`, the same
function the issue goes through. A second parser for hints would drift from this
one and be wrong in a different way.

**Weight 4**, between issue prose (2) and identifiers/user keywords (6/8). The
reasoning: a hint is better evidence than the words that happened to be in the
report, because the developer chose to write it — and worse evidence than a name
the crash printed or a keyword they typed deliberately, because it may be wrong.
A hedge ("maybe", "possibly", "seems") is weight 1; it is how a hint begins, not
what it says.

**Effective hint, fixed here.** `run_investigation` computed `effective_hint` —
explicit `--hint`, else the request's options, else the hint a previous run left
in `developer_hint.md` so `--resume` keeps it — wrote it to disk, and then passed
the *original* `request.options` to the steps. Now that those steps search with
the hint, a resumed run would have retrieved without one while the agent's task
file still carried it. The steps are given `search_options`, carrying the hint
actually in force. An AI-improved hint needs nothing special: the extension puts
the accepted text in the form, so it arrives as `options.hint` like any other.

**Provenance** is in `search_quality.json` already — each term records
`source: "hint"`, so a surprising rank can be explained.

**Retrieval calls no AI**, asserted directly: neither `search.py` nor
`search_terms.py` may contain a provider or a subprocess spawn.

**The case that did not recover.** `hint-points-at-the-fix` went 9 (after §33.3)
to absent (after §33.4) and stays absent. Diagnosed rather than tuned away: the
issue and the hint together yield `built`, `details`, `loaded`, `prompt`, `hint`,
`text` — all prose, all matching 29 to 2,488 times — while the target file
`extension/src/app/hintImprovement.ts` answers to `hintImprovement`, which no
sentence in either spells. This is the identifier-versus-prose gap the
investigation named and did not claim to solve deterministically.

Kept in the corpus as a failing case on purpose. It is the evidence for §33.8:
the remaining headroom is semantic expansion, not more weighting. Tuning until
it passed would have been fitting the ranker to one sentence.

```text
- the developer's hint becomes a search signal, through the same extractor
- weighted above ordinary issue prose and below user keywords and strong
  identifiers, so a wrong hint cannot take over
- the effective hint is whatever the rest of BugPilot already uses, including an
  AI-improved one the developer accepted; retrieval never calls AI
- hint provenance recorded, so a surprising rank can be explained
```

Acceptance: a hint contributes terms; an empty hint changes nothing; a hint term
cannot outrank a user keyword or a stack-trace identifier.

### 33.6 Context Ranking

**Status:** Complete, by verification rather than by new mechanism. 5 tests added.

Files: new `tests/test_context_ranking.py`. No production change was needed.

`context._related_files_markdown` takes `related_files[:5]`, and that list is
already ordered by §33.2's `_select_with_reserved_slots` — so implementation
leading the ranking is implementation leading the context. Adding a second
ordering rule here would have been two places deciding the same thing.

What the tests assert is the finished `bug_context.md`, not the scores behind
it, because the scores were right in cases where the context still was not:

```text
- implementation reaches the context ahead of prose, in a fixture where four
  documents repeat the issue's own sentence twelve times each and one source
  file mentions it once
- documentation is still listed as supporting context
- a test file naming the broken behaviour is still a lead, not excluded
- a --focus-file leads the context even when it is a document, so §33.2's
  reservation cannot overrule the developer
- the §33.4 term diagnostics did not displace the existing quality reporting
```

Header/implementation pairing and the test-path confidence cap are untouched.
The external context format is unchanged, so nothing downstream needed migrating.

Only the top files reach `bug_context.md`, so ranking mistakes are expensive.

```text
- implementation files have protected representation in the context
- supporting documentation stays available
- Focus Files keep their explicit priority
- tests stay eligible; header/implementation pairing unchanged
```

Acceptance: tests that assert the final selected context, not only intermediate
scores.

### 33.7 Regression Verification

**Status:** Complete. Python: 983 passed (64 added across §33).

**Before and after, on the §33.1 corpus against this repository:**

| Metric | Before | After |
| --- | ---: | ---: |
| Relevant file in top 3 | 0/5 | 2/5 |
| Relevant file in top 5 | 0/5 | **3/5** |
| Relevant file in top 10 | 2/5 | 3/5 |
| Documentation in top 5 | 15/30 | **9/30** |
| Zero-match terms | 0 | 0 |
| Broad terms kept at full weight | all | 0 |
| Corpus duration | 2.5s | 3.3s |

Per case:

```text
case                             before   after
fix-mode-persistence             absent       5
identifier-persist-fix-mode           7       1
prose-heavy-keyword-extraction        6       3
generic-terms-only               absent  absent   (no expected file; noise probe)
atomic-write-crash               absent  absent
hint-points-at-the-fix           absent  absent
```

**Regressions found and fixed during the work**, recorded because none of them
was visible from the outside:

```text
1. §33.2 raised recall and lowered precision: making .ts/.js searchable added
   the whole extension to the candidate pool, and prose-heavy fell out of the
   top 10 before §33.3/§33.4 brought it back to 3.
2. Spreading the retained budget across files helped one case and hurt two,
   because sixty matches of `Mode` across twenty files score twenty files.
   Fixed with a separate, smaller budget for broad terms.
3. Retrieval stopped being reproducible. ripgrep walks directories in parallel,
   so once the budget was counted in files, *which* files a broad term kept
   depended on output order: two identical searches of an unchanged tree
   returned different rankings. Caught by running the corpus twice. Matches are
   now sorted before any budget is applied, and a test runs the same search
   three times and compares.
```

**Acceptance.** Retrieval improved, not merely the keyword lists: top-5 recall
0/5 -> 3/5 and documentation's share of the context roughly halved. The
assertions in `tests/test_retrieval_regression.py` were tightened to the
achieved level — identifier case at top 3, the natural-language case present at
all, documentation at most 12/30 — with margin, because the corpus runs against
a repository that keeps changing.

**Threshold honesty.** `BROAD_MATCH_THRESHOLD = 250` is anchored to the corpus
median (193), not to the argmax of a sweep. The sweep over
100/150/200/250/300/400/500/800/1200 moved top-5 recall between 1/5 and 3/5 with
no sharp edge; six cases cannot resolve the constant finely, and tuning it to
them would be fitting the ranker to six sentences.

**Three cases still fail, and they are the honest limit of this phase:**

```text
- generic-terms-only has no expected file; it measures noise, and its ranks are
  the noise floor.
- atomic-write-crash and hint-points-at-the-fix need a bridge from prose to
  identifier ("issue details are loaded" -> `loadIssueDetails`,
  "left truncated" -> `atomic_write_text`). No weighting reaches those; that is
  §33.8's territory and the reason it is written down rather than done.
```

Re-run the 33.1 corpus and publish before/after for every metric. A metric that
gets worse is investigated and reported, not hidden. Acceptance is measured
retrieval improvement, not tidier keyword lists.

### 33.7A Real Historical Corpus Support

**Status:** Complete (support). 13 retrieval-regression tests pass. **No real
C++/Qt cases were available on this machine**, so the loader is verified by
fixture and the corpus itself is empty — see availability below.

Files: `tests/retrieval_corpus.py`, `tests/test_retrieval_regression.py`,
`.gitignore`.

**Two corpora, one harness.** The six committed fixture cases stay as they were.
A real corpus is loaded from a local JSON file naming the product checkout to
search:

```json
{
  "repo_root": "C:/path/to/the/product/checkout",
  "cases": [
    {"id": "JR-12345",
     "issue_text": "VDS cannot be selected as process output.",
     "hint": "maybe output type validation",
     "expected_files": ["src/process/OutputSelector.cpp"],
     "notes": "fixed in MR !456; the header change was incidental"}
  ]
}
```

**Storage decision.** Internal Jira prose does not belong in a public
repository, so `tests/retrieval_corpus/` is git-ignored: the committed part is
the loader, the format and the report. `load_real_corpus` returns an empty list
when the file is absent rather than raising, and a test asserts that the suite
does not depend on a private repository — a test that failed for its absence
would be deleted within a week.

**Ground truth** is what the fixing commit changed, minus what was along for the
ride. A formatting sweep, a regenerated file or a changelog edit appears in the
diff without being what the bug was about, and counting those would reward a
search for finding the wrong thing. Recorded in the dataclass docstring so
whoever populates the corpus reads it first.

**MRR added.** `rank 15 -> rank 6` is a real improvement that top-5 recall
records as nothing happening. Cases with no expected file (the noise probe) are
excluded from recall and MRR: scoring a question with no answer is not a
measurement.

**A developer command**, because retrieval work needs to see where every file
landed and an assertion cannot show that:

```text
python tests/retrieval_corpus.py                 # the fixture cases
python tests/retrieval_corpus.py --real          # a local historical corpus
python tests/retrieval_corpus.py --real PATH --repo PATH
python tests/retrieval_corpus.py --format        # print the file format
```

**Baseline before §33.7B**, re-measured on this tree rather than taken from the
§33.7 report:

```text
fixture corpus (6 cases, 5 scored)
  top-3  2/5
  top-5  3/5
  top-10 3/5
  MRR    0.307
  docs in top 5  9/30
  terms  53
  duration 3.4-3.6s

real C++/Qt corpus
  0 cases — none available on this machine
```

**Availability, stated plainly.** No historical product repository or issue
export is present locally, and none was fabricated. Every number in §33 remains
measured against BugPilot's own Python/TypeScript tree. The C++/Qt validation
this section exists to enable is still outstanding; what changed is that it can
now be run by populating one file.

The §33.1 corpus is six hand-written cases against this repository. It was enough
to find three real defects, and it is not enough to calibrate anything: six
sentences cannot resolve a threshold, and every one of them is Python or
TypeScript while the repository BugPilot was built for is C++/Qt.

Scope:

```text
- a corpus format carrying a real issue and the files that actually fixed it:
  id, issue text, optional hint, expected files
- two corpora, not one: the committed fixture cases stay deterministic and
  self-contained; a real historical corpus is loaded from a local file and
  pointed at a checkout of the product repository
- the standard test suite never requires the private repository, and never
  fails for its absence
- MRR alongside top-3/5/10, because rank 15 -> rank 6 is a real improvement that
  recall thresholds cannot see
- a readable report for use while developing retrieval, not only assertions
```

Storage decision to record: internal Jira text does not belong in this
repository, so the real corpus is a **local, git-ignored file** that a developer
populates from issues they already have access to. The committed part is the
loader and the format.

Acceptance: the harness evaluates a real corpus when one is present, skips
cleanly when it is not, and reports MRR.

### 33.7B Identifier-Shape Expansion

**Status:** Complete. 13 focused tests; 286 retrieval-related tests pass.

Files: `bugpilot/core/keywords.py` (phrases and shapes),
`bugpilot/core/search_terms.py` (candidates, weight, budget),
`bugpilot/core/search.py` (probe before admit, diagnostics);
new `tests/test_shape_expansion.py`; two schema guards widened.

**Where the code lives.** Phrase extraction needs the issue *text*, and by the
time `search.py` runs it has only the keyword lists — so `extract_keywords`
emits `shape_candidates` alongside the five legacy lists, and the search probes
them. Putting it there also avoided a circular import between `keywords` and
`search_terms`.

**The filter that made it work.** The first attempt excluded stop words and
generic prose from phrases, and produced nothing at all: `issue`, `output`,
`type`, `details`, `selection` are all in one list or the other, and they are
exactly the words `issueDetails` and `outputType` are made of. Those lists exist
to stop a word counting as evidence *alone*, which is a different question. Only
grammatical function words are now excluded — enough to keep "does not work" out
— and everything else is let through and killed by the repository probe if the
codebase does not use it. The probe is a better filter than any word list.

**Nothing is evidence until the repository says so.** Each shape is probed; zero
matches means discarded before ranking. A generated string can never lift a file
on the strength of having been generated.

**Case-only variants are not generated.** The search is case-insensitive, so
`outputType` and `OutputType` match the same lines; producing both would spend
two processes to score one piece of evidence twice. `identifier_shapes` returns
camelCase and snake_case only, and a test pins it.

**Weight 5**: below a name somebody wrote (6/8), above a hint (4) and prose (2).
It was assembled by a rule, and the codebase agreed with it.

**Budget, taken out of the total rather than added to it.**
`MAX_EXPANSION_PROBES = 8` comes out of `MAX_SEARCHED_TERMS = 28`, so base terms
get 20. The budget counts attempts, not survivors, because a probe that finds
nothing still costs a process.

*Corrected in the §33.9 fix pass:* this section previously claimed 28 matched
the pre-§33 worst case. It did not. The old pipeline searched phrases plus
high-value plus normal plus expanded, and supplied keywords were **prepended to
the high-value list**, so its worst case was 5 + (20 + 5) + 10 + 8 = **48**
invocations — up to sixteen minutes against the 20-second per-term timeout. 28
is a deliberate reduction to a little over half that, and therefore a retrieval
behaviour change as well as a latency one, not a preservation of previous
behaviour.

**Diagnostics** gained `derived_from` and `status` per term, so a developer can
see that `outputType` came from "output type", matched 17 lines and was kept.

**Measured, fixture corpus:**

```text
                 before 33.7B   after 33.7B
top-3 recall              2/5           3/5
top-5 recall              3/5           3/5
top-10 recall             3/5           3/5
MRR                     0.307         0.467
docs in top 5           9/30          9/30
duration                 3.4s          5.3s
```

`fix-mode-persistence` moved 5 -> 1: "Fix Mode selection" became `fixMode`,
`fix_mode` and `modeSelection`, and `fix_mode` is what the implementation
actually spells. That is the bridge working on the case §33.7 could not reach.

The duration rose 3.4s -> 5.3s for six cases, about 0.3s per case, from the
extra probes. Worst case is unchanged; typical case is slower because it now
spends terms it previously left unused.

The gap §33.7 measured and could not close: a bug says "issue details are
loaded" and the code says `loadIssueDetails`. No weighting reaches across that,
because the words are present and the *shape* is not.

This phase bridges shape only, never meaning:

```text
issue details  ->  issueDetails, IssueDetails, issue_details
output type    ->  outputType,   OutputType,   output_type
```

and explicitly not:

```text
issue details  ->  loadIssueDetails, IssueDetailsLoader, refreshIssueDetails
```

Those invent a verb the report never used. Shape transformation is deterministic
and checkable; semantic inference is §33.8.

Scope:

```text
- candidate phrases from adjacent meaningful tokens, 2-3 words, reusing the
  existing stop-word and generic-word filters
- camelCase, PascalCase and snake_case variants of each phrase
- every candidate probed against the repository: zero matches is discarded, so
  a generated string can never influence ranking on the strength of having been
  generated
- case-only variants deduplicated, because the search is case-insensitive and
  `outputType`/`OutputType` would otherwise score the same evidence twice
- weighted below an explicit user keyword and a stack-trace identifier, above
  issue prose: a confirmed shape is evidence, but weaker than a name somebody
  actually wrote
- its own small budget, so worst-case `terms x timeout` does not grow
- provenance in the diagnostics: which phrase produced it, how many matches it
  found, whether it was kept
```

Acceptance: a fixture case whose implementation file is unreachable before
expansion reaches it after; no case regresses; the corpus duration does not grow
materially.

### 33.7C Retrieval Metrics and Calibration

**Status:** Complete. Python: 1,001 passed (16 added in §33.7).

**Fixture corpus, before and after §33.7B** (6 cases, 5 scored, this repository):

| Metric | Before | After |
| --- | ---: | ---: |
| Top-3 recall | 2/5 | **3/5** |
| Top-5 recall | 3/5 | 3/5 |
| Top-10 recall | 3/5 | 3/5 |
| MRR | 0.307 | **0.467** |
| Docs in top 5 | 9/30 | 9/30 |
| Duration | 3.4s | 5.3s |
| Terms per case (avg) | 8.8 | 17.0 |
| Shapes generated (avg) | 0 | 7.3 |
| Shapes retained (avg) | 0 | 1.8 |

Per case: `fix-mode-persistence` 5 -> **1**; `identifier-persist-fix-mode` 1 -> 1;
`prose-heavy-keyword-extraction` 3 -> 3; three still absent.

**Real C++/Qt corpus: 0 cases.** None available on this machine and none
invented. Every number above is BugPilot's own Python/TypeScript tree.

**Why the three still fail**, from their own diagnostics rather than from
guesswork:

```text
generic-terms-only      not a failure. No expected file; it measures what a bug
                        made only of generic words drags in.

atomic-write-crash      missing semantic bridge. Expected artifact_io.py, which
                        implements `atomic_write_text`. The issue says "writing
                        ... is left truncated". Shapes generated
                        workflowStatusFile, workflow_status (145, kept) and six
                        others; none reaches `atomic_write_text`, because
                        "writing safely" -> "atomic write" is a synonym, not a
                        shape. Exactly §33.8's case.

hint-points-at-the-fix  ground-truth ambiguity, and it is the corpus that is
                        wrong. Expansion worked: issueDetails (86),
                        issue_details (54) and issue_text (13) were all
                        confirmed and retained. They rank host/ports.ts and
                        controller.ts — which is correct, because those are
                        where issue details are *loaded*. The case names
                        hintImprovement.ts, which builds the prompt. Left as-is
                        and recorded rather than quietly re-pointed: a corpus
                        edited until it passes stops being a measurement.
```

**Broad-match threshold: unchanged at 250, still provisional.** With shapes
included the term population is 102 (was 58):

```text
min 0   median 28   p75 323   p90 821   max 3248
deciles [0, 0, 0, 7, 28, 61, 196, 437, 821]
33 zero-match terms — all generated shapes, all correctly discarded

median match count by source
  identifier         18      shape_expansion    0
  issue             187      hint             283
```

250 sits around p70 and separates what it was meant to: identifier-source terms
(median 18) sit far below it, issue prose (median 187) straddles it. Not moved —
six cases cannot justify a different number, and the distribution shifted mostly
because two thirds of generated shapes match nothing, which says more about
expansion than about breadth. Re-derive on a real C++/Qt corpus.

**AI semantic expansion (§33.8): probably useful later, not justified yet.**
Of five scored cases, three are at or above rank 3, one is a corpus error, and
exactly one — `atomic-write-crash` — needs a transformation deterministic rules
cannot make ("writing is left truncated" -> `atomic_write_text`). One case in
six is not evidence for adding a model call to every run. The stronger argument
for revisiting it is that shape expansion generated 44 candidates and the
repository confirmed 11: the probe gate works, and it would work just as well on
AI-proposed terms. Decide it on a real corpus, not on this one.

Scope:

```text
- the same corpus, before and after, on top-3/5/10, MRR, docs in top 5,
  duration, terms per case, expansions generated and retained
- fixture and real corpora reported separately, never averaged into one number
- every case still outside the top 5 classified by *why*, so the §33.8 decision
  rests on evidence rather than on the feeling that AI would help
- the match-count distribution from the larger corpus, to say whether
  BROAD_MATCH_THRESHOLD = 250 still looks reasonable — reported, not tuned,
  unless the evidence is strong enough to justify moving it
```

Acceptance: a before/after table, a failure classification, and a recommendation
on §33.8 that follows from the numbers.

### 33.8 AI Semantic Expansion — Deferred

**Status:** Deferred, deliberately.

Not in this phase: AI keyword generation, a Suggest Keywords UI, automatic
semantic expansion, Jev, embeddings, vector search, repository indexing,
stemming/lemmatisation frameworks, AND/co-occurrence query semantics, cross-run
learning, telemetry, and any automatic rewriting of the developer's keywords.

The investigation's reasoning: the bottleneck is term weighting and the search
surface, not vocabulary breadth. AI cannot fix a positional tier or an include
glob. Expansion is worth reconsidering once 33.7 has numbers — and any AI term
would still have to survive the 33.4 probe, which is also what would remove the
need for a human review step.

### 33.9 Non-Goals for This Phase

```text
- renaming Advanced Settings -> Keywords (a user-visible contract; worth doing
  once the automatic path is demonstrably better)
- making user keywords obsolete: they stay an explicit expert boost
- redesigning the search engine; one rg per term stays, with the term count bounded
```

### 33.10 Pre-Commit Fix Pass

**Status:** Complete. Three review findings closed; metrics unchanged,
duration improved. Python: 1,010 passed.

Files: `bugpilot/core/code_files.py`, `bugpilot/core/search_terms.py`,
`tests/retrieval_corpus.py`; new `tests/test_search_budget.py`;
`tests/test_search_surface.py` and `tests/test_retrieval_regression.py`
extended.

**1. Implementation and documentation are now mutually exclusive.**
`CMakeLists.txt` ends in `.txt`, so a pure suffix rule answered *both* "is this
implementation" and "is this documentation" with yes. Ranking read
`is_implementation` and was right; the `related_files.json` label and the
corpus's docs-in-top-5 metric read `is_documentation` and were wrong — which
would have inflated the headline §33.2 metric on exactly the CMake-heavy
repositories §33.7A exists to measure. `is_documentation` now returns False for
anything in `CODE_FILENAMES`, and a test asserts no path can be both.

**2. Generic `*.txt` is no longer searched.**
§33.2's requirement was to align the *code* extensions the extractor already
recognised. The documentation formats were an addition of mine, and `.txt` was
the wrong one: it is the commonest extension for things that are not prose at
all — `requirements.txt`, licence text, generated file lists, data dumps — so it
bought scan time and noise rather than leads, and it was the root cause of
finding 1. `md`, `rst` and `adoc` remain. `CMakeLists.txt` stays searchable
through `CODE_FILENAMES`, where it belongs: it is a build file, not a document.
Measured effect: corpus duration 5.3s -> 4.0s, every retrieval metric unchanged.

**3. User keywords boost the search; they no longer replace it.**
User terms weigh 8 and therefore sort first, so truncating the merged list
handed them the whole base budget: twenty `--keywords` left room for nothing
else, and `SampleFoo::bar` from the stack trace was dropped in favour of the
twentieth word the developer typed. That inverts what the field is for.

`_allocate` now holds `AUTOMATIC_TERM_RESERVE = 8` of the 20-term base budget
for terms bugpilot found itself. It is a reserve, not a quota — when there are
fewer automatic terms than that, the space goes back to the user rather than
being wasted:

```text
user keywords   total   user   automatic
  0               7       0        7
  2               9       2        7
 12              19      12        7
 20              20      13        7     <- was 20 user, 0 automatic
```

Terms are re-sorted into weight order after allocation, so the strongest term is
still searched first and the result does not depend on which bucket a term came
from.

**4. Corpus files are validated.** A case with no `issue_text` used to load as
an empty string, score "not found", and pull the average down for a reason
invisible in the report. `load_real_corpus` now raises `CorpusError` for
malformed JSON, a missing id, missing issue text, or a duplicate id, and the
developer command prints the message instead of a traceback. The harness also
dropped its private copy of the documentation suffix list and uses the
production classifier — that second list is how the `CMakeLists.txt` miscount
would have reached the metric.

**Metrics across the fix pass** (fixture corpus, unchanged by design):

```text
                 before fixes   after fixes
top-3 recall              3/5           3/5
top-5 recall              3/5           3/5
top-10 recall             3/5           3/5
MRR                     0.467         0.467
docs in top 5            9/30          9/30
duration                  5.3s          4.0s
```

**Deferred, recorded rather than fixed** — none affects correctness:

```text
- `_collect` parses and sorts rg output twice per term; the first pass needs
  only the count
- `extract_keywords(hint)` runs twice per search (CPU only, no subprocess)
- `high_set` / `normal_set` are threaded through `_rank_related_files` and are
  dead on the weighted path
- the corpus has no `primary_files` / `supporting_files` distinction, which
  `hint-points-at-the-fix` argues for
- parallel rg, result caching, threshold tuning, search indexing
- real C++/Qt corpus population, and §33.8 AI semantic expansion
```
