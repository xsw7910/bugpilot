<#
.SYNOPSIS
    Configure and load the SMTP settings used by `bugpilot notify` / `bugpilot commit-plan`.

.DESCRIPTION
    bugpilot reads all email settings from environment variables. This script:
      1. Stores the SMTP password securely in the PowerShell SecretStore
         (never in plain text, never in git).
      2. Exports every SMTP_* / BUGPILOT_EMAIL_* variable into the CURRENT session,
         reading the password back from the secure store.

    Run it at the start of a session, or call it from your $PROFILE so every new
    terminal is configured automatically. Use -Persist to also save the non-secret
    values to your Windows user environment and wire the loader into $PROFILE.

.PARAMETER ResetPassword
    Prompt for the SMTP password again and overwrite the stored secret.

.PARAMETER Persist
    Save the non-secret values (host/port/username/from/to/tls) to your Windows
    user environment (setx) and add a loader line to your PowerShell profile so
    future sessions load the config (including the secure password) automatically.

.EXAMPLE
    .\scripts\setup-email.ps1
    # Loads config into the current session (prompts for the password on first run).

.EXAMPLE
    .\scripts\setup-email.ps1 -Persist
    # Same, and makes it stick for all future PowerShell sessions.

.EXAMPLE
    .\scripts\setup-email.ps1 -ResetPassword
    # Re-enter and re-store the SMTP password.
#>
[CmdletBinding()]
param(
    [switch]$ResetPassword,
    [switch]$Persist
)

# ============================================================================
# EDIT THESE VALUES ONCE to match your mail provider (ask IT if unsure).
# Change every line marked "← 改我" below. The Office 365 example is a guess —
# confirm the real server / port with IT.
# ============================================================================
$Config = @{
    SMTP_HOST         = 'smtp.office365.com'             # ← 改我：向 IT 确认公司 SMTP 服务器地址
    SMTP_PORT         = '587'                            # ← 确认：587=STARTTLS(默认) / 465=SSL
    SMTP_USERNAME     = 'you@example.com'    # ← 改我：发信账号；无需认证的内部中继设为 ''
    SMTP_USE_STARTTLS = 'true'                           # 一般不用动（用 465 端口时改 false）
    SMTP_USE_SSL      = 'false'                          # 一般不用动（用 465 端口时改 true）
    BUGPILOT_EMAIL_FROM = 'you@example.com'    # ← 改我：发件人邮箱
    BUGPILOT_EMAIL_TO   = 'you@example.com'    # ← 改我：收件人（多个用逗号/分号分隔）
}

$VaultName  = 'hrsai'
$SecretName = 'BUGPILOT_SMTP_PASSWORD'
$ErrorActionPreference = 'Stop'

function Ensure-SecretModules {
    $needInstall = foreach ($module in 'Microsoft.PowerShell.SecretManagement', 'Microsoft.PowerShell.SecretStore') {
        if (-not (Get-Module -ListAvailable -Name $module)) { $module }
    }
    if ($needInstall) {
        # Windows PowerShell 5.1 defaults to TLS 1.0/1.1; the PowerShell Gallery
        # requires TLS 1.2, otherwise Install-Module fails to reach it.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
            Write-Host "Installing NuGet package provider..." -ForegroundColor Cyan
            Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force | Out-Null
        }
        foreach ($module in $needInstall) {
            Write-Host "Installing $module (CurrentUser)..." -ForegroundColor Cyan
            Install-Module $module -Scope CurrentUser -Force
        }
    }
    foreach ($module in 'Microsoft.PowerShell.SecretManagement', 'Microsoft.PowerShell.SecretStore') {
        Import-Module $module
    }
}

function Ensure-Vault {
    if (-not (Get-SecretVault -Name $VaultName -ErrorAction SilentlyContinue)) {
        Write-Host "Registering secret vault '$VaultName'..." -ForegroundColor Cyan
        Register-SecretVault -Name $VaultName -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault
    }
}

function Ensure-Password {
    param([bool]$Reset)
    $exists = $false
    try { $exists = [bool](Get-Secret -Name $SecretName -Vault $VaultName -ErrorAction Stop) } catch { $exists = $false }
    if ($Reset -or -not $exists) {
        $secure = Read-Host "Enter the SMTP password for $($Config.SMTP_USERNAME)" -AsSecureString
        Set-Secret -Name $SecretName -Secret $secure -Vault $VaultName
        Write-Host "SMTP password stored securely in vault '$VaultName'." -ForegroundColor Green
    }
}

# --- Load config into the current session --------------------------------------

$needsAuth = -not [string]::IsNullOrWhiteSpace($Config.SMTP_USERNAME)

if ($needsAuth) {
    Ensure-SecretModules
    Ensure-Vault
    Ensure-Password -Reset:$ResetPassword.IsPresent
}

foreach ($key in $Config.Keys) {
    Set-Item -Path "Env:$key" -Value $Config[$key]
}

if ($needsAuth) {
    $env:SMTP_PASSWORD = Get-Secret -Name $SecretName -Vault $VaultName -AsPlainText
} else {
    Remove-Item Env:SMTP_PASSWORD -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "bugpilot email config loaded into this session:" -ForegroundColor Green
Write-Host "  SMTP_HOST         = $($env:SMTP_HOST)"
Write-Host "  SMTP_PORT         = $($env:SMTP_PORT)"
Write-Host "  SMTP_USERNAME     = $($env:SMTP_USERNAME)"
Write-Host "  SMTP_USE_STARTTLS = $($env:SMTP_USE_STARTTLS)"
Write-Host "  SMTP_USE_SSL      = $($env:SMTP_USE_SSL)"
Write-Host "  BUGPILOT_EMAIL_FROM = $($env:BUGPILOT_EMAIL_FROM)"
Write-Host "  BUGPILOT_EMAIL_TO   = $($env:BUGPILOT_EMAIL_TO)"
Write-Host "  SMTP_PASSWORD     = $(if ($env:SMTP_PASSWORD) { '******** (from secure vault)' } else { '(none / no auth)' })"
Write-Host ""
Write-Host "Verify with:  bugpilot doctor    (expect 'email_configured: True')" -ForegroundColor Yellow

# --- Optional: make it stick for future sessions ------------------------------

if ($Persist) {
    Write-Host ""
    Write-Host "Persisting non-secret values to your Windows user environment..." -ForegroundColor Cyan
    foreach ($key in $Config.Keys) {
        [System.Environment]::SetEnvironmentVariable($key, $Config[$key], 'User')
    }

    $scriptPath = $MyInvocation.MyCommand.Path
    $loaderLine = ". `"$scriptPath`""
    if (-not (Test-Path $PROFILE)) {
        New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    }
    $profileText = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if ($profileText -notmatch [regex]::Escape($scriptPath)) {
        Add-Content -Path $PROFILE -Value "`n# Load bugpilot email config (password from secure vault)`n$loaderLine"
        Write-Host "Added loader to your PowerShell profile: $PROFILE" -ForegroundColor Green
    } else {
        Write-Host "Profile already loads this script; no change made." -ForegroundColor Green
    }
    Write-Host "New PowerShell sessions will load the SMTP config automatically." -ForegroundColor Green
    Write-Host "NOTE: The password stays only in the secure vault; it is never written to setx or the profile." -ForegroundColor Yellow
}
