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
$env:JIRA_EMAIL="your.email@company.com"
$env:JIRA_TOKEN="your_jira_api_token"
$env:BUGPILOT_COPILOT_COMMAND="copilot"
```

Linux/macOS:

```bash
export JIRA_BASE_URL="https://yourcompany.atlassian.net"
export JIRA_EMAIL="your.email@company.com"
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


