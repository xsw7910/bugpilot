<#
.SYNOPSIS
    Open the bugpilot notification as a pre-filled Outlook compose window.

.DESCRIPTION
    Reads the work item's email_draft.md (produced by `bugpilot notify <ISSUE>`), in
    the repository's folder in BugPilot's data folder, which `bugpilot doctor --json`
    reports, and
    creates a new Outlook mail item with the subject, body, and recipient filled
    in. By default it opens the compose window for you to review and click Send.

    This uses your installed Outlook desktop client, which sends over its own
    modern-auth channel (HTTPS) — so it works even when the tenant disables SMTP
    client authentication and when outbound port 25 is blocked. Company data
    stays inside Outlook / Microsoft 365.

.PARAMETER Issue
    The Jira issue key, e.g. JR-12345.

.PARAMETER To
    Recipient address. Defaults to $env:BUGPILOT_EMAIL_TO, then your own mailbox.

.PARAMETER Send
    Send immediately instead of opening the compose window for review.

.EXAMPLE
    .\scripts\send-via-outlook.ps1 JR-12345
    # Opens Outlook with the notification ready; review and click Send.

.EXAMPLE
    .\scripts\send-via-outlook.ps1 JR-12345 -To lead@example.com -Send
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Issue,
    [string]$To = $env:BUGPILOT_EMAIL_TO,
    [switch]$Send
)
$ErrorActionPreference = 'Stop'

# A work item id, as BugPilot makes them: it becomes a folder name below BugPilot's data folder.
if ($Issue -notmatch '^[A-Za-z][A-Za-z0-9_-]*[-_][0-9]+$') {
    throw "Not a work item id: $Issue"
}
# The draft is in the work item's folder in BugPilot's data folder (0.1.7), never in the repository:
# the CLI says where that is, run in the repository like every other bugpilot command.
$doctor = (& bugpilot doctor --json | Out-String) | ConvertFrom-Json
$storage = $doctor.report.storage
$repositoryDir = $storage.repository_dir
# Only a folder storage checked and found usable: not one it refused (a link on the way, a record naming
# another repository, a data folder inside a Git working tree).
if (-not $repositoryDir -or $storage.state -ne 'usable') {
    throw "bugpilot cannot use this repository's files ($($storage.state)). $($storage.problem)"
}
$draftPath = Join-Path $repositoryDir "work/$Issue/email_draft.md"
if (-not (Test-Path -LiteralPath $draftPath)) {
    throw "Not found: $draftPath`nRun first:  bugpilot notify $Issue"
}
# Never through a link or junction, as BugPilot itself reads its files.
foreach ($part in @((Join-Path $repositoryDir 'work'), (Join-Path $repositoryDir "work/$Issue"), $draftPath)) {
    if ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Not read: $part is a symbolic link or junction."
    }
}

# Draft format is "Subject: <subject>\n\n<body...>"
$raw = Get-Content -LiteralPath $draftPath -Raw
$subject = 'bugpilot notification'
$body = $raw
if ($raw -match '^(?s)Subject:\s*(.*?)\r?\n\r?\n(.*)$') {
    $subject = $Matches[1].Trim()
    $body = $Matches[2]
}

try {
    $outlook = New-Object -ComObject Outlook.Application
} catch {
    throw "Could not start Outlook via COM. Is the Outlook desktop client installed and configured? $($_.Exception.Message)"
}

$olMailItem = 0
$mail = $outlook.CreateItem($olMailItem)
$mail.Subject = $subject
$mail.Body = $body
if ($To) { $mail.To = $To }

if ($Send) {
    if (-not $To) { throw "No recipient. Pass -To or set BUGPILOT_EMAIL_TO." }
    $mail.Send()
    Write-Host "Sent notification for $Issue to $To via Outlook." -ForegroundColor Green
} else {
    $mail.Display()
    Write-Host "Opened the notification for $Issue in Outlook. Review and click Send." -ForegroundColor Green
}
