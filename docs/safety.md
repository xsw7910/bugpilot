# Safety

bugpilot prepares an AI-ready task package from a Jira bug and then hands it to a coding agent (Claude by default) that runs under the developer's supervision. bugpilot itself never commits, pushes, merges, or opens PRs; the agent stops at the commit gate; and the developer remains in control of source changes and delivery. Pass `--prepare-only` to stop after preparation and launch no agent.

## Rules
- bugpilot does not modify product source code.
- bugpilot does not update Jira.
- bugpilot Jira access is read-only.
- bugpilot does not comment on, assign, close, or transition Jira issues.
- `jira-comment-draft` generates a local markdown draft only; it does not post to Jira.
- `jira-comment` previews by default and posts only when `--execute` is explicitly provided.
- `summarize-results` does not post to Jira by default. It posts one analysis comment only when opted in — either `--jira-comment` on the command, or the environment variable `BUGPILOT_AUTO_JIRA_COMMENT` set to a truthy value. `--no-jira-comment` always wins. This is intended so Jira notifies watchers by email once the fix results are ready, before the developer decides whether to commit.
- Auto-posting from `summarize-results` adds exactly one Jira comment (same scope limits as `jira-comment --execute`); a Jira/network failure is non-fatal and never fails `summarize-results`.
- `jira-comment --execute` only adds one Jira comment; it does not update fields, transition status, assign issues, upload attachments, download attachments, call an agent, or run git commands.
- `notify` previews by default (writes `.ai/<issue>/email_draft.md` and a portable `notification.eml`) and sends only when `--execute` is explicitly provided.
- Automatic sending uses Microsoft Graph when configured, otherwise SMTP; if neither is configured, `notify`/`commit-plan` still succeed and report that no email was sent, and the `.eml` can be sent manually via `scripts/send-via-outlook.ps1` (Outlook).
- `commit-plan` sends the notification email at the commit gate only when a transport is configured through the environment; `--no-email` suppresses it.
- The notification email contains only the fix summary (Jira item, original problem, root cause, changes made) assembled from local artifacts, is sanitized to redact secret-like values, and is sent only to `BUGPILOT_EMAIL_TO`.
- SMTP passwords and Graph client secrets are read from environment variables only; bugpilot never hardcodes, logs, or persists them, and error messages never include the secret.
- `bugpilot setup` saves the Jira email and API token to `~/.bugpilot/config.toml` (the API token in plaintext for now, with file permissions tightened to `600` where the OS supports it). Environment variables (`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_TOKEN`) override the file. The Jira site is asked for and saved alongside them (`bugpilot jira-site set`, or the VS Code extension's Jira Setup, changes only the site; the extension keeps the email and token in VS Code's SecretStorage instead) — there is deliberately no built-in default, because a package anyone can install must not ship one company's tenant as everyone's default, nor disclose the hostname. Token storage is behind a seam so it can later move to the Windows Credential Manager.
- Sending the notification email does not modify source code, Jira, or git state.
- `retry-prompt` and `manual-result` generate local markdown artifacts only.
- `retry-prompt` does not call an agent; the developer runs their agent manually.
- `manual-result` does not inspect or modify product source code.
- Generated agent instructions may offer optional assisted delivery, but the agent must ask for explicit approval before any commit or push.
- By default the generated `task.md` does NOT instruct the agent to write Jira. Pass `--jira-comment` to `bugpilot` (or `agent-task` / `prompt`) to add an instruction to post one Jira status comment (via `bugpilot jira-comment --execute`) after writing the fix report and before commit, so watchers are notified while the developer still controls the commit; the choice is recorded per issue and survives `--resume`.
- The agent must never push main/master, force push, commit `.ai/` or `.ai_memory/`, transition Jira, assign Jira, or change Jira fields. The only Jira write the agent may make is the single status comment above, and only when `--jira-comment` was requested.
- bugpilot does not download Jira attachments; it records attachment metadata only.
- bugpilot does not create pull requests.
- bugpilot does not merge.
- bugpilot does not run `git add`.
- bugpilot does not run `git commit`.
- bugpilot does not run `git push`.
- Commit and push execute commands are placeholders only in this prototype.
- Generated artifacts live under `.ai` and `.ai_memory`.
- The developer reviews context, runs their AI agent manually, validates changes, and performs delivery actions manually.
- `bugpilot clean <ISSUE>` deletes only `.ai/<issue>/`.
- `bugpilot clean <ISSUE> --include-memory` also deletes only `.ai_memory/bugs/<issue>.md`.
- `bugpilot <ISSUE> --fresh` performs the same scoped cleanup before running the workflow; without `--fresh` nothing is deleted.
- `bugpilot <ISSUE>` (and `--resume`, which says so explicitly) preserves existing `.ai/<issue>/` artifacts.
- Cleanup never deletes through a symbolic link or junction: if `.ai`, `.ai/<issue>` or `.ai_memory` is one, `clean` and `--fresh` refuse and delete nothing.
- Writes follow the same rule: every file bugpilot (or the VS Code extension) writes under `.ai/<issue>/` or `.ai_memory/bugs/` goes only into real directories inside the repository, checked component by component and again after creating one, and never through a link at the file itself. A refusal writes nothing and names only the repository-relative path. Work-item ids that could leave `.ai/` are refused.
- The files bugpilot writes atomically — the work item's artifacts in `.ai/` and `.ai_memory/`, the repository's `.bugpilot/` files, and the user's own instructions and Fix Modes — go through a temp file created new in the same folder (exclusive create, an unpredictable name), so a link planted at a temp name is never written through. Their permissions on Linux and macOS: a file bugpilot creates is owner-only (`600`); a file it rewrites keeps the permission bits it had, set on the new file's descriptor and never by path — so bugpilot never widens or narrows a file's permissions, and never carries a setuid, setgid or sticky bit. A team file bugpilot creates in a checkout that other accounts share is readable only by its creator until someone widens it; Git records it as `644` either way. On Windows, file permissions are not changed. The Jira credentials file is always `600` (above).
- Programs are never started from the repository: `git`, `rg` and agent CLIs (and, in the extension, `bugpilot`, `claude`, `codex` and `taskkill`) are resolved on `PATH`'s absolute entries only — not the current directory, which Windows searches first — and run by that absolute path. A relative `bugpilot.executablePath` is refused rather than resolved against the repository. Children and terminals get `NoDefaultCurrentDirectoryInExePath=1`.
- Jira credentials go only to an `https://` site with no user name, password, query or fragment, and redirects are followed only within that site (scheme, host and port); a cross-site or downgrading redirect is refused before the new host is contacted. There is no "allow insecure" switch. The token never appears on a command line, in an artifact, in a log or in an error message.
- Review with AI's captured Claude review runs without a shell or any editing tool (`--tools Read Grep Glob`, `--permission-mode dontAsk`, no settings sources, no MCP servers): it cannot run a command or write a file. bugpilot collects the current `git status` and `git diff` itself, read-only, and gives them to the reviewer. `Read` can open any file the developer can, and the reply, shown only in the panel, may quote it.
- The hint improver runs Claude with no tools at all (`--tools ""`) or Codex in its read-only sandbox, in an empty temporary folder.
- User Instructions (`~/.bugpilot/instructions.md`), Project / Team Instructions (`<repo>/.bugpilot/instructions.md`) and the Verification Policy refine how the agent works. `task.md` writes BugPilot's safety rules unchanged and before them, no file can delete or replace them, and the task tells the agent to resolve a conflict in the safety rule's favour and record it in its review notes. This is an instruction the agent is asked to follow, not something BugPilot can enforce on it: review its changes before committing. Their content is never logged.
- The Verification Policy file (`<repo>/.bugpilot/verification.md`) follows the instruction files' rules: UTF-8, at most 20,000 characters, read and written only as a real file inside the repository (never through a link or junction), written atomically, rendered inside its own section so its headings cannot pose as BugPilot's. Its front matter is parsed strictly; a file that cannot be used is reported and never reinterpreted, and BugPilot's default policy applies. Lines that look like they ask for something a safety rule forbids — force push, committing or pushing without approval, staging `.ai/`, ignoring the safety rules, claiming tests that did not run, hiding failures — get a non-blocking warning in `bugpilot verification show` and in run warnings. The warning is a hint, not a complete check: the policy is kept as written, and the safety rules still apply. Whatever a policy says, "never claim a test or check ran unless it did" is a BugPilot rule, not the policy's.
- The AI Behavior file (`<repo>/.bugpilot/ai_behavior.md`, 0.1.4) follows the same file rules and front-matter parser. It only adds to BugPilot's default conventions — it cannot remove them — and its additions are rendered inside the task's `## AI Behavior` section, below BugPilot's rules, with their headings held below the task's own. A file that cannot be used is left out whole and the defaults apply; reading never creates it. Its non-blocking warnings (the Verification Policy's rule-conflict hints, headings named like a Fix Mode section, lines about running tests) name a line number, never the line, and are hints, not a complete check. Like the instructions, it is an instruction to the agent, not something BugPilot can enforce. Its content is never logged; the extension holds only its source and hash.
- `bugpilot task-preview` (0.1.4) is read-only: it renders the task through the run's own code and writes nothing — no `.ai/` folder, no `issue.json` (it does not record a branch name, as writing a task does), no policy file — starts no process and contacts no Jira. Its JSON says where each policy came from and its hash, never its text outside the task itself, and names no absolute path. A prepared `task.md` is compared with the preview only when neither it nor its folder is a link or junction. A BugPilot heading quoted inside a code fence in any editable layer is never taken for one of the task's sections (so it is never labelled protected), and the developer hint, like the instruction files, has its headings held below the task's own and any open fence closed.
- `bugpilot context-preview` (0.1.4) is read-only in the same way: it reads the stored `context.md`, `retrieval.json`, `run.json`, `issue.json` and `task.md` of one work item — nothing at all when `.ai` or the work item's folder is a link or junction, and `context.md` and `task.md` never through one — and runs no search, no Git command, no Jira request and no process. Its JSON names no absolute path, and repeats nothing of the context outside its `text`.
- Editable text never poses as one of the task's sections. User and Project Instructions, the Verification Policy, AI Behavior, every Fix Mode section and the developer hint are contained: their ATX headings are held two levels down, a `---`/`===` line never underlines the line above it into a heading, a code fence is read as CommonMark reads it (a backtick fence's info string has no backtick) and one left open is closed where the layer ends; the hint's line endings are unified first, so a lone carriage return is a line break like any other. A Fix Mode's name is written on one line, and an attachment's stored name never holds a control character, line separator or bidirectional control.
- In text mode (no `--json`), everything the CLI prints to the terminal passes through one filter: C0 and C1 control characters other than tab and newline, DEL and bidirectional embeddings, overrides and isolates are printed as visible escapes (`\x1b`, `\u202e`), so an ESC sequence (colour, cursor, window title, OSC 52 clipboard) or an overprinting carriage return from an issue, a hint or a policy is shown, never obeyed. Stored files and JSON output are unchanged.
- Files under `.ai/<issue>/` and `.bugpilot/` are written through a temporary file created new, under an unpredictable name, in the same folder, then renamed; a link planted at a temporary name is never written through.
- BugPilot's protected rules (0.1.4) have one source, `bugpilot/core/protected_rules.py`, which writes them into every `task.md` and which `bugpilot protected-rules show` prints. There is deliberately no file to edit them (no `.bugpilot/safety.md` or similar), and the inspection reads nothing from the repository, the user's configuration or the machine. It states what BugPilot does — emits the rules unchanged as its highest-precedence instructions and tells the agent to resolve conflicts in their favour — and that BugPilot cannot enforce what an agent then does.
- Project settings (`<repo>/.bugpilot/project_settings.json`: the legacy Verification switches and the branch naming template) are read and written only as a real file inside the repository, never through a link or junction. The switches name no commands. A branch template must include `{issue}` (so two issues never share a branch), may use only `{issue}` and `{slug}` and the characters `A-Z a-z 0-9 . _ - /`; one that could make an unsafe ref (`..`, `//`, `@{`, a leading `-` or `.`, a `.lock` segment) is refused, a name that still comes out empty or as `main`, `master` or `HEAD` falls back to the default, and BugPilot never creates or switches a branch from it.
- `bugpilot <ISSUE>` (the default command; `bugpilot bug <ISSUE>` still works) prepares the package and stops: no agent is launched. `--launch-agent claude` or `--launch-agent copilot` launches that agent interactively after preparation. The agent stops at the commit gate, and agent-generated code must be reviewed before commit.
- Mock/demo Jira fallback is disabled by default.
- `--allow-mock` explicitly enables mock/demo fallback for demos and testing.
- `--no-mock` is accepted for compatibility and matches the default real Jira-only behavior.

## Final Safety Summary

- Writing to Jira happens only via `bugpilot jira-comment <ISSUE> --execute`, or via `bugpilot summarize-results <ISSUE>` when explicitly opted in (`--jira-comment` or `BUGPILOT_AUTO_JIRA_COMMENT`).
- Both add exactly one Jira comment from the local analysis draft; neither transitions, assigns, or edits fields.
- No other bugpilot command writes Jira, and the opt-in default is off.
- No command transitions Jira issues, assigns issues, updates fields, uploads attachments, or downloads attachments.
- `bugpilot <ISSUE>` prepares the package and launches no agent; `--launch-agent claude|copilot` launches one interactively in the target repo after preparation. bugpilot itself still never commits or pushes, and the agent stops at the commit gate.
- bugpilot does not run `git add`, `git commit`, `git push`, merge, or PR creation.
- The only outbound network actions are the read-only Jira fetch, `jira-comment --execute` (one comment), and the notification email over SMTP or Microsoft Graph (`notify --execute` or a configured `commit-plan`). The email is sent only to the configured internal recipients and carries no credentials.

## Generated Artifact Scope
bugpilot writes generated workflow files to:

```text
.ai/<issue>/
.ai_memory/bugs/<issue>.md
```

These paths are relative to the current working directory, which should be the target product repository root.

Clean and fresh-run commands validate issue keys and are scoped to those generated artifact paths. They do not delete product source code.

## Manual Handoff
The AI agent should be run from the target product repository root. The generated `task.md` instructs the agent to avoid destructive git commands, avoid unrelated refactoring, follow the repository's existing patterns as its Repository Context describes them, and generate result files before delivery planning. Its guidance is layered — BugPilot safety rules, Repository context, Project / team instructions, User instructions, AI Fix Mode, Developer hint — and an earlier layer wins a conflict, so a repository's own rules beat one developer's preference.

## Jira Mock Fallback
When mock fallback is used, generated Jira artifacts are clearly marked as mock/demo fallback. For real Jira-only preparation (no agent launch), run:

```powershell
bugpilot JR-12345 --prepare-only
```

For demo/testing fallback, run:

```powershell
bugpilot JR-12345 --prepare-only --allow-mock
```

## First-time Setup

`bugpilot setup` is an interactive command that collects the Jira site, email and API token, validates them against that site, and saves them to `~/.bugpilot/config.toml`. It stores the token in plaintext for now (permissions tightened to `600` where supported); environment variables override the file. See the credential-storage rule above.
