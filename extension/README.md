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

The warning's **Add to .gitignore** button does it for you. It adds only the
rule git says is missing — a `.ai` or `/.ai/` you already have counts, as it
does for git — to the `.gitignore` at the repository root, creating the file if
there is none. Your existing lines, comments and line endings stay as they are;
the new lines go at the end. Pressing it twice adds nothing the second time.
BugPilot then asks git again, and the warning goes only once git ignores both
folders. If `.gitignore` is open with unsaved changes, the lines go into the
editor and you save them; nothing is written behind your edits.

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
   "Jira issue JR-12345" or "Bug description". Under it, **Fix Mode** says how
   the AI should approach the bug (Standard Fix unless you change it) and
   **Hint** takes any guidance you want it to have; both are optional.
5. Press **Run** (or `Ctrl+Enter`).

That is the whole panel: the problem — issue, Fix Mode, hint — one button, and
one list of steps.

```
Issue
[ Enter a Jira ticket (e.g. JR-12345) or describe the bug ]
Use a Jira issue ID, or describe the problem directly.
Jira issue JR-12345

Fix Mode
[ Standard Fix                            ▾ ] ⚙
Hint
[ e.g. Check initialization logic…          ]
☑ Use issue details   Improve

[        ▶ Run        ] [ Stop ]
         Ctrl+Enter
Run prepares the issue context for AI-assisted fixing.
──────────────────────────────────────────────
Investigation & AI Fix                Running 3/6…
☑ Issue details         <0.1s  ● Completed  ⚙
  JR-12345 · Jira issue
  issue.json
☑ Code search           32.5s  ● Completed  ⚙
  11 terms · 6 relevant files
  4 keywords · 2 focus paths · max 10 files
  retrieval.json
☑ Git history                   ◌ Running
  Collecting git history…
☑ Similar fixes
  Search for similar issues and solutions
☑ Build context                              ⚙
  Prepare structured context for AI
☐ Fix with AI                                ⚙
  Run the prepared context with your AI coding agent
  Claude Code
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
| Fix with AI | AI agent, custom agent command |

The page edits a copy: nothing you change there is used until you press
**Apply** (or Ctrl+Enter). **Cancel**, **Back** and Escape discard the changes,
and the issue, Fix Mode, Hint, the checkboxes and everything else on the main
page stay as you left them. Fix Mode and Hint are not on this page: they are on
the main page under the issue, where you define the problem, and each setting
has exactly one place. Each section says whether its changes **require
rebuilding context** — after applying one that does, the button at the top
becomes **Rebuild Context**. Changing the AI agent or *Delete previous artifacts
first* does not. While BugPilot is running something, Apply waits until it
finishes.

A row with settings shows a short summary of them under its description — "4
keywords · 2 focus paths · max 10 files", "Claude Code" — as counts and names
only, never what you typed or a path.

## Fix Mode

**Fix Mode**, on the main page under the issue, decides how the agent should
approach this bug. Standard Fix is the default, so most runs leave it alone.
Changing it is a change to what is prepared: once a context exists, the button
becomes **Rebuild Context**, as it does for the issue or the hint. The list
comes from your `bugpilot` install, so it shows exactly what that version can
run:

| Mode | What the agent does |
| --- | --- |
| Standard Fix | Analyse, fix minimally, verify, summarise. The default |
| Conservative Fix | Minimal, low-risk changes, for legacy or sensitive code |
| Investigate First | Diagnose and build an evidence-backed fix plan — **no source changes** in this pass |
| Test-Driven Fix | Reproduce with a focused test, fix the cause, then rerun verification |
| Deep Analysis | Deeper evidence review for complex crashes, regressions, or cross-module bugs |

The choice travels with the work item: reopening one from **History**, or
typing its key, selects the mode it was prepared with — so a package prepared
as investigation only is prepared that way again unless you change it — and
the dropdown shows the restored choice before you press **Run**. An
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
which is which: the checkbox on the left decides whether it runs; the right says
how it went, in words — **Completed**, **Skipped**, **Running**, **Failed**,
**Context ready** — with a small dot beside them (the spinner while it runs),
after how long it took. The checkbox is the row's only check mark, and the
status is said once. A step that has not started shows nothing there. Untick
what you do not need — Issue details always runs, because it is the input
rather than an option. In a narrow sidebar the duration, status and gear move
under the step's name rather than squeezing it.

Once a step finishes, its second line says what it produced, if that is more
than its status, with the file it wrote as a link under it. **Issue details**
names the issue (`issue.json`). **Code search** counts the terms it searched
and the relevant files it found (`retrieval.json`), with **Relevant files** and
**Search details** folded beneath it. **Git history** and **Similar fixes** say
only **Completed** — their results are inside `context.md`. **Build context**
says **Context ready** (`context.md`) and offers **Open Context** and **Copy**. **Open Folder**, at the foot of the list, reveals
the whole work item. The list stays open after a run, because those rows are
the result; if a step fails, its card appears on that row and the rows above it
keep what they found.

**Fix with AI** is the last step, and it starts unticked. Tick it and Run does
everything above it and then hands the finished package to your coding agent in
a terminal; leave it alone and BugPilot stops once the context is ready, and the
button at the top becomes **Fix with AI** for when you want it. Either way the
row says what happened — Ready, Started, Failed: Did not start — and "started"
means only that: BugPilot does not watch the agent, so it never says the fix
worked, tests passed or files changed. Which agent it hands to is **Workflow
Settings → Fix with AI → AI agent**: auto-detect, Claude Code, or a custom
command of your own (see below).

After the handoff the button is **Open AI Session**: keep talking to the agent
in its terminal. It brings that terminal forward and says **AI session
focused** under the button for a moment — also when the terminal was already in
front, so a press never looks like it did nothing. It never starts a session or
a second terminal: if that terminal has been closed, the line says **AI session
is no longer available** and points to ⋯ → Start New Attempt.

When the agent writes its report, `fix_report.md`, a **Fix result** row appears
under Fix with AI: the report's first **Summary** line and its **Tests** line,
in the agent's own words, and **Open Fix Report** for the rest. A long summary
shows its first three lines with **Show more** under it, and **Show less** to
fold it again; a new report starts folded. It says a report
is there to read — not that the bug is fixed: an investigation-only pass, a
no-op and an attempt whose tests still fail all write the same file. BugPilot
does not watch the agent, but it does watch the work item's folder: when the
agent — or anything else — writes, changes or deletes a file in `.ai/<work
item>/`, the panel and the Artifacts view read it again within about a second,
with no reload. Only that folder is watched, not the repository; a refresh only
reads, it never prepares, searches or runs anything, and nothing you are typing
in the panel is touched by it. Showing the panel again reads the folder too, and
**Refresh** on the Artifacts or History view does the same by hand. No report
yet does not mean the agent is still working; it only means nothing has been
written. A re-run that is
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

After a fix, the flow is **Review with AI** → **Review Result** →
**Verification Evidence**. Review and verification are kept apart on purpose: a
review is what a reviewer said about the change; verification evidence is what
you actually ran or tried, and what you saw.

**Review with AI** starts a reviewer instead, with the same prompt and the
agent **Workflow Settings → Fix with AI → AI agent** selects — the one Fix with
AI uses — at the repository root, where the reviewer can read those files and
the diff. The prompt asks for four sections — `## Summary`, `## Findings`,
`## Validation Notes` and `## Recommendations` — tells the reviewer to keep
reading the code apart from anything it actually ran, and asks for no verdict:
not "pass", not "approved", not "safe to merge".

- **Claude Code (Auto-detect or Claude Code):** BugPilot runs it once,
  non-interactively (`claude -p --output-format json`), with the prompt on its
  input and no terminal. The reviewer can read files and run `git diff`,
  `git status`, `git log` and `git show`, and nothing else: it cannot edit
  files or run other commands, and neither your Claude Code settings nor the
  repository's widen that. While it runs, the row says **Reviewing with Claude
  Code…** with a spinner, that the review is read-only and in the background,
  and how long it has been running (*Elapsed: 00:18*) — no percentage, because
  the agent reports none, and none of its tool output. **Show details** says
  which agent, the mode, when it started and the four sections it will return.
  **Cancel Review** asks first (*Cancel Review* / *Keep Reviewing*; Escape
  keeps it running), then ends the reviewer and everything it started, keeps
  nothing it printed, saves nothing, and offers Review with AI again for the
  same fix. A reviewer that runs past 15 minutes is stopped and said as
  *AI review did not finish within the allowed time*. When its
  reply has the four sections, the Review Result form opens filled in, marked
  *Prefilled from AI review — review before saving*, and the row says **Review
  result ready to save** — nothing is saved until you check it and press
  **Save Review Result**. If the reviewer exits without such a reply, the row
  says *Review result could not be captured automatically* or *AI review did
  not produce a usable structured result*, with the reason, and **Paste Review
  Output** is the way on (a reply that only needs a heading fixed is already in
  the box). Nothing is ever read from a terminal.
- **A custom agent command** (Codex included) is never run for its output: it
  is a shell template, so the prompt goes to it in a terminal as before, the
  row says **AI review started**, and you bring the reply back with Paste
  Review Output.

Review with AI is offered once per fix. It disappears as soon as a reviewer
starts, and stays hidden for that fix — through a reload, a reopen, saving a
review result, adding verification evidence, a settings change, Rebuild
Context, or Start New Attempt on its own. It comes back when the fix report
changes: a new attempt's `fix_report.md`, with different content, is a new fix
to review. If the reviewer never started — no agent, a prompt that could not be
had — the row says why and the button stays. BugPilot remembers which fix was
reviewed in VS Code's workspace state, not in the repository; the reviewer's
unsaved reply is kept only while the window is open.

**Paste Review Output** brings a reviewer's reply back by hand — from the
terminal, another assistant, or a colleague. Paste it into the box that opens,
and press **Parse**: BugPilot reads
the four sections — headings matched case-insensitively, anything inside a code
fence left as code, a lead-in before `## Summary` left out and said so — and
fills in the Review Result form, marked *Prefilled from structured review
output — review before saving*. Nothing is saved yet: check and edit the text,
then press **Save Review Result**. A reply in any other shape, with a section
missing or repeated, or too long, is refused with the reason, and the pasted
text stays for you to fix. Nothing is read into it: "PASS" or "LGTM" in the
reply is kept as the reviewer's words, never turned into a status.

**Add Review Result** is the same form, empty, for a review you type yourself.
Any review counts — Review with AI's terminal, another assistant, a colleague's
code review, one done yesterday — because BugPilot does not know how a review
went until you tell it. Four text areas open under the row — Summary (the
overall conclusion in the reviewer's words), Findings (problems, risks,
omissions, observations), Validation Notes (what the reviewer actually
inspected or ran — not tests that did not run) and Recommendations (next
actions) — and you fill in what applies. On **Save Review Result** the CLI
writes `review_report.md`, and **Review result saved** appears under Fix result:
the review's first summary line and findings line, and **Open Review Report**.
It says a result was saved — not that the review passed, that the fix is
correct, that tests ran or that its recommendations were applied. **Replace
Review Result** saves a new one in its place, after asking; Paste Review Output
can fill that form too. A **Fresh** run removes it with the fix report;
**Rebuild Context** and **Start New Attempt** leave it, so after a new attempt
it describes the earlier one until you replace it. History is not changed by
it.

**Add Verification Evidence** keeps the checks you actually performed with the
work item's files — not what a reviewer noticed while reading the change, which
belongs in the review result. One row per check, with a name (what was
checked), the status you are recording — Passed, Failed or Not Run; a new row
starts as Not Run — a type (Automated, Manual or Other), and optionally the
command you ran or the steps you followed, the evidence you observed and notes.
The fields show examples such as *Targeted unit tests · npm test · 1285 passed,
0 failed* as placeholders; they are never saved. **Add Check** and **Remove
Check** change the rows. BugPilot does not run any of them, read a terminal or
watch CI. There is no Save button: the form saves itself about three quarters
of a second after you stop typing — the CLI writes `verification_report.md`
with exactly what you entered — and a small line under the form says
**Unsaved changes**, **Saving…** or **Saved**. Nothing is written while the
form is empty or a check has no name yet (the line says which), and a blank
row from Add Check is left out; removing every check keeps the report already
saved. **Done** closes the form, saving anything still waiting first. If a save
fails, the line says *Could not save verification evidence* with the reason,
the form keeps what you typed, and **Retry Save** tries again. If
`verification_report.md` was changed outside the form, nothing is written over
it: auto-save stops, and you choose **Reload Saved Version** or **Overwrite
Saved Version**. Opening another work item or starting a run saves the form
first, and asks before losing changes that could not be saved. Review Result is
different on purpose: it is a reviewer's conclusion, and it is saved only when
you press Save Review Result. Saved evidence appears under Fix result —
"Recorded checks: 2 passed, 1 failed", one line summarizing the recorded
statuses, up to five checks by name, and **Open Verification Report**. A
recorded status is about that one check; all of them passing does not mean the
fix is correct. **Edit Verification Evidence** fills the form from the report,
and your changes replace it as they are saved. While a review result or verification evidence is being recorded, no
run starts and **Clean** is refused until it ends; while Clean runs, neither
recording starts. Plain Enter in a check's name never runs the panel.
A **Fresh** run removes the report with the fix report; **Rebuild Context** and
**Start New Attempt** leave it.
History is not changed by it.

BugPilot never involves a model by itself. A step you tick is the difference:
preparing context and deciding to involve a model stay two separate acts.

The **Artifacts** view is one flat list of the work item's files, in the order
the workflow produces them. Each row is the file name and whether it is
**Written** or **Not written yet**; hover a row for what the file is for (a
screen reader hears it with the row). Click a written file to open it. The
eight standard files are always listed, so you can see what is still to come:

| File | What it is for |
| --- | --- |
| `issue.json` | Issue details or manual bug description |
| `context.md` | Prepared context used by the AI |
| `task.md` | AI task and fix instructions |
| `fix_report.md` | Summary of the AI fix and changes |
| `review_report.md` | Saved review findings |
| `verification_report.md` | Recorded verification checks |
| `retrieval.json` | Investigation and retrieval details |
| `run.json` | Workflow execution metadata |

Files a run writes only sometimes — `user_feedback.md`, `agent_retry_prompt.md`,
Jira and email drafts — appear after them once they exist, and any other file
in the folder is listed last as an additional BugPilot artifact.

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
when a saved review result, or a check recorded as Failed or Not Run, exists;
they copy that text into the box when you press them, and nothing else. A
pasted review that has not been saved is not used. Start New
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
