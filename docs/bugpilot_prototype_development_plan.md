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

---

## 34. Existing Feature & UI/UX Optimization

**Status: COMPLETE / FROZEN.** UI-A1 through UI-B3 and UI-V1 are done,
verified and committed. UI-C is planned and not started.

```text
UI-A1 Main UI Simplification              Complete     default panel = Issue, Run, Advanced
UI-A2 Advanced Settings Organization      Complete     Guidance / Retrieval Overrides / Run Options
UI-A2c Retrieval controls regrouped       Complete     Ignore Paths + the two limits move group
UI-A3 Context Ready / Fix with AI         Complete     result state + primary next action
UI-B1 Relevant Files                      Complete     which files, and click to open
UI-B2 Better Error UX                     Complete     what failed, and what to do next
UI-B3 Run / AI Handoff Summary            Complete     the successful handoff, said out loud
UI-V1 Visual & Interaction Review         Complete     4 issues found by looking, 4 fixed
UI-C1 Retrieval Details                   Complete     why those terms, and how they behaved
UI-C2 Diagnostics                         Complete     what BugPilot is configured with
```

Nothing in this section changes the CLI, the retrieval pipeline, the prompts or
the providers. It is about what the panel shows first.

### 34.0 Why

Every feature since phase 5 arrived as another control in the same column. The
default panel now opens on an input-source switch, two possible input fields, a
Fix Mode selector, a Run button, a six-row workflow checklist with its own
heading and status, and a collapsed Advanced section — before the developer has
typed anything. Each control was right on its own; together they read as a
collection of equally important developer utilities rather than as a workflow.

The workflow is one sentence:

```text
enter the issue -> Run -> BugPilot prepares context -> later, Fix with AI
```

The default view should be that sentence and nothing else.

### UI-A1 Main UI Simplification

**Goal.** The panel's initial state is the primary path, and everything
optional is one disclosure away.

Target initial state:

```text
Issue
[ Jira ticket or bug description ]

[ Run ]   Ctrl+Enter
Run prepares the issue context for AI-assisted fixing.

> Investigation & AI Fix            Ready to run
> Advanced Settings (Optional)
```

**Acceptance criteria.**

```text
1. One Issue field, labelled "Issue", accepting a Jira key or a description.
2. Run is the one primary button and visually dominates everything else.
3. Advanced Settings stays collapsed, with every control and value intact.
4. The workflow checklist is not expanded before a run, and opens by itself
   when one starts.
5. No empty result section is rendered before the first run.
6. A second Run click while running is impossible; Stop and Retry behave as
   they did.
7. Build context, Fix with AI, Open, Copy and Open folder remain reachable and
   keep their current post-run behaviour.
8. The label is associated with the field, every control is keyboard
   reachable, and both disclosures open from the keyboard.
9. No backend, CLI, prompt, retrieval or provider change.
```

**Decisions taken.**

*One Issue field instead of a source switch and two fields.* The radio pair
asked the developer to classify their input before entering it, and the
classification is derivable from the input itself: a Jira key is
`JIRA_ISSUE_KEY_RE` and everything else is prose. The page derives `source` and
fills `issueKey` or `description` accordingly, so `FormState`, the message
protocol, `buildPrepareArgs` and every downstream consumer are unchanged. A
multi-line control, because the same box now has to hold a six-character key
and a pasted bug report; it grows with what is typed, like the other textareas.

*The Fix Mode selector stays above Run and outside Advanced Settings.* This was
a documented decision with a test defending it — an execution choice, not
retrieval tuning, and burying it would make Investigate First a setting nobody
finds. Revisit in UI-A2 or UI-A3 if at all, not here.

*The workflow becomes a disclosure rather than a hidden section.* Its rows carry
two different things: the checkboxes that choose what runs, which the developer
needs before pressing Run, and the statuses of a run in flight, which they need
during one. Hiding it until a run starts would remove the only pre-run access to
Fix with AI and Build context; so it collapses instead, and opens itself the
moment a run begins and stays open afterwards.

**Out of scope, by phase.**

```text
UI-A2  regrouping Advanced Settings; Strategy / Guidance / Retrieval Overrides
UI-A3  the Context Ready layout and the Fix with AI hierarchy after a run
UI-B   Relevant Files, run summary, new error UX, Focus File chips, file picker
UI-C   retrieval diagnostics, search_quality.json surfaced in the panel
```

**UI-A1 checkpoint.**

Files changed:

```text
production  extension/src/panel/html.ts      one Issue field; workflow -> <details>; run label
            extension/media/panel.js         source derived; problems routed; running state
            extension/media/panel.css        .issue-note; .workflow-summary; .radios removed
            extension/src/app/form.ts        two messages that named the removed switch
tests       extension/test/panel.test.ts     6 added, 4 updated
            extension/test/page.test.ts       9 added, 1 replaced, ~12 references retargeted
plan        docs/bugpilot_prototype_development_plan.md
```

Initial layout, as `panelHtml()` now renders it:

```text
Issue
[ Jira ticket or bug description ]

Fix Mode                            How the AI works on this bug.
[ Standard Fix          v ]  [gear]

[ > Run ]                           Ctrl+Enter
Run prepares the issue context for AI-assisted fixing.

> Investigation & AI Fix            Ready to run
> Advanced Settings (Optional)
```

What was simplified:

```text
- the "Jira issue / Bug description" radio pair and its two fields became one
  Issue field; the source is derived from what is typed
- the six-row workflow checklist, previously always expanded, became the
  collapsed "Investigation & AI Fix" disclosure
- the run hint says what Run does and, by saying it, what it does not
- Run carries a Running... label and a spinner while a run is in flight
```

Behaviours preserved deliberately:

```text
- FormState, the page/host message protocol, buildPrepareArgs and every CLI
  argument: the page still sends `source`, `issueKey` and `description`
- the Fix Mode selector's position above Run and outside Advanced Settings,
  which is a documented decision with a test defending it
- Advanced Settings' contents, order, values and state persistence
- Build context's Open / Copy / Open folder icons, hidden until the run has
  produced something and reachable afterwards
- Fix with AI as a workflow row that starts unticked (R5)
- Hint, Improve with AI, Keywords, Focus files, Stop, Retry, attachments
- Title, now shown only when the Issue field is being read as prose, which is
  the only run that sends --title
```

Tests added or updated:

```text
panel.test.ts  default view is Issue + Fix Mode + Run and two closed
               disclosures; the Issue field is the only input above Run; the
               radio pair and its styling are gone; the workflow summary
               carries its own status; Run's label is replaceable; the page's
               copy of JIRA_ISSUE_KEY_RE matches form.ts
page.test.ts   source derived both ways; an empty field is not a manual bug;
               the note that replaced the radio; Title follows the reading;
               the workflow opens on a run and stays open; a developer's own
               collapse is not overruled mid-run; Running... and no second
               run; the post-run actions still post their actions
```

Verification:

```text
extension tests   595 passed, 0 failed   (was 585 before UI-A1's own tests)
typecheck         tsc --noEmit clean
smoke             activated, 21 commands, 3 views, panel HTML built
git diff --check  clean
python            not run: no shared interface changed
```

Deferred to UI-A2 and UI-A3:

```text
UI-A2  regrouping Advanced Settings into Strategy / Guidance / Retrieval
       Overrides, and revisiting where the Fix Mode selector belongs
UI-A3  the Context Ready layout, and the Fix with AI hierarchy after a run —
       including whether the workflow disclosure should present its result
       differently from its plan
```

**Not validated interactively.** Every claim above is from the rendered markup
and the page script under its DOM stub. The panel was not opened in a running
VS Code window, so the visual result — spacing, how the summary line wraps at
200px, the disclosure triangle in each of the four required themes — is
unverified.

### UI-A2 Advanced Settings Organization

**Goal.** A developer opening Advanced Settings can tell at a glance which
controls talk to the AI and which control what BugPilot searches. Today it is
one undifferentiated list of nine settings in the order they were added.

**Scope.** Headings, labels, helper text and order inside the collapsed
section, plus the Improve control's label and tooltip. No new control, no
control removed, no change to what any of them does.

Intended hierarchy:

```text
> Advanced Settings (Optional)

  Guidance
  ----------------------------------
  Hint
  Add technical guidance, constraints, or suspected areas.
  [                                  ]
  [x] Use issue details        [AI] Improve

  Retrieval Overrides
  ----------------------------------
  Keywords (optional)
  Boost retrieval with known identifiers or technical terms.
  [                                  ]

  Focus Files (optional)
  Prioritize files you already suspect are relevant.
  [                                  ]

  Run Options
  ----------------------------------
  Title, Ignore paths, Max files, Max search lines, AI agent,
  Custom agent command, Attachments, Delete previous artifacts first
```

**The third group is a decision this phase had to make.** UI-A2 named two
groups and enumerated four controls; the section has nine. The other seven —
Title, Ignore paths, the two limits, the agent pair, Attachments and the
destructive checkbox — cannot be deleted and cannot go into a group whose
contents were specified as "only Keywords and Focus Files", so they keep their
current order under a third heading.

Ignore paths, Max files and Max search lines are arguably retrieval overrides
by the definition this phase gives, and sit under Run Options only because the
brief fixed the second group's membership. Recorded as the open question for
UI-A3 rather than decided here.

**Must not change.**

```text
- FormState, the page/host protocol, buildPrepareArgs, and every CLI argument
- keyword and path parsing (parseKeywords splits on commas and newlines;
  parsePaths on newlines only)
- the Fix Mode selector's position above Run, outside Advanced Settings
- Hint improvement: the issue-details lookup, the provider selection, the
  suggestion-beside-the-field rule, Use Improved, Keep Original, the error and
  fallback messages
- Advanced Settings collapsed by default, and opening itself for a validation
  problem in one of its fields
- every field's id, so restored state and reported problems still land
```

**Acceptance criteria.**

```text
1. Advanced Settings still starts collapsed and still holds every control it
   held before, with the same ids and values.
2. Guidance and Retrieval Overrides exist as headings, in that order.
3. Retrieval Overrides holds Keywords and Focus Files, and nothing else.
4. Keywords and Focus Files read "(optional)" and carry their helper text.
5. The Improve control reads "Improve", keeps its icon, and gains a tooltip.
6. Use issue details stays beside Improve and wraps rather than overlapping.
7. No tabs, no nested disclosure, no card, no colour literal.
8. No backend, CLI, prompt, retrieval or provider change.
```

**UI-A2 checkpoint.**

Final grouping, as `panelHtml()` renders it:

```text
Guidance
  Hint                  Add technical guidance, constraints, or suspected areas.
                        [x] Use issue details            [AI] Improve
                        (the AI Suggestion panel, unchanged)

Retrieval Overrides
  Keywords (optional)   Boost retrieval with known identifiers or technical terms.
  Focus Files (optional) Prioritize files you already suspect are relevant.

Run Options
  Title, Ignore paths, Max files, Max search lines, AI agent,
  Custom agent command, Attachments, Delete previous artifacts first
```

Labels and text changed:

```text
Keywords          -> Keywords (optional)     + helper
Focus files       -> Focus Files (optional)  + helper
Hint              -> Hint                    + helper
Improve with AI   -> Improve                 + title="Improve clarity and
                                                technical precision using the
                                                configured AI provider."
AI Suggested Hint -> AI Suggestion
```

**The icon stayed `codicon-hubot`.** UI-A2 preferred a spark icon "if
consistent with the existing icon system". The vendored codicon subset is 25
glyphs and has no `sparkle`; a name outside it renders as an empty box, which
a guard test catches. `hubot` is the subset's AI glyph and is already what the
AI agent setting uses.

**No provider name was added to the suggestion panel.** UI-A2 sketched an
"Improved with Claude Code" line. A test forbids Claude-specific wording
anywhere in the panel outside the agent picker's own option — the mechanism is
Claude-shaped, the workflow must not be — so the heading says "AI Suggestion"
and stops there.

Behaviour preserved, checked by test:

```text
- every field id, so restored state and reported problems still land; a
  problem in a regrouped field still opens the section and takes focus
- keywords, focus files, hint and ignore paths round-trip through `run`
  byte for byte
- the Fix Mode selector above Run, outside Advanced Settings
- Hint improvement end to end: the busy state, the suggestion beside the
  field, Use Improved, Keep Original, the notice and the error
- Advanced Settings collapsed by default; one disclosure, no nesting, no tabs
```

Files changed:

```text
production  extension/src/panel/html.ts   three field lists + groupHeading();
                                          labels, helper text, Improve, tooltip
            extension/media/panel.js      the Improve label
            extension/media/panel.css     .setting-group; .hint-actions comment
tests       extension/test/panel.test.ts  8 added, 3 updated
            extension/test/page.test.ts   3 added, 1 updated
            extension/test/unwired.test.ts ADVANCED_FIELD_IDS left the
                                          allowlist: it now has a production
                                          consumer inside html.ts
plan        docs/bugpilot_prototype_development_plan.md
```

Verification:

```text
extension tests      606 passed, 0 failed
typecheck            tsc --noEmit clean
smoke                activated, 21 commands, 3 views, panel HTML built
python               tests/test_publishable.py 8 passed — run because the new
                     Keywords placeholder adds text to a published artifact
git diff --check     clean
```

**Not validated interactively.** No VS Code Extension Host was available, so
dark/light themes and the 200px / 300px / 400px sidebar widths were not looked
at. What is checked instead is mechanical: no colour literal, no fixed width,
no `white-space: nowrap` or absolute positioning on the hint row, `flex-wrap`
with a 200px floor under every helper, and `overflow-wrap: anywhere` on the
group headings. The one arrangement worth a human eye is Use issue details
beside Improve at 200px, where the two are expected to stack.

Deferred to UI-A3:

```text
- the Context Ready layout and the Fix with AI hierarchy after a run
- whether Ignore paths, Max files and Max search lines belong under Retrieval
  Overrides: they are retrieval overrides by this phase's own definition and
  sit under Run Options only because UI-A2 fixed that group at Keywords and
  Focus Files
- whether Title belongs in Advanced Settings at all, now that it is the only
  Run Option that is part of the bug report rather than of the run
```

### UI-A2c Retrieval controls regrouped

The open question UI-A2 recorded, now answered: Ignore paths, Max files and Max
search lines are retrieval overrides by this section's own definition, and sat
under Run Options only because UI-A2 fixed the second group at Keywords and
Focus Files. They move.

```text
Guidance             Hint
Retrieval Overrides  Keywords (optional), Focus Files (optional),
                     Ignore paths, Max files, Max search lines
Run Options          Title, AI agent, Custom agent command, Attachments,
                     Delete previous artifacts first
```

Markup order and group membership only: no field id, serialization, parsing,
validation or default changes. `ADVANCED_FIELD_IDS` still lists all eight text
fields, so the existing guards — every advanced field inside the collapsed
section, none above Run — keep applying unchanged.

### UI-A3 Context Ready and the Fix with AI hierarchy

**Goal.** A finished run reads as a result with a next action, not as a
checklist with six ticks. Before Run the panel is configuration; during a run it
is progress; afterwards it is "here is what you have, here is what to do with
it".

```text
before        Issue / Fix Mode / Run / > Investigation & AI Fix  Ready to run
during        Run says Running...; the disclosure opens itself; rows tick over
after         [v] Context Ready
              8 relevant files - 53 search terms
              Strategy: Standard Fix
              [ Fix with AI ]
              [Open Context] [Copy] [Open Folder]
              > Investigation & AI Fix                          Context ready
```

**What the counts come from, and nothing else.** The extension reads two files
the run itself wrote, through the `readFile` port it already uses for
`workflow_status.json` and `agent_handoff.md`:

```text
related_files.json   a JSON array -> "N relevant files"
search_quality.json  an object with `terms` -> "N search terms"
```

Both are already read by `bugpilot/core/context.py`, so this is the contract
BugPilot relies on internally rather than a new one. Parsing is defensive at
every step — missing file, unreadable file, invalid JSON, wrong shape — and
each of those omits the count rather than showing a wrong one. No count is
invented, no field is added to any artifact, and nothing in Python changes.

Deliberately not shown: implementation-versus-document splits, retained-versus-
dropped term counts, weights, or anything else that would teach §33's
vocabulary. "N relevant files" and "N search terms" are what a developer can
act on.

**Decisions.**

*The result is its own section above the workflow disclosure.* Not a redesign of
the rows: they stay exactly as they are, one step back, still the place to
change the plan or read what each step did.

*The three artifact actions move into it.* Open Context, Copy and Open Folder
were icons on the Build context row — the right place when the row was the only
result surface, and the wrong one now that there is a result section whose whole
job is "what to do next". Same ids, same messages, same tooltips; they become
icon-and-label buttons under the primary one, secondary by size rather than by
being hidden.

*The Strategy line is the prepared mode, relocated.* `Prepared with Fix Mode: X`
already existed inside the disclosure and already distinguishes prepared from
selected, available from missing. It moves into the result section under the
word Strategy. No second selector, and no repetition of the mode's description.

*Fix with AI is a button only when pressing it would do something new.* The
`fixWithAI` panel action has been wired on the host since phase 5 with no page
sender; this is its button. It is offered when no handoff has been attempted for
this run, and after a handoff that was skipped or failed — but not after one
that succeeded, where the outcome line stands in its place. That is what keeps
§11's promise: a developer who preselected Fix with AI before the run is not
asked to click again, and no click can produce a second handoff of a run that
already had one.

*Failure shows no result.* Context Ready requires `bug_context.md` on disk, a
run that is not in flight, and a run that did not fail. A stopped run that got
as far as writing the context does show it, because the context is genuinely
there. The existing failure card is untouched.

**Acceptance criteria.**

```text
1.  Nothing is rendered before the first run that was not rendered before.
2.  The workflow disclosure and all its checkboxes survive, pre-run and after.
3.  A run in flight shows no Context Ready.
4.  A failed run shows no Context Ready and keeps its failure card.
5.  A successful run shows Context Ready with whichever counts were readable.
6.  Fix with AI is the one primary button in the result, and sends the
    `fixWithAI` action the host already handles.
7.  A succeeded handoff replaces the button with its outcome; no second run
    can be started by clicking.
8.  Open Context, Copy and Open Folder send exactly the messages they sent
    before, and appear only when their files exist.
9.  No new codicon, no colour literal, no fixed width, no absolute layout.
10. No Python, CLI, prompt, provider, retrieval or artifact change.
```

**UI-A2c checkpoint.** Moved: Ignore paths into `RETRIEVAL_FIELDS`, and the
`.limits` row rendered inside Retrieval Overrides rather than after Run Options.
`RUN_OPTION_FIELDS` is now Title alone, with the agent pair, Attachments and the
destructive checkbox rendered inline below it as before.
`ADVANCED_FIELD_IDS` was reordered to follow the rendered order, so the export
and the document can be read against each other.

Files: `extension/src/panel/html.ts`. Tests: the group-membership test now
expects five fields under Retrieval Overrides, and a new one asserts Run Options
holds Title, the agent pair, Attachments and the checkbox and none of the five.
607 passed.

**UI-A3 checkpoint.**

Files changed:

```text
production  extension/src/app/contextSummary.ts   new: counts, defensively read
            extension/src/app/controller.ts       #readCounts, #contextReady,
                                                  #strategyLine, state wiring
            extension/src/panel/messages.ts       ContextReadyView
            extension/src/panel/html.ts           the result section; the three
                                                  artifact buttons moved into it
            extension/media/panel.js              renderContextReady; the
                                                  Fix with AI sender
            extension/media/panel.css             .result and its parts
tests       extension/test/contextSummary.test.ts new: 7
            extension/test/controller.test.ts     10 added
            extension/test/page.test.ts           9 added, 5 rewritten
            extension/test/panel.test.ts          3 added, 1 rewritten
plan        docs/bugpilot_prototype_development_plan.md
```

State transition, as the page renders it:

```text
before a run   nothing. The section is `hidden` in the markup and the host
               sends no `contextReady`, so there is no empty card to ignore.
during a run   still nothing. Run reads Running..., the disclosure opens
               itself, the rows tick over. No result can appear mid-run.
after success  [v] Context Ready
               2 relevant files - 11 search terms
               Strategy  Standard Fix
               [ Fix with AI ]
               [Open Context] [Copy] [Open Folder]
after failure  nothing, and the existing failure card unchanged.
```

Summary data, in full — these two numbers and nothing else:

```text
related_files.json    length of the top-level array   -> "N relevant files"
search_quality.json   length of `terms`               -> "N search terms"
```

Verified against a real CLI run rather than a fixture: a two-file repository
prepared through `bugpilot bug --description ... --prepare-only` produced
`2 relevant files - 11 search terms`, which matches the artifacts on disk.

Fix with AI hierarchy: one full-width primary button, and the three artifact
actions below it as small icon-and-label buttons that wrap. The button sends
`{type: "action", id: "fixWithAI"}` — the action the host has handled since
phase 5 and which nothing on the page had ever sent. It is hidden after a
handoff that succeeded, so no press can produce a second terminal for one
package; after a handoff that was skipped it stays, because installing an agent
and trying again is a real thing to do.

Verification:

```text
extension tests   636 passed, 0 failed   (607 before UI-A3's own tests)
typecheck         tsc --noEmit clean
smoke             activated, 21 commands, 3 views, panel HTML built
git diff --check  clean
python            not run: no Python, CLI, artifact or protocol change
```

**Not validated interactively.** No VS Code Extension Host was available, so
neither theme and none of the three sidebar widths were looked at. What is
checked mechanically: no colour literal, no new codicon (the tick is
`pass-filled` and the button's icon is `hubot`, both already in the vendored
subset), no fixed pixel width under `.result`, no absolute positioning, a
full-width primary and a wrapping secondary row.

Deferred, unchanged by this phase:

```text
UI-B  Relevant Files as a list, Retrieval Details, Diagnostics, Run Summary,
      Better Error UX, Focus File chips, a file picker
UI-C  search_quality.json surfaced beyond the one count
      — and, still open: whether Title belongs in Advanced Settings at all
```

### UI-B1 Relevant Files

**Goal.** Context Ready says "2 relevant files · 11 search terms" and the next
question is which ones. A collapsed disclosure inside the result section answers
it and opens any of them in the editor.

**Source artifact, and the fields actually used.** A real
`related_files.json` from `bugpilot bug --prepare-only`:

```json
[
  {
    "confidence": "medium",
    "documentation": false,
    "file": "src/Selector.cpp",
    "match_count": 3,
    "matched_keywords": ["Output", "outputType", "type"],
    "noise_flags": [],
    "reasons": ["matched keyword in application source path", "..."],
    "score": 10
  }
]
```

Three fields are read and the other five are deliberately not:

```text
file               -> the row's path, exactly as written. Never guessed,
                      never resolved by basename against the workspace.
documentation      -> Implementation / Supporting grouping. Python's
                      `code_files.is_documentation` stays the only opinion;
                      the extension re-derives nothing.
matched_keywords   -> the "Matched:" line. Already bounded by the ranker.

score, confidence, match_count, reasons, noise_flags -> not shown. They are
how the ranking works, not what it found; §31's Retrieval Details is where
that belongs, if anywhere.
```

**Intended UI.** Inside the result section, below the artifact actions, so the
hierarchy stays Fix with AI first:

```text
[v] Context Ready
2 relevant files - 11 search terms
Strategy  Standard Fix
[ Fix with AI ]
[Open Context] [Copy] [Open Folder]
> Relevant Files
```

Expanded, with grouping only when there is something to separate:

```text
v Relevant Files
  Implementation
    Selector.cpp
    src/Selector.cpp
    Matched: Output - outputType - type
  Supporting
    README.md
    README.md
    Matched: Output - outputType - restored - type
```

**Click to open.** The filename is a `<button>`; pressing it posts
`{type: "openRelevantFile", path}` with the artifact's own relative path. The
host resolves it against the repository root, refuses anything that does not
land inside it, and hands it to the same `ui.openFile` port `openArtifact`
already uses. No shell, no OS-specific call, no absolute path from the page.

**Compatibility constraints.**

```text
- the entries render in the artifact's order; nothing is re-sorted, and
  grouping is a stable partition that keeps each group's relative ranking
- the list belongs to `contextReady`, so it inherits that lifecycle exactly:
  cleared when a run starts, absent while one is in flight, absent after a
  failure, replaced when another work item is opened
- the artifact is read once per refresh, as it already was for the count
- nothing in Python, the CLI, the artifact schema or the ranker changes
```

**Acceptance criteria.**

```text
1.  Nothing named Relevant Files exists before a run, or after a failed one.
2.  The section is a collapsed disclosure, keyboard-operable, secondary to
    Fix with AI by position and by size.
3.  Rows appear in the artifact's order.
4.  A malformed artifact, a malformed entry or a missing optional field never
    breaks Context Ready: bad entries are dropped, and a list with nothing
    valid in it hides the section.
5.  A path is used exactly as the artifact wrote it; none is constructed.
6.  Clicking a row opens that file through the existing editor port.
7.  A path that escapes the repository is refused on the host, not only on
    the page.
8.  No score, confidence, match count, reason or noise flag reaches the UI.
9.  No new codicon, no colour literal, no fixed width, no horizontal scroll.
10. No Python, CLI, retrieval, ranking or artifact change.
```

**UI-B1 checkpoint.**

*Artifact model and parser.* `relevantFiles()` lives beside `contextCounts()` in
`contextSummary.ts` — option B of the three §19 offered. The file is read once
and this is a second `JSON.parse` of a string already in memory, which buys two
functions that each do one thing. Fields consumed: `file`, `documentation`,
`matched_keywords`. Fields deliberately not consumed: `score`, `confidence`,
`match_count`, `reasons`, `noise_flags` — and because they never enter the
`RelevantFile` type, they cannot reach the page. A test asserts the type has
exactly four keys.

Defensive decisions, each with a test: a missing, empty, non-JSON, non-array or
object-shaped artifact yields `[]`; an entry that is not an object, or whose
`file` is absent, non-string, empty or unsafe, is dropped while its neighbours
survive; `documentation` absent means implementation (the ranker's own default);
`matched_keywords` is accepted only as a list of non-empty strings. A malformed
list costs the list and never Context Ready — verified from both sides.

*Click to open.* The filename is a `<button>`; pressing it posts
`{type: "openRelevantFile", path}`. `parsePanelMessage` requires a string of at
most 1024 characters that passes `isSafeRelativePath` — non-empty, relative, no
`..` segment, no `/` or `\` prefix, no drive letter. The controller then resolves
it against the repository root and checks `isWithin` (the same utility focus-file
and ignore-path validation uses) before calling `ui.openFile`, which is the port
`openArtifact` already goes through. A path that escapes is logged and refused.
Both layers are tested, and the host-side test drives `openRelevantFile`
directly so it cannot be satisfied by page-side validation alone.

*UI.* A collapsed `<details>` last in the result section, after the primary
button and the artifact actions, so the hierarchy stays Fix with AI first. Rows
are built by the page through `textContent`. Grouping is Implementation before
Supporting, from the artifact's own `documentation` flag, and the headings appear
only when both groups have entries — one heading over one group labels a
distinction the list does not make. Order inside each group is the artifact's;
nothing is sorted. Ten rows at most, with `N more in related_files.json` beyond
that rather than pagination, because `MAX_TOTAL_RELATED_FILES` is 10 and only a
raised Max files setting can exceed it.

Responsive: the row is a column, so the name and the path stack at any width;
both wrap with `overflow-wrap: anywhere` and neither is truncated, because a
middle-elided path hides the part that says which of four same-named files this
is. No fixed width, no absolute positioning, no `nowrap`.

Verified against a real run, not a fixture. A three-file repository prepared
through `bugpilot bug --description ... --prepare-only` rendered:

```text
3 relevant files - 11 search terms

Implementation
  Selector.cpp        platform/sample/plugins/Selector.cpp
                      Matched: Output - outputType - type
  VolumeDescriptor.h  platform/sample/VolumeDescriptor.h
                      Matched: Output - outputType - type
Supporting
  architecture.md     docs/architecture.md
                      Matched: Output - outputType - restored - selection - type
```

*One known inconsistency, left alone.* The count line is the artifact's length
and the list is the entries that parsed, so a malformed entry would make them
disagree by one. Reconciling them would mean the count reporting fewer files
than the run actually found, which is the worse of the two. BugPilot writes this
file, so the case is theoretical.

Files changed:

```text
production  extension/src/app/contextSummary.ts   RelevantFile, relevantFiles,
                                                  isSafeRelativePath, MAX_LISTED_FILES
            extension/src/app/controller.ts       #readSummary, #files,
                                                  openRelevantFile, state wiring
            extension/src/panel/messages.ts       openRelevantFile; files on the view
            extension/src/panel/html.ts           the Relevant Files disclosure
            extension/media/panel.js              renderRelevantFiles, fileRow
            extension/media/panel.css             .files, .file-row, .file-open
tests       extension/test/contextSummary.test.ts 11 added
            extension/test/controller.test.ts      8 added
            extension/test/page.test.ts           12 added
            extension/test/panel.test.ts           5 added, 1 updated
plan        docs/bugpilot_prototype_development_plan.md
```

Verification:

```text
extension tests   671 passed, 0 failed   (636 before UI-B1's own tests)
typecheck         tsc --noEmit clean
smoke             activated, 21 commands, 3 views, panel HTML built
git diff --check  clean
python            not run: no Python, CLI, artifact or ranking change
```

**Not validated interactively.** No VS Code Extension Host was available, so
neither theme, none of the three sidebar widths, and no real click-to-open were
looked at. What is checked mechanically: no new codicon (the section adds none),
no colour literal, no fixed width or absolute positioning under `.file*`, a
column row that stacks, and both text lines allowed to wrap anywhere.

Deferred, unchanged:

```text
UI-B  Status / Errors / Run Summary, Better Error UX, Focus File chips, a file
      picker, promoting a relevant file into Focus Files
UI-C  Retrieval Details and Diagnostics — term weights, match counts,
      broad-term handling, the rest of search_quality.json
      — and, still open: whether Title belongs in Advanced Settings at all
```

### UI-B2 Better Error UX

**What is wrong today.** The failure card shows `diagnose()`'s summary and
action, which is already good copy — but three things are missing. The CLI's own
error message is thrown away by `ProgressTracker.#markFailure`, so a developer
who wants the technical detail has to go to the output channel. There is no
action button on a failure, so "Jira rejected the stored credentials" is a
sentence with no way to act on it. And a Fix with AI that cannot start is
reported as a *step detail* — `"claude is not on PATH. The handoff prompt is on
the clipboard instead."` — sitting in the result section as though it were a
status, which conflates "the package could not be built" with "the package is
fine and the agent would not start".

**Not a second error architecture.** `errors.ts` already maps the CLI's error
codes to a summary, an action and a retryable flag, and the contract says a
consumer branches on `error.code` and never parses `error.message`. That stays
the classifier. UI-B2 adds a category and a title on top of it, preserves the
raw message beside it, and gives the card a button.

**Categories, and the signal each is decided by.**

```text
jira-access     code JIRA_NOT_CONFIGURED, JIRA_AUTH_FAILED
                -> "Unable to access Jira"
jira-not-found  code JIRA_ISSUE_NOT_FOUND
                -> "Issue not found", naming the key when one is known
agent           AgentPlan.kind === "unavailable" from resolveAgent
                -> "AI agent unavailable"
run             every other code, including one this extension does not know
                -> "Run failed"
```

No message parsing anywhere. Every category comes from a code the CLI declared
or from a typed result the extension itself produced.

**Category 4 (repository unavailable) already exists and is not duplicated.**
`chooseRepoRoot` returns "No folder is open. Open the repository you are fixing
bugs in.", which readiness renders as the blocked card, and `run()` refuses
while that is true. Adding a second card saying the same thing would stack two
explanations of one fact. A test pins the existing behaviour instead.

**Preserving the technical detail.** `ProgressView.failure` gains `detail` —
the CLI's own `error.message`, untouched. The page renders it inside a
collapsed `<details>` through `textContent`, so a message containing markup
stays text. Nothing is redacted here that was not already redacted upstream, and
no new redaction is invented.

**The two failures are different states.**

```text
run failed        -> no Context Ready, no Relevant Files, the run error card,
                     the form and the workflow still usable for a retry
handoff failed    -> Context Ready stays, Relevant Files stays, the artifact
                     actions stay, and the agent error appears beside them
```

**Lifecycle.**

```text
a new run starts          both errors cleared
a new handoff starts      the handoff error cleared, Context Ready untouched
a run succeeds            the run error is gone with the failure it came from
a handoff succeeds        the handoff error is replaced by the outcome line
another work item opens   neither error follows it
```

**Acceptance criteria.**

```text
1.  Classification happens in the host; the page receives a rendered model and
    does no string matching.
2.  Every category carries a title, a sentence, the original detail, and at
    most one action.
3.  An unknown code falls back to "Run failed" with the CLI's own message.
4.  A failed run shows no Context Ready and no Relevant Files.
5.  A failed handoff leaves Context Ready and Relevant Files exactly as they
    were.
6.  Details is a collapsed disclosure rendered with textContent.
7.  The action button reuses an existing command through the existing
    `{type:"command"}` path, re-checked against COMMANDS on arrival.
8.  No health check, no probe, no provider change, no Python change.
```

**UI-B2 checkpoint 1 — the error model.** `failures.ts` is one small module with
two functions and no state. `runError(failure, workItemId?)` maps a CLI error
code to a category; `handoffError(reason)` turns `resolveAgent`'s typed refusal
into the same shape. Both return

```text
{ kind, title, message, detail?, action? }
```

`message` is `diagnose()`'s existing summary and action joined — copy a previous
phase already got right, not rewritten. `detail` is the CLI's own message,
which `ProgressTracker.#markFailure` used to discard and now keeps. A test reads
`failures.ts` itself and fails if `includes`, `match`, `indexOf`, `toLowerCase`
or `RegExp` appears in it, which is the guard that keeps classification off
message text.

Categories and their fallback:

```text
jira-access     JIRA_NOT_CONFIGURED, JIRA_AUTH_FAILED   -> Set Jira Credentials
jira-not-found  JIRA_ISSUE_NOT_FOUND                    -> names the key
agent           resolveAgent -> unavailable             -> Open Settings
run             everything else, known code or not      -> no button
```

A timeout, a rate limit, a network error and an unreadable response stay in
`run`: telling somebody to check their token when their VPN is down sends them
to the wrong place. A code this extension has never seen also lands in `run`,
where `diagnose()` has already fallen back to the CLI's own words.

**Checkpoint 2 — state and lifecycle.** Two fields on `PanelState`, and the
difference between them is the point:

```text
runError      never present with contextReady; a run that failed built nothing
handoffError  deliberately present *with* contextReady; the package is fine
```

```text
a run starts             both cleared, before the first push
a handoff starts         handoffError cleared, contextReady untouched
a handoff succeeds       handoffError cleared, the outcome line takes its place
a run succeeds           no error, because there is no failure to classify
another work item opens  neither follows it
a run in flight          runError suppressed, so a stale card cannot sit
                         beside a Running... button
```

**Category 4 was already implemented and is not duplicated.** `chooseRepoRoot`
returns "No folder is open. Open the repository you are fixing bugs in.",
readiness renders it as the blocked card, and `run()` refuses while that is
true. A test presses Run with no repository and asserts the blocked card
explains it, no `runError` appears, and no process is started. Two cards saying
the same thing would be worse than one.

**Checkpoint 3 — the UI.** One `errorCard(id)` helper builds both, so the two
cannot drift:

```text
(!) Unable to access Jira
Jira rejected the stored credentials. Re-run `bugpilot setup`.
[ Set Jira Credentials ]
> Details
  HTTP 401 Unauthorized
```

An icon and text, not a red panel — `codicon-error` tinted from the existing
danger tone, no background, no border, which is also what survives a
high-contrast theme. The run's card sits below the form where a run's outcome
has always been; the handoff's sits inside the result section, beside the
package it did not spoil. `Details` is a collapsed `<details>` over a `<pre>`
written with `textContent`, wrapped with `pre-wrap` and `overflow-wrap: anywhere`
so a traceback keeps its line breaks without a horizontal scrollbar. The button
posts `{type: "command", id}` — the path the blocked card already used, which
the host re-checks against `COMMANDS`.

One new command, `bugpilot.openSettings`, opening the editor's settings filtered
to `@ext:ShiweiX.bugpilot`. Jira failures get `setCredentials` instead, which
already existed: a Jira credential lives in SecretStorage, and pointing at the
settings page for it would be wrong.

**Checkpoint 4 — verification.**

```text
extension tests   712 passed, 0 failed   (671 before UI-B2's own tests)
typecheck         tsc --noEmit clean
smoke             activated, 22 commands, 3 views, panel HTML built
git diff --check  clean
python            not run: no Python, CLI, artifact or protocol change
```

Files changed:

```text
production  extension/src/app/failures.ts      new: the categories
            extension/src/app/progress.ts      failure keeps the CLI's message
            extension/src/app/controller.ts    classify, hold, and clear
            extension/src/panel/messages.ts    runError, handoffError
            extension/src/panel/html.ts        errorCard(), used twice
            extension/media/panel.js           renderError(), one renderer
            extension/media/panel.css          .failure and its parts
            extension/src/commands.ts          openSettings
            extension/src/extension.ts         its handler, EXTENSION_ID
            extension/package.json             contributes the command
tests       extension/test/failures.test.ts    new: 13
            extension/test/controller.test.ts  12 added
            extension/test/page.test.ts        11 added, 2 updated
            extension/test/panel.test.ts        6 added
plan        docs/bugpilot_prototype_development_plan.md
```

**Not validated interactively.** No VS Code Extension Host was available, so no
theme, no sidebar width and no real Jira or agent failure was seen on screen.
Mechanically checked: no colour literal, no background or border on the card, a
wrapping action row, a wrapping `<pre>`, no fixed pixel width or absolute
positioning under `.failure`, and a page source that contains none of the error
codes it would need to classify anything itself.

Deferred, unchanged:

```text
UI-B  Run Summary: what an agent did with the package after the handoff
UI-C  Diagnostics and Retrieval Details
      — proactive health checks, provider installation detection and a
        telemetry or logging architecture stay out of scope entirely
      — and, still open: whether Title belongs in Advanced Settings at all
```

### UI-B3 Run / AI Handoff Summary

**What is missing.** Every other end of the journey says something. A handoff
that cannot start gets a card with a title, a reason and a button (UI-B2). A
handoff that *works* gets the Fix with AI button quietly disappearing and a
muted sentence in its place — the one outcome the developer most wants
confirmed, communicated by an absence.

**What BugPilot knows, and what it must never claim.** The extension launches a
terminal and stops watching. So:

```text
knows        context was prepared; a handoff was attempted; an agent was
             resolved; a terminal was started with the handoff prompt; or the
             handoff was skipped and why
does not     whether the bug was fixed, which files changed, whether tests
             passed, whether the agent finished, or whether the root cause was
             found
```

`overallStatus` has said this since phase 5 — "Complete" is not among its
answers, and "AI fix started" is the furthest it goes. UI-B3 reuses that exact
phrase rather than inventing a second vocabulary for the same fact.

**The existing state model already distinguishes what is needed**, so nothing is
renamed and no boolean is added beside it:

```text
#fix undefined          not attempted    -> the Fix with AI button
#fix.status "success"   handed over      -> the outcome, and no button
#fix.status "skipped"   nothing started  -> the UI-B2 error card, button stays
```

A skip is never a success. It happens two ways — no agent could be resolved
(the prompt goes to the clipboard instead, and UI-B2 already explains it), or
the run did not finish, in which case there is no result section at all.

**Target.**

```text
[v] Context Ready
3 relevant files - 11 search terms
Strategy  Standard Fix

[v] AI fix started
The prepared context was handed to the configured AI agent.
Handed to Claude Code in a terminal.

[Open Context] [Copy] [Open Folder]
> Relevant Files
```

The headline and the explanation are provider-neutral. The third line is the
host's own record of what it did and names whatever agent resolved — that line
already existed as the workflow row's detail and is not new copy.

**Lifecycle.**

```text
a handoff starts        the button reads Starting AI fix... and is disabled
it succeeds             the outcome replaces the button; Context Ready,
                        Relevant Files and the artifact actions are untouched
it cannot start         the UI-B2 card; the button comes back, because
                        installing an agent and pressing again is real
a retry succeeds        the card goes, the outcome appears, Context Ready
                        never moved
a new run starts        the outcome is cleared with everything else
another work item       the same
```

**Acceptance criteria.**

```text
1.  A successful handoff shows a title and a sentence, not a vanished button.
2.  The copy claims only that an agent was started.
3.  Context Ready, its counts, Strategy, the three artifact actions and
    Relevant Files all survive a handoff unchanged.
4.  The automatic path (Fix with AI ticked before Run) reaches exactly the
    same state as the manual one.
5.  A skipped handoff shows no success, and keeps the button.
6.  Success and the handoff error are never both present.
7.  No terminal polling, no completion detection, no new artifact data.
8.  No Python, CLI, provider or retrieval change.
```

**UI-B3 checkpoint 1 — the state model.** Nothing was renamed and no boolean was
added beside the existing outcome. `#fix: FixWithAiOutcome | undefined` already
distinguished the three states this phase needs, and `handoff.ts` reads it:

```text
undefined            not attempted     the Fix with AI button
status "success"     an agent started  the outcome; no button
status "skipped"     nothing started   the UI-B2 card; the button returns
```

One state was added, because the press is not instant: `#handoffBusy`, true
while `resolveAgent` spawns its probes. It is exclusive with the outcome by
construction — the success and skip branches no longer push, so the single
`finally` push carries a cleared flag and the result together. A test walks
every pushed state and asserts no two of busy, succeeded and failed were ever
reported at once.

`handoffOutcome()` returns `undefined` for everything but `success`, which is
what keeps a skip from being dressed up. A skip means no agent was launched and
the prompt went to the clipboard for the developer to use themselves; saying
"AI fix started" there would tell them an agent is working on their bug when
none is.

**Checkpoint 2 — the UI.**

```text
[v] AI fix started
The prepared context was handed to the configured AI agent.
Handed to Claude Code in a terminal.
```

The title is the phrase `overallStatus` has used since phase 5 — one vocabulary
for one fact. The headline and the sentence name no vendor; the third line is
the host's own record of the launch, the same sentence the workflow row carries,
and it is optional. The tick is `codicon-pass-filled` from the vendored subset,
tinted from the existing success tone: no new icon, no colour literal, no
banner. The status is in the text with `role="status"`, so it survives a
monochrome theme and a screen reader.

While the handoff is being resolved the button reads `Starting AI fix…` with the
theme's own spinner and is disabled — the same pattern Run and Improve already
use.

Preserved through a successful handoff, and asserted field by field on both
sides of the boundary: Context Ready, the counts, Strategy, Relevant Files, and
Open Context / Copy / Open Folder with their existing messages.

**Checkpoint 3 — lifecycle.**

```text
a retry that works        the failure card goes, the outcome appears, and
                          Context Ready never moved
the automatic path        Fix with AI ticked before Run reaches an identical
                          `handoffOutcome` to the manual press; asserted by
                          comparing the two states directly
a new run                 the outcome is cleared with the rest of the result
another work item         `#fix` is now cleared there too, which it was not
a run that failed         no package, so no result and no outcome — even with
                          Fix with AI ticked
```

**Checkpoint 4 — verification.**

```text
extension tests   740 passed, 0 failed   (712 before UI-B3's own tests)
typecheck         tsc --noEmit clean
smoke             activated, 22 commands, 3 views, panel HTML built
git diff --check  clean
python            not run: no Python, CLI, artifact or protocol change
```

Files changed:

```text
production  extension/src/app/handoff.ts       new: the outcome and its copy
            extension/src/app/controller.ts    busy flag, outcome, work-item clear
            extension/src/panel/messages.ts    handoffOutcome, handoffBusy
            extension/src/panel/html.ts        the outcome block; a Run-style label
            extension/media/panel.js           renders it; the busy button
            extension/media/panel.css          .result-handoff
tests       extension/test/handoff.test.ts     new: 6
            extension/test/controller.test.ts  10 added, 2 updated
            extension/test/page.test.ts         8 added, 3 updated
            extension/test/panel.test.ts        4 added
plan        docs/bugpilot_prototype_development_plan.md
```

**The claims this phase is careful not to make.** Two tests, one on the copy and
one on the markup, fail if "bug fixed", "fix completed", "issue resolved",
"changes applied", "tests passed" or "files changed" ever appears. BugPilot
launches a terminal and stops watching, so none of those is knowable — and the
one that would be most believed is the one most worth guarding.

**Not validated interactively.** No VS Code Extension Host was available, so no
theme, no sidebar width, and no real handoff was seen on screen.

Deferred, unchanged:

```text
UI-C  Diagnostics and Retrieval Details
      — actual agent completion tracking stays out of scope permanently rather
        than temporarily: terminal polling, diff watching and output parsing
        are what this phase deliberately did not build
      — and, still open: whether Title belongs in Advanced Settings at all
```

### UI-V1 Visual & Interaction Review

Six phases were built and verified against markup, a DOM stub and the page
script. None of them was ever looked at. This phase looks.

**Review targets.**

```text
initial state        hierarchy, the Issue field, the Fix Mode block, Run
narrow sidebar       200px, 300px, 400px: overflow, wrapping, clipping, height
Advanced Settings    group spacing, heading weight, helper density, the hint row
Context Ready        counts, Strategy, the primary button
secondary actions    Open Context / Copy / Open Folder at 200px
Relevant Files       filename hierarchy, long paths, Matched density
error states         agent unavailable, run failed, Jira access
handoff success      whether three lines are two lines too many
duplication          Context Ready beside Investigation & AI Fix
themes               dark and light contrast, borders, focus, disabled
```

**How it was reviewed, and the limit of that.** A real VS Code Extension Host
opens a window that this environment cannot see, so the panel was rendered in
headless Chromium instead — the real `panelHtml()` output, the real
`panel.css`, the real vendored codicon font and the real `panel.js`, driven
through actual state messages, with VS Code's Dark Modern and Light Modern
tokens supplied as `--vscode-*` variables. Screenshots at each width and theme
were then read.

That is real layout from the real stylesheet, so it answers overflow, wrapping,
clipping, spacing, hierarchy and contrast. It cannot answer anything that needs
VS Code itself: the editor's own fonts and density, a live Jira or agent
failure, whether clicking a relevant file opens the right editor tab, real focus
rings, or how the panel behaves inside the sidebar's own chrome. Those stay
unverified and are recorded as such rather than claimed.

**Rule for changes.** Nothing is adjusted without a screenshot behind it. Each
change records what was seen, why it is a problem, and the smallest fix; each
thing reviewed and left alone is recorded too, so a later phase does not reopen
a decision that has already been looked at.

**UI-V1 findings.** Nine states, two themes, three widths — 54 rendered pages,
measured and screenshotted.

*1. Stop and Retry rendered while hidden.* **Fixed.**

```text
Observed    #stop computed `display: flex` with hiddenAttr=true in every state,
            including an untouched panel: a greyed Stop sat beside Run in both
            themes. Retry the same when canRetry was false.
Problem     `.run-buttons > button { display: flex }` beats the UA
            `[hidden] { display: none }`. The markup's own comment says the
            opposite is intended — "a greyed Stop under an idle panel is a
            control that has never once been usable when it was on screen" —
            and Run was squeezed to 55% of the row to make space for it.
            Third occurrence of this bug class in this stylesheet.
Change      `.run-buttons > button[hidden] { display: none }`, and a new guard
            that walks the markup with a tag stack: any rule reaching a hidden
            element through its parent's class must carry a `[hidden]`
            companion. The existing guard only modelled classes on the hidden
            element itself, and #stop has none.
Verified    Re-measured: Stop absent, Run back to full width. Removing the CSS
            fix makes the new guard fail.
```

**Why no test caught it.** The DOM stub records the `hidden` property and lays
nothing out, so it reported the button hidden while a browser drew it. No amount
of markup assertion reaches this; rendering does.

*2. A label pushed the panel into horizontal scroll at 200px.* **Fixed.**

```text
Observed    At 200px with Advanced Settings open, body scrollWidth exceeded the
            panel by 19px. The culprit measured as
            <label.choice[for=fresh]> :: Delete previous artifacts first,
            right edge 219 against a 200px panel.
Problem     `.setting-header > label { flex: none }` is right for a label that
            is a name and wrong for the one that is a whole sentence, which
            could not shrink and so could not wrap.
Change      `.field-check .setting-header > label { flex: 1 1 auto; min-width: 0 }`
Verified    Zero overflowing elements across all nine states at 200px.
```

*3. The run hint outlived its usefulness.* **Fixed.**

```text
Observed    "Run prepares the issue context for AI-assisted fixing." sat
            between the Run row and the Context Ready block in every post-run
            screenshot.
Problem     Advice about a button, directly above the proof of what that button
            already did.
Change      The page hides it once there is a result or a failure, and brings
            it back for the next untouched state.
```

*4. The checklist repeated the result under it.* **Fixed.**

```text
Observed    After a run: 412px of result, then 314px of auto-expanded
            checklist whose summary read "Context ready" directly below a block
            reading "Context Ready", and whose last row was "Fix with AI"
            directly below the "Fix with AI" button.
Problem     UI-A3 kept the disclosure open after a run for one stated reason —
            the artifact icons lived on the Build context row. UI-B1 moved them
            into the result section, which took the reason away and left the
            duplication behind.
Change      Open while a run is in flight; fold once as it finishes, and only
            on that transition, so a developer who opens it again is not
            overruled by the next state push. Every control, status and
            duration is still there, one click away.
Verified    Re-rendered: the post-run panel is about half its previous height
            and Fix with AI is the one blue button below Run.
```

*5. The agent error sat below the artifact actions.* **Fixed** (markup order):
three things a developer can still do were between "Fix with AI" and the reason
it did not work.

**Reviewed and deliberately unchanged** — so a later phase does not reopen these
without new evidence:

```text
Fix Mode block      88px with its label, helper, selector, gear and mode
                    description. Reads as an execution choice rather than a
                    form field; not compacted.
Artifact actions    at 200px they wrap to "Open Context" / "Copy  Open Folder".
                    Uneven but not clipped, and all three reachable. §13's own
                    acceptable outcome.
Long paths          `overflow-wrap: anywhere` breaks a deep path mid-token. Two
                    lines at 300px, readable. Not truncated: a middle-elided
                    path hides the part that says which of four same-named
                    files this is.
"Jira issue JR-45678" under a field containing JR-45678. Redundant only for a
                    key; for prose it reads "Bug description", which is the
                    signal the removed radio pair used to carry.
Run and Fix with AI both being blue and full width. They are the primary action
                    of their own step, and Retry shares Run's row after a run.
Handoff success     three lines. The generic sentence carries the claim, the
                    detail names the agent. Neither is redundant.
Themes              Dark Modern and Light Modern both read correctly. No
                    contrast problem, no colour literal, no custom colour.
```

**The tool.** `extension/.review/` renders the real `panelHtml()` output with the
real stylesheet, the vendored codicon font and the real page script, driven by
real state messages, with VS Code's tokens supplied as variables:
`npx tsx .review/harness.ts` then `python3 .review/run.py shoot "*.dark.300"` or
`measure "*.200"`. Its output is git-ignored. It exists because four of these
five findings were invisible to every other kind of check this repository has.

**What this could not check.** No VS Code Extension Host: the editor's own fonts
and density, a live Jira or agent failure, whether clicking a relevant file
opens the right editor tab, real focus rings, and the sidebar's own chrome
remain unverified. Keyboard flow was reviewed structurally — real disclosures,
real buttons, real labels, no clickable divs — but not driven by hand.

**Verification.**

```text
extension tests   744 passed, 0 failed   (740 before UI-V1's own guards)
typecheck         tsc --noEmit clean
smoke             activated, 22 commands, 3 views, panel HTML built
git diff --check  clean
```

Deferred, recorded rather than built: Retrieval Details, Diagnostics, Focus File
chips, a file picker, a provider selector redesign, run history, agent
completion tracking.

### 34.F Freeze

The main-flow UI work is closed. Everything below is what the freeze pass found
reviewing the whole diff from `13973e8` to here, rather than only the last
phase's changes.

```text
frozen     UI-A1  one Issue field, Run primary, the rest behind disclosures
           UI-A2  Guidance / Retrieval Overrides / Run Options
           UI-A2c Ignore paths and the two limits joined Retrieval Overrides
           UI-A3  Context Ready, and Fix with AI as the next action
           UI-B1  Relevant Files, and click to open one
           UI-B2  failures with a title, an action and the original underneath
           UI-B3  the successful handoff, said out loud
           UI-V1  four issues found by rendering the panel and looking

deferred   Retrieval Details, Diagnostics, Focus File chips, a file picker, a
           provider selector redesign, run history, agent completion tracking,
           and whether Title belongs in Advanced Settings at all
```

**One blocker, found by the review and fixed.**

```text
Observed    UI-B2 gave the failure cards an action button and routed it through
            the `{type:"command"}` path the blocked card already used. That
            path accepts only ids the host is offering — and it built that list
            from `readiness.actions` alone, which an error card's action never
            entered. "Set Jira Credentials" and "Open Settings" posted their
            message and the controller refused it. Both buttons did nothing.
Why missed  The page test asserted the message went out, which it did. No host
            test received it. Two halves, each green, with the gap between them.
Change      `#isOffered(command)` replaces the cached set at the point of use:
            the blocked card's actions, plus whichever action the current run
            or handoff card is showing. Derived per call, because a cached copy
            of "what is on screen" is exactly what drifted.
Verified    Four tests: each button reaches its command; an id the host never
            offered is still refused; and an offer expires when a retry clears
            the card that made it.
```

**Minor, recorded and not done during a freeze:** the run failure card renders
after the form, so it sits below Advanced Settings; the red "Run failed" on the
workflow summary is above it and carries the signal. Three dead CSS blocks left
by the completed phases — `.card-failure`, `.result-fix`, `.step-actions` —
were removed, since they were debris from this very diff.

**An invariant this section learned the hard way.**

```text
An element controlled by the `hidden` attribute must stay hidden whatever a
component rule says about its `display`.
```

`hidden` is only a user-agent `display: none`, so any author rule setting
`display` on the same element beats it. It has now shipped three times here: the
Fix Mode views laid out down the main view, a stray tick beside "Not
configured", and a greyed Stop button beside Run in every state. Two guards
enforce it — one for classes on the hidden element, one for rules that reach it
through its parent — and neither would have found the third case without
somebody rendering the page. A blanket `[hidden] { display: none !important }`
was considered and not added: there is no unresolved instance, and the guards
name the rule at the place it is broken.

**How the UI was validated, and what that does not cover.** The panel was
rendered in headless Chromium from the real `panelHtml()` output, the real
stylesheet, the vendored codicon font and the real page script, driven by real
state messages, with VS Code's Dark Modern and Light Modern tokens supplied as
variables — 9 states x 2 themes x 3 widths, 54 pages, re-run after the freeze
pass's changes with zero overflowing elements.

```text
validated      layout, wrapping, overflow, spacing, hierarchy, and contrast
               against supplied theme tokens
not validated  a real Extension Host: VS Code's own chrome and fonts, live
               editor focus, whether click-to-open lands in the right tab, a
               real Jira or agent failure, and keyboard interaction by hand
```

**Nothing here claims an agent finished anything.** "AI fix started" means a
terminal was launched with the prepared prompt, and two guards fail if the panel
ever says a bug was fixed, tests passed or files changed.

**Verification at the freeze.**

```text
extension tests   748 passed, 0 failed
typecheck         tsc --noEmit clean
smoke             activated, 22 commands, 3 views, panel HTML built
git diff --check  clean
python            not run: no Python, CLI, artifact or protocol file changed
```

The visual harness in `extension/.review/` is deliberately **not** part of this
commit. Whether it becomes a permanent visual-regression tool is its own
decision, and a product freeze is not the place to make it.

## 35. UI-C1 Retrieval Details

**Status:** Complete and verified.

Context Ready says "11 search terms" and stops. The question a developer asks
next is which ones, and why BugPilot searched a word they never typed. §33 built
all of that and wrote it to disk; nothing has ever shown it.

This is transparency, not configuration. Nothing here is editable, nothing is
recomputed, and no retrieval behaviour changes.

### Checkpoint 1 — the artifact, read rather than assumed

A real `search_quality.json`, from `bugpilot bug --description ... --keywords
VolumeDescriptor --hint "check output validation" --prepare-only`:

```json
{
  "classification": "specific",
  "derived_from": "",
  "effective_weight": 8,
  "match_count": 1,
  "source": "user",
  "status": "retained",
  "value": "VolumeDescriptor",
  "weight": 8
}
```

Top level: `confidence`, `high_confidence_files`, `medium_confidence_files`,
`low_confidence_files`, `noise_indicators`, `reasons`, `terms`.

**What each field actually means**, read from `search._term_diagnostics` and
`TermSearchResult` rather than inferred from its name:

```text
value           the string given to ripgrep
source          TermSource: issue | hint | user | identifier | phrase |
                expanded | shape_expansion
match_count     `total_match_count` — the number of matching *lines* across the
                repository. Not files, and not the evidence kept downstream:
                `TermSearchResult` says so in as many words, and `_collect`
                increments it once per parsed rg line.
classification  zero | specific | broad, derived from match_count alone against
                BROAD_MATCH_THRESHOLD
derived_from    the phrase a generated shape was built from; "" for everything
                else, because a term present in the text is its own explanation
status          retained | dropped, and `dropped` means exactly match_count == 0
weight          the scale in `search_terms.py`
effective_weight the same after a broad term is demoted
```

**The subset the UI consumes, and why the rest is left out:**

```text
consumed   value, source, match_count, classification, derived_from
left out   weight and effective_weight — the user-facing question is "why was
           this searched", not "what constant did the ranker use" (§8)
left out   status — it is `match_count == 0` restated, and `classification`
           already carries that as `zero`
```

**One label this changes.** "18 matches" would have been wrong: the number is
matching lines. The UI says **lines**, and a term that found none says "no
matches" rather than "0 lines".

**Bounded already.** `MAX_SEARCHED_TERMS` is 28, so the whole set renders inside
the collapsed disclosure and no pagination is invented for it.

### Checkpoint 2 — the parser

`src/app/retrievalDetails.ts`, a sibling of `contextSummary.ts` rather than part
of it: the two answer different questions from different files, and one module
with two unrelated shapes in it is not one module.

```ts
interface RetrievalTerm {
  term: string; source?: string; lines?: number;
  broad: boolean; empty: boolean; derivedFrom?: string;
}
```

**Every degradation drops the row, never the result.** A missing, empty,
non-JSON, non-object or `terms`-less artifact yields `[]`; an entry that is not
an object, or whose `value` is absent, non-string or blank, is dropped while its
neighbours survive; a `match_count` that is not a whole non-negative number is
omitted rather than shown; `derived_from: ""` is the artifact saying "nothing to
add", not a missing field. A malformed `search_quality.json` costs the terms and
leaves Context Ready and Relevant Files untouched — asserted from both sides.

**Broad is read, never computed.** `BROAD_MATCH_THRESHOLD` lives in `search.py`
and stays there. Three tests pin it: a huge count the artifact did not call
broad is not broad, a tiny one it did call broad is, and the flag comes only
from `classification`.

**An unknown source degrades to itself.** A newer bugpilot may add one, so a
value this table does not know is shown raw — but only if it looks like the
identifier it is meant to be, because the string reaches the panel and an
artifact is a file something else could have written.

**One read, not two.** `search_quality.json` answers both "how many terms" and
"which", so the controller reads it once and hands the text to both parsers. A
test counts the reads.

### Checkpoint 3 — the UI

Last in the result, collapsed, after Relevant Files:

```text
v Retrieval Details

  VolumeDescriptor
  User keyword - 18 lines

  outputType
  Shape expansion - 7 lines
  From: output type

  validation
  Hint - 821 lines - Broad

  reload
  Issue text - no matches
```

Source labels, the full `TermSource` union: `user` -> User keyword, `hint` ->
Hint, `issue` -> Issue text, `identifier` -> Identifier, `phrase` -> Phrase,
`expanded` -> Expanded term, `shape_expansion` -> Shape expansion.

"Broad" is a word, not a colour and not a badge: it is what the repository had
to say about the term, not a warning, and a fact carried only by a colour is one
a screen reader never gets. Typography and spacing rather than a card per term —
twenty-eight bordered boxes in a 200px sidebar is a wall.

Nothing in the section is editable; a test fails if a `button`, `input`,
`select` or `textarea` ever appears inside it.

**Found by running the parser over a real artifact:** "1 lines". Fixed, and
pinned by a test. Also observed there — of 16 terms in a small repository, 10
were shape expansions that matched nothing. Kept: "BugPilot tried
`output_type_selection` and your repository does not have it" is exactly the
transparency this section exists for, and the disclosure is collapsed.

### Checkpoint 4 — verification

```text
extension tests   785 passed, 0 failed   (748 before UI-C1's own tests)
typecheck         tsc --noEmit clean
smoke             activated, 22 commands, 3 views, panel HTML built
git diff --check  clean
publishability    tests/test_publishable.py 8 passed
```

Visual: the harness's 54-page matrix re-rendered with a Retrieval Details
scenario added — 9 states x 2 themes x 3 widths, zero overflowing elements, and
the expanded section read at 200px dark and 400px light. A 35-character
identifier wraps without overflow. Still not a real Extension Host: VS Code's
own chrome and fonts, live focus, and real keyboard interaction remain unseen.

**§34 did not move.** The diff into the frozen files is 110 insertions and no
deletions, and a test asserts the result's reading order end to end — Context
Ready, counts, Strategy, handoff outcome, Fix with AI, the agent error, the
artifact actions, Relevant Files, Retrieval Details — with Fix with AI still the
only primary button in it.

**Non-goals held.** No retrieval behaviour changed, no Python touched, no score
or weight shown, no per-term file list, no tuning control, no Suggest Keywords,
no telemetry, and nothing persisted anywhere new.

Deferred: Diagnostics, provider/Jira/environment health, per-term matched files,
focus-file promotion, AI semantic expansion, run history.

## 36. UI-C2 Diagnostics

**Status:** Complete and verified.

One question: *is BugPilot configured and operating in the environment I think it
is?* On a machine with a pipx copy of the CLI and a checkout of it, with two
repositories open and an agent that may or may not be on PATH, that is not
obvious — and the panel currently answers none of it.

**It is not a health check.** Opening Diagnostics makes no request, spawns no
probe, reads no directory and starts no timer. It shows state the extension
already holds, and every word is chosen so that it cannot be read as something
stronger: "Configured" means a credential is stored, not that Jira answered.

### Checkpoint 1 — what is already known, and what is not

Read from the controller rather than assumed:

```text
RELIABLE, and used
  #root                  the repository, absolute
  readiness.executable   which bugpilot is being run
  readiness.version      that CLI's version, from `bugpilot --version`
  #jiraConfigured        a credential is in SecretStorage. Nothing more.
  #form.agent            the developer's selection: auto | claude | custom
  #workItemId            the current work item, when a run has established one
  #form.source           whether that work item is a Jira issue or hand-written

RELIABLE, and rejected
  #fix / #handoffError   handoff state — UI-B2 and UI-B3 already show it in
                         cards a developer is looking at (§12)
  #contextReady          "Context Ready" is on screen two inches above (§14)
  #counts, #terms        already shown by §34 and §35, twice would be noise
  #artifactNames         a file list belongs behind Open Folder (§15)
  #form.agentCommand     a custom command line may carry paths, arguments or
                         a token; never displayed (§11, §25)
  Jira base URL, account the URL is company-specific and the account is a
                         person; neither is diagnostic enough to be worth it
  the CLI's environment  that is where the token travels (§25)

NOT AVAILABLE, so added rather than guessed
  the resolved agent     `resolveAgent` returns a typed plan and the label went
                         only into prose — "Handed to Claude Code in a
                         terminal". §21 forbids deriving it from that text, so
                         the one place resolution already happens now records
                         the typed outcome. Nothing new is probed: the field
                         stays "Not checked" until a handoff is attempted.
  the extension version  `readiness.version` is the *CLI's*. The extension's own
                         comes from `context.extension.packageJSON.version`
                         through a port, because the two can differ and on this
                         project routinely do.
```

**Both versions are shown.** The footer already prints the CLI's, but the useful
diagnostic on a machine with several installs is *which* bugpilot, at *what*
path, against *which* extension. That is the failure this section exists to make
visible.

### Checkpoint 2 — the model

`src/app/diagnostics.ts` turns controller state into rows of plain strings:

```ts
interface DiagnosticsRow { label: string; value: string; detail?: string }
```

Its input is eight fields, and that list *is* the privacy guarantee: the token,
the custom command line and the bug's own description are not parameters, which
is a stronger statement than "not displayed". A test asserts the input keys and
fails if one ever contains `token`, `credential`, `secret`, `command`,
`description`, `email` or `prompt`.

**Every word is chosen so it cannot be read as stronger than it is.** A stored
credential is "Credentials configured", never "Connected"; a test fails on
"Connected", "Healthy", "Online", "Verified" or "Working" appearing anywhere in
the rendered rows. An agent nobody has resolved is "Not checked yet" rather than
an error or a blank.

Lifecycle is the existing state push and nothing else — no timer, no poll, no
cache. One gap was found and closed: `#formChanged` deliberately does not push
per keystroke, so the agent row lagged a push behind a selection change. It now
pushes when `form.agent` differs, which is a comparison rather than a new push
per keystroke.

**One typed field was added rather than guessed.** `resolveAgent` already
returns a plan and its label went only into prose; `#resolvedAgent` now records
the typed outcome at the one place resolution happens. Nothing new is probed —
the field stays "Not checked yet" until a handoff is attempted, which is what
keeps opening Diagnostics free.

### Checkpoint 3 — the UI

```text
v Diagnostics

  Repository        seismic-platform
                    C:/work/seismic-platform
  Jira              Credentials configured
  AI agent          Auto-detect
                    Resolved: Claude Code
  Work item         JR-45678
                    From a Jira issue
  Extension         0.1.0
  BugPilot CLI      0.1.0
                    C:/Users/dev/.../pipx/venvs/bugpilot/Scripts/bugpilot.exe
```

A `dl`: label-and-value is a pairing, and putting it in the markup is what makes
it survive a screen reader. Label above value, both full width, because a
two-column table needs a width a 200px sidebar does not have. No dot, no badge,
no colour — a green dot beside "Credentials configured" would claim something
nobody checked. Read-only: a test fails if a `button`, `input`, `select`,
`textarea` or `a` ever appears inside the section.

**Placed last in the form, after Advanced settings — a deliberate departure from
UI-C2's sketch, which put it inside the result.** Four of its five rows are
environment facts that exist before any run, and the question it answers is
asked most urgently when nothing has run or when a run has just failed. Inside
Context Ready it could be opened in neither case. It still reads last in the
details, after Relevant Files and Retrieval Details, and the frozen result did
not move: the diff into `html.ts` is additions only.

**One overlap accepted.** The footer has shown the CLI version, the repository
root and "Jira: Configured" since phase 5. Diagnostics repeats those and adds
what the footer cannot fit — the executable's path, the extension's own version,
the agent and the work item. The footer is the glance and this is the detail;
changing the footer would mean reopening frozen §34 for a cosmetic reason.

Visual: 60 pages — 10 states x 2 themes x 3 widths — with zero overflowing
elements. Read at 200px dark (a pipx executable path wrapping across three
lines) and 300px light with nothing configured.

### Checkpoint 4 — verification

```text
extension tests   823 passed, 0 failed   (785 before UI-C2's own tests)
typecheck         tsc --noEmit clean
smoke             activated, 22 commands, 3 views, panel HTML built
git diff --check  clean
publishability    tests/test_publishable.py 8 passed
```

**Passive, and tested to be.** A focused test drives the two messages that can
cause a render without asking for work, then asserts the stream, JSON, probe and
terminal counters are unchanged. Opening Diagnostics contacts nothing.

**Fields rejected, with the reason**: handoff state (UI-B2 and UI-B3 already
show it), context state and counts (§34 and §35 show them), the artifact list
(Open Folder reaches it), the custom command line, the Jira URL and account, and
anything from the CLI's environment.

Deferred: Jira connectivity or latency, agent version detection, provider
installation probes, Node/Python/PATH display, a log viewer, diagnostic export,
run history, telemetry, and productizing the visual harness.

---

## 37. Artifact Simplification + Workflow Result Integration

**Status:** Batches 1 (`issue.json`), 2 (`retrieval.json`), 3 (`context.md`, `task.md`) and 4 (`run.json`) committed at `7fde6aa`; Batch 5 (`fix_report.md`) committed at `adc3c53`; Batch 6 (`WorkflowStepResult`: the workflow rows are the result view) committed at `594ac5c`; Batch 7 (Fix Mode under Advanced settings → Strategy) committed at `317ecb0`; Batch 8 (Fix result from `fix_report.md`) committed at `fc97345`; Batch 9 (review aids on Fix result) complete, visually reviewed, independently reviewed and verified, uncommitted.

**Canonical reference:** `BugPilot_Artifact_Simplification_Workflow_Result_Integration_Plan.md`
(kept outside the repository). This section records what has landed against it.

**Compatibility policy:** BugPilot is pre-release. There is no dual-write, no
legacy reader, no fallback and no migration layer. A work item prepared before a
batch lands is simply re-prepared. The inventory below explains the starting
point; it is not a compatibility requirement.

### 37.1 Checkpoint A — current artifact inventory (Batch 1 start)

Read from the code at `158d92a`, not assumed. "ext" is the VS Code extension
(`extension/src`). Every file lives in `.ai/<work item>/` unless noted.

| Old artifact | Producer | Content | Readers | Canonical destination | Action |
|---|---|---|---|---|---|
| `jira.json` | `workflow.fetch_step`, `workflow.jira_validate_step` | Raw Jira REST payload, plus `bugpilot_normalized` and `bugpilot_fetch.url` | `workflow._parsed_issue` (every issue-reading step), `workflow._issue_summary` (branch name); ext `artifacts.ts` group map; delivery rules text | `issue.json` (normalized subset only; raw payload not persisted) | Batch 1: remove |
| `jira_summary.md` | `fetch_step`, `jira_validate_step` via `jira.jira_summary_markdown` | Rendered issue metadata, description, comments, attachment table | `context.build_context` (pasted into `bug_context.md`), `email_notify.build_email_draft`, `cli._print_key_generated_artifacts`; ext group map | `issue.json` (data); rendered in `bug_context.md` from memory | Batch 1: remove |
| `jira_parsed.md` | `workflow.parse_step`, `jira_validate_step` via `jira.parsed_markdown` | Repro steps, actual/expected, environment, errors, stack traces, log/regression/comment/attachment signals, missing-info checklist | `context.build_context`, `workflow.jira_comment_draft_step` (existence), `cli._print_key_generated_artifacts`, `prompts._copilot_task` (agent told to read it); ext group map | `issue.json` (data); rendered in `bug_context.md` from memory | Batch 1: remove |
| `bug_spec.json` | `input_adapters.save_bug_spec` (manual: before steps; Jira: `_persist_resolved_spec` after parse) | `work_item_id`, `source`, `title`, `description`, `source_ref` | `workflow._parsed_issue`, `_issue_summary`, `refine_investigation`; `cli` (`bug --json`, `status --json`, `list`, Jira-only refusals); `mcp_server` (`_package`, `get_status`); `email_notify`; ext group map | `issue.json` (`id`, `source`, `title`, `description`) | Batch 1: remove |
| `developer_hint.md` | `run_investigation` (effective hint), `refine_investigation` (new hint) | The hint text | `run_investigation` (resume reuse), `prompt_step`, `copilot_task_step` | `issue.json.guidance.hint` | Batch 1: remove |
| `fix_mode.json` | `fix_mode_state.persist_fix_mode` (before the pipeline) | `schema_version`, mode `id` + audit metadata (`name`, `version`, `source`, `execution_kind`, `based_on*`) | `fix_mode_state.select_fix_mode` (resume, refine, retry, standalone agent-task), `stored_fix_mode_metadata` → `workflow_status.json.fix_mode` → ext `fixModes.ts`, `cli status`, MCP `get_status` | `issue.json.guidance.fix_mode` | Batch 1: remove |
| `extracted_keywords.json` | `workflow.keywords_step` | Mined + supplied keywords, dropped keywords | `code_search_step`, `context_step`, `memory.search_memory`; ext group map | `retrieval.json` | Batch 2 |
| `code_search.md` | `code_search_step` via `search.run_code_search` | Matched lines, snippets, top files, warnings | `context.build_context`, retry prompt reading list, final review prompt, `cli` key artifacts, task prompt text; ext | `retrieval.json` (data) / `context.md` (snippets) | Batch 2 |
| `search_quality.json` | `code_search_step` | Confidence, reasons, per-term match counts/classification | `context.build_context`, retry prompt; ext `contextSummary.ts`, `retrievalDetails.ts` | `retrieval.json` | Batch 2 |
| `related_files.json` | `code_search_step` | Ranked files with matched keywords | `context.build_context`, `git_ops`, `_build_manual_validation`, retry prompt; ext `contextSummary.ts`, Relevant Files | `retrieval.json.related_files` | Batch 2 |
| `git_context.md`, `memory_search.md` | `git_context_step`, `memory.search_memory` | Git history / similar historical issues (deleted after `context` folds them) | `context.build_context` | `retrieval.json.git_history` / `.similar_fixes` | Batch 2 |
| `bug_analysis.md` | The coding agent (required result file); `manual_result_step` template | Root cause analysis *after* a fix attempt | `check_results`, `_build_result_summary`, `jira_comment_draft`, retry prompt; ext | `fix_report.md` (in the code it is a post-fix result, not pre-fix context) | Later batch |
| `bug_context.md` | `context_step` via `context.build_context` | The assembled context an agent reads first | `copilot_task_step` (existence), MCP `_package` excerpt, memory entry path, prompts; ext Open Context / Copy | `context.md` | Batch 3 |
| `agent_task.md`, `agent_handoff.md` | `prompt_step` / `copilot_task_step` via `prompts.generate_prompts` | Task package and handoff prompt | `cli`, `handoff`, MCP `_package`; ext Fix with AI | `task.md` | Batch 4 |
| `agent_team_instructions.md` | `prompt_step`, `copilot_instructions_step` (copy of `docs/agent_team_instructions.md`) | Stable team instructions | Agent (via task text) | merged into `task.md` | Batch 4 |
| `execution.log` | `logging_utils.log` (append-only) | Step log | `cli._print_log_hint`; ext group map | `run.json` (state); log disposition decided in that batch | Batch 5 |
| `workflow_status.json` | `workflow._write_status` / `_mark_step` (atomic) | Step statuses, generated files, fresh/allow_mock, fix mode record | `cli status/list`, MCP `get_status`, ext progress restore (`controller.ts`, `ports.ts`), `fixModes.ts` | `run.json` | Batch 5 |
| `diff_summary.md`, `fix_summary.md`, `review_notes.md`, `test_result.md` | The coding agent; `manual_result_step` templates | Post-fix results | `check_results`, `_build_result_summary`, retry prompt, jira comment draft, `_build_manual_validation`; ext | `fix_report.md` | Later batch |

Not in the plan's list but found while inventorying, and left for the batch that
owns them: `jira_field_report.md` (written only by the diagnostic
`jira-validate` command), `jira_comment_on.flag`, `agent_retry_prompt.md`,
`user_feedback.md`, `result_summary.md`, `manual_validation.md`,
`final_review_prompt.md`, `commit_plan.md`, `push_plan.md`, `email_draft.md`,
`notification.eml`, `jira_comment_draft.md`, `jira_comment_post_*`, and the
`attachments/` directory.

**Disk-as-IPC found in the issue stage.** `fetch_step` writes `jira.json`, then
`parse_step`, `keywords_step`, `context_step` and `memory_add_step` each re-read
and re-parse it; `parse_step` writes `jira_parsed.md` and `context_step` reads it
back as text; `_persist_resolved_spec` re-parses `jira.json` a fourth time to
write `bug_spec.json`. Batch 1 replaces all of this with one typed object.

### 37.2 Checkpoint B — the canonical 5+1 contract

```text
.ai/<work item>/
├── issue.json       normalized bug + effective guidance        (Batch 1)
├── retrieval.json   terms, relevant files, git history, fixes  (Batch 2)
├── context.md       what the agent reads first                 (Batch 3)
├── task.md          the task package for the coding agent      (Batch 4)
├── run.json         runtime state                              (Batch 5)
└── fix_report.md    optional, post-fix only
```

Single source of truth: `bugpilot/core/artifacts.py` — `ISSUE_ARTIFACT`,
`RETRIEVAL_ARTIFACT`, `CONTEXT_ARTIFACT`, `TASK_ARTIFACT`, `RUN_ARTIFACT`,
`FIX_REPORT_ARTIFACT`, `CORE_ARTIFACTS` and `ARTIFACT_SCHEMA_VERSION = 1`. Every
JSON artifact carries `schema_version: 1`. No constant exists for any old name.

`CORE_ARTIFACTS` and `FIX_REPORT_ARTIFACT` have no production caller yet; they
are listed in `test_no_unwired_symbols.py`'s `ALLOWED` table with that reason, so
the batch that adopts each deletes its line and the table records exactly what
is still unwired. (`RETRIEVAL_ARTIFACT`, `CONTEXT_ARTIFACT`, `TASK_ARTIFACT` and
`RUN_ARTIFACT` are referenced by `CORE_ARTIFACTS`; each batch starts writing its
file through the constant.)

### 37.3 Checkpoint C — `issue.json`: one typed model

`bugpilot/core/issue.py` defines `IssueArtifact` (frozen dataclasses:
`IssueComment`, `IssueAttachment`, `IssueSignals`, `IssueDetails`,
`IssueGuidance`), its builders and its on-disk form.

```json
{
  "schema_version": 1,
  "id": "JR-12345",
  "source": "jira",
  "title": "WidgetController rejects a valid output type",
  "description": "…",
  "comments": [{ "created": "2026-05-10T09:00:00.000+0000", "body": "…" }],
  "signals": { "stack_traces": [], "error_messages": [], "log_signals": [] },
  "details": {
    "issue_type": "Bug", "status": "Open", "resolution": "", "priority": "High",
    "labels": [], "components": [], "affected_versions": [], "fix_versions": [],
    "mock": false,
    "reproduction_steps": [], "actual_result": "", "expected_result": "",
    "environment": "", "regression_signals": [], "missing_information": [],
    "attachments": [{ "filename": "crash.log", "kind": "log", "mime_type": "text/plain",
                      "size": 4096, "created": "…" }]
  },
  "guidance": {
    "hint": "Investigate output validation.",
    "fix_mode": { "id": "standard", "name": "Standard Fix", "version": 1, "source": "builtin",
                  "execution_kind": "fix", "based_on": null, "based_on_version": null }
  }
}
```

Decisions, each against what the code actually reads:

- **One parser for both sources.** A Jira payload goes through `parse_issue`; a
  hand-written bug goes through the same `parse_issue` via
  `manual_issue_payload`. Same schema, same signal extraction.
- **`signals`** holds exactly the three lists keyword extraction ranks first.
  `IssueArtifact.combined_text` / `.priority_text` rebuild the two strings
  `keywords_step` used to assemble from the parsed dict, so extraction inputs are
  unchanged (a test compares the two paths byte for byte).
- **`details`** holds what `bug_context.md` renders and `_caution_markdown` /
  `_quality_score` decide from. The version lists come from the payload's
  normalized block, because `parse_issue` folds them into `environment`.
- **Not kept:** the raw payload (attachment/thumbnail URLs, `self` links, account
  ids, custom fields), the fetch URL, and people's names — assignee, reporter,
  comment authors. No step decides anything from them. `bug_context.md` loses
  its Assignee / Reporter / Project / Created-Updated lines and comment authors;
  everything a step reads is still there.
- **`guidance.fix_mode` is the audit record, not a bare id.** The canonical plan
  sketches `"fix_mode": "standard"`; an id alone would drop the version/source
  drift warnings (`_drift_warnings`), which is a Fix Mode behaviour change. The
  id remains the only thing that selects a mode.
- **`guidance.hint`** is the effective hint: explicit `--hint`, else the
  request's option (how an accepted improved hint arrives), else — on
  `--resume` only — the hint `issue.json` already records.
- **`source_ref`** is not stored: it is `id` for Jira and `None` for manual, so it
  is a property. `can_write_back` follows from it.
- **Atomic:** `save_issue` writes through `artifact_io.atomic_write_text`.
- **Version 1 only:** `issue_from_dict` rejects any other `schema_version`, an id
  that does not match the directory, or an unknown source.

Flow, with the disk-as-IPC removed:

```text
run_investigation
  manual → issue_from_spec(spec, guidance)          (complete, in memory)
  jira   → jira_stub(id, guidance)                  (or the previous issue on --resume)
  persist_fix_mode(…, issue) → one atomic write of issue.json, before any step
  fetch  → _fetch: fetch_issue → issue_from_jira → save_issue   (raw payload dropped)
  parse  → parse_step(issue=…): checks a Jira issue was fetched; writes nothing
  keywords / context / prompt / memory_add ← the same IssueArtifact, in memory
refine / standalone steps / agent-task → load_issue (persisted state)
```

### 37.4 Checkpoint D — legacy issue writers and readers removed

Removed, with no fallback and no compatibility constant:

| Old | Writer removed | Readers moved to |
|---|---|---|
| `jira.json` | `fetch_step`, `jira_validate_step` | the in-memory issue; `issue.json` |
| `jira_summary.md` | `fetch_step`, `jira_validate_step`; `jira.jira_summary_markdown` deleted | `context._issue_summary_markdown` (from memory); `email_notify` reads `issue.json` |
| `jira_parsed.md` | `parse_step`, `jira_validate_step`; `jira.parsed_markdown` deleted | `context._issue_details_markdown`; `jira_comment_draft_step` checks `issue.json`; the task prompt points at `bug_context.md` |
| `bug_spec.json` | `input_adapters.save_bug_spec` (+ `load_bug_spec`, `spec_to/from_dict`, `bug_spec_path`, `bug_spec_from_jira`) deleted | `issue.read_issue_quietly` in `cli` (`bug --json`, `status --json`, `list`, Jira-only refusals), `mcp_server`, `email_notify` |
| `developer_hint.md` | `run_investigation`, `refine_investigation` | `issue.guidance.hint` |
| `fix_mode.json` | `persist_fix_mode` now writes `issue.json.guidance.fix_mode`; `FIX_MODE_FILE` / `FIX_MODE_SCHEMA_VERSION` deleted | `select_fix_mode` / `stored_fix_mode_metadata` read `issue.json` |

Also: `workflow._parsed_issue`, `_issue_summary`, `_persist_resolved_spec` deleted;
the extension's artifact group map lists `issue.json` instead of the four old
names; the delivery rule "Do not add `jira.json`" now names `issue.json`; a
corrupt `issue.json` on `agent-task` / `prompt` prints a one-line error instead of
a traceback.

`jira-validate` (a diagnostic command, not part of normal execution) now writes
`issue.json` plus its own `jira_field_report.md`. That report is the one `jira*`
file left, and belongs to the batch that decides the fate of diagnostic outputs.

### 37.5 Checkpoint E — tests and verification (Batch 1)

New: `tests/test_issue_artifact.py` (28 collected). It covers the Jira and the
manual source (`schema_version`, `id`, `source`, `title`, `description`,
`comments`, `signals`, `details`, effective hint, Fix Mode, exactly one issue
artifact), no raw payload / URL / token / account id / person name in
`issue.json`, the status file still reporting the recorded mode, the derived
manual title, the Jira write-back gate, byte-identical keyword-extraction input
for both sources and across an `issue.json` round trip, the atomic write, every
unusable-file case as an error rather than a fallback, and resume: hint and mode
kept, retrieval searching with the recorded hint, an accepted improved hint
winning and sticking, a fresh run dropping old guidance, refine restoring from
`issue.json`, and a legacy directory (`developer_hint.md`, `fix_mode.json`,
`bug_spec.json`) being ignored rather than read.

Existing tests moved to `issue.json` rather than tolerating both layouts. Deleted
because their only subject was an old file: 13 `bug_spec.json` / `bug_spec_from_jira`
tests (their round-trip, UTF-8, missing, corrupt and write-back-gate behaviour is
re-covered against `issue.json`), the `developer_hint.md` foreign-encoding test,
and the `bugpilot_normalized.summary` branch-name fallback.

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1036 passed (baseline 1022: −15 legacy-only, +1, +28 new) |
| `npm test` (extension) | 823 passed |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean |

Real scratch run (a throwaway `sample-repo`, working tree via
`python -m bugpilot`, manual `--prepare-only` with title, hint and
`--fix-mode conservative`, plus `JR-12345 --allow-mock`): both work items hold
`issue.json` with the expected data and none of `jira.json`, `jira_summary.md`,
`jira_parsed.md`, `bug_spec.json`, `developer_hint.md`, `fix_mode.json`. The
remaining files are the later batches' (`code_search.md`, `extracted_keywords.json`,
`related_files.json`, `search_quality.json`, `bug_context.md`, `agent_task.md`,
`agent_handoff.md`, `agent_team_instructions.md`, `workflow_status.json`,
`execution.log`).

Note for whoever repeats the scratch run: the `bugpilot` on PATH is currently a
pipx install of the frozen `installer/` wheel, not the working tree, and still
writes the old files.

Open for later batches, found in this one:

- `refine_investigation` without a new hint searches without the recorded hint
  while its regenerated task file carries it. Unchanged from before; it belongs
  with the retrieval batch.
- User-facing docs (`README.md`, `docs/usage_guide.md`, `docs/architecture.md`,
  `docs/adapter_design.md`, the two architecture HTML guides) still describe the
  old issue files; historical logs and phase notes stay as written.
- `jira_field_report.md` from the diagnostic `jira-validate` command.

### 37.6 Checkpoint — retrieval artifact inventory (Batch 2 start)

Read from the Batch 1 working tree. The canonical spec now lives at
`docs/BugPilot_Artifact_Simplification_Workflow_Result_Integration_Plan.md`.

| Old artifact | Producer | Actual content | Readers | Canonical destination | Action |
|---|---|---|---|---|---|
| `extracted_keywords.json` | `workflow.keywords_step` (`keywords.extract_keywords` + supplied keywords prepended to `high_value_keywords`, overflow in `dropped_supplied_keywords`) | Seven extractor lists: `high_value_keywords`, `normal_keywords`, `dropped_keywords`, `phrase_keywords`, `expanded_keywords`, `priority_keywords`, `shape_candidates` | `code_search_step` (→ `search_terms.terms_from_extraction` / `shape_candidates`, and the legacy high/normal sets in `_rank_related_files`); `memory._query_keywords` (high + normal, for Similar fixes); `context_step` (Extracted Keywords section, a JSON dump of the dict, and the high-value count in the quality score); `tests/retrieval_corpus.py` mirrors the step; ext group map | Not persisted. Internal pipeline state, passed in memory; a standalone step recomputes it from `issue.json` (it is a pure function of the issue text). What was actually searched is `retrieval.json.terms` | Remove writer and all readers |
| `code_search.md` | `code_search_step` via `search._render_markdown` | Human-readable report: quality + reasons, the four keyword lists, warnings, high/low-confidence lists, Top Related Files lines, and Matched Lines (per file, up to 5 snippets, bounded by `max_search_lines`) | `context._code_search_summary` (Top Related Files and Warnings excerpts) and `_matched_lines_excerpt` (first 25 Matched Lines) into `bug_context.md`; agent prompts ("Read and inspect code_search.md", "Use matched line numbers from code_search.md"); retry and final-review reading lists; manual validation text; memory entry text; `cli._print_key_generated_artifacts`, `cli search --json`; ext group map | Removed. The one piece of evidence that is read downstream — matched lines — becomes bounded structured data: `retrieval.json.related_files[].snippets` (`line`, `text`), exactly the snippets the Matched Lines section showed under the same `max_search_lines` budget. Everything else in it was a re-rendering of data retrieval.json holds | Remove writer, renderer and readers |
| `search_quality.json` | `code_search_step` via `search._overall_quality` + `_term_diagnostics` | `confidence`, `reasons` (warnings appended), `high/medium/low_confidence_files`, `noise_indicators`, `terms[]` (`value`, `source`, `weight`, `effective_weight`, `match_count`, `classification`, `derived_from`, `status`) | `context` (confidence, reasons; confidence in the quality score); agent prompts; retry reading list; `cli search --json`; ext `contextSummary.contextCounts` (terms count), `retrievalDetails.retrievalTerms`; ext group map | `retrieval.json`: `confidence`, `reasons`, `noise_indicators`, `terms` unchanged in meaning. The three `*_confidence_files` lists are dropped: each is `related_files[].confidence` filtered, no production code reads them, and keeping them would store every file twice | Remove writer and readers |
| `related_files.json` | `code_search_step` via `search._related_files` | Ranked list: `file`, `documentation`, `score`, `confidence`, `match_count`, `matched_keywords`, `reasons`, `noise_flags` | `context` (Top Related Files — file/confidence/score/match_count/keywords — and the count in the quality score); `git_ops._related_files` (top 5, for Git history); `workflow._build_manual_validation`; agent prompts; retry reading list; ext `contextCounts` (count), `relevantFiles` (file/documentation/matched_keywords), panel overflow text "N more in related_files.json"; ext group map | `retrieval.json.related_files`, same order, same fields, plus `snippets` | Remove writer and readers |

**Git history and Similar fixes (Case B).** Neither produces persisted
structured data. `git_ops.generate_git_context` renders Markdown
(`git_context.md`); `memory.search_memory` builds a small list of dicts in
memory but persists only Markdown (`memory_search.md`). Both files are
intermediate: `context_step` folds them into `bug_context.md` and deletes them.
Nothing is added to `retrieval.json` for them in this batch, and no
`git_history.json` / `similar_fixes.json` is created. They change only where
their *inputs* come from (the related files and the keywords, now in memory).

**Algorithm baseline.** The corpus runs against this repository, so file
contents move it even when the algorithm does not. Pre-Batch-2, on the working
tree: top-1 1/5, top-3 3/5, top-5 3/5, top-10 3/5, MRR 0.367, docs in top 5 9,
53 terms, ~5.0 s. The same code against HEAD's file contents gives MRR 0.467, the
§33.7C figure: Batch 1 removed the string `fix_mode.json` from
`fix_mode_state.py`, which the `identifier-persist-fix-mode` case text names, so
that file fell from rank 1 to 10 while `workflow.py` rose from 9 to 2. A content
effect, not a ranking change; the corpus text is left as it is. For Batch 2 a
frozen copy of the pre-Batch-2 tree is the fixed repository: the new code must
rank every case on it exactly as the old code did.

### 37.7 Checkpoint — `retrieval.json`: one typed model

`bugpilot/core/retrieval.py` defines `RetrievalArtifact` (frozen dataclasses
`RetrievalTerm`, `RelatedFile`, `Snippet`), `save_retrieval` (atomic, through
`artifact_io.atomic_write_text`), `load_retrieval` (version 1 only; anything else
is `RetrievalArtifactError`, never a fallback) and `read_retrieval_quietly`.
`search.run_code_search(repo_root, keywords, options)` now returns the artifact
itself; `code_search_step` writes it once, when the search is complete.

Abridged from the real manual scratch run in §37.11 (`sample-repo`):

```json
{
  "schema_version": 1,
  "confidence": "high",
  "reasons": ["At least one high-confidence application source file was found."],
  "noise_indicators": [],
  "terms": [
    { "value": "VDS", "source": "identifier", "weight": 8, "effective_weight": 8,
      "match_count": 2, "classification": "specific", "derived_from": "", "status": "retained" },
    { "value": "validation", "source": "hint", "weight": 4, "effective_weight": 4,
      "match_count": 0, "classification": "zero", "derived_from": "", "status": "dropped" },
    { "value": "outputType", "source": "shape_expansion", "weight": 5, "effective_weight": 5,
      "match_count": 3, "classification": "specific", "derived_from": "output type", "status": "retained" }
  ],
  "related_files": [
    { "file": "src/WidgetController.cpp", "documentation": false, "score": 42,
      "confidence": "high", "match_count": 12,
      "matched_keywords": ["Output", "VDS", "WidgetController", "outputType", "type"],
      "reasons": ["keyword matches file name", "matched 2 distinct high-value keywords", "..."],
      "noise_flags": [],
      "snippets": [ { "line": 4, "text": "return type != OutputType::VDS;" } ] }
  ]
}
```

Against the canonical sketch:

- **`terms`** is exactly the old `search_quality.json` term record — same eight
  fields, same meaning, same order (weighted terms, then probed shapes).
  `match_count` is still matching ripgrep *lines*.
- **`related_files`** keeps all eight fields the old file had, not only the
  sketch's three. `score`, `confidence`, `match_count` feed `bug_context.md` and
  the quality score; `reasons` and `noise_flags` are what an agent reads to see
  why a file ranked. **`snippets`** is new and is the only thing taken from
  `code_search.md`: the matched lines, chosen by the same `max_search_lines`
  arithmetic the report's Matched Lines section used (two heading lines per
  file, one per line, one blank), so the option still bounds the evidence.
- **`confidence`, `reasons`, `noise_indicators`** unchanged. `reasons` still ends
  with the search warnings (a failed probe, "rg is unavailable").
- **Dropped:** `high/medium/low_confidence_files` (a filter of
  `related_files[].confidence`), the extracted keyword lists (in-memory state),
  and every Markdown rendering.
- **No `git_history` / `similar_fixes`.** Case B (§37.6): no structured data
  exists to put there.

Equivalence, proved on the frozen pre-Batch-2 tree for all six corpus cases:
every related file (all eight fields, same order), every term, confidence,
reasons and noise indicators are identical to what the old code wrote, and the
old Matched Lines section re-renders byte for byte from `snippets`. Corpus
summary on that tree: identical (top-3 3/5, MRR 0.367, docs in top 5 9, 53 terms).

**Keywords in memory.** `workflow.extract_issue_keywords(issue, supplied)` is the
old keywords step as a pure function; `keywords_step` returns its result and
`run_investigation` / `refine_investigation` hand it to `memory_search_step`,
`code_search_step` and `context_step`. A step run on its own
(`bugpilot search`, `context`, `memory search <id>`, the MCP memory tool)
recomputes it from `issue.json` via `work_item_keywords`. `--keywords` is a
per-run retrieval option, like `--focus-file`, `--ignore-path` and `--max-files`,
none of which a standalone command has ever remembered. `bugpilot keywords` now
prints the lists instead of writing a file.

**Git history** takes its five files from the retrieval in memory
(`generate_git_context(..., related_files)`); `git_ops` no longer reads an
artifact. **Memory search** takes the extraction as an argument
(`search_memory(..., extracted=)`) instead of reading one.

### 37.8 Checkpoint — legacy retrieval writers and readers removed

Removed, with no fallback and no compatibility constant:

| Old | Writer removed | Readers moved to |
|---|---|---|
| `extracted_keywords.json` | `keywords_step` (and `keywords.keywords_json`, deleted) | the in-memory extraction: `memory_search_step`, `code_search_step`, `context_step`; standalone steps and the MCP memory tool recompute it (`workflow.work_item_keywords`); `memory._query_keywords` takes it as an argument |
| `code_search.md` | `code_search_step`; `search._render_markdown` deleted | `context._code_search_summary` / `_matched_lines_excerpt` render from `retrieval.related_files` (+ `snippets`); prompts, retry and final-review reading lists, manual validation, memory entry and `cli` listings name `retrieval.json` |
| `search_quality.json` | `code_search_step`; `search.search_quality_json` deleted | `context._search_quality_markdown` / `_quality_score` from the retrieval; prompts and retry list name `retrieval.json` |
| `related_files.json` | `code_search_step`; `search.related_files_json` deleted | `context`, `git_context_step` (top 5 → `generate_git_context(related_files=)`; `git_ops._related_files` deleted), `_build_manual_validation` |

Also deleted: `search.MAX_TOTAL_CODE_SEARCH_LINES` (the renderer's default;
`InvestigationOptions.max_search_lines` still defaults to 300), the dead
`workflow._read_json` / `_read_json_default`. `cli search --json` reports
`retrieval.json` as its one generated file; `bugpilot keywords` prints the
extraction instead of writing it. Stale present-tense comments naming the old
files (in `keywords.py`, `search_terms.py`, `models.py`) were corrected.

Three deliberate differences in `bug_context.md` (context is Batch 3's; these
follow only from its inputs moving):

- "Code Search Summary" points at `retrieval.json` instead of `code_search.md`.
- It lists at most the first ten ranked files. The old 12-line excerpt of the
  report held up to eleven; with the default `max_files` of 10 the output is the
  same. *(Superseded by §37.12: that cap dropped the eleventh file from the
  context; the summary now lists every ranked file.)*
- It no longer appends a "Warnings:" block. The same warnings are the last
  entries of Code Search Quality → Reasons in the same document, where they
  already appeared.

The Relevant Snippets excerpt, Top Related Files, Code Search Quality, the
quality score and the Extracted Keywords section are unchanged; §37.11 checks
this on a real run.

### 37.9 Checkpoint — extension migrated to `retrieval.json`

- `src/app/retrieval.ts` (new) is the one reader: `RETRIEVAL_ARTIFACT`,
  `parseRetrieval(text)` → `{ relatedFiles?, terms? }`. It accepts only
  `schema_version: 1`; a missing file, invalid JSON, a wrong version, or the old
  bare-array / version-less shapes are all "no retrieval".
- `controller.#readSummary` reads `retrieval.json` once, parses it once, and
  derives the Context Ready counts (`contextCounts`), Relevant Files
  (`relevantFiles`) and Retrieval Details (`retrievalTerms`) from that one value.
  The three functions no longer take strings or parse anything.
- `RELATED_FILES_ARTIFACT` / `SEARCH_QUALITY_ARTIFACT` deleted; the panel's
  overflow line reads "N more in retrieval.json"; the artifact group map lists
  `retrieval.json` in place of the four old names.
- Unchanged: Implementation / Supporting grouping, artifact order, the 10-row
  cap, matched keywords, click-to-open with `isSafeRelativePath` on the page and
  `isWithin` on the host, "N lines" / "1 line", Broad only from
  `classification == "broad"`, `derived_from`, zero-match shapes, no weights, no
  tuning UI. The context-existence check still uses `bug_context.md` (Batch 3).
- Tests: every fixture is one `retrieval.json`; new coverage for version-1-only
  parsing and for a directory that holds only the old files (nothing is read).

### 37.10 Checkpoint — Refine searches with the recorded hint

The Batch 1 finding (§37.5): `refine_investigation` without a new hint passed
its own options — hint `None` — to the search, while the task file it
regenerated carried the hint `issue.json` recorded. Retrieval and task
disagreed about the hint in force.

One precedence now serves every search, `workflow._effective_hint(*candidates)`:
the first non-blank, stripped, of

1. a hint supplied for this operation (`--hint`, or refine's new hint),
2. the request's own option — how an accepted improved hint arrives,
3. `issue.json.guidance.hint`,
4. none.

`run_investigation` passes (explicit `hint=`, `request.options.hint`, the
previous issue's hint on `--resume` only) — the Batch 1 behaviour, unchanged.
`refine_investigation` passes (`options.hint`, the recorded hint); a new hint is
still written to `issue.json` first, and the search runs with
`replace(options, hint=effective)`. Hint Improvement itself is untouched: an
accepted hint still arrives as the run's hint.

Tests (`tests/test_retrieval_artifact.py`): refine with no new hint searches
with the recorded one and records its `hint` terms; a new hint overrides it,
replaces the recorded one, and is kept by the next refinement; with no hint
anywhere the search gets none; refining the hint leaves the Fix Mode and the
task's mode line unchanged. Each first one would fail against the Batch 1 code.

### 37.11 Checkpoint — Batch 2 verification

New: `tests/test_retrieval_artifact.py` (26). Schema and exact keys; every kind
of term — user, hint, issue, identifier, confirmed shape with `derived_from`,
zero-match shape, broad term demoted from 2 to 1 with `match_count` = 300 lines,
retained/dropped status; search order; related-file rank, documentation
classification, noise flags and sorted matched keywords; snippets and the
`max_search_lines` budget; byte-identical serialization of a repeated search;
git history looked up for the top five in memory; the three refine-hint cases
and Fix Mode unchanged; a plan without code search writing no retrieval; resume
reading the persisted retrieval; round trips, atomic write, and every unusable
or old-shape file as an error rather than a fallback.

**Resume coherence.** Running `memory_search_step`, `git_context_step` and
`context_step` by hand after a pipeline run — each from `issue.json` and
`retrieval.json` alone — rebuilds a `bug_context.md` byte-identical to the
pipeline's.

Deleted: `test_code_search_markdown_contains_quality_section_headers` (its
only subject was the Markdown report). Everything else was migrated in place.

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1061 passed (Batch 1 end 1036: −1 deleted, +26 new) |
| `npm test` (extension) | 825 passed (823: +1 version-1-only parse, +1 old files not read) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean (new untracked files checked separately: no trailing whitespace) |
| `python tests/retrieval_corpus.py` | top-3 3/5, MRR 0.367, docs in top 5 9 |

Retrieval corpus (`tests/retrieval_corpus.py`, cases unchanged; the harness
adapted to `run_code_search` returning the artifact):

| | top-1 | top-3 | top-5 | top-10 | MRR | docs in top 5 | terms | duration |
|---|---|---|---|---|---|---|---|---|
| frozen pre-Batch-2 tree, before | 1/5 | 3/5 | 3/5 | 3/5 | 0.367 | 9 | 53 | 5.4 s |
| frozen pre-Batch-2 tree, after | 1/5 | 3/5 | 3/5 | 3/5 | 0.367 | 9 | 53 | 5.7 s |
| live tree, before | 1/5 | 3/5 | 3/5 | 3/5 | 0.367 | 9 | 53 | 5.0 s |
| live tree, after | 1/5 | 3/5 | 3/5 | 3/5 | 0.367 | 9 | 53 | 5.1 s |

On the frozen tree every case ranks identically, and a field-by-field
comparison (all eight related-file fields, terms, confidence, reasons, noise,
and Matched Lines re-rendered from `snippets`) shows no difference. On the live
tree one case, `prose-heavy-keyword-extraction`, reorders ranks 6-10 with its
expected file still at 3: this batch added text about keyword extraction to
`context.py`, `workflow.py` and `artifacts.ts`, and the corpus searches this
repository.

Real scratch runs (`sample-repo`, working tree via `python -m bugpilot`): a
manual `--prepare-only` with title, hint and `--fix-mode conservative`, and
`JR-12345 --allow-mock --keywords WidgetController`. Both directories hold

```text
issue.json  retrieval.json                                   canonical (Batches 1-2)
bug_context.md  agent_task.md  agent_handoff.md
agent_team_instructions.md  workflow_status.json  execution.log   Batch 3+
```

and none of the six issue-stage or four retrieval-stage files. Against a
pre-Batch-2 run of the same Jira-mock command, `retrieval.json` carries
identical related files, terms, confidence, reasons and noise indicators;
`bug_context.md` differs by one line (the pointer to `retrieval.json`); and
`agent_task.md` differs only in the file names the agent is told to read.

Also corrected: the shipped `README.md` still described `developer_hint.md`,
`fix_mode.json`, `jira_summary.md` / `jira_parsed.md` and the four search files;
those statements now name `issue.json` and `retrieval.json`. The rest of `docs/`
(usage guide, architecture, adapter design, the two HTML guides) still describe
the old layout and belong to a documentation pass; history files stay as written.

### 37.12 Batch 2 follow-up — the eleventh file, and generic examples

Two findings recorded in §37.8 and the Batch 2 review, checked on the tree
rather than assumed.

**A. More than ten relevant files.** The rule: a panel row limit is
presentation and must not become a context limit.

Measured with twelve matching files and `--max-files 11`, before any change:

| | count |
|---|---|
| `retrieval.json` related files (all with snippets) | 11 |
| Code Search Summary in `bug_context.md` | 10 |
| Top Related Files | 5 (pre-existing budget) |
| Relevant Snippets | 4 files (the pre-existing 25-line excerpt) |
| files named anywhere in `bug_context.md` | **10 — the eleventh was lost** |

A real, narrow regression (Case B). The summary is the only section that names
every ranked file, and Batch 2 capped it at ten (`_SUMMARY_FILES`, the default
and the panel's row count). Before Batch 2 a 12-line excerpt held up to eleven,
so files were lost only from `--max-files 12`; Batch 2 moved that to 11.

Fix (`context._code_search_summary`): list every related file. `--max-files`
already bounds the list at retrieval, so there is no second, silent cap.
`_SUMMARY_FILES` is deleted. After the fix: 11 in the summary, 11 named in the
context; with the default 10 the output is byte-for-byte what it was. Unchanged
on purpose: Top Related Files (5) and the 25-line snippet excerpt, which are
evidence budgets rather than file limits, and the panel's ten rows with its
"N more in retrieval.json" line.

Tests:

- `test_eleven_ranked_files_all_reach_the_agent_context` — twelve matching
  files, `--max-files 11`: `retrieval.json` has 11; the context step is handed
  all 11; the summary lists all 11 in rank order and every one is named in
  `bug_context.md`; the snippet excerpt is exactly the first 24 lines of the full
  matched-line rendering, so the files it leaves out are cut by the line budget,
  not by a file count. Against the old ten-file slice it fails.
- `test_the_summary_lists_every_ranked_file_however_many` — fifteen files, fifteen
  lines.
- Extension, `eleven files show ten rows and one more, and still count eleven`
  — the panel keeps its ten rows, `moreFiles` is 1, the count says 11.

**B. Company-specific examples.** Replaced with the generic vocabulary
(`WidgetController`, `src/widgets/…`):

The old values are not repeated here — the Batch 3 review pointed out that a
table spelling out the removed identifiers would put them back into the file
this commit publishes. They are the company product classes, platform paths and
prefixed identifiers the batch removed; the removal diff itself is their record.

| Where | Was | Now |
|---|---|---|
| canonical plan §4.2 retrieval example | a company class and its source path | `WidgetController`, `src/widgets/WidgetController.cpp` |
| canonical plan §8.1 Relevant Files | two company classes and a company platform path | `WidgetController.cpp`, `WidgetController.h`, `src/widgets/...` |
| canonical plan §8.2 Search details | a company class | `WidgetController` |
| canonical plan §9 Git history | a commit subject naming a company data type | "Update widget output handling" |
| `extension/test/controller.test.ts`, `page.test.ts` | a company platform path and its basename | `src/widgets/WidgetController.cpp` / `WidgetController.cpp` |
| `extension/test/contextSummary.test.ts` | two company platform paths, both separators | `src/widgets/WidgetController.cpp`, `src\widgets\WidgetController.h` |
| `bugpilot/core/search_terms.py` (shipped comment) | a company-prefixed example identifier | `` `WidgetFoo::bar` `` |
| `tests/test_hint_retrieval.py` | a company class | `WidgetController` |
| `tests/test_workflow.py` (three extraction tests) | company-prefixed identifiers and file names | `WidgetController::…`, `WidgetController`, `widget_txn.cxx`, `widget_controller.cxx` |

`VDS` (a public format name, already in the generic fixtures) and `JR-…` keys
(the project's generic prefix) stay. The tests keep every assertion; nested
paths, both separators, click-to-open and the overflow line are still covered.

Left on purpose, all present at HEAD and none introduced by Batches 1-2:
`keywords._GENERIC_PARTS` keeps `sample` — a documented, deliberate retrieval rule
this follow-up must not change — and `test_keywords_expand_compound_identifiers`
keeps the `SampleQt…` input that exercises it; history in this plan (§33,
`platform/sample` in the UI-B1 mockup) and `implementation_log.md`; the
old-project-name guard in `test_publishable.py`; the untouched
`test_search_budget.py` (`SampleFoo::bar`); and `scripts/setup-email.ps1`'s
`'bugpilot'` vault name, a pre-rename leftover worth a separate look.

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1063 passed (+2) |
| `npm test` | 826 passed (+1) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean |
| `python tests/retrieval_corpus.py` | top-1 1/5, top-3 3/5, top-5 3/5, top-10 3/5, MRR 0.367, docs in top 5 9 — rankings identical before and after, on the live tree and on a frozen copy |

### 37.13 Checkpoint — context/task inventory (Batch 3 start)

Pre-batch cleanup: the canonical plan's header lines 3-5 lost their Markdown
hard-break trailing spaces, so `git diff --check` stays clean once it is tracked.

Read from the Batch 2 working tree, and from real pre-Batch-3 scratch runs.

| Old artifact | Producer | Actual content | Readers | Kind | Destination / action |
|---|---|---|---|---|---|
| `bug_context.md` | `context_step` → `context.build_context` | The context document: Scope, Issue, Caution, Context Quality, then `jira_summary` and `jira_parsed` renderings pasted in whole (three `## Issue` headings, sub-documents flattened to `##`), a 60-line keyword JSON dump, Code Search Summary, Code Search Quality, Top Related Files (a copy of the summary's first five lines), Relevant Snippets, Similar Historical Issues, Git Context (with its own `## Status`) | agent (via `agent_task.md`), ext Context Ready existence + Open Context, MCP `_package` excerpt, `copilot_task_step` guard, `jira_comment_draft_step` guard, memory entry, manual validation, final review and retry prompts, `handoff.REQUIRED_READS`, skill, `cli` listings | persisted, user-facing, read by the agent | `context.md`, restructured (§37.14); remove |
| `git_context.md` | `git_context_step` → `git_ops.generate_git_context` | Markdown: branch, working-tree status, `git log -5` for the top five ranked files | `context.build_context` (read back from disk); deleted after the fold by `_remove_intermediate_files`; retry reading list | disk IPC; kept only when a plan disables `build_context` | kept in memory, rendered into `context.md`; stop writing |
| `memory_search.md` | `memory_search_step` → `memory.search_memory(write_report=True)` | Markdown: query keywords, up to five similar past bugs with scores | `context.build_context` (read back); deleted after the fold | disk IPC | kept in memory, rendered into `context.md`; stop writing |
| `agent_task.md` | `prompt_step` / `copilot_task_step` → `prompts.generate_prompts` / `generate_copilot_task_files` (two identical functions) | The task: hint, execution location, a pointer to the team-instructions file, branch, attachments, required inputs, AI Fix Mode, precedence, evidence rules, guardrails, required outputs, forbidden actions, delivery safety, Jira status, delivery offer or investigation handoff | the agent (CLI launch prompt `handoff.handoff_prompt`, MCP prompt, skill), ext `copyHandoff` gate, `#canRetry`, artifact grouping, `openAgentTask` command, `cli` JSON `agent_task` field, MCP `_package`, retry prompt | persisted, agent-facing | `task.md`; remove |
| `agent_handoff.md` | same generators | A 17-line pointer: read `agent_task.md` and the team-instructions file, plus reminders every one of which `agent_task.md` already states | **ext Fix with AI and Copy**: its *content* is the prompt put on the terminal command line (`controller.#handoffText`), falling back to `handoff_prompt()`'s sentence when absent | persisted, agent-facing | dropped; the handoff is the one-line sentence pointing at `task.md` (the CLI already used it) |
| `agent_team_instructions.md` | same generators, and `copilot_instructions_step` (`bugpilot agent-instructions`) | A copy of `docs/agent_team_instructions.md` (or the bundled `_fallback_team_instructions()` when the package has no `docs/`) | the agent, told by `agent_task.md` and `agent_handoff.md` to read it | persisted per work item, agent-facing, stable across work items | inlined into `task.md` as a section; stop writing; sources unchanged |

Resume: `run_investigation --resume` re-runs every step and overwrites all of
these, so nothing reads them back as state. What does read them back is each
standalone command: `bugpilot context` (read the two intermediates if present),
`bugpilot agent-task` (required `bug_context.md`), and `jira-comment-draft`.

**The Copy button.** The plan (§4.3, §11, §21) says Open Context and Copy use
`context.md`. The implementation's Copy — panel id `copy-context`, action
`copyHandoff`, tooltip "Copy the handoff prompt to the clipboard" — copied the
handoff *prompt*. Batch 3 makes the panel Copy copy `context.md`, as the plan
and this batch's instructions say; the handoff prompt stays reachable through
the "BugPilot: Copy Handoff Prompt" command and Fix with AI's no-agent path,
which puts it on the clipboard.

Baseline for this batch: Python 1063, extension 826, publishability 8; corpus
top-1 1/5, top-3 3/5, top-5 3/5, top-10 3/5, MRR 0.367, docs in top 5 9, on
the live tree and on a frozen copy.

### 37.14 Checkpoint — `context.md`

`context.build_context(issue, keywords, retrieval, git_history, similar_fixes)`
renders one document from four in-memory inputs; `context_step` writes it
atomically to `CONTEXT_ARTIFACT`. Nothing is read from an intermediate file.

```text
# Bug Context: <id>
## Scope
## Issue              id, source, summary, type, status, priority, mock  (+ ## Caution)
## Guidance           developer hint; AI Fix Mode name and id, from issue.json
## Context Quality    score and signals
## Issue Details      ### Description (both sources)
                      ### Jira Fields / Comments / Attachments   (Jira only)
                      ### Reproduction Steps … ### Missing Information Checklist
                      ### Reading Comments and Attachments       (Jira only)
## Code Search        ### Search Quality   ### Search Terms
                      ### Relevant Files   (every ranked file)   ### Relevant Snippets
## Similar Fixes
## Git History        (git's own ## headings demoted to ###)
```

Against the old `bug_context.md`, compared line by line on real runs:

- **Seams removed.** The pasted `jira_summary` and `jira_parsed` renderings
  became one `## Issue Details` with `###` subsections; the three `## Issue`
  and two `## Status` headings are gone. Single-value Jira fields (resolution,
  labels, components, versions, data source) are one bullet list.
- **Duplicates removed.** "Top Related Files" repeated the first five lines of
  the file list and is gone — the one file list keeps every ranked file
  (§37.12's invariant); the parsed section's "id — title" line repeated
  `## Issue`.
- **Dropped:** the extracted-keyword JSON dump. Its high-value, normal and phrase
  lists stay under Search Terms; what was searched is `retrieval.json.terms`; the
  rest was extractor state (§37.7).
- **Added:** `## Guidance` (the recorded hint and Fix Mode, which the context never
  showed; how the mode works stays in `task.md`), and the description of a
  hand-written bug, which previously reached the context only through the
  Jira-only summary and so never reached it at all.
- **Renamed** to the workflow's own words: Similar Historical Issues → Similar
  Fixes, Git Context → Git History. The Scope sentence no longer says "Phase 2".
- **Unchanged:** the quality score and its signals, the caution rules, the
  25-line snippet excerpt, the comment limit, the "Low confidence" agent
  instruction, and every issue field.

### 37.15 Checkpoint — git history and similar fixes stay in memory

`git_context_step` returns the Markdown `generate_git_context` produced;
`memory_search_step` returns the report `search_memory` produced (which no
longer takes `write_report` and writes nothing). `run_investigation` and
`refine_investigation` hand both to `context_step` (refine through its
`_RetrievalState`, now with `similar_fixes` / `git_history`). `git_context.md`
and `memory_search.md` are never written, so `_INTERMEDIATE_FILES`,
`_remove_intermediate_files` and `_context_and_fold` are deleted.

No structure was invented: both stay the text they were, bounded as before
(five files' `git log -5`, at most five similar bugs). A plan that disables
`build_context` still runs the two steps but has nowhere to put their text —
the files it used to leave were exactly the disk IPC this removes. Standalone,
`bugpilot git-context` and `bugpilot memory search <id>` print their result, and
`bugpilot context` gathers both before writing `context.md`, so a context
rebuilt on its own is as complete as the pipeline's.

### 37.16 Checkpoint — `task.md`

`prompts.generate_task(...)` returns the task; `prompt_step` and
`copilot_task_step` write it atomically to `TASK_ARTIFACT`. The two generators
that produced the same three files (`generate_prompts`,
`generate_copilot_task_files`) and `_copilot_handoff` are deleted.

What the agent receives, before and after:

| | Before | After |
|---|---|---|
| launch prompt (CLI) | "Read .ai/<id>/agent_task.md and complete the workflow." | "Read .ai/<id>/task.md and complete the workflow." |
| launch prompt (extension) | the whole of `agent_handoff.md`, flattened | the same one sentence as the CLI |
| task | `agent_task.md`, which said to read two more files | `task.md` |
| team instructions | `agent_team_instructions.md`, a per-work-item copy | a section of `task.md`, rendered from the same source |
| context | `bug_context.md` | `context.md` |

`task.md` is `agent_task.md` with three changes: the title is "BugPilot Task";
the Team Instructions section carries the effective instructions inline
(`docs/agent_team_instructions.md`, else the bundled fallback — sources
unchanged, headings demoted, the precedence bullets kept); and every reference
names `context.md`, whose sections it now points at ("Issue Details"). A
line-by-line comparison on a Standard Fix Jira run and an Investigate First
manual run finds every old line in `task.md` except the file pointers, and
every reminder `agent_handoff.md` carried — run from the repo root, not from
the tool repo, not on main, the mode, no commit without approval, the Jira and
`.ai/` rules, the result files — already stated in the task's Execution
Location, AI Fix Mode, guardrails, Forbidden Actions, Required Output Files and
Investigation Handoff sections. So `agent_handoff.md` is dropped rather than
merged: it had nothing the task lacked. Pattern B of the batch brief: the task
references `context.md` rather than inlining it, which is the contract the agent
already followed.

`handoff.REQUIRED_READS` is (`task.md`, `context.md`); the MCP prompt, the MCP
package's next step and instructions, and the skill's steps all render from it.
`bugpilot agent-instructions` prints the team instructions instead of writing a
per-work-item copy.

### 37.17 Checkpoint — legacy context/task writers and readers removed

Writers. Normal execution writes none of the six files:

| Old file | Writer before | Now |
|---|---|---|
| `bug_context.md` | `context_step` | `context_step` writes `context.md` only |
| `git_context.md` | `git_context_step` | returns the Markdown; writes nothing |
| `memory_search.md` | `search_memory(write_report=True)` | `write_report` removed; returns the report |
| `agent_task.md`, `agent_handoff.md`, `agent_team_instructions.md` | `generate_prompts` / `generate_copilot_task_files` (both deleted), `copilot_instructions_step` | `generate_task` → `task.md`; `copilot_instructions_step` returns the text |

Readers, each moved to the canonical file with no fallback: the `agent-task`
guard, the `jira-comment-draft` guard (`context.md` or `issue.json`), the
memory entry's context path, the manual-validation, final-review and retry
prompts (the retry reading list lost `git_context.md`), the MCP package
(`agent_task` → `task.md`, excerpt from `context.md`, next step), the CLI's
`--json` `agent_task` path, launch fallback and key-artifact list,
`handoff.REQUIRED_READS`, the skill, and the extension (§37.18).

A work item directory holding only `bug_context.md` / `agent_task.md` /
`agent_handoff.md` is not a package: `bugpilot agent-task` exits 1 with
"Missing .ai/<id>/context.md", `jira-comment-draft` refuses ("No core context
found"), the MCP package reports no task and no excerpt, and the extension
shows no Context Ready, no Open/Copy, and skips Fix with AI.

Kept on purpose:

- The field name `agent_task` in `bugpilot … --json` and the MCP package, and
  the command id `bugpilot.openAgentTask`. They are protocol names a client
  matches on; their values now point at `task.md` (the command's title is
  "Open task.md"). Renaming them is a contract change, not an artifact one.
- `docs/agent_team_instructions.md`: the source template the Team Instructions
  section is rendered from, not a work-item artifact.
- `controller.copyHandoff()`: the "Copy Handoff Prompt" command, which copies
  the one-line sentence.

Final repository search for the six names, `generate_prompts`,
`generate_copilot_task_files`, `write_report` and the `copyHandoff` action:
no production reader or writer. Remaining hits are tests asserting absence or
rejection, the source template above, the canonical plan's migration tables,
history (this plan, `implementation_log.md`, `docs/phases/`), and the unshipped
`docs/` guides (§37.20).

### 37.18 Checkpoint — extension

`artifacts.ts` exports `CONTEXT_ARTIFACT` / `TASK_ARTIFACT`; every reader uses
them.

| Surface | Before | After |
|---|---|---|
| Context Ready | `bug_context.md` exists | `context.md` exists |
| Open Context | opens `bug_context.md` | opens `context.md` |
| Copy (panel) | action `copyHandoff`: copied the handoff prompt | action `copyContext`: copies the content of `context.md`; a missing file is a warning, not an empty clipboard |
| Fix with AI | needed `agent_task.md`; sent the content of `agent_handoff.md`, else the fallback sentence | needs `task.md`; sends "Read .ai/<id>/task.md and complete the workflow." — no file read |
| Fix with AI, no `task.md` | — | step `skipped` ("No task.md was prepared…"), a warning, no terminal |
| custom agent | `agent_handoff.md` content in its prompt slot | the same sentence |
| artifact groups, results expectation, retry gate | old names | `task.md`, `context.md` |
| "Open Agent Task" command | `agent_task.md` | "Open task.md" |

The panel's element id `copy-context` did not change; only the protocol action
did, so `PANEL_ACTIONS` still lists exactly one Copy. The cross-language test
now resolves `{TASK_ARTIFACT}` from `artifacts.py` before comparing the
extension's sentence with `handoff_prompt`.

Tests: new — no `task.md` means skipped and no terminal; a directory with only
the old files has no Context Ready, no Open/Copy and no launch; Copy copies
`context.md`; Copy with the file missing warns. Rewritten — the handoff sentence
ignores an `agent_handoff.md` on disk; Fix with AI and the custom agent receive
the sentence. Deleted — "a multi-line handoff still reaches the agent as one
argument": the prompt is now one fixed sentence, and flattening stays covered
by `workflow.test.ts` ("a multi-line prompt becomes one line before it reaches
a shell").

### 37.19 Checkpoint — resume and standalone commands

`--resume` re-runs the pipeline from `issue.json` and regenerates `context.md`
and `task.md`, with git history and similar fixes recomputed in memory; the
recorded hint and Fix Mode reach both. Refinement carries them through
`_RetrievalState`.

| Command | Behaviour |
|---|---|
| `bugpilot context <id>` | gathers similar fixes, git history and the recorded user search terms, writes `context.md`; `--json` lists only it |
| `bugpilot git-context <id>` | prints the git history; writes nothing |
| `bugpilot memory search <id>` | prints the similar-fixes report; writes nothing |
| `bugpilot prompt <id>` | writes `task.md` |
| `bugpilot agent-task <id>` | requires `context.md`; rewrites `task.md` |
| `bugpilot agent-instructions <id>` | prints the team instructions `task.md` includes |

A standalone `agent-task` after a pipeline run reproduces the pipeline's
`task.md` byte for byte.

### 37.20 Checkpoint — Batch 3 verification

New: `tests/test_context_task_artifacts.py` (21). Exactly six files after a
manual and a Jira prepare, and after a resume; `context.md` sections and data
(guidance, issue, description, Jira fields and comments, every ranked file,
snippets); git history rendered from a real git repository with no
`git_context.md`, and the no-repository message; similar fixes from a seeded
`.ai_memory` with no `memory_search.md`, and the empty case; `task.md` carrying
hint, Fix Mode, team instructions, the `context.md` reference, required outputs,
forbidden actions and the handoff, with no old name; the context not repeating
the task; the standalone commands above; the old layout rejected by
`agent-task`, `jira-comment-draft` and the MCP package; a standalone rebuild
byte-identical to the pipeline's, `--keywords` included; a multi-line hint
kept to one Guidance bullet. The eleven-file tests
of §37.12 run against `context.md` (Relevant Files / `####` snippet headings).

Deleted: the "both generators agree" test (one generator remains) and the
"agent-instructions creates a missing directory" test (it writes nothing now).

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1082 passed (baseline 1063: −2 deleted, +21 new) |
| `npm test` (extension) | 829 passed (826: +4 new, −1 deleted) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 8 passed |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean; untracked files (the canonical plan included) have no trailing whitespace |
| `python tests/retrieval_corpus.py` | top-1 1/5, top-3 3/5, top-5 3/5, top-10 3/5, MRR 0.367, docs in top 5 9 |

Retrieval corpus, cases and harness unchanged by this batch: on the frozen
pre-Batch-3 tree every case ranks identically; on the live tree the metrics are
identical and the expected files keep their ranks, while three cases reorder
non-expected files among ranks 3-10 (`cli.py`, `context.py`, `models.py`),
whose text this batch changed.

Real scratch runs (`sample-repo`, working tree via `python -m bugpilot`): a
manual `--prepare-only` with title, hint and `--fix-mode investigate-first`, and
`JR-12345 --prepare-only --allow-mock --keywords WidgetController --hint …`.
Both directories hold exactly `issue.json retrieval.json context.md task.md
workflow_status.json execution.log`. Compared line by line with pre-Batch-3
runs of the same commands, the only old lines missing are the ones §37.14 and
§37.16 list (work-item ids aside); the Jira context's score rose from 90 to
100 only because the scratch repository's `.ai_memory` now holds entries from
the other runs. Twelve matching files with `--max-files 12` and 10: every
ranked file is named in `context.md`, identical to the pre-Batch-3 code on the
frozen tree (four files in the 25-line snippet excerpt in both).

A first pair of scratch runs omitted `--prepare-only`, so the CLI's default
launched the configured agent in `sample-repo`. From the one-line prompt
alone, it read `task.md` and `context.md` and wrote the five result files — a
documented no-op for the mock Jira issue and an investigation for the manual
one — with no source change, branch or commit. Those runs are not the
verification above; the `--prepare-only` runs are.

Docs: `README.md` and the shipped `extension/README.md` name `context.md` and
`task.md`. The rest of `docs/` (usage guide, architecture, adapter design,
safety, workflow overview, demo script, checklists, the HTML guides), which the
sdist prunes, still describes the old layout, as §37.11 recorded for Batches
1-2; it belongs to a documentation pass.

**Independent review.** A whole-diff review found no blocker and two things
worth fixing, both fixed:

- *A rebuilt context forgot the developer's `--keywords`.* Batch 2 had decided
  a standalone step recomputes keywords from `issue.json` alone ("options
  belong to the run"), which held for re-searching but not for re-rendering: a
  `bugpilot context` rebuild showed Search Terms and a quality score that
  disagreed with the `source: "user"` terms `retrieval.json` records — and with
  the Relevant Files list rendered from that same file. `work_item_keywords`
  and `context_step` now replay the recorded user terms through the same merge
  the pipeline used (`_user_terms`), so a rebuilt `context.md` is byte-identical
  to the pipeline's. A fresh `bugpilot search` still takes its own options,
  which replace the recording rather than replay it. Test:
  `test_a_standalone_rebuild_reproduces_the_pipelines_context`.
- *The §37.12 table spelled out the removed company identifiers*, which would
  have put them back into this file at commit time; the "Was" column now
  describes them generically.

Also from the review: a multi-line hint (the extension's hint field is a
textarea) is collapsed to one line in the context's Guidance bullet — the full
text stays in `task.md` — with a test; four stale statements corrected (the
`artifacts.py` header still claimed `retrieval.json` holds git history and
similar fixes; a corpus-test docstring still said only the top five files reach
the context; a doubled JSDoc line and two phase-5-era file counts in the
extension). Noted, deliberately not done in this batch: the work-item id is not
pattern-checked before it is quoted into the agent command line (pre-existing,
needs a trusted workspace; worth a follow-up together with `historyFromPayload`);
"Copy Handoff Prompt" still copies the sentence when no `task.md` exists (kept:
it copies a sentence, not a file, and parity with the old fallback behaviour);
the heading-demotion helper exists in both `prompts.py` and `context.py`
(accepted duplication, five lines); the `agent_task` JSON field name (kept per
§37.17 — renaming it before 0.1.0 ships is possible but is a contract decision).

### 37.21 Checkpoint — runtime artifact inventory (Batch 4 start)

Read from the Batch 3 working tree; every producer and reader listed from a
repo-wide search, not from memory.

| | `workflow_status.json` | `execution.log` |
|---|---|---|
| Producer | `workflow._write_status`, called by `_mark_step` on **every** step transition (read-modify-write), by `run_investigation`'s final and exception paths, and by every standalone step command | `logging_utils.log(issue_dir, message)`: ~150 call sites appending timestamped `[START]/[END]/[ERROR]/[WARN]/[INFO]/[GENERATED]/[SKIP]` lines |
| Write timing | incremental during the run; final snapshot at the end | append-only during the run |
| Schema | `issue_key`, `mode: "prepare-only"` (constant), `steps` (all 24 `WORKFLOW_STEPS` → pass/fail/skipped), `generated_files` (directory listing + attachments + memory entry), `fresh`, `allow_mock`, `fix_mode` (additive) | timestamped free text |
| Readers | CLI `status` / `status --json` (`mode`, `steps`, `generated_files`, `fix_mode`), CLI `list` (existence → `prepared`), MCP `get_status` (`steps`, `generated_files`, `fix_mode`), extension `ports.probeWorkItem` → `historyOutcome` (existence + `steps`), `viewFromStatus` (`steps`, `generated_files`), `preparedFixModeFromStatus` (`fix_mode`), `controller.#readStatus` (`fix_mode` line), `workflow._read_step_status` (its own read-modify-write) | **none**. `cli._print_log_hint` prints its path on failure; `extension/src/errors.ts` names it in one advice string. Nothing parses it |
| Resume dependency | none — resume re-runs every step from `issue.json`; `_read_step_status` only merges marks within a run | none |
| Field readers | `steps`, `generated_files`, `fix_mode` have real consumers. `issue_key` and `mode` are echoed by the human `status` printer only; `fresh` and `allow_mock` are read by nothing (mock provenance already lives in `issue.json.details.mock` and `context.md`) | — |
| Classification | canonical runtime state (steps, generated files, fix mode) plus dead fields | C/D: developer trace duplicating the steps map (`[START]/[END]`), `generated_files` (`[GENERATED]`), CLI prints (`[WARN]`) and the exception the CLI already reports (`[ERROR]`). No A/B content beyond the failing step + error message, which the status file never carried |

Decisions:

- `run.json` (the `RUN_ARTIFACT` constant has existed in `artifacts.py` since
  Batch 1) carries: `schema_version`, `work_item_id`, one authoritative
  `status` (`running` / `prepared` / `failed` — the product's own vocabulary:
  `bugpilot list` and the extension's history already say "prepared"),
  `steps` (same 24 names, same pass/fail/skipped marks — the extension's
  checklist and outcome logic key on them), `generated_files` (same consumers),
  `fix_mode` (same shape), and on a run-level failure an `error`
  (`step`, `message` — the sanitized string the CLI already prints; the one
  A/B item `execution.log` held that no artifact kept).
- Dropped fields: `mode` (a constant), `fresh` and `allow_mock` (no readers;
  mock provenance is `issue.json`'s), `issue_key` renamed `work_item_id`.
- `execution.log` is deleted as an artifact. `log()` keeps its 150 call sites
  and signature but emits through stdlib `logging` (`bugpilot.execution`),
  so nothing is persisted per work item; the trace is opt-in, on that logger.
- `status` is owned by run-level entry points (`run_investigation`, refine):
  initial write `running`, terminal `prepared` / `failed`. Standalone step
  commands update `steps`/`generated_files` in the existing file and leave
  `status` alone, as their step marks did before.

### 37.22 Checkpoint — `run.json`: one typed model

`bugpilot/core/run.py`: `RunArtifact` (`work_item_id`, `status`, `steps`,
`generated_files`, `fix_mode`, `error: RunError | None`), `run_to_dict` /
`run_from_dict` (version 1 only; unknown statuses and non-map steps are
errors), `save_run` (atomic, via `artifact_io`), `load_run` (None when absent,
`RunArtifactError` when unusable), `read_run_quietly`. Serialization always
writes the full `WORKFLOW_STEPS` map — the shape every consumer already reads —
and leaves `fix_mode` / `error` out rather than null when absent.

The actual schema, from a real prepare:

```json
{
  "schema_version": 1,
  "work_item_id": "JR-12345",
  "status": "prepared",
  "steps": {"doctor": "pass", "fetch": "pass", "…": "…", "agent_fix": "skipped"},
  "generated_files": [".ai/JR-12345/context.md", "…", ".ai/JR-12345/run.json"],
  "fix_mode": {"id": "standard", "name": "Standard Fix", "version": 1, "source": "builtin", "execution_kind": "fix"}
}
```

Differences from the plan's conceptual sketch, all §37.21 decisions: the real
step names instead of UI labels; no `agent` block (nothing persists agent
state today); `generated_files` and `fix_mode` kept (they have three consumers
each); `work_item_id` added; `error` on failure. `run.json` lists itself in
`generated_files` because that list is a directory snapshot, and the file
exists from the run's first write.

### 37.23 Checkpoint — `workflow_status.json` migrated

`_write_status` / `_read_step_status` / `_normalize_status` are gone. In their
place: `_save_run` (recomputes the generated-files and Fix Mode snapshots on
every write, saves atomically), `_start_run` (the run's first write: status
`running`, the plan's disabled steps marked — one write instead of one per
skipped step), `_mark_step` (read-modify-write through the typed model),
`_set_run_status` (refine's `running` → `prepared`), `_finish_run` (the
terminal success write) and `_fail_run` (status `failed` + `error`, reading
quietly because it runs inside an exception handler). `run_investigation` and
`refine_investigation` own the lifecycle; standalone steps update marks only.

### 37.24 Checkpoint — `execution.log` removed

Nothing read it (§37.21), so nothing replaces it. `logging_utils.log` keeps
its signature and ~150 call sites but emits through stdlib logging
(`bugpilot.execution`), INFO, **non-propagating** (NullHandler): the trace is
opt-in on that logger, and a host's root handler never receives it. That last
property is load-bearing — the MCP SDK installs a rich root handler writing to
stderr, and while the trace propagated, a prepare over stdio deadlocked the
server against any client that does not drain stderr (`test_mcp_stdio` caught
it on the full run). The lifecycle trace stays observable — the tests attach a
handler to the logger (`execution_trace` fixture) — without a per-work-item
file. The one
useful fact it held on failure — which step, and why — is `run.json.error`,
asserted in `test_run_artifact.py`. The CLI's "See execution.log for details"
hint became "Run: bugpilot status <id> for step status", printed when run
state exists; the extension's INTERNAL_ERROR advice points at the BugPilot
output channel, which already records CLI stderr.

### 37.25 Checkpoint — resume, CLI, MCP, extension migrated

- Resume/refine: `--resume` starts with `_start_run` (a fresh `running` state)
  and re-runs the plan from `issue.json`; refine transitions the existing
  state. A corrupt `run.json` is an error to `_mark_step` and every reader; a
  fresh or resumed run replaces it at `_start_run`, which is the sanctioned
  recovery (a run owns its file).
- CLI: `status` / `status --json` read `load_run` — the JSON gained `status`
  and `error` and lost the constant `mode`; the human form prints Work item /
  Status / the failure line / Steps / Generated files. `list`'s `prepared`
  flag keys on `run.json` existence. The `bug` command's "Generated:" list
  prints `CORE_ARTIFACTS`, run.json included.
- MCP `get_status`: same shape as the CLI's JSON (steps, generated_files,
  fix_mode, plus `status` and `error`), through the same loader.
- Extension: `RUN_ARTIFACT` exported beside the other artifact constants;
  `probeWorkItem`, `historyOutcome`'s existence check, `#readStatus` and the
  restore comments read `run.json`. `viewFromStatus` and
  `preparedFixModeFromStatus` were already reading `steps` /
  `generated_files` / `fix_mode`, which kept their names, so they did not
  change. The `workflow_status.json` / `execution.log` group entries stay as
  phase-era labels for directories prepared before Batch 4, like the copilot
  ones — grouping metadata, not readers.

### 37.26 Checkpoint — the five-artifact prepare contract

A successful prepare-only run leaves exactly

```text
issue.json  retrieval.json  context.md  task.md  run.json
```

pinned by `test_a_manual_prepare_writes_exactly_the_canonical_files` /
`…jira…` (set equality plus an explicit count of five), with
`workflow_status.json` and `execution.log` added to the legacy-absence list
and to the generated-files check. `tests/test_run_artifact.py` (19) holds the
schema and exact key set (which is also the no-raw-log guard: no `logs`, no
events, `error` bounded to `step` + `message`), the mid-run `running` state,
the standalone-step semantics, the failure record and its clearing by the next
successful run, round trips, and every unusable file as an error — including
the old `workflow_status.json` layout placed at `run.json`'s path, and a
directory holding only the old files ("No run state found").

### 37.27 Checkpoint — Batch 4 verification and review

New: `tests/test_run_artifact.py` (22). The exact top-level key set of a
prepared run (which doubles as the no-raw-log guard), the full steps map, the
generated-files snapshot, the mid-run `running` state observed from inside a
run, standalone steps leaving the lifecycle alone, the failure record
(step + bounded message, no other keys), a later successful run clearing it,
a refine failure naming its own step, round trips, missing → `None`, and every
unusable file — corrupt, wrong type, schema_version 2, unknown status, and the
old `workflow_status.json` layout at `run.json`'s path — as
`RunArtifactError`, surfaced cleanly by `bugpilot status`, by standalone
steps, and by human-mode commands. Migrated rather than weakened: the
lifecycle-trace test now pins the `bugpilot.execution` logging output and the
absence of `execution.log`; the atomic-write spy watches `run.json`.

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1104 passed (Batch 3 baseline 1082: +22 new) |
| `npm test` (extension) | 832 passed (829: +1 old-layout, +2 lifecycle-outcome) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 8 passed |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean; untracked files have no trailing whitespace |
| `python tests/retrieval_corpus.py` | see below |

Retrieval, cases and harness untouched: on the frozen pre-Batch-3 tree all six
cases rank **byte-identically** before and after Batch 4, which is the
equivalence proof — no retrieval module changed. On the live tree the corpus
measures this repository, and this batch edited the subject files of one
self-referential case: `identifier-persist-fix-mode`'s expected
`workflow.py` moved from rank 2 to 7 (its status-machinery text shrank, the
plan gained Fix Mode prose, and shared terms crossing the broad-match
threshold repo-wide deflate every heavy matcher at once), taking the headline
from top-3 3/5 / MRR 0.367 / docs 9 to top-3 2/5 / MRR 0.295 / docs 10. Both
expected files stay in the top 10 (top-10 3/5 unchanged) and
`test_documentation_no_longer_takes_half_the_context` still holds (10 ≤ 12).

The same full run also proved the unwired-symbol guard honest in the way it
was designed to be: `CORE_ARTIFACTS`, allowlisted since Batch 1 with "delete
this line then", gained its first production caller (the CLI's `Generated:`
list) and its entry is gone.

That drift broke `test_an_identifier_bug_retrieves_its_implementation`, whose
top-3 hedge existed for exactly this noise and ran out. The floor it guards —
a bug naming real symbols finds the defining file and its caller in the top
three — is now asserted on a purpose-built fixture tree (defining file,
caller, a prose decoy naming the symbol, an unrelated implementation), so it
fails only when retrieval changes, never when this repository's prose does.
The live corpus keeps being measured, without hard-failing on drift, by the
parametrized reporting test and the standalone runner.

Real scratch runs (`sample-repo`, `python -m bugpilot`, `--prepare-only`):
the manual and the `JR-12345 --allow-mock` packages hold exactly the five
canonical artifacts; `run.json` carries `status: "prepared"`, the full steps
map, the five artifacts plus the memory entry in `generated_files`, and the
recorded Fix Mode. A controlled failure (Jira pointed at a closed local port,
`--no-mock`) leaves valid JSON with `status: "failed"`,
`error: {step: "fetch", message: <the catalog sentence>}`, partial marks, and
no token — the credentials passed in the environment appear nowhere.

**Found by the full run, fixed before it could ship:** the first complete
suite runs after the migration hung in `test_mcp_stdio`'s real-tool-call test.
Root cause: the SDK's `MCPServer()` installs a rich root logging handler that
writes to stderr; once `log()` emitted through stdlib logging, a prepare
inside the stdio server streamed the whole trace into a stderr pipe the client
never drains, the pipe filled, and the server deadlocked mid-call — a
production deadlock for any MCP client that leaves stderr undrained, not a
test artifact. `bugpilot.execution` is now non-propagating with a
`NullHandler`: the trace is opt-in on that logger, no host root handler ever
receives it, and the trace tests capture through an `execution_trace` fixture
that attaches to the logger directly. `test_mcp_stdio` passes in seconds
again, and the isolation repro (initialize over a held-open pipe) confirmed
the server itself was never at fault.

**Independent review** (whole diff, Batches 1–4): no blocker. Fixed from it:

- `docs/architecture.md` presented itself as the current code guide while
  describing the pre-consolidation artifacts; it now opens with a status note
  naming the five-artifact contract and marking those sections historical
  until the documentation pass (which still owns the rest of `docs/`, as
  §37.11 and §37.20 recorded).
- A refine failure could blame a stale fail mark from an earlier run
  (`_fail_run` scanned the preserved marks); refine now names its executing
  step.
- `historyOutcome` ignored the new authoritative `status`: a run failed
  outside any step showed "prepared", and a `running` one had an outcome. It
  now reads `status` first (`failed` → failed, `running` → incomplete) and
  falls back to the mark scan otherwise.
- A corrupt `run.json` escaped human-mode standalone commands as a chained
  traceback; the CLI now prints the error and the recovery command.
- The persisted failure message is capped (2000 chars, `_cap_text`), and
  `RunArtifactError` maps to `ARTIFACT_NOT_FOUND` in the machine envelopes
  rather than falling through to `INVALID_INPUT` as a `ValueError`.

Noted, deliberately unchanged: `bugpilot list`'s `prepared` flag keys on
`run.json` existence (documented in §37.25; reading `status` there is a UX
decision for later); `IssueArtifactError` / `RetrievalArtifactError` still
classify as `INVALID_INPUT` in the envelopes (pre-existing, Batches 1–2);
the shell-quoting hardening and the `agent_task` field rename stay in the
backlog per the batch brief.

### 37.28 Checkpoint — post-fix artifact inventory (Batch 5 start)

Read from the committed Batch 4 tree (`7fde6aa`); every producer and reader
from a repo-wide search. The one structural fact the design hangs on: the five
result files are **agent-owned** — the coding agent writes them per `task.md`'s
contract — and everything else BugPilot writes after them is a *derivation* of
those five plus git state.

| Artifact | Producer | Contents | Readers | Category | Decision |
|---|---|---|---|---|---|
| `bug_analysis.md` | the agent (task contract); `manual-result` template | root cause, evidence | `result_summary` builder, Jira draft (Root Cause), retry's previous-attempt summary, `check_result_files` | A | → `fix_report.md` `## Analysis` |
| `fix_summary.md` | agent | the fix (or proposed plan) | `result_summary`, Jira draft (Changes), extension history "fixed" marker | A | → `## Changes` |
| `diff_summary.md` | agent | changed files / diff summary | `result_summary`, email, retry reading list | A | → `## Changes` (merged with the fix summary — two files carried one story) |
| `test_result.md` | agent | commands run, outcomes, or not-run + reason | `result_summary`, validation pointer, retry reading list | A | → `## Tests` |
| `review_notes.md` | agent | risks, open questions, next step; mode-conflict record | `result_summary`, validation risks, retry reading list | A | → `## Review Notes` |
| `result_summary.md` | `summarize_results_step` | a concatenation of the five + presence lines | email draft, `memory_update`'s Final Result, commit-plan's summary line, delivery-check presence | A (redundant aggregate) | **removed** — once the report is one file, the aggregate of five is the file itself; readers parse `fix_report.md` |
| `manual_validation.md` | `summarize_results_step` | a validation checklist derived from retrieval + review notes | nobody in code; the developer | B (generated helper) | file **removed**; the checklist renders in memory (`summarize-results` prints it, MCP returns it) |
| `final_review_prompt.md` | `review_package_step` | reviewer prompt, a pure function | nobody in code; the developer pastes it | B (disk IPC) | file **removed**; `review-package` prints (the `agent-instructions`/`git-context` precedent) |
| `commit_plan.md` / `push_plan.md` | plan steps | branch/status/diff stat, suggested message, safety checklist, manual commands | nobody in code; the developer | B | files **removed**; the commands print the same plan, safety text intact — approval stays manual and explicit |
| `agent_retry_prompt.md` | `retry_prompt_step` | the second-attempt task | **an external agent process, by path** — the extension's Retry handoff and the CLI's printed instruction | C | **kept**: it is `task.md`'s retry counterpart, not IPC — another process reads the file; content migrates to the report contract |
| `user_feedback.md` | template once, then the developer | user-authored corrections | retry prompt builder | C/D (user data) | **kept** — never silently discard user-authored text |
| `jira_comment_draft.md` | draft step | the proposed comment | `jira-comment --execute` reads it back; the developer reviews/edits | C (approval artifact) | **kept**; sources → `fix_report.md` sections |
| `jira_comment_post_result.json` | execute step | POST audit: comment id, timestamp | nobody; audit | C (action record) | **kept** — proof an external action happened |
| `jira_comment_post_summary.md` | execute step | prose duplicate of the JSON | nobody | C (duplicate) | **removed**; the CLI prints the outcome, the JSON is the record |
| `email_draft.md` / `notification.eml` | `notify` | preview + the sendable message | the developer / the mailer | C (delivery artifacts) | **kept**; body sources → `fix_report.md` |
| `memory_entry.md` | nobody since the memory moved to `.ai_memory/` (a phase-era extension group label remains) | — | — | D | no work-item file exists; unchanged |
| `jira_field_report.md` | `jira-validate` | field-mapping diagnostic | the developer; named in delivery safety as never-stage | D (diagnostic) | unchanged, outside the core contract |
| `attachments/` | `copy_attachments` | the developer's source material | the agent, via `task.md` | D | unchanged — source material, not report content |

Step marks (`result_summary`, `manual_validation`, `final_review_prompt`,
`commit_plan`, `push_plan`, …) are preserved in `run.json` (§26): the commands
still run and mark; only what they persist changes.

### 37.29 Checkpoint — `fix_report.md`: contract and ownership

One post-agent report, human-readable, with a fixed section contract:

```text
# Fix Report: <id>
## Summary        one honest line — fixed / attempted / no-op / investigation only — then a short paragraph
## Analysis       the root cause and the evidence (hypotheses + evidence when investigating)
## Changes        what changed, files touched, bounded diff summary — or the proposed plan and "no source change applied"
## Tests          commands run and outcomes, or "not run" and why; never a pass that did not happen
## Review Notes   risks, open questions, remaining concerns, recommended next step
```

**Ownership: model A.** The coding agent writes and updates the report per
`task.md`'s Required Output contract; BugPilot never rewrites it. BugPilot's
one writer is the `manual-result` template (a developer who fixed by hand),
which preserves an existing report unless `--overwrite`. Everything BugPilot
needs from it, it reads through the typed `core/fix_report.py`
(`FixReport`, `read_fix_report`, tolerant section parsing: a missing heading is
an empty section rendered "not available", never an error). The name means
"post-agent workflow report", not "confirmed fix" (§37.28's investigate rule);
`run.json` stays the machine state and duplicates none of it.

### 37.30 Checkpoint — canonical fix result consolidation

Merged into the report, with the duplication removed rather than concatenated:

| Old | Where it went |
|---|---|
| `bug_analysis.md` | `## Analysis` |
| `fix_summary.md` + `diff_summary.md` | `## Changes` — the two files told one story (what changed / which files), and the old aggregate quoted both |
| `test_result.md` | `## Tests` |
| `review_notes.md` | `## Review Notes` |
| `result_summary.md` | gone: it was the five concatenated with presence lines. Its readers parse the report instead — the email draft, the memory entry's Final Result (same `### Root Cause/Fix/Tests/Review Notes` shape, fed from the report's sections), the commit plan's suggested-message line, delivery-check |
| `manual_validation.md` | gone as a file: the checklist renders in memory (`_build_manual_validation`, from the report's Review Notes + `retrieval.json`'s top files) and reaches the developer through `summarize-results`' printed Result Overview and the MCP tool |

`check_result_files` / `REQUIRED_COPILOT_RESULT_FILES` is now the one name
(`FIX_REPORT_ARTIFACT`); the CLI's `check-results` shapes are unchanged
(`missing` list, strict exit).

### 37.31 Checkpoint — temporary prompts and plans stop being files

- `final_review_prompt.md`: a pure function nothing read back; `review-package`
  **prints** it (the `agent-instructions` / `git-context` precedent), now
  pointing at `fix_report.md`.
- `commit_plan.md` / `push_plan.md`: nothing read them; the commands **print**
  the same plans — branch/status/diff stat, suggested message, safety notes,
  the manual commands — so committing and pushing stay the developer's own
  explicit actions. The commit-gate email hook is untouched.
- `jira_comment_post_summary.md`: a prose duplicate of the JSON audit record;
  gone. `jira_comment_post_result.json` remains the proof of the POST.
- `agent_retry_prompt.md` is **kept deliberately**: it is not disk IPC but the
  retry counterpart of `task.md` — an external agent process reads it by path
  (the extension's Retry handoff, the CLI's printed instruction). Its content
  migrated: Required Reading is `context.md`, `retrieval.json`,
  `fix_report.md`, `user_feedback.md` + the current diff; the previous-attempt
  summary is a bounded excerpt of the report; Required Output is "update
  `fix_report.md`, every section, for this attempt".

### 37.32 Checkpoint — delivery and side-band decisions

Kept, each with its own responsibility: `user_feedback.md` (user-authored;
never silently discarded), `jira_comment_draft.md` (the approval artifact
`jira-comment --execute` reads back; its Root Cause / Summary of Changes now
come from the report's Analysis / Changes), `jira_comment_post_result.json`
(action audit), `email_draft.md` + `notification.eml` (delivery preview and the
sendable message; the body's Root Cause / Changes Made / Tests now come from
the report, and the separate diff heading folded into Changes),
`jira_field_report.md` (a `jira-validate` diagnostic, outside the core
contract), `attachments/` (source material, untouched), and the `.ai_memory/`
entry (its own lifecycle; no work-item copy existed).

### 37.33 Checkpoint — CLI, MCP, agent text, extension migrated

- Agent-facing text: `task.md`'s Required Output section (both modes,
  investigation truthfully phrased), the investigation handoff ("write
  `fix_report.md`, every section investigation-phrased"), the precedence rule
  ("record the conflict in the Review Notes section of `fix_report.md`"), the
  Jira status block, the team instructions' Output Expectations (both
  `docs/agent_team_instructions.md` and the bundled fallback), the handoff
  sentence's "write the fix report" (skill and MCP prompt in step).
- CLI: `check-results` (one-name missing list), `manual-result` (one
  template), `summarize-results` prints the Result Overview (report status +
  validation checklist; `--json` gained `fix_report`/`overview`, lost the
  two generated paths), `review-package`/`commit-plan`/`push-plan` print,
  `memory update` reads the report and its warning names it,
  `delivery-check`'s warnings check the report and its sections plus the
  memory entry (the two removed files left its list).
- MCP: `check_results` (same shape), `summarize_results` returns
  `fix_report` / `overview` / `report_excerpt` (the old two path fields named
  files that no longer exist — a documented, necessary field change).
- Extension: `RESULT_FILES = ["fix_report.md"]` (missing-results row, results
  grouping), the history "fixed" marker keys on the report, deletion-warning
  strings name it; the five old result names plus the removed derivation files
  keep phase-era `GROUPS` entries so pre-Batch-5 directories still list sanely.
  No UI redesign.

### 37.34 Checkpoint — the five-plus-one core contract, verified

Scratch runs (`sample-repo`, `python -m bugpilot`, `--prepare-only`):

- Prepare-only (Jira-mock and manual/investigate-first): exactly
  `issue.json retrieval.json context.md task.md run.json` — Batch 5 changed
  nothing about the prepare stage.
- Post-agent (the report written by hand, standing in for an agent):
  `check-results` passes, `summarize-results` prints the Result Overview
  (report status, its Summary, the validation checklist), `review-package` and
  `commit-plan`/`push-plan` print, `memory update` writes the report's
  sections into the `.ai_memory` entry — and the directory holds exactly the
  five plus `fix_report.md`. A retry adds its two deliberately-kept side-band
  files (`agent_retry_prompt.md`, `user_feedback.md`) and nothing else.
- No report yet: the overview says "missing" and names `manual-result` as the
  manual-fix path, `memory update` skips with the same message,
  `check-results --strict` exits 1 — and nothing invents a report or an
  outcome. The investigate-first `task.md` requires the report with every
  section investigation-phrased and "Do not write any section as though a fix
  exists."

Pinned by `tests/test_fix_report_artifact.py` (10): section parsing (a `###`
stays inside its section; a missing heading is an empty section, never an
error; the manual template fills every section), honest outcomes ("Not run: no
code changed" passes through the memory and the email verbatim; an empty
report renders "not available" rather than claims; the overview names the
empty sections), prepare = 5 and report = 6 with `run.json`'s snapshot picking
the report up, the post-fix flow writing none of the eleven old files, and a
retry that ignores a pre-Batch-5 attempt's legacy files (no fallback).

### 37.35 Checkpoint — Batch 5 verification and review

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1117 passed (checkpoint baseline 1104: +11 `test_fix_report_artifact.py`, +2 in `test_workflow.py`) |
| `npm test` (extension) | 832 passed (unchanged count: fixtures migrated in place) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 8 passed |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean; untracked files have no trailing whitespace |
| `python tests/retrieval_corpus.py` | frozen pre-Batch-3 tree: all six cases **byte-identical** (no retrieval module changed). Live tree: top-3 2/5, MRR 0.292, docs 10 — the same self-referential case again (`workflow.py` rank 7→8, its post-fix text changed); both expected files stay top-10, and the §37.27 fixture floor test is immune by design |

Final legacy search for the eleven consolidated names: zero live production
readers or writers. The remaining references are one explanatory docstring
(`summarize_results_step`), the extension's phase-era `GROUPS` labels for
pre-Batch-5 directories (the copilot/runtime precedent), tests asserting
absence or rejection, the unshipped `docs/` guides (the documentation pass,
as recorded since §37.11), and history.

**Independent review** (whole diff vs `7fde6aa`): no blocker, no important
finding. Fixed from its minors: the retry prompt's delivery intro still said
"required result files" (now "the fix report"); `section_of` required an exact
heading line, so a model's `## summary ` read as a missing section everywhere
downstream — headings now match with trailing whitespace and case forgiven
(false-missing was the failure mode, never false-success; a test pins the
tolerance); three stale plural help strings and the launch message; an
f-string with no placeholder; and the extension's grouping gained entries for
`jira_comment_post_summary.md` (phase-era) and `jira_comment_post_result.json`
(current audit record), which had none. Deferred as pre-existing cosmetics:
`manual-result --overwrite` prints its overwrite warning even when the
template was freshly created. The review confirmed ownership (one writer, the
template, preserve-by-default), the honest-outcome semantics end to end, the
bounds and sanitization on everything leaving the machine, retry and delivery
approval flows unchanged, zero disk-IPC prompts and zero fallback readers, and
no prepare-stage, run.json, MCP-stdio, or scope regressions.

### 37.36 Checkpoint — workflow UI inventory and data ownership (Batch 6 start)

Read from the committed tree (`adc3c53`). The panel is host-computed: the
controller builds one `PanelState` per push and `media/panel.js` renders it
into static markup from `src/panel/html.ts`.

| Surface | Where it renders | Fed by |
|---|---|---|
| Six workflow rows (checkbox, status icon, duration, one text line) | `<details id="workflow">` → `<li id="step-*">`, `renderWorkflow` | `buildWorkflow()` (`workflow.ts`) from `ProgressView` + the artifact listing + `#fix` |
| Context Ready card (counts, Strategy, handoff outcome, Fix with AI button, handoff error card, Open Context / Copy / Open Folder, Relevant Files, Retrieval Details) | `<section id="context-ready">` *above* the workflow, `renderContextReady` | `#contextReady()`: present only when not running, not failed, `context.md` listed |
| Run failure card | `#failure`, outside both | `runError(progress.failure)` |
| Relevant Files | `#relevant-files` inside Context Ready | `relevantFiles(parseRetrieval(...))`, 10 rows + overflow |
| Retrieval Details | `#retrieval-details` inside Context Ready | `retrievalTerms(...)` |
| Fix with AI | button + handoff card inside Context Ready; the sixth row shows `#fix.detail` as text | `#fix`, `#handoffBusy`, `#handoffError`, `handoffOutcome()` |

State sources: row states come from the live event stream
(`ProgressTracker`, `CAPABILITY_MARKER_STEPS`: issue ← fetch/parse, code search
← code_search, git history ← git_context, similar fixes ← memory_search, build
context ← context/prompt/memory_add) or, for a reopened work item, from
`run.json` through `viewFromStatus` with the same marker table. Artifact
presence comes from the directory listing (`#artifactNames`). The only artifact
the host parses today is `retrieval.json` (`retrieval.ts`, once); `issue.json`
is not read at all. No structured git-history or similar-fixes data reaches the
extension — the CLI's stream events carry step names only, and Batch 3 kept
both results inside `context.md` on purpose.

Disclosure lifecycle: `renderWorkflow` opens the workflow when a run starts and
**folds it once** when the run ends (UI-B1's reason: results lived in the card
above it). Offered commands: `#isOffered` = the blocked-readiness actions plus
whatever `#runFailure()` / `#handoffError` currently carry — derived per call,
which is the fix for UI-B2's allow-list bug.

What Batch 6 changes: the rows become the result view. `WorkflowStep` grows
into a `WorkflowStepResult` (summary per state, owned artifact, owned actions,
nested content, row-owned error); Relevant Files and Search details move under
Code search, Open Context / Copy under Build context, the Fix with AI button
and its outcome / error under Fix with AI; the workflow stays open after Run;
and the card's duplicates are removed.

### 37.37 Checkpoint — `WorkflowStepResult`: the rows are the result

`WorkflowStep` became `WorkflowStepResult` (`extension/src/app/workflow.ts`).
The host computes it on every push and the page renders it; `panel.js` does
not interpret a status, an artifact or a count.

```ts
type StepStatus = "idle" | "running" | "success" | "ready" | "failed" | "skipped";
type StepActionId = "openContext" | "copyContext" | "fixWithAI";

interface WorkflowStepResult {
  id; label; description; enabled; required?; status; durationMs?;
  summary: string;          // the secondary line for the state the row is in
  detail?: string;          // a quieter second line: the issue title, which agent
  strategy?: string;        // Fix with AI only, once task.md is this run's
  artifact?: string;        // a plain file name, opened via `openArtifact`
  actions: StepActionId[];
  search?: SearchContent;   // Code search only: files (+ moreFiles), terms
  error?: UserFacingError;  // a failure this row owns
}
```

Inputs (`WorkflowInput`) are real state only: the step marks (`ProgressView`,
from the live stream or `run.json` via `viewFromStatus`), the directory listing,
`issue.json` (`parseIssue`), the `retrieval.json` projection, the handoff state
(`fix`, `handoffBusy`, `handoffError`), the run's classified failure and the
prepared Fix Mode line. Three rules hold for every row:

- **A row reports only once its own step finished.** A running or pending row
  says what it is doing or will do, and never offers the previous run's
  artifact or actions — even while the old file is still on disk.
- **A row owns its failure.** The run's card goes on the row whose capability
  was in flight (`progress.failure.capability`, status `failed`); the handoff's
  goes on Fix with AI. `PanelState.runError` now carries only a failure no row
  owns (before any step started, or observed by the extension itself), rendered
  as the standalone card at the top of the workflow. The controller computes
  ownership by identity (`workflow.some(step => step.error === failed)`), so a
  failure is never shown twice.
- **`ready` is not `success`.** It exists for one case — a task on disk that
  nobody handed over — and has no status glyph; the green tick is reserved for
  a handoff that actually started.

`PanelState` changes: `workflow: WorkflowStepResult[]`, new
`workItemActions` (Open Folder), `runError` unowned-only; `contextReady`,
`handoffError` and `ContextReadyView` are gone. `#isOffered` is untouched: it
still derives the offer from `#runFailure()` and `#handoffError`, whichever
surface renders them.

Phases 6A/6B collapsed into one step for the page: the moved elements carry
unique DOM ids (`open-context`, `fix-with-ai`, `relevant-files`, …), so the old
card and the new rows could not both render them. 6A was therefore the host
model and its tests, landed and green first; 6B moved the markup and deleted
the card together, so no intermediate build showed two sources of truth.

### 37.38 Checkpoint — Issue details and Code search

`extension/src/app/issue.ts` is the one reader of `issue.json`: schema version
1 only; `id` must be a non-empty string, `source` a string; `title` trimmed or
`""`. Anything else is "not known" and the row says only "Completed" — better
than naming the wrong issue. The controller's `#readSummary` reads `issue.json`
then `retrieval.json`, once per listing; both are forgotten when a run starts,
when another work item is shown, and when its folder cannot be read
(`#forgetSummary`), so no push names the previous work item.

| Row | Pending | Running | Finished |
|---|---|---|---|
| Issue details | "Fetch Jira issue information" / "Parse the description you wrote" (+ "Always runs") | "Loading JR-12345…", "Loading the Jira issue…", "Reading the description…" | "JR-12345 · Jira issue" or "Manual bug description"; the title as the detail line; `issue.json` |
| Code search | "Search relevant code in the repository" | "Searching repository…" | "11 terms · 6 relevant files" (terms first, singular at one, a list the artifact lacks is left out, never reported as 0); `retrieval.json` |

Pinned by `test/issue.test.ts` (10) and the per-row tests in
`test/workflow.test.ts`.

### 37.39 Checkpoint — Relevant files and Search details under Code search

Both disclosures moved inside the Code search row (`<details id="relevant-files">`,
`<details id="search-details">`), collapsed by default. Retrieval Details is
renamed **Search details**. They render only while the row carries `search` —
a finished search whose `retrieval.json` had files or terms — so a running,
failed or pending search shows none of the last run's content.

Everything else is unchanged: ten rows plus "N more in retrieval.json", the
artifact's order partitioned into Implementation / Supporting (headings only
when both exist), "Matched: …", "N lines" / "1 line" / "no matches" / "Broad" /
"From: …", `openRelevantFile` resolved against the repository with
`isSafeRelativePath` + `isWithin`, and every string through `textContent`.

### 37.40 Checkpoint — Git history and Similar fixes

Running: "Collecting git history…" / "Searching past fixes…". Finished:
"Completed", "Skipped" or "Failed" — nothing more. No structured result reaches
the extension (stream events carry step names only) and Batch 3 kept both
results inside `context.md` on purpose, so there is no count to show without
parsing Markdown. No `git_history.json` / `similar_fixes.json` was added and no
prose is parsed.

### 37.41 Checkpoint — Build context actions, and Open Folder

Build context finished with `context.md` listed: "Context ready", the
`context.md` link, and **Open Context** / **Copy** in the row
(`actions-buildContext`). Finished without the file: "Completed" and no actions
— a disabled button would invite a click that explains nothing. The actions
post the same `{type:"action"}` messages as before.

**Open Folder** is work-item level: it reveals every artifact, not Build
context's, so it sits in the workflow's footer (`workflow-foot`), offered via
`workItemActions` whenever nothing is running and the work item directory lists
anything (`canOpenFolder`).

### 37.42 Checkpoint — Fix with AI on its row

| State | Row | Offers |
|---|---|---|
| No task yet | the description, or "Waiting for task…" while a run is in flight | — |
| Ready (task.md is this run's, Build context succeeded, nothing running) | `ready`, "Ready", Strategy line, `task.md` | Fix with AI |
| Starting (`handoffBusy`) | `running`, "Starting AI fix…" | — (no second press) |
| Started | `success`, "AI fix started", "Handed to Claude Code in a terminal." | — (a second press would open a second terminal) |
| Could not start (`handoffError`) | `failed`, "Did not start", the route the prompt took as the detail ("…on the clipboard instead."), the row's card (title, sentence, Open Settings, Details) | Fix with AI again |
| Skipped / failed without a card | the controller's own sentence | — |

The row is not greyed as "not chosen" once it is ready or was handed over
(`step-off` applies only to an idle, unticked row). The header reports the
handoff whether or not the box was ticked — since the button moved onto the
row, pressing it is a choice of its own. `handoff.ts` shrank to
`HANDOFF_STARTED_TITLE`; the no-false-claims guard now runs against the row
(`test/handoff.test.ts`). Handoff semantics — agent resolution, the clipboard
fallback, `task.md` as the one input, no completion claim — are unchanged.

### 37.43 Checkpoint — duplicate external UI removed

Removed from the page: the `#context-ready` section and everything in it (the
counts line, the Strategy line, the handoff outcome block, the Fix with AI
button, the handoff error card, the three action icons, Relevant Files and
Retrieval Details), and the trailing run-failure card after the form (the
standalone card now sits inside the workflow, above the steps). Removed from the
host: `#contextReady()`, `ContextReadyView`, `handoffOutcome` /
`HandoffOutcome` / `HANDOFF_STARTED_MESSAGE`, `describeCounts`; from the CSS the
dead `.result-*` card rules (only `.result-link` and `.result-label` remain in
use). `test/panel.test.ts` proves each of Relevant files, Search details, Open
Context, Copy and Fix with AI exists exactly once, inside its owning row, and
that no Context Ready surface remains.

### 37.44 Checkpoint — disclosure lifecycle

The workflow opens on the transition into a run and **no longer folds when the
run ends** — the rows are the result. It also opens once when a different work
item with results arrives (reopened from History, or restored by a reloaded
panel), and once when a failure card appears — every card lives inside the
workflow, and a Set Jira Credentials button nobody can see does nothing. All
three are transitions only, so a developer who collapses it, mid-run or after,
is not overruled by the next push; the next run opens it again. The sentence
under Run hides once the header reports a result or a failure.

### 37.45 Checkpoint — visual review and the Context Ready decision

Harness: the ignored `extension/.review/` (real markup, stylesheet and page
script; rows from the real `buildWorkflow`). Thirteen states — initial, running
(issue), running (search), prepared, Relevant files open, Search details open,
retrieval unreadable, Fix starting, Fix started, Fix failed, run failed on
Issue details, late failure on Build context, unowned failure — in dark and
light at 200, 300 and 400 px: **78 pages, zero horizontal overflow**. Workflow
height, prepared with the disclosures closed: 674 / 487 / 471 px.

1. *Primary result view?* Yes: the header carries the one global status and
   every result sits on the row that produced it.
2. *Too tall with details closed?* No: 487 px at a 300 px sidebar, six rows
   with their results; the two disclosures add one line each.
3. *Relevant files / Search details owned by Code search?* Yes: indented under
   its summary line, before the next row's divider.
4. *Open Context / Copy owned by Build context?* Yes: directly under "Context
   ready" and its `context.md` link.
5. *Fix with AI owned by its row?* Yes: the only primary button besides Run,
   full-width inside the row, with the Strategy line above it.
6. *Outer Context Ready redundant?* Yes — see the decision below.
7. *Filenames too prominent?* No: small link-coloured text at the right of the
   description line, dropping to its own line at 200 px; only rows that
   produced a file show one.
8. *Failed Fix with AI preserves earlier results?* Yes: every row above keeps
   its summary, link, disclosures and actions; only Fix with AI turns red.
9. *200 px usable?* Yes: labels wrap, links drop below, the context actions
   stack, the card's text wraps; nothing clips.
10. *Duplicates outside the workflow?* None (also pinned by tests).

Fixed during the review: "AI agent unavailable" appeared both as the row's
line and as the card title (the line now says "Did not start"); the ready row's
label was greyed by `step-off` (now idle-only); the run hint keyed off the old
card (now the header's kind); `[hidden]` guards for every new flex container.

**Decision: Option B.** The standalone Context Ready block is removed entirely;
the workflow header ("Context ready", "AI fix started", "AI fix did not start",
"Run failed") is the single global status. With Option A the line repeated the
header one row above it, and after a failed handoff it read "Context Ready"
directly over "AI fix did not start" — true, but a second status to reconcile.

### 37.46 Checkpoint — Batch 6 verification and review

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1117 passed (unchanged: Batch 6 touches no Python behaviour; two docstrings in `core/retrieval.py`, whose 231 importing tests were rerun after the edit) |
| `npm test` (extension) | 866 passed (baseline 832: +34 — 10 in `issue.test.ts`, the rest row, placement, lifecycle and review-fix tests) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 8 passed |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean; untracked files have no trailing whitespace |
| `python tests/retrieval_corpus.py` | frozen pre-Batch-3 tree: all six cases **byte-identical** to Batch 5. Live tree: the same summary (top-3 2/5, MRR 0.292, docs 10); only ranks 3–10 of two cases shuffled among files this batch edited (the corpus searches this repository), expected files unranked in both runs as before |

**Real flow** (scratch `sample-repo`, the working tree's CLI via
`python -m bugpilot`, `--prepare-only`): the real `Controller` with a real
runner and filesystem and a recording UI port (nothing opened, copied,
launched or probed for real). Run pushed 24 running states in which every
capability row was seen running, none offered a handoff or Open Folder; the
prepared state read "Manual bug description" + title, "18 terms · 2 relevant
files", "Completed" ×2, "Context ready" with both actions, Fix with AI ready
with "Standard Fix · availability unknown"; the header "Context ready". The
first relevant file opened the real source path; `../outside.txt` was refused;
the four row artifacts opened inside `.ai/<id>/`, and names with a separator or
`..` were refused. Copy copied `context.md` byte for byte. Fix with AI with no
agent: the row failed with its card and the clipboard sentence, every earlier
row unchanged, header "AI fix did not start", the card's Open Settings accepted;
with an agent: a terminal command reading `task.md`, "AI fix started", and the
withdrawn card's command then refused. A fresh controller reopening the work
item from `run.json` rebuilt the same six rows.

**Independent review** (whole diff vs `adc3c53`): no blocker. **One important finding, fixed**: `showWorkItem`
never cleared the issue and search summary, and `refreshArtifacts` pushes a
loading state before it reads — so switching from JR-1 to JR-2 in History
briefly showed "JR-1 · Jira issue", JR-1's title and JR-1's files on JR-2's
rows, and with an unreadable folder kept them there. Now `#forgetSummary()`
runs at run start, on `showWorkItem` and in the unreadable branch; three
controller tests pin it (both regression tests fail without the fix). Fixed
from its minors: the host-level mid-run test only ever saw the first, empty
push — it now reopens the same work item first (the old `task.md` and
`context.md` listed), awaits the run, requires a mid-run push with Build
context finished, and fails if the `!running` guard in `taskReady` is removed;
failure cards could sit inside a collapsed workflow (every card now lives in
it), so a card appearing opens the workflow once (three page tests, all failing
without the change); the "exactly once" claim of §37.43 is now an explicit test
by id and by visible label; a stale `errorCard` comment. Kept, deliberately:
Build context shows both its `context.md` link and Open Context — the link is
the same quiet ownership label every row that produced a file carries, and Open
Context is the named action the plan keeps; a restored work item whose
`run.json` is missing or unreadable shows idle rows with no row actions (the
rows report only what `run.json` says finished; Open Folder and the Artifacts
view still reach every file — and pre-release there are
no pre-Batch-4 directories to support). The review confirmed ownership, row
states, ready ≠ success, failure preservation by deep equality, `#isOffered`
unchanged and still card-scoped, file opening unchanged (`openArtifact`
re-checked, relevant files `isSafeRelativePath` + `isWithin`), `textContent`
throughout with `innerHTML` still banned, no timers, probes or I/O from
`panel.js`, `[hidden]` guards on every new container, and no artifact contract,
retrieval, Fix Result, Git history, Similar fixes, Fix Mode or delivery change.

### 37.47 Checkpoint — Fix Mode placement inventory (Batch 7 start)

Read from the committed tree (`594ac5c`).

| Concern | Where | Owner |
|---|---|---|
| The selector | `<div id="field-fixModeId">` on the main form between Issue and Run (`html.ts`): `<select id="fixModeId">`, the Manage Fix Modes gear `#manage-fix-modes`, the note `#fixModeId-description`, helper `#fixModeId-hint` | markup |
| Options | `renderFixModeOptions` from `PanelState.fixModes` (`bugpilot fix-mode list --json`; built-ins and custom modes alike, `defaultModeId` from the CLI) — no mode name in the page | host → page |
| Note | `renderFixModeNote`: the mode's description, "Investigation only — no source changes in this pass." for `executionKind: "investigate"`, the catalog's `unavailable` detail, or a `fixModeId` field problem | page |
| Selection | `FormState.fixModeId`: `readForm` / `writeForm`, persisted with the rest of the form (`setState`, `formChanged` → host `saveForm`) | page owns while typing, host by revision |
| Default and fallback | `selectedFixModeId` (`fixModes.ts`): a mode the catalog offers, else `defaultModeId`; applied when the catalog arrives and when a work item is shown (`#deriveFixModeFor`, from `run.json`'s `fix_mode`) | host |
| Validation | `buildPrepareArgs`: `FIX_MODE_ID_RE`, else a `fixModeId` field problem; else `--fix-mode=<id>` | host |
| Management | the gear → `manageFixModes` → manager / preview / editor views (`showView`; focus returns to the gear) | page + host |
| Artifacts | the CLI writes the full audit record to `issue.json` `guidance.fix_mode` and `run.json` `fix_mode`, and renders `task.md`'s `## AI Fix Mode` | Python, unchanged |
| Result display | the Fix with AI row's Strategy line (`#strategyLine`, from `run.json`) | host |

There is no Jira / Bug description switch to preserve: UI-A1 replaced it with
one Issue field whose source is derived, and Batch 7 leaves it as it is.

### 37.48 Checkpoint — Strategy subsection and the relocation

`FIX_MODE_FIELD` (`html.ts`) is the same field, moved: same ids, label, helper,
gear and note. It is the first group inside Advanced settings, under a new
`groupHeading("strategy", "Strategy")`, before Guidance, Retrieval Overrides
and Run Options, which are untouched. The main form is now the Issue field and
Run. Two small additions keep a closed section from hiding anything:

- A `fixModeId` problem opens Advanced settings once and focuses the selector
  (`renderFixModes`, keyed on the message) — the rule every field in the section
  already follows (`ADVANCED_FIELDS`), applied to the one control whose problem
  is shown in its note rather than an error line. Defensive: the message parser
  and `buildPrepareArgs` leave almost no way to reach it.
- Returning to the form from a Fix Mode view opens Advanced settings before
  focusing the gear (`showView`). In the normal path it is already open; a
  reloaded panel can restore the manager with the section closed, and focus
  cannot land inside a closed disclosure.

The selector's `aria-describedby` now names its helper as well as its note, as
the section's text fields do. An unavailable catalog is explained in
the note and does not force the section open: Run still works on the CLI's
default.

### 37.49 Checkpoint — state, persistence and run payload

No host, protocol or artifact change: `FormState`, `PanelMessage`,
`buildPrepareArgs`, the controller and the Python side are untouched, so the
run request is byte-for-byte what it was. Pinned anyway:

- Page (`test/page.test.ts`): the closed section holds the real selection and
  its description; nothing chosen → the CLI's default, and Run sends it; a mode
  chosen and then folded away — with pushes arriving meanwhile — is what Run
  sends and what the page persists; Ctrl+Enter likewise; a restored custom mode;
  a mode problem opens the section once; an unavailable catalog does not; the
  way back from the manager opens the section and focuses the gear; a load, a
  run and a finished run leave the section closed.
- Controller (`test/controller.test.ts`): exactly one `--fix-mode=<id>` for
  Standard, Investigate First and a custom mode; a restored custom mode survives
  the catalog arriving; a deleted one falls back to the default.
- Integration (`test-integration`, real CLI): the panel's form with
  `standard`, `investigate-first` and a project custom mode (created with
  `fix-mode duplicate`) → `buildPrepareArgs` → a real prepare → `issue.json`
  `guidance.fix_mode` carries the full seven-key audit record (id, name,
  version, source, execution_kind, based_on, based_on_version), `run.json`
  carries the same record, and `task.md`'s `## AI Fix Mode` names the mode, its
  source and its execution kind.
- Markup (`test/panel.test.ts`): exactly one `select#fixModeId`, one field, one
  gear; inside Advanced settings, after the Strategy heading and before
  Guidance, with its note and gear in the same field; nothing of it above Run;
  no control of any kind above Run but the Issue field; four named groups.

### 37.50 Checkpoint — responsive, theme and accessibility review

Harness: the ignored `extension/.review/`, now 18 states — Batch 6's thirteen
plus Advanced open with Standard Fix, Investigate First, a custom mode, a mode
problem and an unavailable catalog — in dark and light at 200, 300 and 400 px:
**108 pages, zero horizontal overflow**.

The harness laid pages out by constraining `body`, but headless Chrome's
viewport never goes below 500 px, so `panel.css`'s one `@media (max-width:
380px)` rule (which hides "Hide Advanced" in a narrow sidebar) never applied
and the open section's heading overlapped at 200 px. The harness now applies
that rule at its narrow widths; the stylesheet did not change.

Findings: the main form is visibly shorter — Issue, Run, the workflow,
Advanced settings, Diagnostics. Inside Advanced settings, Strategy reads as one
more group: the selector takes the row with the gear beside it (a long custom
name is truncated by the native select, and its description wraps below); the
Investigation-only line, the problem text and the unavailable detail sit where
the mode's description does. Both themes use only existing `--vscode-*`
variables; nothing new was styled. The label stays associated
(`<label for="fixModeId">`), the gear keeps `title` and `aria-label`, and the
tab order follows reading order: Advanced settings' summary, then the
selector, the gear, then Guidance.

### 37.51 Checkpoint — Batch 7 verification and review

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1117 passed (unchanged: no Python change) |
| `npm test` (extension) | 888 passed (baseline 866: +18 page, +1 panel, +3 controller; the panel placement tests were rewritten in place) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 9 passed (baseline 8: + the form → `issue.json` → `task.md` Fix Mode test) |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean; no untracked files |
| `python tests/retrieval_corpus.py` | frozen pre-Batch-3 tree: all six cases **byte-identical**. Live tree: the same summary (top-3 2/5, MRR 0.292, docs 10), lower ranks shuffled among edited files as the self-referential corpus does |

**Independent review** (whole diff vs `594ac5c`): no blocker, no hard-constraint
violation. **Important, a product decision rather than a defect**: the host
still re-selects the mode a work item was prepared with when it is reopened or
its key is typed (and resets to the default for a new one) — behaviour tested
since phase 7 — and with the selector collapsed that change is visible only by
opening Advanced settings. Before the run nothing on the main form says so;
after it, the Fix with AI row's Strategy line names the real mode before any
handoff. Fixing it on the page would mean new main-form text or an automatic
open, both outside this batch's constraints, so it is recorded as open for
review in the canonical plan's Batch 7 decisions, and the README sentence that
promised "nobody is surprised" was rewritten to say what actually happens.
**Resolved** before freezing (below).
Fixed from its minors: a mode problem now focuses the selector as well as
opening the section (defensive — the parser and `buildPrepareArgs` leave almost
no way to reach it); the collapsed-state page test now pushes the host's older
form under the same revision and fails if the revision guard is removed (it
previously passed without the change, as most of the new page tests do — the
stub DOM does not model `<details>` containment; the two that pin the new
behaviour, problem-opens-once and back-from-the-manager, both fail without it);
§37.48 no longer claims every field in the section names its helper (the
Attachments button, pre-existing, does not). Kept, deliberately: an
unavailable catalog is explained inside the section and does not open it.

**The open item, resolved: the collapsed summary names a non-default mode.**
Decision: Advanced settings exposes the active non-default Fix Mode in its
collapsed summary, so restored strategy changes remain visible without
returning the selector to the primary form. Presentation only — `FormState`,
persistence, the run payload, the controller and protocol, the artifacts,
`WorkflowStepResult` and the section's auto-open rules are untouched.

- Markup (`html.ts`): the summary's title line became `.adv-title-row` — the
  title, then `#advanced-strategy` (a lightbulb and `#advanced-strategy-name`),
  `hidden` in the markup and `aria-hidden`, so the disclosure's name is what it
  was. The summary carries `aria-describedby="advanced-strategy-description"`,
  a `hidden` span holding "Fix Mode: <name>" — the mode reaches assistive
  technology as the description.
- Page (`renderStrategySummary`, called from `renderFixModeNote`): named when
  the catalog is ready and the selected mode is not the CLI's `defaultModeId`
  (the display name, custom modes included); empty otherwise, including with no
  catalog, when Run sends no mode at all. Because it reads the selector, it
  follows a click, a restored work item (a new form revision), a reset to the
  default and a catalog fallback on the same render. `title` carries the full
  name.
- Style (`panel.css`): secondary (`descriptionForeground`, 0.9em, the Fix Mode
  lightbulb in the primary tone); hidden while the section is open, where the
  selector itself is on screen. The title row wraps with
  `justify-content: space-between`: the label sits at the far end while it
  shares the title's line (400 px) and starts its own line under the title
  once it wraps (300 and 200 px); the name is cut with an ellipsis rather than
  widening the panel.
- Tests: Standard Fix adds no label (chosen, or the default with nothing
  chosen); Investigate First and a custom mode are named, with the description
  and hover title; a click to and from the default; a restored mode on a new
  revision, before Run; a reset to the default clears a stale label; a deleted
  custom mode falls back and takes its label; no catalog, no label; Run from the
  closed section unchanged; the markup keeps the name, holds no control, and
  still has exactly one selector. Seven of the page tests fail with the renderer
  removed (the other two assert the empty case).
- Visual: harness states for Investigate First collapsed, a 66-character
  custom name collapsed, and a prepared work item whose package used Standard
  Fix while the next run is set to Investigate First — the Fix with AI row's
  Strategy line and the summary label now say both. 21 states in dark and light
  at 200, 300 and 400 px: 126 pages, zero horizontal overflow.

### 37.52 Checkpoint — Fix report UI inventory (Batch 8 start)

Read from the committed tree (`317ecb0`).

| Where the extension notices `fix_report.md` | What it does with it |
|---|---|
| `artifacts.ts` `RESULT_FILES` / `GROUPS` | Artifacts tree: grouped under Results; listed as *missing* once `task.md` exists and it does not |
| `artifacts.ts` `historyOutcome` (from `ports.ts` `probeWorkItem`, cached by directory mtime) | History row outcome `fixed`: codicon `verified`, hover "An agent wrote its report in fix_report.md." |
| Clean / fresh confirmations | named as something an agent wrote that deletion removes |
| The panel | nothing: no row, no text, no header |

When the work item's directory is re-read (`refreshArtifacts` → the listing,
`issue.json`, `retrieval.json`): at the end of a run, on `showWorkItem` (a
History click, a context action on another row, the window restoring its last
work item), on Retry and Clean, and on `bugpilot.refreshViews` (the Refresh
button in the Artifacts and History view titles). After Fix with AI nothing is
re-read: the handoff starts a terminal and the extension stops watching. There
is no file-system watcher, no timer and no polling anywhere in the extension —
so a report an external agent writes later is seen only at the next of those
reads. Batch 8 keeps it that way.

The History `fixed` outcome is left as it is: its hover is factual, but its
`verified` badge reads as "verified fix" for an investigation-only report. A
separate, presentation-only follow-up, not this batch.

### 37.53 Checkpoint — `fix_report.md` presentation parser

`extension/src/app/fixReport.ts`, host-side only:

```ts
interface FixReportPreview {
  readonly readable: boolean;   // listed but unreadable is still a report
  readonly summary?: string;    // first meaningful line of ## Summary
  readonly tests?: string;      // first meaningful line of ## Tests
}
parseFixReport(text: string | undefined): FixReportPreview
sectionOf(markdown, heading): string   // a port of core/fix_report.py section_of
```

Rules: lines split on every boundary Python's `str.splitlines()` knows (CRLF,
a lone CR or LF, form feed, vertical tab, `\x1c`–`\x1e`, `\x85`, U+2028,
U+2029); a heading matches after `trim().toLowerCase()` (surrounding
whitespace and case forgiven, internal spacing not — as the CLI); a section
runs to the next line starting `## `, so `###` stays inside; the first
matching heading wins; a missing section is empty. The first meaningful line
skips blank lines, rules, HTML comments (multi-line too), lines that are only
HTML tags, subheadings, and a table's header and separator; drops a leading
list, quote or task marker and `**bold**` wrapping a whole span (never a lone
`**` or `__`, so `__init__.py` and `**kwargs` survive); joins table cells with
" · "; prefers prose outside a code fence and otherwise takes a fence's first
line literally; collapses whitespace; and is cut at 240 code points with an
ellipsis, never mid-surrogate. Only the first 256 Ki characters of the text are
parsed (the host reads the file whole, as it does `issue.json` and
`retrieval.json`). No wording is classified: "Fixed …", "Investigation complete
…", "Attempted fix …", "No code change was required." and "2 failed, 18
passed" all pass through. A parity run of `sectionOf` against the Python
`section_of` on 33 heading / input pairs (case, indentation, CRLF, a lone CR,
Unicode separators, repeated headings and subheadings) matched exactly.
`FIX_REPORT_ARTIFACT` joined the artifact-name constants; `RESULT_FILES` and
the History probe use it. Review Notes are not surfaced: counting concerns
out of prose would be classification, and the row stays two lines.

### 37.54 Checkpoint — Fix result in `WorkflowStepResult`

`WorkflowStepId` gained `fixResult` and `StepActionId` gained
`openFixReport`; `WorkflowStepResult` gained an optional `statusLabel` (the
words a screen reader announces). `WORKFLOW_STEP_IDS` stays the six plan rows,
which own the checkboxes and the CLI plan. `buildWorkflow` appends one
`fixResult` row exactly when `fix_report.md` is in the listing — a run in
flight included (the rule as confirmed after review: file present, row; file
absent, none) — built from `WorkflowInput.fixReport`. It is a file, not a step,
so it never counts towards "Running n/m…":

| Report | Row |
|---|---|
| Summary and Tests | `ready`, "report available"; summary = the Summary line; detail = "Tests: …"; `fix_report.md`; Open Fix Report |
| Summary, no Tests | no detail line |
| no Summary (partial) | "Fix report available" |
| listed but unreadable | "Fix report available" / "Preview unavailable" — never a failure card |

`overallStatus`: "Fix report available" when a report row exists, below a run
failure, "AI fix did not start" and "AI fix started" (what this session saw
of a handoff is newer than a file), above "Context ready" — and also for a
reopened work item whose `run.json` gives idle rows. Fix with AI is untouched:
a reopened work item shows it Ready from `task.md` beside the report, because
handoff state is not persisted and none is invented.

The controller reads the report in `#readSummary` only when listed
(`parseFixReport` of the file text, or of `undefined` when it cannot be read),
keeps only the preview, and clears it in `#forgetSummary`. Only the two lines
reach the panel — a test checks the state carries none of Analysis.

Markup: one more row after the six (`FIX_RESULT_ROW`), `hidden`, with no
checkbox and no failure card, the same foot and body as the others, and a
secondary Open Fix Report button (`result-link`, like Open Context). The page
shows and fills the row only while the host's workflow has it
(`renderFixResult`); absent, it is hidden and emptied and its file forgotten.
The label is indented by id (`#step-fixResult`), because the page rewrites
each row's classes from its status; the summary is clamped to three lines and
the Tests line to two, with the whole bounded line as the title.

### 37.55 Checkpoint — history, stale state and opening the report

A reopened work item with a report rebuilds the row from the file alone, with
the header "Fix report available". Switching work items clears the preview
(`#forgetSummary`) — and, found while pinning that, the folder listing too:
`showWorkItem` pushed a loading state while `#artifactNames` still held the
previous work item's listing, so a Fix result row (and, since Batch 6, the
previous item's Build context actions) could show on the new item for a push.
`showWorkItem` now clears the listing before it re-reads; the regression test
fails without that line. The same held for a run (review finding, below): a
run now starts from an empty listing — Jira included — so no push before its
folder is read again can offer a file the run may have changed. The one entry
kept is `fix_report.md` itself, and its preview, when the run is a re-prepare
of the same Jira work item without Fresh: the CLI keeps the report then (the
retry flow reads it), so its row stays through the run — describing the
previous attempt until an agent writes a new one, which nothing on the row
claims otherwise. After a Fresh run, a
run on another key or a hand-written bug, no push shows the previous report;
a prepare-only run grows no row. Each case has a test that fails without it.

Open Fix Report and the row's file link post `openArtifact` with the name the
host put on the row; the message parser takes only a plain file name and the
controller re-checks it, so `../fix_report.md`, `subdir/fix_report.md`,
absolute and drive paths never reach a file open (tested through both).
No new message type, no new host action, no shell.

A report written after the handoff is picked up by the next read: a test
writes one, sends a plain state push (nothing happens), then refreshes (the
row appears).

### 37.56 Checkpoint — responsive, theme and accessibility review

Harness states added to the ignored `extension/.review/`, each built from
Markdown through the real parser: a fix-style report, investigation-only,
tests not run, failed-tests wording, partial (no Summary), unreadable, a long
Summary, a long Tests line, a report after a handoff this session saw, a
reopened work item (idle rows, report), and a switch from a reported work item
to one without (a sequence of two states). With the prepared and handoff states
already there, 32 states in dark and light at 200, 300 and 400 px.

Found and fixed during the review: the label indent did not apply, because the
page rewrites the row's classes from its status (now keyed by id), and a
240-character summary wrapped to ten lines at 200 px (now clamped to three).
Result: the row reads as one more step — label, the agent's line, `fix_report.md`
at the right (its own line when the text is long), the Tests line, Open Fix
Report — with no status glyph and no outcome colour in either theme; the label
is at full strength like Fix with AI's ready row. Accessible name "Fix result:
report available"; the summary and tests are the elements' text (clamping is
visual); Open Fix Report has its label and a title.

### 37.57 Checkpoint — Batch 8 verification and review

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1117 passed (unchanged: no Python change) |
| `npm test` (extension) | 941 passed (baseline 888: +19 `fixReport.test.ts`, +12 workflow, +10 controller, +9 page, +3 panel) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 9 passed |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean; the two new files have no trailing whitespace |
| `python tests/retrieval_corpus.py` | frozen pre-Batch-3 tree: all six cases **byte-identical**. Live tree: the same summary (top-3 2/5, MRR 0.292, docs 10) |
| Visual harness | 32 states × dark/light × 200/300/400 px: 192 pages, zero horizontal overflow |

**Real flow** (scratch `sample-repo`, the working tree's CLI via
`python -m bugpilot`, the real `Controller` with a real runner and filesystem
and a recording UI port — nothing opened, launched or probed): a prepare-only
run left exactly five files and no Fix result; a canonical report written
afterwards appeared only after `refreshArtifacts` (a plain state push re-read
nothing), with the agent's Summary line, "Tests: …", `fix_report.md` and the
header "Fix report available", and no Analysis text in the state; Open Fix
Report opened `.ai/<id>/fix_report.md`, and traversal names were refused by
the message parser; investigation-only wording gave the same `ready` row;
switching to a work item without a report showed no Fix result in any push;
`bugpilot manual-result` produced a report the same row showed ("Developer
manual fix. TODO: …"); reopening the first item rebuilt its row from the file,
with Fix with AI Ready from `task.md`.

**Independent review** (whole diff vs `317ecb0`): no blocker. **Important,
fixed**: a Jira run kept the previous listing, so the push at `completed`
(progress done, the process not yet exited) and the loading push after it were
built from it — after a fresh re-run that deleted the report, or a run on
another key, a Fix result row and "Fix report available" flashed up, and the
previous item's context actions with them. The run now clears the listing as
it starts; the test that claimed this case was vacuous (its run never left
`running`) and was rewritten with a completing run — it fails without the fix.
Fixed from its minors: the parser's bold strip removed every `**` and `__`
(mangling `__init__.py`, `**kwargs`); line splitting now matches
`splitlines()`; multi-line comments, bare tags, fenced command blocks and table
headers no longer become the preview; truncation cannot split an emoji; the
page auto-open test passed without a report and now proves the report is what
opens it. Noted, not changed:

**After the review, the visibility rule was made strict** at the developer's
request: `fix_report.md` present → the row; absent → none, a run in flight
included (it had been hidden during runs). A same-key, non-Fresh re-run keeps
the row throughout; a Fresh run, another key or a hand-written bug starts
without it (see §37.55).

- After an ordinary (not fresh) re-prepare, the previous attempt's report is
  still on disk — deliberately: the retry flow reads it — so the Fix result row
  shows it beside the new package and the header prefers "Fix report available"
  to "Context ready", as the Batch 8 precedence says. Nothing marks the report
  as older than the package; whether to (for example by comparing it with
  `run.json`) is a product decision left open.
- A reopened work item with no readable `run.json` (idle rows) and a report
  does not auto-open the workflow: the controller's loading push reaches the
  page first and consumes the once-per-work-item open, a pre-existing lifecycle
  rule. The header still says "Fix report available" on the closed summary.
- The preview bound applies after the host has read the file whole, as with
  `issue.json` and `retrieval.json`.
- The History row's `verified` badge for a work item with a report (§37.52)
  remains a separate presentation-only follow-up.

### 37.58 Checkpoint — post-fix capability inventory (Batch 9 start)

Read from the committed tree (`fc97345`) and run against a scratch work item.
"Marks" means the command records a step mark in `run.json` (read-modify-write,
creating `run.json` when it is missing); `log` goes to a non-propagating logger
and writes no file.

| Command / tool | Inputs | Output | Writes / side effects | External action | Class | Batch 9 |
|---|---|---|---|---|---|---|
| `check-results [--strict] [--json]` | id | missing result files | creates `.ai/<id>/` if absent | — | A | no: the Fix result row already says the report exists |
| `summarize-results [--json] [--jira-comment\|--no-jira-comment]` | id | the Result Overview (report status + Reported Summary + validation checklist); JSON `fix_report`, `overview`, `jira_comment_requested` | marks `result_summary`, `manual_validation` (fail on error; a corrupt `run.json` makes it fail) | **Jira comment** with `--jira-comment` or `BUGPILOT_AUTO_JIRA_COMMENT` | B | not called: marks `run.json` in every mode and gates a Jira POST |
| `review-package` | id | the Final Review Request prompt, on stdout exactly (a template of the id: the files to use, the review focus, the verdict format) | marks `final_review_prompt`; creates `.ai/<id>/` | — | A | **yes, via a new read-only `--json`** |
| `manual-result [--overwrite]` | id | — | writes the `fix_report.md` template | — | C | no: creates the result rather than reviewing it |
| `bug --retry` / `retry-prompt` | id | — | writes `user_feedback.md`, `agent_retry_prompt.md`; marks | — | C | no: already the panel's Retry button |
| `memory update` | id | — | writes `.ai_memory/bugs/<id>.md`; marks | — | E | no: shared memory is not review |
| `jira-comment-draft [--strict]` | id | — | writes `jira_comment_draft.md`; marks | — | D | no: delivery |
| `jira-comment [--execute]` | id | preview / post result | writes `jira_comment_post_result.json` when executed; marks | **Jira POST** with `--execute` | D | no: delivery |
| `delivery-check [--json]` | id | readiness warnings | reads git; marks | — | D | no: delivery |
| `commit-plan [--no-email]` | id | the manual commit plan | reads git; marks | **email** at the commit gate unless `--no-email` | D | no: delivery |
| `push-plan` | id | the manual push plan | reads git; marks | — | D | no: delivery |
| `notify [--execute]` | id | — | writes `email_draft.md`, `notification.eml` | **SMTP** with `--execute` | D | no: delivery |
| `commit` / `push` | id | a refusal | — | — | E | no |
| MCP `check_results` | id | missing / complete | — | — | A | no (same as above) |
| MCP `summarize_results` | id | `fix_report`, `overview`, `report_excerpt` | calls `summarize_results_step`, so it marks `run.json` — its docstring said it wrote nothing (corrected in one line at the end of the batch, no behaviour change) | — | B | no |
| MCP (others) | — | prepare, refine, status, memory search, Fix Modes | — | — | E | no |

There is no MCP tool for the review prompt.

Decision. Two capabilities are useful and safe *as queries*: the final-review
prompt (A) and the validation checklist (B). Both are pure functions of the work
item id and its canonical files — the prompt is a template of the id, and the
checklist is five fixed steps plus "Regression Areas": the top ten files of
`retrieval.json` and each line of the report's Review Notes. What makes the
existing commands unsuitable for a panel button is not their content but their
wrappers: every mode marks `run.json` (a read-modify-write that would race a
same-item re-run, which Batch 8 keeps the row visible through, and a `fail`
mark would turn the History row "failed"), `review-package` creates the work
item directory, and `summarize-results` can post to Jira. So `review-package`
gains a **read-only `--json`** — the brief's option 3 — carrying the prompt and
the checklist as structured lists, built by the same functions the human
outputs render (`_build_final_review_prompt`, and the checklist that
`_build_manual_validation` renders). It creates nothing, marks nothing, logs
nothing and refuses a work item that does not exist. Human `review-package`,
`summarize-results` (both modes) and the MCP tools are unchanged. Everything in
class C, D and E stays out of the panel.

Sizes from a real run: five steps, at most ten regression files (the builder's
own cap), and one risk line per Review Notes line — the only unbounded part,
which the panel caps.

The prompt then said "Please review the completed fix for Jira issue <id>" —
"Jira issue" for a hand-written bug too, "completed fix" for an investigation,
an attempt or a no-op. Since it is one click away from the panel, it was
corrected before the checkpoint (§37.63).

### 37.59 Checkpoint — the review-prompt action

**Copy Review Prompt** on the Fix result row, after Open Fix Report. The
label is what happens: the host runs `review-package <id> --json`, copies the
`prompt` field to the clipboard exactly, and says "Review prompt copied. Paste
it into the reviewer you use." as a notification — nothing on the row changes,
nothing is persisted, no agent or terminal is started, and the prompt is
provider-neutral because it is the CLI's. While the CLI works the button is
disabled, `aria-busy`, and reads "Copying…". A failure is one error notice
("Could not prepare the review prompt: …", or "Could not copy the review
prompt: …" when the clipboard refuses); the row, the report, Fix with AI and
the run are untouched, and the button comes back either way.

Python: `review-package` gained `--json` (`cli.py`), backed by
`workflow.review_package_projection` — the prompt from `_build_final_review_prompt`
and the checklist from `validation_checklist` — which validates the id, requires
the work item directory, and creates, marks, logs and posts nothing. Failures
are one JSON object with exit 1: `INVALID_INPUT` for an id that is not one,
`WORK_ITEM_NOT_FOUND` for a missing work item (`WorkItemNotFoundError`), and the
standard mapping for a file that vanished mid-read. The human command is
unchanged, step mark included (`tests/test_review_package.py`, 8).

### 37.60 Checkpoint — the Validation checklist

`workflow.validation_checklist` is now the one source of the checklist: the five
steps, `retrieval.json`'s top ten files and the report's non-blank Review Notes
lines. `_build_manual_validation` renders its Markdown from it, byte for byte as
before (pinned), and `review-package --json` carries it as `validation.steps`,
`regression_files`, `review_risks`. The extension reads it in
`src/app/reviewPackage.ts` (`reviewPackageFromEnvelope`): lines whitespace-
collapsed and cut at 240 code points, list markers dropped from the risks, at
most eight risks with "N more in fix_report.md" (the only unbounded part in real
output; steps are five and files at most ten by construction).

The disclosure is collapsed by default and loads lazily: opening it posts
`loadValidation` once; the host shows "Loading…", then the lists (a numbered list
of steps; "Regression areas" with the files and the risks), or "Validation
checklist unavailable: …" with Retry. Opened again after it loaded, it asks
nothing. Read-only guidance: no checkbox, no tick, no colour, every line
`textContent`, and no state persisted.

### 37.61 Checkpoint — stale state and action security

`copyReviewPrompt` and `loadValidation` joined the closed `PANEL_ACTIONS`, and
the controller accepts them only while a report is on screen (`#offersPostFix`:
a work item, and `fix_report.md` in its listing) — otherwise it refuses and
logs. No generic post-fix command exists. The checklist captures an epoch
before calling the CLI; `#forgetValidation` bumps it and clears the list
whenever the work item changes, a run starts or the folder is read again (the
report may have been rewritten), and a list that arrives under an older epoch
is dropped — A's checklist never lands on B. The prompt depends on the work item
alone, so the copy checks that instead when the CLI answers: the same work item
on screen and its report still offered; a switch or a vanished report drops it
silently, while a refresh or a same-key re-run does not (dropping it there would
leave the developer pasting whatever the clipboard held before). The busy flag
is cleared by a switch or a run start, never by a refresh mid-copy. Each case is
tested with the CLI's answer held open, and each test fails without its check.
A report kept through a same-item re-run keeps its aids (the query writes
nothing, so asking mid-run is safe).

### 37.62 Checkpoint — responsive, theme and accessibility review

Harness states added: validation loading, ready, ready with long wrapping paths
and risks (and "3 more"), failed, copying, and a same-item re-run keeping the
report and its aids; with the existing report states, 38 states in dark and
light at 200, 300 and 400 px. At 300 px the two actions stack under the report
line; at 200 px "Copy Review Prompt" wraps inside its button; long paths and a
spaceless risk wrap within the column. Existing tokens only: the checklist is
plain lists in the description colour, the heading like Relevant files'
groups, the failure line in the existing error colour; no success or verify
colour. The disclosure's expanded state is native `<details>`, its body is
`aria-live="polite"` and is rebuilt only when its content changes (a push for a
Copy press or a progress event leaves it — and the focus on Retry — alone), and
the button's label is its accessible name.

### 37.63 Checkpoint — Batch 9 verification and review

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1127 passed (baseline 1117: +10 `test_review_package.py`) |
| `npm test` (extension) | 977 passed (baseline 941: +8 `reviewPackage.test.ts`, +15 controller, +11 page, +2 panel; two workflow expectations updated in place) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 10 passed (baseline 9: + review-package --json read through the extension's reader, the directory byte-identical after) |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `git diff --check` | clean; the three new files have no trailing whitespace |
| `python tests/retrieval_corpus.py` | frozen pre-Batch-3 tree: all six cases **byte-identical**. Live tree: the same summary (top-3 2/5, MRR 0.292, docs 10) |
| Visual harness | 38 states × dark/light × 200/300/400 px: 228 pages, zero horizontal overflow |

**Real flow** (a scratch copy of `sample-repo`, the working tree's CLI via
`python -m bugpilot`, the real `Controller` with a real runner and filesystem
and a recording UI port — nothing opened, launched or posted): a prepared work
item with a canonical report offered Open Fix Report and Copy Review Prompt, and
no checklist until asked; the checklist came back from the CLI with the five
steps, the two related files and the report's two Review Notes lines, the
work item's files byte-identical after; Copy Review Prompt put exactly the text
`bugpilot review-package <id>` prints on the clipboard, with the info notice;
a switch to another work item while a copy and a load were in flight left the
clipboard untouched and no row on the new item; across it all, four
`review-package --json` calls and nothing else — no terminal, no command, no
Jira, commit, push or email path, one prepare run.

**Independent review** (whole diff vs `fc97345`): no blocker. **Important,
fixed**: the checklist body — a live region — was rebuilt on every push, so a
loaded list was read out again twice around one Copy press and on every
progress event of a re-run, and focus on Retry or Load was lost; it is now
rebuilt only when its content changes (a page test fails without it). Fixed
from its minors: a copy in flight was dropped on a same-item refresh with no
word, though the prompt depends only on the id — it now survives a refresh or a
same-key re-run and is dropped only on a switch or a vanished report; a
clipboard that refused left the button on "Copying…" — it now comes back with
an error notice; an invalid id was reported as `WORK_ITEM_NOT_FOUND` — now
`INVALID_INPUT`, with a distinct `WorkItemNotFoundError` for the missing
directory; a doc comment had been separated from `#readSummary`; tests added for
a refresh during a load and during a copy, a vanished report, the clipboard
failure, and "said once" now counts; the mid-run test no longer filters out
Markdown writes.

**Resolved before the checkpoint.** The review prompt the panel copies is now
**source-neutral, outcome-neutral and provider-neutral**: it opens "Review the
BugPilot result for work item <id>." instead of "Please review the completed fix
for Jira issue <id>.", and the two review-focus items that made the same
assumptions read "Whether the result matches the reported issue" (was "…the fix
matches the Jira issue") and "Whether any source change is minimal and safe"
(was "Whether the fix is minimal and safe"). No branching and no reading of the
report: the reviewer learns the outcome from `fix_report.md`. The change is in
the canonical builder, so `review-package` and `review-package --json` still
expose byte-identical prompts (tested for a Jira key and a hand-written id,
along with the absence of "completed fix" and "Jira issue"); side effects, the
JSON contract, the clipboard and the checklist are untouched. The MCP
`summarize_results` docstring's "writes nothing" became "writes no file, only
its step mark in `run.json`" — one line, no behaviour change.

**Checkpoint review.** Each stale and gating check was removed in turn and its
test run: the checklist's epoch check (2 tests fail), the copy's report check
(1), the host's refusal with no report (1), dropping a copy on a same-item
refresh instead of keeping it (1), and the checklist body's unchanged-push skip
(1). The copy's work item check failed nothing: the switch test opened a work
item without a report, so the report check dropped A's prompt on its own. A
test now switches to a work item with its own report — Copy offered again when
A's answer lands — and fails without the work item check (+1 controller test,
test-only).

**Post-checkpoint wording cleanup** (after `5cda2cb`). Three phrases still
assumed the result was a successful fix; they are now outcome-neutral, as static
text with no branching. The Copy Review Prompt tooltip reads "…asks a reviewer to
review this result" (was "…to check this fix"); `extension/README.md` says the
prompt asks a reviewer "to review the result" (was "to check the fix"); and the
checklist's third step reads "If source changes were made, confirm they do not
affect unrelated behavior." (was "Confirm the fix does not change unrelated
behavior.") — an investigation or a no-op may change no source, and an attempt
may not be a fix. The checklist builder is shared, so `summarize-results`'
Markdown changes by that one sentence. No behaviour, state, schema or file
change. Recorded, not changed: the adjacent second step, "Confirm the failure no
longer occurs.", makes the same assumption.

### 37.64 Checkpoint — review handoff inventory (Batch 10 start)

Read from the committed tree (`58b0fef`) before any Batch 10 change. Batch 10
adds Review with AI to Fix result: the canonical review prompt, handed to the
selected agent in a terminal. What exists for Fix with AI, and what of it a
review can use:

| Piece | Where | What it does | Reusable? | Batch 10 |
|---|---|---|---|---|
| Agent selection | `form.ts`: `agent` (`auto` \| `claude` \| `custom`) and `agentCommand` (a template with `{prompt}`), in Advanced settings | the one setting; persisted with the form | yes | reused as is — no review-agent setting |
| Providers | `agents.ts` `KNOWN_AGENTS`: Claude Code only | Codex, Gemini or an in-house CLI only through a custom command | yes | unchanged; nothing invented |
| Resolution | `resolveAgent({choice, customCommand, prompt, canRun})` | `run {label, commandLine}` or `unavailable {reason}`; `canRun` probes each candidate (`--version`, then a PATH lookup); a custom template must contain `{prompt}` and its first word must be runnable | yes | reused exactly |
| Command line | inside `resolveAgent`: `flatten` (all whitespace to one space) then `quote` = `JSON.stringify` | the recorded pre-release quoting issue (§37.27 backlog): right only for text in which no shell expands anything | yes | reused exactly, behind a guard on the new input (below) |
| Terminal | `UiPort.runInTerminal(name, cwd, line)` → `createTerminal`, `show`, `sendText` | synchronous; nothing is read back | yes | reused; cwd is the repository root, as for Fix |
| Fix prompt | `#handoffText`: "Read .ai/<id>/task.md and complete the workflow." | a constant around a validated id | no | untouched |
| Busy state | `#handoffBusy`, set before the probe, cleared in `finally`; the row says "Starting AI fix…" with no button | Fix row only | no | the review has its own state |
| Outcome | `#fix` (`success` = handed over) → the row's "AI fix started" and the header's | Fix row and header | no | untouched |
| Failure | `handoffError(reason)`: `UserFacingError` "AI agent unavailable", detail = `resolveAgent`'s reason, action Open Settings; on the Fix with AI row; `#isOffered` accepts its button | the card shape and `errorCard`/`renderError` are shared | shape yes, title no | the review gets its own card, same shape |
| No agent | the handoff sentence to the clipboard, `revealAgentPanel()`, an info notice; the row "Did not start" | Fix only | no | not reused: Copy Review Prompt is the explicit clipboard path |
| Terminal failure | `runInTerminal` is not wrapped: a throw would escape `fixWithAI` | pre-existing | — | the review wraps its own call; Fix unchanged |
| Action gating | the page's `action` ids are a closed list (`PANEL_ACTIONS`); editor commands go through `#isOffered`; Batch 9's two aids check `#offersPostFix()` | `fixWithAI` is checked only for `task.md` in `#handOver`, and a second press while busy is not refused host-side (pre-existing, recorded, not changed) | pattern yes | `reviewWithAI` is checked for the report, the offer and the state |
| Diagnostics | `#resolvedAgent`: what a handoff resolved | shown in Diagnostics | yes | recorded by the review too |
| Review prompt | `review-package --json` (Batch 9): read-only, the canonical `_build_final_review_prompt` | — | — | the payload |

**The prompt, measured.** 634 characters for `JR-12345`, 682 for a
`local_…` id; 28 newlines; nothing but letters, digits, spaces, newlines and
`. , : # / _ -`. It points the reviewer at `context.md`, `retrieval.json`,
`fix_report.md` and the current diff and inlines none of them, so it is a
bounded template, not data.

**Shell decision.** The review prompt goes through `resolveAgent` unchanged —
the same `flatten` and `quote` as the Fix sentence, whose character class it
shares — so no new command line is built anywhere. Because this prompt comes
from the CLI rather than a constant in the extension, the review path refuses a
prompt holding any character outside that class (and says so on the row)
instead of quoting it: this path can never carry a `$`, a backtick, `%`, `!`,
`^`, a quote or a backslash onto a command line. A guard on the new input, not
the backlog's quoting redesign; it makes nothing worse. The terminal sees the
prompt on one line, as it would any handoff prompt; Copy Review Prompt keeps
the formatting.

**Reused vs Fix-specific.** Reused: the selection, `resolveAgent`,
`runInTerminal` and its working directory, `#resolvedAgent`, the
`UserFacingError` shape, `errorCard` and `renderError`, and Batch 9's
`review-package --json` reader. Fix-specific and untouched: `#fix`,
`#handoffBusy`, `#handoffError`, the clipboard-and-reveal fallback, the Fix with
AI row and the workflow header. Shared primitive: one private
`#resolveSelectedAgent(prompt)`, so both handoffs ask the same selection by
construction.

### 37.65 Checkpoint — the Review with AI action and its state

**Where it lives.** Fix result's third action, after Open Fix Report and Copy
Review Prompt, in the same `result-link` style — the report is what the row is
about, and Run and Fix with AI keep the only primary buttons. Under the actions,
a status region and the row's own failure card (the `errorCard` markup, id
`review-error`), then the Validation checklist. No new row, no step id, nothing
in the Running n/m count, and `overallStatus` is untouched: the header stays the
run's, the report's and Fix with AI's.

**The state** (`ReviewHandoff` in `workflow.ts`, held in the controller's
`#review`, pushed as the row's `review`):

| State | Button | Under the actions |
|---|---|---|
| none | **Review with AI** | nothing |
| `starting` | "Starting AI review…", `aria-disabled` and `aria-busy` — not `disabled`, which in Chromium takes the focus off the control | nothing |
| `started` | gone | "AI review started" / "Handed to <agent> in a terminal." |
| `failed` | **Review with AI** again, for a retry | the card: "AI review did not start", why (the prompt could not be had; it was had but not put on a command line; the agent; the terminal), Details, and Open Settings when the agent is the reason |

One busy state rather than "preparing" and "starting": the query, the probe and
the terminal are one wait from the developer's side, and one label says it.
`canStartReview` decides both the row's offer and the host's acceptance, so the
two cannot drift.

**Lifetime.** Never written, never restored. Cleared by another work item or a
reopen (`showWorkItem`), a run starting (`run`), and a refresh that no longer
lists the report; a same-item refresh with the report still there keeps it. A
second review is an explicit second press after one of those — reopening the
work item from History is enough. Copy Review Prompt remains for anything else.

**What it never touches:** Fix with AI's `#fix`, `#handoffBusy` and
`#handoffError`; the checklist; the clipboard; `fix_report.md`; `run.json`;
History. Nothing says reviewed, passed, approved or verified.

### 37.66 Checkpoint — the agent handoff

The flow, from the press: the host checks the offer (a work item, its report
listed, no review starting or started) → `starting`, pushed → `review-package
--json` (Batch 9's read-only query, 60 s) → still wanted? → a prompt that could
not be had is a `prompt` failure, one outside the plain class a `command-line`
failure (Copy Review Prompt still gives the text) → the selected agent through
`#resolveSelectedAgent` (the same `resolveAgent` call Fix with AI makes, now
shared; a probe that throws is an `agent` failure, never a button left waiting)
→ still wanted? → `unavailable` is an `agent` failure →
`runInTerminal("Review with AI · <id>", <repository root>, commandLine)`, a
throw being a `terminal` failure → `started`, with the agent's label.

- **Prompt**: exactly the query's; the controller test compares the terminal's
  command line with `claude ` + the quoted one-line form of the envelope's
  prompt. No second builder anywhere.
- **Agent**: `auto` → Claude Code when `claude` runs; `claude`; `custom` → the
  template's first word must run and `{prompt}` is replaced with the quoted
  prompt. Codex is reached the way the product already supports it, as a custom
  command; nothing is invented.
- **No agent**: the card, with Open Settings, which `#isOffered` accepts while
  the card is on screen (and refuses once it is gone). No clipboard fallback
  and no agent panel revealed: Copy Review Prompt is the explicit clipboard
  path, one button away, and a silent overwrite of the clipboard is what the
  batch brief asked not to do.
- **Diagnostics**: the resolution is recorded in `#resolvedAgent`, as Fix with
  AI's is.
- **Shell**: no command line is built outside `resolveAgent`; the plain-class
  guard (`isPlainPrompt`: letters, digits, whitespace and `. , : # / _ -`,
  opening with a letter, a digit or `#` so it can never read as an option) sits
  in front of it, pinned from both sides — the Python builder's own test and the
  integration test's real prompt.

### 37.67 Checkpoint — stale state and action security

A handoff captures `#reviewEpoch` on the press. `#forgetReview` bumps it and
clears `#review`, and runs wherever the work item changes or a run starts
(`#forgetPostFix`) and when a refresh no longer lists the report — every path
that takes the report off the listing is one of those. A refresh that still
lists it bumps nothing. After each wait — the query, then the probe —
`#reviewStillWanted(epoch)` is that comparison alone: another epoch drops the
handoff and touches nothing, since its state was reset where it changed. So A's
handoff never launches, succeeds or fails under B, a run's package is never
reviewed with the press from before it, a report that went and came back is
reviewed only by a press made for the new one, and a harmless refresh cancels
nothing.

The page asks for `{type: "action", id: "reviewWithAI"}` and nothing else — no
prompt, no agent, no command — through the closed `PANEL_ACTIONS` list; the host
refuses it unless the row is offering it, so a double press, a press while one
starts or once one started, and a press with no report are all refused
host-side whatever the page shows. There is no generic "launch an agent with
this prompt" message.

### 37.68 Checkpoint — responsive, theme and accessibility review

Ten Batch 10 states in the ignored `extension/.review/` harness — idle,
starting, started (Claude Code), started with a long custom agent name, no
agent, the prompt unavailable, a terminal that failed (Details open), a
same-item re-run keeping the report, started with the checklist expanded, and
both handoffs started — beside the 38 before: 48 states × Dark/Light Modern ×
200/300/400 px, **288 pages, zero horizontal overflow**. The probe now also
measures Fix result's parts and counts the lines its buttons take: one per line
at 200 and 300 px (the three do not fit two to a line there), two lines at
400 px, one once started.

- **Weight.** Review with AI is the same `result-link` as Open Fix Report and
  Copy Review Prompt; Run and Fix with AI keep the only primary buttons.
- **Started is not success.** "AI review started" is the row's foreground text
  and the detail is muted; no tick, no green, no status glyph on the row. The
  failure card is the one every failure uses.
- **Wrapping.** A long custom agent name wraps inside the status at 200 px; a
  Windows terminal path wraps inside Details.
- **Screen readers.** The button's label is its name and stays in words while
  busy ("Starting AI review…", `aria-busy`, `aria-disabled`). The status is a `role="status"`
  region that is always in the document — a region created as it fills is not
  reliably heard — and it and the card are rewritten only when what they say
  changed, so a progress event or a Copy press announces nothing again (a page
  test fails without that). While empty it cancels the column gap it would add,
  rather than `display: none`, which would take it out of the accessibility
  tree.
- **Focus.** Kept on the button while the handoff starts — `aria-disabled`
  rather than `disabled`, because Chromium's focus fixup sends the focus of a
  control that becomes disabled to the document — and moved once, when the
  button that has it goes because the reviewer started, to the status. Never on
  an ordinary push, never from elsewhere. The page tests' fake document now
  drops the focus of a control that becomes disabled, as Chromium does, so these
  tests cannot pass on focus a webview would lose.
- **Re-run.** With the report kept, the row offers all three actions mid-run
  and the header's Running n/m does not count it.

### 37.69 Checkpoint — Batch 10 verification and review

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1128 passed (baseline 1127: +1, the canonical prompt stays in the class Review with AI accepts) |
| `npm test` (extension) | 1024 passed (baseline 977: +23 controller, +10 page, +4 panel, +3 workflow, +3 `reviewPackage.test.ts`, +2 handoff, +2 failures; five Fix result action expectations and the "no failure card" test updated in place) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` (real CLI, temp repositories, no Jira) | 10 passed (the review-package test also checks the real prompt passes `isPlainPrompt`) |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `python tests/retrieval_corpus.py` | live tree unchanged: top-3 2/5, top-5 2/5, top-10 3/5, MRR 0.292, docs in top 5 10, terms 53 |
| `git diff --check` | clean; no untracked files; no mixed line endings |
| Visual harness | 48 states × Dark/Light × 200/300/400 px: 288 pages, zero horizontal overflow |

**Each guard, removed, fails a test.** Twenty-one mutations, each applied alone
to `controller.ts` or `panel.js`, each file restored byte for byte after
(hashes checked): the checks after the query and after the probe, the epoch
check, the refresh's epoch bump, a refresh that would cancel a valid handoff,
the host's double-press and report gates, the review card's offered button, the
plain-prompt guard, the outcome outliving its report, a switch or run keeping
it, an uncaught terminal or probe failure, a review clearing Fix with AI's card,
a clipboard fallback; on the page, the status's unchanged-push skip, the focus
move, focus taken from elsewhere, the button left pressable while starting,
`disabled` instead of `aria-disabled`, and a failure that would not open the
workflow. None was left passing. (The first run found the double-press test
could hang rather than fail when its guard was gone; it now holds every answer
the CLI owes and gives them all at once.)

**Real flow** (a scratch repository, the working tree's CLI via
`python -m bugpilot`, the real `Controller` with a real runner and filesystem, a
recording UI port and a recording agent probe — no terminal opened, no agent
run, nothing posted): two hand-written work items with reports; Review with AI
put `claude` plus exactly the quoted one-line form of `review-package --json`'s
prompt in a terminal named for the work item, at the repository root (685
characters); a custom `codex exec {prompt}` got the same prompt; with no agent,
the card with Open Settings and no terminal; a switch mid-query launched
nothing and left nothing on B; a same-item refresh mid-query did not cancel;
the work item's files byte-identical throughout; the only JSON command was
`review-package`; the clipboard untouched.

**Independent review** (whole diff vs `58b0fef`): no blocker. **Important,
fixed**: the focus handoff could not have fired in a webview — the button was
`disabled` while starting, and Chromium's focus fixup sends the focus of a
control that becomes disabled to the document, so by "started" there was no
focus to hand on; the page test passed only because its fake document kept
focus on a disabled element. The button now waits `aria-disabled` (announced
unavailable, still refused by the click handler and the host), and the fake
drops focus from a disabled control as Chromium does. **Minors, fixed**: a
report that went and came back during one query let a second press start a
second reviewer — a refresh without the report now bumps the epoch, which makes
the stale check the epoch alone; a throwing probe would have left the button
waiting — now an `agent` card; a prompt opening with `-` passed the guard — it
must now open with a letter, a digit or `#`, on both sides; the refusal said
"couldn't prepare the review prompt" for a prompt that was prepared — now its
own `command-line` cause, pointing at Copy Review Prompt; a review failure did
not open a collapsed workflow — it now does, once; tests added for a report
removed during the probe and for one that goes and comes back. **Recorded, not
changed**: Review with AI stays offered during a same-key re-run that keeps the
report, which the batch brief accepts (§30) — it reviews the report on disk,
and the docs say it may be the previous attempt's; Fix with AI still has no
host-side double-press refusal and no catch around its terminal (pre-existing,
§37.64).

### 37.70 Stabilization pass (after Batch 10, before Batch 11)

The retrospective review of Batches 1–10 (2026-09-26, at `4bf9243`) found one
blocker and a few narrow prerequisites for any review-result work. This pass
fixes exactly those — BL-1, I-2, the minimal slice of I-1, I-9 — and prepares
U-1 for a manual check. Nothing else from that review is touched.

**BL-1 — the panel's Stop and Retry did nothing.** In `parsePanelMessage`,
`case "ready"`, `case "stop"` and `case "retry"` fell through into
`case "improveHint"`, which c767ddd had inserted directly below them and which
needs a form. The page sends those three bare, so all three came back
`undefined` and `provider.ts` dropped them: the panel's Stop and Retry had been
dead since c767ddd (the palette commands worked), and the page's `ready`
handshake was lost. They now return `{ type }`. No test had crossed the parser:
the page tests check what is posted, the controller tests call `handle()`, and
the one test that compared the two did so against a hand-written list that
named all three as understood.

- `PANEL_MESSAGE_TYPES` (messages.ts): the host's list of message types — a
  `Record` over the `PanelMessage` union, so a type missing from it, or one the
  union lacks, fails to compile. `panel.test.ts` checks every `postMessage` type
  in panel.js against it (the hand-written copy is gone), and parses one
  well-formed message of every type as that type.
- `page.test.ts` wires the real page, the real parser and the real controller
  into one loop: the controller renders into the page, and whatever the page
  posts goes through `parsePanelMessage` into `controller.handle`. Ready, Run,
  Stop, Retry, Open Context, Copy, Open Fix Report, Copy Review Prompt, the
  checklist, Review with AI, Fix with AI and Improve are pressed on the page and
  must arrive and do what they do — Stop aborts the held run and the view says
  stopped; Retry runs `bug <id> --retry`. All five of these tests fail on the
  4bf9243 parser (checked by putting it back).
- Cancellation and Retry themselves are unchanged; the Retry semantics the
  review found (§ below) stay deferred.

**I-2 — Fix with AI's stale and duplicate handoffs.** `#fixEpoch`, bumped by
`#forgetFix()` whenever a work item is opened — another one, or the same one
again from History, which re-reads it — or a run starts; `#handOver` checks it
after the agent probe, and in the no-agent branch after the clipboard copy and
again after the reveal. A dropped press touches nothing: no terminal, no
clipboard, no outcome, no card, no notice. `task.md` is re-checked after the
probe — a Clean while the agent was looked for gets the same "no task.md"
answer as before it. `fixWithAI()` refuses while `#handoffBusy`, which is set
before the first wait, so the page, the palette, the History menu and the end
of a run cannot open a second terminal; only the press that set it clears it,
so a press dropped by a switch cannot free the next item's. After a finished
handoff, a deliberate second press still works, as before. Fix and Review keep
separate state and separate counters.

`showWorkItem` now drops the previous work item's Fix state, its review and
validation state and its listing *before* its first wait (reading the new
item's `run.json`). Before, a handoff or query resuming during that read was
still current — for Fix, and for Review with AI's epoch too, which only bumped
after the read. Both windows are pinned by tests that hold that read open.

**I-1 (minimal slice) — work item ids from outside a form.** One extension-side
rule, `WORK_ITEM_ID_RE` / `isWorkItemId` in form.ts, equal to `WORK_ITEM_ID_RE`
in `bugpilot/core/identity.py` (compared by a test, like the Jira key) and held
to the same answers by the shared cases in `tests/fixtures/work_item_ids.json`,
which both languages run. It is enforced:

- at `showWorkItem` — History, the saved work item and the command argument all
  arrive there — refused with a notice that does not echo the name;
- on the `started` id the CLI streams;
- in History: `historyFromPayload` drops the row before the probe, which reads
  files under `.ai/<id>/`;
- again in `fixWithAI`, before the prompt is built — unreachable now, since
  nothing invalid gets that far, and kept because the prompt gate below lets
  `.` and `/` through.

`bugpilot list` skips any folder under `.ai/` not named like a work item; it
never deletes or renames one. Found while pinning the contract: Python's three
id predicates used `re.match`, whose `$` also matches before a trailing
newline, so `"JR-12345\n"` passed `is_work_item_id` (and `cleanup`, which
deletes by that name, accepted it) while the JavaScript copy rejected it. They
use `fullmatch` now — stricter only; every id BugPilot mints still passes.

**One prompt gate for both handoffs.** `isPlainPrompt` moved from
reviewPackage.ts to agents.ts, and `resolveAgent` — the one function both Fix
with AI and Review with AI call — refuses a prompt outside the plain class
before any agent is probed (`{ kind: "refused" }`). Review with AI's own check
is gone: it shows the same `command-line` card from the plan. Fix with AI says
`skipped` with a notice — unreachable by construction, because its sentence
around a valid id is always plain; kept so a refusal can never fall into the
no-agent branch and put the prompt on the clipboard. Both canonical prompts
pass the gate (tested).

**Still not the shell fix.** Command lines are still one string, quoted with
`JSON.stringify` and parsed by whatever shell the terminal runs; PowerShell and
bash still expand `$(…)` and backticks inside double quotes, cmd `%VAR%`. What
changed is what can reach that string: validated ids, only work-item folders in
History, and one gate on every prompt. The argv/tokenized-terminal redesign
(§37.27) remains deferred.

**I-9 — what `run.json` steps mean.** Before: `summarize-results` marked
`result_summary` and `manual_validation` `pass` (both `fail` on an error), and
the human `review-package` marked `final_review_prompt` `pass` — which
`status`, `status --json` and MCP `get_status` then showed as a validation and
a review. Consumers, checked before changing anything: `config.WORKFLOW_STEPS`
(the step list — `run_to_dict` writes exactly those keys, each defaulting to
`skipped`, for all three status surfaces and for the file), the two step
functions, and tests. No extension code reads them; its only matches are
grouping labels for the old `.md` files.

Decision: `run.json` steps describe steps that ran.

| Step | Before | Now |
|---|---|---|
| `manual_validation` | `pass` when the checklist was printed | not written, not a step (removed from `WORKFLOW_STEPS`) |
| `final_review_prompt` | `pass` when the prompt was printed | not written, not a step; the human `review-package` records nothing, like `--json`, and no longer invents a `run.json` for an unknown id |
| `result_summary` | `pass` / `fail` | unchanged, and stated: `summarize-results` rendered the Result Overview, or could not — a command having run, never a verdict on the fix |

Because the status surfaces print through `run_to_dict`, an older `run.json`
that still carries the two keys shows neither, and its next write drops them.
The MCP `summarize_results` docstring says what its one mark means. History is
unchanged for the same package (tested); an old file's `fail` mark under one of
those keys would still read as failed until the file is next written —
pre-release data, not migrated.

**U-1 — the review prompt's leading `#`.** Not verified. Claude Code's local
help (2.1.214) says nothing about a `#` prefix on the prompt argument; whether
an interactive session started with `claude "# Final Review Request …"`
treats it as a memory note rather than a prompt needs one manual run with a
real agent, which this pass did not do. The canonical prompt is unchanged.

**Deferred, untouched** (the retrospective's other findings): hint-improvement
staleness, reopen and Fix Mode, the memory clobber, `jira_comment_on.flag`,
Retry's semantics, History naming, the prepare-only documentation, the
fake-DOM blind spots (only `disabled` is modelled), the argv redesign,
publishability and git history, and the broad documentation cleanup.

**Verification.**

| Check | Result |
|---|---|
| `python -m pytest -q tests` | 1162 passed (baseline 1128: +31 `test_work_item_id_contract.py`, +2 status, +1 MCP; four tests that pinned the old marks updated in place) |
| `npm test` (extension) | 1049 passed (baseline 1024: +16 controller, +4 page, +2 panel, +2 form, +2 artifacts, +1 workflow; the custom-command test now uses a plain prompt) |
| `npx tsc --noEmit` | exit 0 |
| `npm run smoke` | ok — 22 commands, 3 views, panel HTML |
| `npm run integration` | 10 passed |
| `python -m pytest -q tests/test_publishable.py` | 8 passed |
| `python tests/retrieval_corpus.py` | retrieval code unchanged: on a frozen copy of the 4bf9243 tree, every line of the report is identical with 4bf9243's code and with this code. The live summary moves with the repository it searches (MRR 0.292 → 0.295; top-3/5/10, docs and terms unchanged) |
| `git diff --check` | clean; no mixed line endings; the new files have no trailing whitespace |

Each new guard was removed in turn and its test run: the parser fall-through
(5 tests fail), the double-press refusal, the stale checks after the probe,
after the copy and after the reveal, the task.md re-check, the busy flag freed
by a dropped press, the switch dropping Fix state and review state only after
its first wait, run start keeping a handoff, `showWorkItem` and the streamed id
accepting any id, History keeping bad names, the shared prompt gate and its
leading-dash rule, Review ignoring a refusal, the id rule's end anchor, and on
the Python side the `list` filter, `fullmatch`, and each removed mark put back
— every one fails a test. One does not: Fix with AI's `refused` branch, which
no valid id can reach (above).

No rendered UI changed — no markup, style or page-script edit; the only new
words are notices — so no visual matrix was run.

**Independent review** (whole diff vs `4bf9243`): no blocker, no important
finding. Minors, all fixed: Python's `\d` also matched other scripts' digits
where JavaScript's does not (`[0-9]` in both now, with two such cases in the
shared fixture); a stale no-agent press could still reveal an agent's panel if
the switch came during the clipboard copy (a check between the two); a reopen
of the same work item drops a handoff in flight, as it resets Review with AI —
documented rather than changed; an invalid saved work item warned at every
start-up (the restore path now clears it quietly); a rejected streamed id left
no log line; a second press from the palette said nothing (an info notice
now); `npm test` strips types, so the message list is also checked against the
union's source at run time; the page loop now presses only what is offered,
includes Open Folder, and cannot hang on an already-aborted signal; a stale
file name in the fixture's comment.

### 37.71 Publishability cleanup and git history audit (after `ee48f41`)

A repository-sanitization pass, separate from the stabilization work. The
current tree is cleaned and guarded; git history was audited read-only and **not
rewritten**; nothing was pushed. Whether to rewrite history is the open
decision.

**Current tree.** A company product name and a customer name (from real ticket
text in the implementation log) became `SampleProduct` and `ExampleCustomer`.
Five likely-real ticket ids — three in docs and fixtures, two in a
canonical-plan mockup — became synthetic ones (`JR-23456`, `JR-34567`,
`JR-45678`). Distinct tickets stay distinct within each document, but one
synthetic id can stand for different originals in different documents: they are
examples, not references. Two real-looking issue titles in four workflow tests
(branch name, two slug rules, task branch) and a design doc became made-up ones
with the same slug features. The mapping itself is not recorded here: restating
the originals would put them back. `HR`, the real prefix, became `JR` in two
retrieval tests (the ids were synthetic; the tests read any id). A developer's
checkout path in the README, the demo script and two HTML guides became
`C:\path\to\sample-repo` or was dropped, and placeholder emails and a Jira
tenant on real registered domains moved to reserved example domains.
`MANIFEST.in` no longer says the tests carry real ticket numbers. No product
behaviour changed.

**The synthetic convention.** `JR` is the example prefix. A `JR-` id of one to
three digits is always an example; a longer one must be `JR-9999`, `JR-11111`,
`JR-12345`, `JR-23456`, `JR-34567`, `JR-45678`, `JR-77777` or `JR-99999`. `HR-`
is not allowed at all. Emails use `example.com/.org/.net` or the `.test`,
`.invalid`, `.example` and `.localhost` TLDs (plus the `your-company` setup
placeholder, and two role addresses: `git@` on a public forge and the commit
trailer's `noreply@`); paths use `C:\path\to\…` or `/path/to/…`, and home
directories use a generic name (`dev`, `me`, `user`, …).

**The scanner.** `tests/test_publishable.py` now scans every text file git lists
as tracked, or new and not ignored — `docs/` and `tests/` included — except
generated and vendored content (`node_modules/`, `extension/out/`, lockfiles,
the vendored codicons, the ignored visual harness) and binaries. Without git it
skips rather than walk into `node_modules/` and the private word list. Beyond
the published-surface checks (a Jira tenant with or without a scheme, an email
on any real domain, the `HR` prefix, the local company word list) it flags an
unlisted `JR` number, an upper-case key of four to six digits under any other
prefix (standards such as `ISO-8601` aside), a developer's checkout root in any
shell's spelling, a personal home directory, an internal host or private
address, and the two names known to have leaked — kept as SHA-256 digests
(obfuscation, not secrecy), matched alone or glued to a neighbour, across a line
break and inside a longer identifier too. The guard file is scanned like the
rest and must carry exactly its pinned, made-up samples; the checkout root it
needs for one is spelt in two pieces. Run over the tree at `ee48f41` it flags
all 90 disclosures this pass removed; over the cleaned tree, none. Four tests
check what it must reject and allow, what it scans, and the guard's own samples.

**History, read only.** 18 commits from one root (`64dc2f9`); `origin/main` and
`origin/feature/fix-modes` hold the first four, pushed. Every removed value is
in history — most of it in all 18 commits, so on the remote too — plus three ids
that existed only in older commits (one likely-real, two under the real prefix).
One commit message (`158d92a`, local only) carries one of the removed ids.
Separately, 33 of 36 author/committer entries use the work email domain — five
of them on three of the four pushed commits (`1062370`, `10e1d6d`, `10b148d`).
No credential was found in any blob; the credential-like literals are the known
placeholders and a dummy test token. The company's own domain appears in no file
in history. A replacement map, a commit-message replacement and a mailmap for a
future `git filter-repo` run were drafted in the audit report, not stored in the
repository; none was run.

**Packages.** The built 0.1.0 wheel and sdist carry the checkout path through
the README (`METADATA` / `PKG-INFO`); nothing else from this list shipped, since
`docs/` and `tests/` are pruned; the `.vsix` is clean. They are unpublished and
must be rebuilt anyway.

**Not changed, for a decision.** The "SampleProduct" product family: the `sample` entry in
`keywords._GENERIC_PARTS` (a retrieval rule — changing it changes ranking), the
tests that exercise it (`SampleFoo::bar`, `SampleQtExportDialog…`), the
internal-looking identifiers recorded on purpose in §37.12, `preSample12` from real
ticket text, and the `'bugpilot'` vault name in `scripts/setup-email.ps1`. Also the
personal licensor and publisher names (legal attribution, not examples).
