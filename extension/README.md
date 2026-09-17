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
4. Type an issue key such as `JR-12345`, or switch the input source to **Bug
   description** and describe the problem in your own words.
5. Press **Run** (or `Ctrl+Enter`).

That is the whole panel: one input, one button, and one list of steps.

```
[Jira issue] [Bug description]

Issue key
[ JR-12345                                  ]

[        ▶ Run        ] [ Stop ]
         Ctrl+Enter
Prepare context and optionally fix with AI.
──────────────────────────────────────────────
Investigation & AI Fix           Running 3/6…
☑ Issue details                        ●
  Fetch Jira issue information     Always runs
☑ Code search                   32.5s  ●
  Search relevant code in the repository
☑ Git history                          ◌
  Find recent related changes
☑ Similar fixes
  Search for similar issues and solutions
☑ Build context      [↗] [⧉] [🗀]
  Prepare structured context for AI
☐ Fix with AI
  Run the prepared context with your AI coding agent
──────────────────────────────────────────────
▸ Advanced settings (optional)
```

**Stop** joins Run in that row while a run is in flight, and **Retry** once a
prepared attempt exists. Neither is ever shown greyed out.

## Attachments

**Advanced settings → Attachments → Add files…** attaches anything that is not
in the repository and not in the Jira ticket: a crash log, a screenshot of the
broken dialog, a config that reproduces it.

The files are copied into `.ai/<work-item>/attachments/` and **named one by one
in `agent_task.md`**, which is what makes the agent read them — dropping a file
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

When **Build context** finishes, three icons appear on its own row: open the
generated context, copy the handoff prompt, reveal the artifacts folder.

**Fix with AI** is the last step, and it starts unticked. Tick it and Run does
everything above it and then hands the finished package to your coding agent in
a terminal; leave it alone and BugPilot stops once the context is ready. Which
agent it hands to is **Advanced settings → AI agent**: auto-detect, Claude Code,
or a custom command of your own (see below).

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
| verified | An agent wrote `fix_summary.md` | Read the summary |
| comment | A retry is waiting on you | Describe the miss in `user_feedback.md` |
| restart | A second attempt is prepared | Hand `agent_retry_prompt.md` over |
| error | The run failed | Hover to see which step |
| circle | The run never finished | Run it again |

Hover a row for the source, when it last changed, and that sentence in full.
**Click** it to reopen the whole investigation in the panel — the six steps come
back from `workflow_status.json` and the Artifacts view follows.

**Right-click** for the things worth doing to a past work item: open
`agent_task.md`, copy the handoff prompt, reveal the artifacts folder, retry, or
clean it up. Each one switches the panel to that row first, so nothing happens
to a work item you cannot see.

## When a fix did not work

Press **Retry**, which appears under **Run** once a prepared attempt exists. The first press creates `user_feedback.md` and opens it —
describe what the previous attempt got wrong, save, and press Retry again. That
second press builds `agent_retry_prompt.md`, which carries your correction plus
a summary of the last attempt.

This is deliberately two steps: handing an agent an unfilled template defeats
the only purpose of the loop.

## Advanced settings

Collapsed, and nothing in it is needed for a normal run: Title, Hint, Keywords,
Focus files, Ignore paths, Max files, Max search lines, the AI agent, and
whether to delete previous artifacts first.

**AI agent** decides what **Fix with AI** runs:

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
first word of the command exists before running anything, and if it does not,
the prompt goes to your clipboard instead of a terminal printing
"command not found".

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
| "not on PATH" after Fix with AI | The prompt is on your clipboard instead. Install an agent CLI, or set **Advanced settings → AI agent** to a custom command |
| The icons on Build context never appear | They follow the files: they arrive when `bug_context.md` and `agent_task.md` do |

The **BugPilot** output channel (**BugPilot: Show Log**) records every command
line it ran, which is the fastest way to reproduce a problem in a terminal.
