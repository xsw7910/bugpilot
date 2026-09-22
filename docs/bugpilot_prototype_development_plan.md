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

Fix Mode must remain repository- and domain-independent. It must not contain GDA Volume, OpenVDS, geophysical, or other product-specific knowledge. Product/domain evidence continues to come through the normal BugPilot context inputs.

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
bugpilot bug HR-12345 --fix-mode standard
bugpilot bug HR-12345 --fix-mode conservative
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
- domain independence: no GDA Volume / OpenVDS / geophysical hard-coding
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
[x] No GDA/VDS/geophysical-specific instructions are hard-coded into Fix Mode.
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
- GDA Volume/OpenVDS/geophysical-specific memory or instructions
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
| 2026-09-22 | AI Fix Mode | Complete | Six phases: model and registry, prompt integration, CLI selection and persistence, VS Code selection, custom user/project modes, MCP discovery and selection. Remaining known limitations are recorded with their phases rather than closed: manual-edit version discipline, changing the mode of a hand-written work item, and nested-directory repository discovery. |

For every later Fix Mode phase, update this table in the same change set so the original development plan remains the source of truth for both planned and completed work.
