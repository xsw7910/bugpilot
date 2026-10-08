# Notifications

When a fix is ready, BugPilot can tell people — only when you ask, and only in the ways below. Each previews by default and sends nothing until you say so.

## One Jira comment

The lightest way to notify the people watching an issue: BugPilot posts one comment with the analysis summary, and Jira notifies the issue's watchers, assignee and reporter through its own notifications. It uses your existing Jira credentials (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, or `~/.bugpilot/config.toml`).

```powershell
bugpilot jira-comment-draft JR-12345        # write a local, reviewable draft
bugpilot jira-comment JR-12345              # preview it; nothing is posted
bugpilot jira-comment JR-12345 --execute    # post exactly one comment
```

To post automatically as soon as results are summarized, opt in:

```powershell
$env:BUGPILOT_AUTO_JIRA_COMMENT="true"
bugpilot summarize-results JR-12345                      # summarizes AND posts one comment
bugpilot summarize-results JR-12345 --jira-comment       # post this run
bugpilot summarize-results JR-12345 --no-jira-comment    # never post this run
```

- A comment is the only thing BugPilot ever writes to Jira. It never transitions, assigns or edits fields.
- If posting fails, `summarize-results` still succeeds and says so; post later with `jira-comment --execute`.
- The comment body is sanitized to redact secret-like values.
- You receive Jira's email only if you watch the issue (or are its assignee or reporter) and have Jira email notifications enabled.

## Email at the commit gate

`bugpilot commit-plan <ISSUE>` can email a summary of the completed fix: the issue, the original problem, the root cause and the changes made, assembled from the local `fix_report.md` and `issue.json`. It picks **Microsoft Graph if configured, otherwise SMTP**; `bugpilot doctor` shows `email_configured` (SMTP) and `email_graph_configured` (Graph).

```powershell
bugpilot notify JR-12345                    # preview: writes email_draft.md + notification.eml, sends nothing
bugpilot notify JR-12345 --execute          # send (Graph if configured, else SMTP)
bugpilot commit-plan JR-12345               # print the commit plan and send the email
bugpilot commit-plan JR-12345 --no-email    # the plan only
```

If no transport is configured, `commit-plan` still succeeds and reports that no email was sent. Secrets (an SMTP password, a Graph client secret) are read from the environment only, and are never logged or written to an error message.

### Microsoft Graph

For a Microsoft 365 tenant that disables SMTP client authentication or blocks outbound SMTP — Graph sends over HTTPS. It needs an app registration with the **application** permission `Mail.Send` (admin consent granted), ideally limited by an application access policy to the sending mailbox. Then:

```powershell
$env:GRAPH_TENANT_ID="<directory (tenant) id>"
$env:GRAPH_CLIENT_ID="<application (client) id>"
$env:GRAPH_CLIENT_SECRET="..."                 # keep it in a secrets manager
$env:BUGPILOT_EMAIL_FROM="you@example.com"     # the mailbox the app may send as
$env:BUGPILOT_EMAIL_TO="you@example.com"       # comma- or semicolon-separated
```

### SMTP

```powershell
$env:SMTP_HOST="smtp.example.com"
$env:SMTP_PORT="587"               # optional, default 587
$env:SMTP_USERNAME="relay-user"    # optional; omit for an unauthenticated relay
$env:SMTP_PASSWORD="..."           # keep it in a secrets manager
$env:SMTP_USE_STARTTLS="true"      # optional, default true
$env:SMTP_USE_SSL="false"          # optional, default false (true for SMTPS on 465)
$env:BUGPILOT_EMAIL_FROM="bugpilot@example.com"
$env:BUGPILOT_EMAIL_TO="you@example.com"
```

`scripts/setup-email.ps1` stores the SMTP password in the PowerShell SecretStore and loads the variables into your session (`-Persist` for future sessions, `-ResetPassword` to replace the stored password).

### Sending by hand through Outlook

With no transport, `bugpilot notify` still writes a portable `.ai/<ISSUE>/notification.eml`. `scripts/send-via-outlook.ps1 <ISSUE>` opens it as a pre-filled Outlook message for you to review and send.
