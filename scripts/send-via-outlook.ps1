<#
.SYNOPSIS
    Open the bugpilot notification as a pre-filled Outlook compose window.

.DESCRIPTION
    Reads .ai/<ISSUE>/email_draft.md (produced by `bugpilot notify <ISSUE>`) and
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

$draftPath = Join-Path (Get-Location) ".ai/$Issue/email_draft.md"
if (-not (Test-Path $draftPath)) {
    throw "Not found: $draftPath`nRun first:  bugpilot notify $Issue"
}

# Draft format is "Subject: <subject>\n\n<body...>"
$raw = Get-Content -Path $draftPath -Raw
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
