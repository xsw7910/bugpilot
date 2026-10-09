# BugPilot for VS Code

Turn a Jira issue or a bug you describe into focused code context for your AI
coding agent — the issue details, the candidate files, the relevant git
history, and a task file — without leaving the editor.

The extension is a shell over the `bugpilot` CLI. It does not bundle it, and it
never hands your code to an agent by itself: it prepares the package and you
decide who reads it.

## Requirements

- **The BugPilot CLI, 0.1.0 or later.** The extension runs it for everything it
  prepares, and does not bundle it — see [Installing](#installing).
- **Python 3.10 or later**, for the CLI.
- **Git**, with the repository you fix bugs in checked out.
- **ripgrep** (`rg`) on `PATH`, for code search.
- Optional: **a Jira Cloud site** and an API token, to work from Jira issues. A
  bug you describe needs neither.
- Optional: **an AI coding agent** — Claude CLI, Codex CLI, the Claude or Codex
  extension, or a command of your own — for **Fix with AI** and **Review with
  AI**. Without one, BugPilot prepares the context and you hand it over.

## Installing

**The CLI.** Install it from PyPI with pipx:

```powershell
pipx install bugpilot
```

or with pip:

```powershell
python -m pip install bugpilot
```

For the MCP server as well, use `pipx install "bugpilot[mcp]"` or
`python -m pip install "bugpilot[mcp]"` instead. Then check it:

```powershell
bugpilot --version          # bugpilot 0.1.0
```

This extension needs a CLI at least as new as itself: 0.1.0 or later. It finds
the CLI on `PATH` — its absolute entries only — or at the absolute path in the
`bugpilot.executablePath` setting, which **BugPilot: Choose Executable** sets.

**The extension.** Install **BugPilot** from the Extensions view (search for
*BugPilot*), then open the repository you fix bugs in. Building it from source
is described in the repository's
[docs/development.md](https://github.com/xsw7910/bugpilot/blob/main/docs/development.md).

## Before you start

If the panel says *BugPilot CLI is out of date*, the `bugpilot` it found is
older than the extension — often an older copy that comes first on `PATH`.
Upgrade it:

```powershell
pipx upgrade bugpilot       # or: python -m pip install --upgrade bugpilot
```

Or run **BugPilot: Choose Executable** and point the extension at the one you
want.

Jira access is optional. A bug you describe by hand needs no credentials.
There is no built-in Jira site: enter yours in the panel's **Jira Setup** (see
[First run](#first-run-in-about-five-minutes)), run `bugpilot setup` in a
terminal, or set `JIRA_BASE_URL`.

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
2. Click the BugPilot icon in the activity bar. It has two views:
   **Workflow** (the panel below) and **Results** — the open work item's files
   under **Current**, every work item under **History**, and what BugPilot is
   configured with under **Diagnostics**.
3. If a Jira issue: press **Configure** on the **Jira** row in Workflow, under
   **Advanced Settings** (or run **BugPilot: Set Jira Credentials**), once.
   **Jira Setup** opens over the panel: your **Jira site**, your Atlassian
   account email and an API token, together, with **Save** and **Cancel**. The
   site is an `https://` address such as `https://your-company.atlassian.net`,
   with no user name, query or fragment; it is saved where the CLI reads it,
   `~/.bugpilot/config.toml`. If `JIRA_BASE_URL` is set in your environment,
   that is the site BugPilot uses, and the dialog shows it without letting you
   change it there. To get a token, press **Open Atlassian API tokens**, select
   **Create API token**, choose a name and an expiration date, then copy the
   new token — Atlassian shows it only once — and paste it into the dialog.
   The email and token are kept in VS Code's SecretStorage and reach the CLI as
   environment variables — never in a command line, never in the panel.
   Opening it again shows your site and email and an empty token field: leave
   the token blank to keep the one stored, or enter a new one to replace it.
   The row then says **Configured**, and its button **Replace**; with no site
   anywhere it says **No Jira site**; if Jira turns the credentials away on a
   run, it says **Authentication failed** until you replace them. Cancel or
   Escape leaves whatever was stored as it was.
4. In the **Issue** field, type an issue key such as `JR-12345`, or describe the
   problem in your own words. The field is one line until you write more, and
   grows to about four lines before it scrolls. Once you type, the right end of
   the Issue label's row says which it read — "Jira issue · JR-12345" or "Bug
   description"; only a whole key counts, so `JR-12345 crashes on save` is a
   description. An empty field says nothing there.
5. Press **Run**, directly under it (or `Ctrl+Enter`). Below Run are the
   optional settings it uses: **Fix Mode** says how the AI should approach the
   bug (Standard Fix unless you change it) and **Hint** takes any guidance you
   want it to have.

That is the whole panel: the issue, one button, the settings it uses, and one
list of steps — six quietly outlined groups, one under the other: **Issue**
(with Run and More), **Fix Mode**, **Hint** (with *Improve with AI ☑ using
Issue details*; unticked, *using Issue details* is greyed),
**Advanced Settings**, **Jira** and **Workflow Steps**.

```
┌ ⊙ Issue               Jira issue · JR-12345 ┐
│ [ jr-12345                                ] │
│ [        ▶ Run        ] [ Stop ] [ ⋯ More ] │
└─────────────────────────────────────────────┘
┌ Fix Mode                                    ┐
│ [ Standard Fix                          ▾ ] ⚙
└─────────────────────────────────────────────┘
┌ Hint                                        ┐
│ [ Add technical guidance or suspected areas ]
│ Improve with AI ☑ using Issue details       │
└─────────────────────────────────────────────┘
┌ ⚙ Advanced Settings                       › ┐
┌ 🔑 Jira  ✓ Configured               Replace ┐
┌ ▾ ☰ Workflow Steps            ( Running 3/6… )
  Issue details         <0.1s  ● Completed  ⚙
  Widget rejects the output type
  issue.json
☑ Code search           32.5s  ● Completed  ⚙
  11 terms · 6 relevant files
  4 keywords · 2 focus paths · max 10 files
  retrieval.json
☑ Git history                   ◌ Running  ⚙
  Collecting git history…
☑ Similar fixes                              ⚙
  Build context                              ⚙
☐ Fix with AI                                ⚙
  Claude CLI
──────────────────────────────────────────────
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

Usually nothing is under the button. When something there changes what the
button will do, one short line says so: *Settings changed* under **Rebuild
Context** (or *Asks before deleting artifacts*, with **Delete previous
artifacts first** ticked), *AI session started* under **Open AI Session**
when this window started the session. **Workflow Steps** gives the overall
state in brief: *Not started*, *Running 3/6…*, *Ready*, *Needs rebuild*, *Fix
report available*. What a button or a setting
does is its tooltip: hover **Run**, **Fix with AI**, **Rebuild Context**, **Fix
Mode**, **Hint** or **Issue details** (which says exactly what the improver
may read). The button's tooltip also names its shortcut,
`Ctrl+Enter`.

**Stop** joins it while a run is in flight. Beside it, always, is **⋯ More**
(just **⋯** in a very narrow sidebar). It holds **Reset Session** — see
[Starting over](#starting-over-reset-session) — and, once there is a context,
what is not the next step: **Rebuild Context**, and — once an attempt exists —
**Start New Attempt**. Nothing is ever shown greyed out beside it.

## Advanced Settings

Every step that has settings has a **⚙** at the end of its row — **Configure
Issue Details**, **Configure Code Search**, **Configure Git History**,
**Configure Similar Fixes**, **Configure Build Context**, **Configure AI
Agent**. Each opens the same **Advanced Settings** page and scrolls straight to
that step's section; the **⚙ Advanced Settings** row, under Hint, opens it at
the top.

| Section | Settings |
| --- | --- |
| Issue details | Title (a bug you describe), Attachments |
| Retrieval inputs | Keywords, Focus files — shared by the retrieval steps |
| Code search | Ignore paths, Max files, Max search lines |
| Git history | Use shared keywords, Use shared focus files, Additional commit keywords, Additional files, Search commit messages, Search related file history, History depth, Max related commits |
| Similar fixes | Use shared keywords, Additional keywords, Max similar fixes |
| Repository | Repository profile: Auto-detect, Generic or Custom (Languages, Frameworks, Application type, Build system, Test framework, Codebase notes); Project instructions |
| AI instructions | User instructions; Verification: Run relevant tests, Run existing static checks, Run full test suite, Report tests not run |
| Build context | Delete previous artifacts first |
| Fix with AI | AI Agent, custom agent command |
| Branch | Branch policy, Branch naming (and its Template) |

**Keywords** and **Focus files** are entered once, under **Retrieval inputs**,
and shared:

- **Code search** always uses both.
- **Git history** uses them too, unless you untick its **Use shared keywords**
  or **Use shared focus files**.
- **Similar fixes** uses the Keywords unless you untick its **Use shared
  keywords**, and never the Focus files — a past fix is found by its words.

Each step's own additions — Git history's **Additional commit keywords** and
**Additional files**, Similar fixes' **Additional keywords** — are used by that
step alone and never change the shared lists. **Max similar fixes** is how many
past fixes go into the context, 1 to 20; empty means 5. Retrieval inputs
belongs to no single step, so no row's gear opens it: it is the section just
above Code search.

The page edits a copy: nothing you change there is used until you press
**Apply** (or Ctrl+Enter). **Cancel**, **Back** and Escape discard the changes,
and the issue, Fix Mode, Hint, the checkboxes and everything else on the main
page stay as you left them. Fix Mode and Hint are not on this page: they are on
the main page under the issue, where you define the problem, and each setting
has exactly one place. Each section's heading is tagged **Requires rebuild** or
**Next run only** — after applying a change in a *Requires rebuild* section, the
button at the top becomes **Rebuild Context**; nothing is rebuilt until you press
it. Changing the AI Agent or *Delete
previous artifacts first* does not. What each setting does is its tooltip:
hover its label. While BugPilot is running something, Apply waits until it
finishes.

**Repository profile** says what `task.md` tells the agent about this
repository. **Auto-detect** (the default) reads high-confidence facts from the
repository's own build and package files — the line under the picker says what
it found, "Detected: C++ · Qt · CMake" — and never guesses; **Generic** assumes
nothing about languages or frameworks; **Custom** shows six short fields for the
details you provide. It is the repository's setting rather than this panel's:
**Apply** saves it in `.bugpilot/repository_profile.json` in the repository,
where the CLI and the MCP server read it too (commit it to share it), and a
profile someone else saved there is what the page shows. It needs a rebuild, and
**Reset Session** keeps it.

**Project instructions** (in Repository) and **User instructions** (in AI
instructions) are your own guidance for the AI agent, in plain text or
Markdown: the project's in `.bugpilot/instructions.md` in the repository,
shared with it (commit it to share it), and yours in
`~/.bugpilot/instructions.md`, for every repository. Each row says what its file
holds — *No project instructions configured.*, *Configured · 1,204 characters*
— and **Edit** opens its own page: Back, the title, one line on whom it applies
to, the text, **Save** and **Cancel** (Ctrl+Enter saves, Escape cancels).
Opening it creates nothing; Cancel and Back write nothing; saving empty text
removes the file. Up to 20,000 characters each — the page counts, and a longer
text is refused rather than cut. They are not part of Apply: Save writes the
file straight away. `task.md` carries them after the Repository Context, the
project's first: where the project's instructions and yours disagree, the
project's win. BugPilot's safety rules win over both — an instruction that
conflicts with them is ignored. The whole order, the earlier winning, is:
safety rules, repository context, project / team instructions (with the
Verification Policy), user instructions, Fix Mode, hint. Changing either needs a rebuild (an edit made outside the
panel is noticed at the next environment check or Run), **Reset Session** keeps
both, and the CLI and the MCP server read the same two files. Their text is
never written to the Output channel.

**Verification** (in AI instructions) is the project's Verification Policy:
what checking it expects from a fix, as four switches — **Run relevant tests**
(on), **Run existing static checks** (on), **Run full test suite** (off) and
**Report tests not run** (on). `task.md` states it in a short section beside
the project's instructions. It names no commands: the agent uses the
repository's own, and your project instructions can name them. How a given
attempt verifies is still the Fix Mode's — an investigation-only pass writes
down what it would run. Like the Repository profile it belongs to the
repository: **Apply** saves it in `.bugpilot/project_settings.json`, which the
CLI and the MCP server read too (commit it to share it). It needs a rebuild,
and **Reset Session** keeps it.

A row with settings shows a short summary of them under its description — "4
keywords · 2 focus paths · max 10 files", "shared keywords off · max 3 similar
fixes", "Claude CLI" — as counts and names only, never what you typed or a
path. Unticking Similar fixes (or Git history) skips the step and keeps its
settings for the next run.

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
panel; **Back** returns you to the form with your selection intact. Every page
that takes over the panel — Advanced Settings, Manage Fix Modes, a mode's page,
New and Edit Fix Mode — has the same header: **Back** and the page's name, kept
at the top while you scroll. Hover Back to see where it goes. The list
has three folding groups — **Built-in**, **User** and **Project** — and each
mode is one row: its icon, its name, one line of description, and a badge only
where it changes something (*Current* for the mode the form has selected,
*Investigation only*, *Overridden by project*). The mode's id and version are
not on the row.

Each built-in has its own icon — a task list for Standard Fix, a shield for
Conservative Fix, a magnifier for Investigate First, a beaker for Test-Driven
Fix, a chart for Deep Analysis — and a copy keeps the icon of the mode it was
copied from. A mode written from scratch shows a lightbulb (a magnifier if it
only investigates).

Every action is on the row, with no menu to open: **View** and **Customize
copy** for a built-in; **Edit**, **Duplicate** and **Delete** for a user or
project mode. Delete asks before it removes anything. At rest a row is just
its name, its badges and its description; point at the row, or tab into it,
and it lights up with its actions at the right end of the description line —
nothing on the row moves. In a narrow sidebar Customize copy, Duplicate and
Delete show as icons (hover one for its name). On a touch screen, where
nothing can hover, the actions are always shown.

**View** opens the mode's page: its name with a *Built-in*, *User* or
*Project* badge and its description, its action at the right — **Customize
copy** for a built-in, **Edit**, **Duplicate** and **Delete** for your own —
and its six instruction sections. Objective, Investigation, Implementation and
Verification are open; Constraints and Completion requirements start closed,
each showing its first line, and open to the full text (separate
requirements as a list). The id, version and type are under **Details**, at
the foot. You cannot edit a built-in mode, but **Customize copy** — from its
row or from its page — opens a new mode prefilled from it: its name, its
description and the six instruction sections an agent reads.

**New Fix Mode** and **Edit Fix Mode** are the same editor. Under the title it
says what you are editing (or, for a new mode, *Create a custom AI fixing
workflow.*) and which mode it was based on. **Basic info** holds the name, ID,
description, execution kind and scope; **Workflow instructions** holds the six
sections, each with its icon. Objective, Investigation, Implementation and
Verification start open; Constraints and Completion Requirements start
folded, showing their first line, and open from their header. The boxes grow
with their text. **Create Fix Mode** (new) or **Save Fix Mode** (edit),
**Preview** and **Cancel** stay at the bottom of the panel while you scroll.
A mode's ID and scope can't change once it exists, so editing shows them as
fixed; duplicate a mode to use another ID or scope. If BugPilot refuses a save
because of one field, the message appears under that field, and a folded
section holding it opens.

Each custom mode lives in one of two scopes:

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

**Advanced Settings → Issue details → Add files…** attaches anything that is not
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

## Workflow Steps

Each step is both the choice and the outcome, and the two ends of the row say
which is which: the checkbox on the left decides whether it runs; the right says
how it went, in words — **Completed**, **Skipped**, **Running**, **Failed**,
**Context ready** — with a small dot beside them (the spinner while it runs),
after how long it took. The checkbox is the row's only check mark, and the
status is said once. A step that has not started shows nothing there. Untick
what you do not need. **Issue details** and **Build context** have no checkbox:
they always run — Issue details because it is the input, Build context because
it writes the package every later step and the AI fix work from. Each row has an
icon for its step between the checkbox and the name; what the step does — and,
for those two, that it always runs — is its tooltip: hover the name or the icon.
Under a step there is only state: what it is doing or produced, a setting you
changed from its default (the agent you chose, say), a failure. The overall
state is the pill beside **Workflow Steps**. In a narrow sidebar the duration,
status and gear move under the step's name rather than squeezing it, and a name
too long for the line ends in an ellipsis.

Once a step finishes, its second line says what it produced, if that is more
than its status, with the file it wrote as a link under it. **Issue details**
shows the issue's title (`issue.json`). **Code search** counts the terms it searched
and the relevant files it found (`retrieval.json`), with **Relevant files** and
**Search details** folded beneath it. **Git history** and **Similar fixes** say
only **Completed** — their results are inside `context.md`. **Build context**
says **Context ready** (`context.md`) and offers **Open Context** and **Copy**. **Open Folder**, at the foot of the list, reveals
the whole work item. **Workflow Steps** starts open. Fold it with its triangle
and it stays folded while you work; it opens again only for something worth
seeing — a run starting, a failure's card, a work item with results being
opened — and is open again whenever the panel is rebuilt (after the sidebar was
hidden, or a window reload). If a step fails, its card appears on that row and
the rows above it keep what they found.

## Fix with AI

**Fix with AI** is the last step, and it starts unticked. Tick it and Run does
everything above it and then hands the finished package to your coding agent in
a terminal; leave it alone and BugPilot stops once the context is ready, and the
button at the top becomes **Fix with AI** for when you want it. Either way the
row says what happened — Ready, Started, Failed: Did not start — and "started"
means only that: BugPilot does not watch the agent, so it never says the fix
worked, tests passed or files changed. Which agent it hands to is **Advanced
Settings → Fix with AI → AI Agent**: Auto-detect, Codex CLI, Claude CLI, the
Codex or Claude extension, or a custom command of your own (see below).

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
item>/`, the panel and **Current** read it again within about a second,
with no reload. Only that folder is watched, not the repository; a refresh only
reads, it never prepares, searches or runs anything, and nothing you are typing
in the panel is touched by it. Showing the panel again reads the folder too, and
**Refresh** on the Results view does the same by hand. No report
yet does not mean the agent is still working; it only means nothing has been
written. A re-run without
**Delete previous artifacts first** keeps the last report, so during and after it the row can show the
previous attempt's report until an agent writes a new one.

BugPilot never involves a model by itself. A step you tick is the difference:
preparing context and deciding to involve a model stay two separate acts.

## Branch

Which branch the agent works on is **Advanced Settings → Branch → Branch
policy**. BugPilot never runs `git branch` itself; it tells the agent:

- **Use current branch** (the default): stay on the branch that is checked out
  — no new branch for every run. Only on `main`/`master` or a detached HEAD
  does the agent stop and ask before creating one, named by **Branch naming**.
- **One branch per issue**: one branch for the work item, created once and
  reused. A bug you describe yourself gets a new id on every Run, so its
  branch is named from its title instead: the same bug, the same branch.
- **Ask before editing**: the agent shows the current and the suggested branch
  and asks which to use — never staying on `main`/`master`.

Run, Rebuild Context, a retry and Start New Attempt never call for a new branch
by themselves; only this setting decides. Under every choice `main` and
`master` are never edited, committed to or pushed. The setting is written into
`task.md`, so changing it needs **Rebuild Context**; Reset Session keeps it.

**Branch naming**, below Branch policy, is the name a new branch gets under any
of them. **Default** is `feature/{issue}-{slug}` —
`feature/JR-12345-widget-rejects-the-output-type` — except that a bug you
describe is named from its title alone. **Custom template**
shows a **Template** field for the repository's own pattern, such as
`bugfix/{issue}-{slug}`. Only two placeholders are filled in: `{issue}`, the
Jira key (for a bug you describe, `bug-` and a short hash of its title, so the
same bug gets the same name), and `{slug}`, the title in lower case with
hyphens. A template must include `{issue}` — two issues with the same title, or
any two titles in a non-Latin script, would otherwise share a branch — and
only letters, digits, `.`, `_`, `-` and `/` around the placeholders; one git
could not use as a branch name is refused
when you press Apply, with the reason, and the saved one stays. A template only
names a branch: it never creates or switches one, and a work item that already
has a branch keeps it. Like the Verification Policy, it is saved for the
repository in `.bugpilot/project_settings.json`; it needs a rebuild, and Reset
Session keeps it.

## Review and verification

Two review aids sit under the **Fix result** row, both built by the CLI from
the work item's files. **Copy Review Prompt** puts a prompt on your clipboard
asking a reviewer —
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
agent **Advanced Settings → Fix with AI → AI Agent** selects — the one Fix with
AI uses — at the repository root, where the reviewer can read those files and
the diff. The prompt asks for four sections — `## Summary`, `## Findings`,
`## Validation Notes` and `## Recommendations` — tells the reviewer to keep
reading the code apart from anything it actually ran, and asks for no verdict:
not "pass", not "approved", not "safe to merge".

- **Claude CLI (chosen, or what Auto-detect found):** BugPilot runs it once,
  non-interactively (`claude -p --output-format json`), with the prompt on its
  input and no terminal. BugPilot first collects the current changes itself —
  `git status --short` and `git diff HEAD`, read-only, without the
  repository's own diff drivers, filters or hooks, bounded and said when cut —
  and gives them to the reviewer after the prompt. The reviewer can only read
  and search files: it has no shell, so it cannot run any command, edit a file
  or write anything, and neither your Claude Code settings nor the
  repository's widen that. Its reply is shown only to you, in the panel, and
  may quote any file it read. While it runs, the row says **Reviewing with Claude
  CLI…** with a spinner, that the review is read-only and in the background,
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
- **Codex CLI, or a custom agent command,** is not run for its output — only
  Claude CLI's reply is read back, and a custom command is a shell template — so
  the prompt goes to it in a terminal, the row says **AI review started**, and
  you bring the reply back with Paste Review Output.
- **The Codex or Claude extension** gets the prompt on your clipboard and its
  own view opened; the row says *BugPilot review prompt copied. Paste it into
  Codex to continue* (or Claude).

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
can fill that form too. A run with **Delete previous artifacts first** ticked removes it with the fix report;
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
A run with **Delete previous artifacts first** ticked removes the report with the fix report; **Rebuild Context** and
**Start New Attempt** leave it.
History is not changed by it.

## Results

Below Workflow, **Results** is one view with three groups: **Current**, the
files of the work item open in the panel; **History**, every work item in this
repository; and **Diagnostics**, what BugPilot is configured with. They share
one view because VS Code gives every open view the same minimum height however
little it holds, so short lists would take that space again and again.
**Refresh** in its title bar reads them all again.

**Diagnostics** starts collapsed: one row each for the **Repository** (its
name; the full path on hover), **Jira** (Configured, Not configured or
Authentication failed — the Workflow row's own words), the **AI agent** you
chose (and, once a handoff has run, what it resolved to), the **Work item**,
the **Extension**'s version and the **BugPilot CLI**'s (its executable on
hover). It only reports state the extension already holds: nothing is
checked, probed or sent when you open it. To set up Jira, use the Jira row in
Workflow; Diagnostics shows the status and says where that is.

The first time you open BugPilot, Results starts open at VS Code's own
minimum for an open view — its title and about five rows — and Workflow takes
the rest of the sidebar, however tall the window. Drag the divider between
them and VS Code keeps your sizes from then on; BugPilot never resets them.

### Current

**Current** is one flat list of the open work item's files, in the order the
workflow produces them; the Current row itself shows which work item that is,
and with none open it says *No work item selected yet.* Each row is the file
name and whether it is **Written** or **Not written yet**; hover a row for what
the file is for (a screen reader hears it with the row). Click a written file to
open it. The eight standard files are always listed, so you can see what is
still to come:

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

### History

**History** lists the work items in this repository, most recently changed
first. It is collapsed each time the window opens — expand it to see them, and
it stays open until you close it or the window; it is read only while it is
open. Each row's icon says what became of it:

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
back from `run.json` and Current follows. A Jira work item's key goes
into the Issue field (never over a bug description you are typing), **Delete previous artifacts first** is
cleared, and its Fix Mode is selected again, so the next Run prepares that item
as it was prepared before.

**Right-click** for the things worth doing to a past work item: open
`task.md`, copy the handoff prompt, reveal the artifacts folder, retry, or
clean it up. Each one switches the panel to that row first, so nothing happens
to a work item you cannot see.

## Starting over: Reset Session

**⋯ More → Reset Session** puts the panel back to a fresh session: the Issue,
the Hint, Keywords, Focus Files, attachments, the workflow steps, every Code
Search and Git History setting, Delete previous artifacts first, and Fix Mode (back to Standard Fix) —
and the work item on screen, with its results, is let go. The next button is
**Run** again, and a reload or a restart opens the fresh session too.

It keeps what is yours rather than the issue's: the **AI Agent** you chose and
its custom command, your settings, the **Repository profile** (the repository's
own), and **History**.

It asks first, with one choice about the generated files:

- **Keep generated files** (the default) leaves `.ai/<work item>/` exactly as
  it is. The work item stays in History, and clicking it there reopens it.
- **Delete generated files** permanently deletes `.ai/<work item>/` — the
  current work item's context, task, report and copied attachments — and
  nothing else: never a repository file, never another work item, never the
  memory entry. The work item leaves History with its folder. BugPilot deletes
  only a real folder inside the repository's own `.ai/`; if `.ai` or the folder
  is a link or junction, or the delete does not finish, nothing is reset and
  the dialog says why.

A BugPilot run in progress is stopped first, and a background AI review
BugPilot is running is cancelled. An agent already handed the work item keeps
running in its own terminal or extension — BugPilot cannot stop it, and the
dialog says so. While a review result or verification evidence is being saved,
Reset waits for it.

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

The command palette also has **BugPilot: Retry After a Failed Fix**: the CLI's
own two-step loop, which creates the `user_feedback.md` template for you to fill
in first.

## The AI Agent

Nothing on the Advanced Settings page is needed for a normal run.

**AI Agent** decides what **Fix with AI** and **Review with AI** run — one
setting for both. A quiet line under it says what BugPilot found on this
machine: *Detected: Codex CLI* for Auto-detect, or how the agent you chose
stands — *Available*, *Not found on PATH*, *Installed · Limited integration*,
*Not installed or disabled*.

| Choice | What happens |
| --- | --- |
| Auto-detect | The best agent this machine has, by how well BugPilot can reach it (below) |
| Codex CLI | `codex "<handoff prompt>"` in a terminal, and nothing else is tried |
| Claude CLI | `claude "<handoff prompt>"` in a terminal, and nothing else is tried |
| Codex Extension | The prompt is copied and the Codex view opened: paste it to continue |
| Claude Extension | The same, for the Claude Code extension |
| Custom command… | Your own command line, with `{prompt}` where the handoff prompt goes |

A choice you make is kept: if Codex CLI is not installed, Fix with AI says
*Codex CLI is not available* and does not start Claude instead. Only
Auto-detect chooses, and it picks, in order: the agent your last handoff
reached, if it is still there; an extension BugPilot can call directly; a CLI
on `PATH` (Claude CLI first, because Review with AI can read its answer back);
an installed extension, by clipboard; and a custom command, if you set one.

Neither extension offers a documented way for another extension to hand it a
prompt, so both are *Limited integration*: BugPilot never types into their
views. Changing the AI Agent never needs a context rebuild.

A custom command is how you use Gemini, OpenCode, or an in-house agent:

```
my-agent --yolo --prompt {prompt}
```

`{prompt}` is substituted already quoted, so write it bare. BugPilot checks the
first word of the command exists before running anything. If it does not, Fix
with AI puts its prompt on your clipboard instead of opening a terminal that
prints "command not found"; Review with AI says so on the row, next to Copy
Review Prompt.

Codex and Claude are built in because each takes the prompt as one positional
argument. Other agents' command lines differ, and a guessed one would fail in
the terminal in a way that looks like a bug in this extension, so they run
through the custom command you write.

## Settings

| Setting | What it does |
| --- | --- |
| `bugpilot.executablePath` | Absolute path to the `bugpilot` executable. Empty means find it on `PATH` — its absolute entries only, never the repository or the current folder. A relative path is refused. |

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
| Resume Agent Session in Terminal | Continue the last Claude CLI session that ran in this repository (`claude --resume`) |

## What it does not do

- **It does not launch an agent unless you ask.** Preparing context and giving
  it to a model are separate acts; the second one is the last step in the
  workflow, and it starts unticked.
- **It does not write to Jira.** No comments, no status changes.
- **It does not touch git.** No commits, no pushes.
- **It does not run programs from your repository.** `bugpilot`, `claude`,
  `codex` and `taskkill` are found on `PATH`'s absolute entries and started by
  that path; a `bugpilot.exe` in the repository is never what runs.

## Privacy

- **Generated files hold repository context.** `.ai/<work item>/` and
  `.ai_memory/` contain code excerpts, file paths, git history, attachments and
  the fetched issue text, and the prompts BugPilot builds for an agent or a
  reviewer carry the same. Keep both folders out of source control (see
  [Before you start](#before-you-start)) unless you mean to share them, and
  hand them only to an agent you would show the code to.
- **Project settings are shared; yours are not.** `.bugpilot/` in the
  repository — Project instructions, the Repository profile, the Verification
  Policy, Branch naming, project Fix Modes — is meant to be committed. User
  instructions and user Fix Modes in `~/.bugpilot/` are yours alone.
- **Jira credentials stay out of artifacts.** The token is kept in VS Code's
  SecretStorage and is never written to a generated file, the Output channel or
  a command line.

## Licence

BugPilot for VS Code is source-available, not open source, under the Business Source License 1.1 ([LICENSE.txt](https://github.com/xsw7910/bugpilot/blob/main/extension/LICENSE.txt)), with the same terms as the `bugpilot` CLI it runs. The licence lets you copy, modify, redistribute and make non-production use of it. Its Additional Use Grant adds production use for the internal purposes of you or your organization, including commercial software development and use while providing software development services to clients. Offering BugPilot, or a substantially similar product or service based on it, to third parties as a hosted, managed, embedded, redistributed or otherwise competing offering is not part of that grant and needs a separate commercial licence; for one, contact the Licensor through the [BugPilot GitHub repository](https://github.com/xsw7910/bugpilot). Each version becomes available under the Apache License 2.0 on its Change Date, or on the fourth anniversary of that version's first public release if that comes first. This is a summary; LICENSE.txt is authoritative.

The codicons icon font in `media/codicons/` is Microsoft's and is licensed CC BY 4.0, not under BugPilot's licence ([THIRD_PARTY_NOTICES.md](https://github.com/xsw7910/bugpilot/blob/main/extension/THIRD_PARTY_NOTICES.md)).

## Troubleshooting

| What you see | What it means |
| --- | --- |
| "bugpilot is not on PATH" | The CLI is not installed, or not in this terminal's `PATH`. Use **Install Instructions** |
| "does not support the machine-readable output this extension needs" | An older CLI is being found first. Upgrade it, or set `bugpilot.executablePath` |
| "BugPilot CLI is out of date" | The CLI found is older than this extension and does not accept what a Run sends. **Update Instructions** says how (`pipx upgrade bugpilot`); **Choose Executable** points at a newer one; then **Retry**. `bugpilot --version` shows which version runs |
| "BugPilot CLI was not found" during a Run | The executable went away since the panel checked. Install it, or choose it again |
| "The configured bugpilot path is not valid" | `bugpilot.executablePath` is a relative path, which BugPilot will not resolve against the repository. Use an absolute path, or leave it empty to use `PATH` |
| "The Jira site must be an https:// address" | `JIRA_BASE_URL` or the saved site is `http://`, or carries a user name, password, query or fragment. Enter `https://your-company.atlassian.net` in **Jira Setup** (or run `bugpilot jira-site set`), or fix `JIRA_BASE_URL` |
| "Jira redirected to a different site" | The Jira site answered with a redirect to a different host, scheme or port, and BugPilot did not send your credentials there. Check the site address |
| "… instructions were not included" in a run's warnings | The instructions file is a link, not UTF-8, unreadable, or longer than 20,000 characters. It was left out of `task.md` whole; fix it, or open **Edit** and save |
| "did not answer `doctor --json` in time" | Usually a frozen executable starting cold under antivirus. Try again |
| "runs, but its environment check failed" | The CLI is fine; something it needs is not. The message names which |
| A run stops with "ran longer than BugPilot waits" | Narrow the search: ignore vendored or generated directories, or lower Max files |
| "is not available" or "No supported AI agent detected" after Fix with AI | The prompt is on your clipboard instead. Install the agent, or choose another in **Advanced Settings → Fix with AI → AI Agent** |
| The icons on Build context never appear | They follow the file: they arrive when `context.md` does |

The **BugPilot** output channel (**BugPilot: Show Log**) records every command
line it ran, which is the fastest way to reproduce a problem in a terminal. What
you typed and what Jira returned are never in it: a description, title, hint,
keywords and paths show as `<redacted>`, and for Fix with AI and Review with AI
it names the agent, never the prompt or a custom command — so the log is safe
to paste into an issue.
