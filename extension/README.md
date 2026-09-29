# BugPilot for VS Code

Turn a Jira bug into focused code context — the issue details, the candidate
files, the relevant git history, and a task file for your coding agent — without
leaving the editor.

The extension is a shell over the `bugpilot` CLI. It does not bundle it, and it
never hands your code to an agent by itself: it prepares the package and you
decide who reads it.

## Installing the extension

Install it from the Marketplace, or build the `.vsix` yourself from this
repository:

```powershell
cd extension
npm install
npm run package        # builds, checks the package contents, writes bugpilot-<version>.vsix
code --install-extension bugpilot-0.1.0.vsix
```

Reload VS Code afterwards. To try it without touching your normal profile:

```powershell
code --extensions-dir .\tmp-ext --user-data-dir .\tmp-data --install-extension bugpilot-0.1.0.vsix
```

## Before you start

You also need the CLI on the machine:

```powershell
pipx install bugpilot        # or: python -m pip install bugpilot

# tell it where your Jira lives, and store your credentials
bugpilot setup

# check it, and check that it speaks the machine-readable protocol
bugpilot doctor --json
```

There is no built-in Jira site: `bugpilot setup` asks for yours, or set
`JIRA_BASE_URL`. Setting credentials in the panel alone is not enough for a Jira
issue — the panel says so when the site is missing.

That last command must print a single JSON object. If it prints
`unrecognized arguments: --json`, the `bugpilot` on your `PATH` is too old —
which happens easily when an older pipx copy shadows a newer install. Upgrade
that copy in place:

```powershell
python -m pipx install --force .    # `pipx` itself is often not on PATH; the module is
```

Or run **BugPilot: Choose Executable** and point the extension at the one you
want.

Jira access is optional. A bug you describe by hand needs no credentials.

One thing to do in the repository you are fixing bugs in, before the first run:

```gitignore
.ai/
.ai_memory/
```

BugPilot writes its artifacts there, including the fetched Jira content. The
panel warns when they are not ignored, and **BugPilot: Doctor** reports it as
`ai_artifacts_ignored`.

## First run, in about five minutes

1. Open the repository you are fixing bugs in. One folder, and ideally a git
   checkout — BugPilot writes `.ai/<work-item>/` next to your code.
2. Click the BugPilot icon in the activity bar.
3. If a Jira issue: run **BugPilot: Set Jira Credentials** once (email plus an
   API token from your Atlassian account settings). They are kept in VS Code's
   SecretStorage and reach the CLI as environment variables — never in a
   command line, never in the panel.
4. In the **Issue** field, type an issue key such as `JR-12345`, or describe the
   problem in your own words. The line under the field says which it read —
   "Jira issue JR-12345" or "Bug description".
5. Press **Run** (or `Ctrl+Enter`).

That is the whole panel: one input, one button, and one list of steps.

```
Issue
[ JR-12345                                  ]
Jira issue JR-12345

[        ▶ Run        ] [ Stop ]
         Ctrl+Enter
Run prepares the issue context for AI-assisted fixing.
──────────────────────────────────────────────
Investigation & AI Fix           Running 3/6…
☑ Issue details                     ●  ⚙
  Fetch Jira issue information     Always runs
☑ Code search                32.5s  ●  ⚙
  Search relevant code in the repository
  4 keywords · 2 focus paths · max 10 files
☑ Git history                       ◌
  Find recent related changes
☑ Similar fixes
  Search for similar issues and solutions
☑ Build context                        ⚙
  Prepare structured context for AI
☐ Fix with AI                          ⚙
  Run the prepared context with your AI coding agent
  Claude Code · Standard Fix
──────────────────────────────────────────────
[ ⚙ Workflow Settings ]
```

The button under the issue is always the next step, and changes with the work
item — you never need to know what resume, retry or fresh mean to find it:

| The button says | When | Pressing it |
| --- | --- | --- |
| **Run** | Nothing is prepared yet | Prepares the context (and hands it over, if **Fix with AI** is ticked) |
| **Fix with AI** | `task.md` is ready and no agent has had it | Hands the prepared `task.md` to your agent — no second preparation |
| **Open AI Session** | An attempt has started | Brings back the terminal the agent is running in |
| **Rebuild Context** | You changed the issue, hint, keywords, focus files, Fix Mode or another preparation setting since | Prepares it again, keeping what the agent wrote |
| **Running…** | Something is in flight | Nothing — it waits |

**Stop** joins it while a run is in flight. Once there is a context, a **⋯**
button beside it holds what is not the next step: **Rebuild Context**, and —
once an attempt exists — **Start New Attempt**. Nothing is ever shown greyed
out beside it.

## Workflow Settings

Every step that has settings has a **⚙** at the end of its row — **Configure
Issue Details**, **Configure Code Search**, **Configure Build Context**,
**Configure Fix with AI**. Each opens the same **Workflow Settings** page and
scrolls straight to that step's section; **Workflow Settings** under the list
opens it at the top. Git history and Similar fixes have nothing to set beyond
their checkbox, so they have no gear.

| Section | Settings |
| --- | --- |
| Issue details | Title (a bug you describe), Attachments |
| Code search | Keywords, Focus files, Ignore paths, Max files, Max search lines |
| Build context | Delete previous artifacts first |
| Fix with AI | AI agent, custom agent command, Fix Mode, Hint |

The page edits a copy: nothing you change there is used until you press
**Apply** (or Ctrl+Enter). **Cancel**, **Back** and Escape discard the changes,
and the issue, the checkboxes and everything else on the main page stay as you
left them. Each section says whether its changes **require rebuilding
context** — after applying one that does, the button at the top becomes
**Rebuild Context**. Changing the AI agent or *Delete previous artifacts first*
does not. While BugPilot is running something, Apply waits until it finishes.

A row with settings shows a short summary of them under its description — "4
keywords · 2 focus paths · max 10 files", "Claude Code · Standard Fix" — as
counts and names only, never what you typed or a path.

## Fix Mode

**Workflow Settings → Fix with AI → Fix Mode** decides how the agent should
approach this bug. Standard Fix is the default, so most runs never need to open
the page; the choice holds while it is closed. The list comes from your
`bugpilot` install, so it shows exactly what that version can run:

| Mode | What the agent does |
| --- | --- |
| Standard Fix | Analyse, fix minimally, verify, summarise. The default |
| Conservative Fix | Minimal, low-risk changes, for legacy or sensitive code |
| Investigate First | Diagnose and build an evidence-backed fix plan — **no source changes** in this pass |
| Test-Driven Fix | Reproduce with a focused test, fix the cause, then rerun verification |
| Deep Analysis | Deeper evidence review for complex crashes, regressions, or cross-module bugs |

The choice travels with the work item: reopening one from **History**, or
typing its key, selects the mode it was prepared with — so a package prepared
as investigation only is prepared that way again unless you change it. Beside
**Workflow Settings** the panel names any mode other than Standard Fix, so a
restored choice is visible before you press **Run**. An
investigate-only mode says so beneath the dropdown, and after a run the **Fix
with AI** row's **Strategy** line names the mode the package was actually
prepared with, before you hand it over.

### Manage Fix Modes

The gear beside the dropdown opens **Manage Fix Modes**, which takes over the
panel; **‹ Back** returns you to the form with your selection intact. You
cannot edit a built-in mode, but **View** reads any of them in full, and
**Duplicate & Customize** — from the list or from what you are reading — opens a
new mode prefilled from it: its name, its description and the six instruction
sections an agent reads. Each custom mode lives in one of two scopes:

| Scope | Where it lives | Who sees it |
| --- | --- | --- |
| User | `~/.bugpilot/fix_modes/` | You, in every repository |
| Project | `.bugpilot/fix_modes/` in this repository | Everyone who checks the repository out |

A project mode with the same id shadows a user mode, which is how a team
standardises a workflow: commit `.bugpilot/fix_modes/` and the mode arrives with
the code. A mode's instructions are guidance for the agent; BugPilot's own
rules — evidence, branches, Jira, delivery, no commits — wrap every mode and are
not editable here.

## Attachments

**Workflow Settings → Issue details → Add files…** attaches anything that is not
in the repository and not in the Jira ticket: a crash log, a screenshot of the
broken dialog, a config that reproduces it.

The files are copied into `.ai/<work-item>/attachments/` and **named one by one
in `task.md`**, which is what makes the agent read them — dropping a file
into that directory by hand does nothing, because the task file lists its inputs
explicitly.

Three things worth knowing:

- **Only what arrived is listed.** A file that had been moved or deleted by the
  time the run copied it is reported to you as a warning and never mentioned to
  the agent. Being sent after a file that is not there costs the agent a turn
  and teaches it to distrust the list.
- **Whether an image can be read depends on your agent.** The task file names
  the file and asks the agent to say so plainly if it cannot open it, rather
  than guessing at the contents.
- **They land in `.ai/`.** Same as every other artifact — so the `.gitignore`
  advice above matters more once a customer's log file is in there.

At most ten files, 10 MB each.

Each step is both the choice and the outcome, and the two ends of the row say
which is which: the checkbox on the left decides whether it runs, the icon on
the right says how it went. A step that has not started shows nothing there. Untick what you do not need —
Issue details always runs, because it is the input rather than an option.

Once a step finishes, its row says what it produced, with the file it wrote as
a link on the right. **Issue details** names the issue (`issue.json`). **Code
search** counts the terms it searched and the relevant files it found
(`retrieval.json`), with **Relevant files** and **Search details** folded
beneath it. **Build context** says **Context ready** (`context.md`) and offers
**Open Context** and **Copy**. **Open Folder**, at the foot of the list, reveals
the whole work item. The list stays open after a run, because those rows are
the result; if a step fails, its card appears on that row and the rows above it
keep what they found.

**Fix with AI** is the last step, and it starts unticked. Tick it and Run does
everything above it and then hands the finished package to your coding agent in
a terminal; leave it alone and BugPilot stops once the context is ready, and the
button at the top becomes **Fix with AI** for when you want it. Either way the
row says what happened — Ready, AI fix started, Did not start — and "started"
means only that: BugPilot does not watch the agent, so it never says the fix
worked, tests passed or files changed. Which agent it hands to is **Workflow
Settings → Fix with AI → AI agent**: auto-detect, Claude Code, or a custom
command of your own (see below).

After the handoff the button is **Open AI Session**: keep talking to the agent
in its terminal. If that terminal has been closed, BugPilot says so rather than
pretending to reopen it.

When the agent writes its report, `fix_report.md`, a **Fix result** row appears
under Fix with AI: the report's first **Summary** line and its **Tests** line,
in the agent's own words, and **Open Fix Report** for the rest. It says a report
is there to read — not that the bug is fixed: an investigation-only pass, a
no-op and an attempt whose tests still fail all write the same file. BugPilot
does not watch the agent, so a report written after the handoff appears the next
time the work item is read: press **Refresh** on the Artifacts or History view,
reopen it from **History**, or reload the window. No report yet does not mean the
agent is still working; it only means nothing has been written. A re-run that is
not **Fresh** keeps the last report, so during and after it the row can show the
previous attempt's report until an agent writes a new one.

Two review aids sit under the report, both built by the CLI from the work item's
files. **Copy Review Prompt** puts a prompt on your clipboard asking a reviewer —
any assistant, or a colleague — to review the result against `context.md`,
`retrieval.json`, `fix_report.md` and the current diff; it prepares the review,
it does not run one. **Validation checklist**, collapsed until you open it,
lists what to try by hand and the regression areas: related files and the
report's Review Notes. It is guidance, not a verification — nothing is ticked,
recorded or written, and neither aid changes the run, the report or History.
Posting to Jira, committing and pushing stay separate and manual.

**Review with AI** starts a reviewer instead: the same prompt, handed to the
agent **Workflow Settings → Fix with AI → AI agent** selects — the one Fix with AI uses — in a
terminal at the repository root, where the reviewer can read those files and
the diff. The row then says **AI review started** and which agent it went to,
and that is all it knows: BugPilot does not read the reviewer's output or wait
for it, so nothing says the review finished, passed or approved anything, and
nothing is written — no review file, no change to `fix_report.md` or `run.json`,
nothing on your clipboard. It reviews the report on disk, which after a re-run
that is not **Fresh** can be the previous attempt's. The status lasts until you
open another work item, reopen this one or run again; then the button is back.
If no agent can be started, the row says why, and Copy Review Prompt still
works.

**Record Review Result** keeps what a completed review said with the work
item's files. Any review counts — Review with AI's terminal, another assistant,
a colleague, one done yesterday — because BugPilot does not know how a review
went until you tell it. Four text areas open under the row — Summary, Findings,
Validation notes, Recommendations — and you fill in what applies. On Save the
CLI writes `review_report.md`, and **Review result** appears under Fix result:
the review's first summary line and findings line, and **Open Review Report**.
It says a result was recorded — not that the review passed, that the fix is
correct, that tests ran or that its recommendations were applied. **Replace
Review Result** records a new one in its place, after asking. A **Fresh** run
removes it with the fix report; **Rebuild Context** and **Start New Attempt**
leave it, so after a new attempt it describes the earlier one until you replace
it. History is not changed by
it.

**Record Verification Evidence** keeps the checks you ran with the work item's
files: one row per check, with a name, the status you recorded — Passed,
Failed or Not Run; a new row starts as Not Run — a type, and optionally the
command or procedure, the evidence and notes. **Add Check** and **Remove
Check** change the rows. BugPilot does not run any of them, read a terminal or
watch CI: on Save the CLI writes `verification_report.md` with exactly what you
entered, and **Verification Evidence** appears under Fix result — "Recorded
checks: 2 passed, 1 failed", one line summarizing the recorded statuses, up to
five checks by name, and **Open Verification Report**. A recorded status is
about that one check; all of them passing does not mean the fix is correct.
**Edit Verification Evidence** fills the form from the report and saving
replaces it — unless the report changed since Edit was opened, which is kept
and said. While a review result or verification evidence is being recorded, no
run starts and **Clean** is refused until it ends; while Clean runs, neither
recording starts. Plain Enter in a check's name never runs the panel.
A **Fresh** run removes the report with the fix report; **Rebuild Context** and
**Start New Attempt** leave it.
History is not changed by it.

BugPilot never involves a model by itself. A step you tick is the difference:
preparing context and deciding to involve a model stay two separate acts.

The **Artifacts** view lists everything the run produced, grouped by what it is
for.

## History

The **History** view lists the work items in this repository, most recently
changed first. Each row's icon says what became of it:

| Icon | What it means | What to do next |
| --- | --- | --- |
| bug | Context is ready; nothing has acted on it | Hand it to an agent |
| document | An agent wrote `fix_report.md` — a report, not a verified fix | Read the report |
| comment | A retry is waiting on you | Describe the miss in `user_feedback.md` |
| restart | A second attempt is prepared | Hand `agent_retry_prompt.md` over |
| error | The run failed | Hover to see which step |
| circle | The run never finished | Run it again |

Hover a row for the source, when it last changed, and that sentence in full.
**Click** it to reopen the whole investigation in the panel — the six steps come
back from `run.json` and the Artifacts view follows. A Jira work item's key goes
into the Issue field (never over a bug description you are typing), **Fresh** is
cleared, and its Fix Mode is selected again, so the next Run prepares that item
as it was prepared before.

**Right-click** for the things worth doing to a past work item: open
`task.md`, copy the handoff prompt, reveal the artifacts folder, retry, or
clean it up. Each one switches the panel to that row first, so nothing happens
to a work item you cannot see.

## When a fix did not work

If the agent is still running, tell it in its terminal — **Open AI Session**
takes you there. For a clean start instead — the session ended, the approach
was wrong, a review or a check found problems — choose **⋯ → Start New
Attempt**. A form opens under Fix with AI with one optional box: *What should
the new attempt do differently?*

- Left empty, nothing is written: a new session gets the same `task.md`.
- With text, BugPilot saves it as `user_feedback.md` (replacing earlier
  feedback), builds `agent_retry_prompt.md` from it — your correction plus a
  summary of the last attempt — and hands that to the new session.

**Use Review Findings** and **Use Verification Evidence** appear in the form
when a review result, or a check recorded as Failed or Not Run, exists; they
copy that text into the box when you press them, and nothing else. Start New
Attempt reuses the prepared context — to prepare it again, use **Rebuild
Context**.

The command palette's **BugPilot: Retry After a Failed Fix** is still there: the
CLI's own two-step loop, which creates the `user_feedback.md` template for you
to fill in first.

## The AI agent

Nothing on the Workflow Settings page is needed for a normal run.

**AI agent** decides what **Fix with AI** and **Review with AI** run — one
setting for both:

| Choice | What happens |
| --- | --- |
| Auto-detect | The first known agent CLI found on `PATH`. Today that list is `claude` |
| Claude Code | `claude "<handoff prompt>"`, and nothing else is tried |
| Custom command… | Your own command line, with `{prompt}` where the handoff prompt goes |

A custom command is how you use Codex, Gemini, or an in-house agent:

```
my-agent --yolo --prompt {prompt}
```

`{prompt}` is substituted already quoted, so write it bare. BugPilot checks the
first word of the command exists before running anything. If it does not, Fix
with AI puts its prompt on your clipboard instead of opening a terminal that
prints "command not found"; Review with AI says so on the row, next to Copy
Review Prompt.

Only `claude` is in the auto-detect list because its invocation was measured on
a real install. Nobody here knows the flags of the others, and a guessed command
line fails in a terminal in a way that looks like a bug in this extension —
hence the custom template rather than our guess.

## Settings

| Setting | What it does |
| --- | --- |
| `bugpilot.executablePath` | Path to the `bugpilot` executable. Empty means resolve it through `PATH`. |

## Commands

Everything is under the **BugPilot:** prefix in the command palette. The ones
worth knowing:

| Command | When you need it |
| --- | --- |
| Check Environment | After installing or upgrading the CLI, or changing folders |
| Doctor | What the CLI thinks of this machine: Python, git, ripgrep, Jira, agents |
| Choose Executable | You have more than one bugpilot and want a specific one |
| Fix with AI | Hand the prepared package to your agent in a terminal, from anywhere |
| Open Artifacts Folder | Reveal `.ai/<work-item>/` in the explorer |
| Open Panel in Editor | The form is more comfortable in a wide editor tab |
| Clean Work Item Artifacts | Remove one work item's `.ai/` directory. Confirms first |
| MCP Status | Whether an agent in this workspace can reach bugpilot directly |
| Resume Agent Session in Terminal | Continue the agent run that happened in this repository |

## What it does not do

- **It does not launch an agent unless you ask.** Preparing context and giving
  it to a model are separate acts; the second one is the last step in the
  workflow, and it starts unticked.
- **It does not write to Jira.** No comments, no status changes.
- **It does not touch git.** No commits, no pushes.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| "bugpilot is not on PATH" | The CLI is not installed, or not in this terminal's `PATH`. Use **Install Instructions** |
| "does not support the machine-readable output this extension needs" | An older CLI is being found first. Upgrade it, or set `bugpilot.executablePath` |
| "did not answer `doctor --json` in time" | Usually a frozen executable starting cold under antivirus. Try again |
| "runs, but its environment check failed" | The CLI is fine; something it needs is not. The message names which |
| A run stops with "ran longer than BugPilot waits" | Narrow the search: ignore vendored or generated directories, or lower Max files |
| "not on PATH" after Fix with AI | The prompt is on your clipboard instead. Install an agent CLI, or set **Workflow Settings → Fix with AI → AI agent** to a custom command |
| The icons on Build context never appear | They follow the file: they arrive when `context.md` does |

The **BugPilot** output channel (**BugPilot: Show Log**) records every command
line it ran, which is the fastest way to reproduce a problem in a terminal.
