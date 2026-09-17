<#
.SYNOPSIS
    Installs the BugPilot CLI from a local wheel using pipx.

.DESCRIPTION
    Detects Python and pipx (installing pipx if needed), finds the BugPilot
    wheel next to this script, installs it with pipx, and verifies the install.

.NOTES
    Runs on Windows PowerShell 5.1 and PowerShell 7+.
    Place this script in the same folder as a bugpilot-*.whl file and run it.

.PARAMETER InstallPython
    If Python 3.10+ is missing, install it via winget without prompting
    (per-user, no admin). Without this switch you are asked first.

.PARAMETER Setup
    Run 'bugpilot setup' automatically after install, without asking. Without
    this switch you are prompted (default Yes) at the end.
#>

param(
    [switch]$InstallPython,
    [switch]$Setup
)

$ErrorActionPreference = 'Stop'
# PowerShell 7.4+ makes native commands that exit non-zero throw when
# ErrorActionPreference is 'Stop'. We check $LASTEXITCODE ourselves (e.g. the
# "is pipx installed?" probe expects a non-zero exit), so turn that off. This
# variable does not exist on Windows PowerShell 5.1 — assigning it is harmless.
$PSNativeCommandUseErrorActionPreference = $false

# --- output helpers ---------------------------------------------------------

function Write-Step    { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Note    { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }
function Write-Fail    { param([string]$Message) Write-Host $Message -ForegroundColor Red }

# Prominent notice that the user must close this window and open a new terminal
# (a PATH change from this session won't take effect in the current window).
function Write-Reopen {
    param([string]$Message)
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Yellow
    Write-Host "   >>> IMPORTANT: CLOSE THIS WINDOW, open a NEW terminal <<<" -ForegroundColor Yellow
    if ($Message) { Write-Host "       $Message" -ForegroundColor Yellow }
    Write-Host "  ============================================================" -ForegroundColor Yellow
    Write-Host ""
}

function Write-Banner {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host "        BugPilot CLI" -NoNewline -ForegroundColor White
    Write-Host "  -  Installer" -ForegroundColor Cyan
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host "    Prepare-only AI-assisted Jira bug workflow" -ForegroundColor DarkGray
    Write-Host ""
}

# Run a native command and fail (throw) on a non-zero exit code.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @()
    )
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $Exe $($Arguments -join ' ')"
    }
}

# True if $Exe reports Python 3.10 or newer.
function Test-PythonVersion {
    param([string]$Exe)
    try { $out = & $Exe --version 2>&1 } catch { return $false }
    return ($LASTEXITCODE -eq 0 -and ($out -match 'Python 3\.(1[0-9]|[2-9][0-9])'))
}

# Resolve a usable Python 3.10+ interpreter to an absolute path, or $null.
# Skips the Windows "App execution alias" stubs under \WindowsApps\ (those are
# Store placeholders, not real Python).
function Resolve-Python {
    # Prefer the py launcher (never the Store alias); resolve it to a real exe.
    # try/catch: `py -3` can fail with redirected stderr, which is terminating on
    # Windows PowerShell 5.1 under ErrorActionPreference=Stop.
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $exe = $null
        try { $exe = (& py -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1) } catch { $exe = $null }
        if ($exe) { $exe = "$exe".Trim() }
        if ($exe -and (Test-Path $exe) -and (Test-PythonVersion $exe)) {
            return $exe
        }
    }
    foreach ($name in @('python', 'python3')) {
        foreach ($cmd in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
            $src = $cmd.Source
            if (-not $src) { continue }
            if ($src -like '*\WindowsApps\*') { continue }
            if (Test-PythonVersion $src) { return $src }
        }
    }
    return $null
}

# True if `python` on PATH is only the Windows Store App-execution-alias stub.
function Test-PythonAliasOnly {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    return ($cmd -and $cmd.Source -like '*\WindowsApps\*')
}

# Try to install Python via winget (per-user, no admin). Returns $true on success.
function Install-PythonViaWinget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Note "winget is not available, so Python can't be installed automatically here."
        return $false
    }
    $proceed = $script:InstallPython
    if (-not $proceed) {
        Write-Host ""
        try { $answer = Read-Host "    Install Python 3.12 now with winget (per-user, no admin)? [Y/n]" }
        catch { $answer = 'n' }
        $proceed = ($answer -eq '' -or $answer -match '^[Yy]')
    }
    if (-not $proceed) { return $false }

    Write-Step "Installing Python 3.12 via winget..."
    winget install -e --id Python.Python.3.12 --scope user --accept-source-agreements --accept-package-agreements
    return ($LASTEXITCODE -eq 0)
}

# --- installation -----------------------------------------------------------

try {
    Write-Banner

    # 1. Python -------------------------------------------------------------
    Write-Step "Checking for Python..."
    $python = Resolve-Python
    if (-not $python) {
        Write-Note "No usable Python 3.10+ was found."
        if (Test-PythonAliasOnly) {
            Write-Note "Your 'python' command is a Windows Store placeholder (App execution alias), not real Python."
            Write-Note "It just prints 'Python was not found ...'. Install real Python below (or delete the stub at"
            Write-Note "%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe)."
        }
        if (Install-PythonViaWinget) {
            Write-Ok "Python installed."
            Write-Reopen "Then run install.cmd again to finish installing bugpilot."
            exit 0
        }
        Write-Fail "Python 3.10 or newer is required."
        Write-Fail "Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'),"
        Write-Fail "or run:  winget install -e --id Python.Python.3.12"
        Write-Fail "Then open a new terminal and run install.cmd again."
        exit 1
    }
    $pythonVersion = (& $python --version 2>&1).Trim()
    Write-Ok "Found $pythonVersion"
    Write-Ok "$python"

    # 2. pipx ---------------------------------------------------------------
    Write-Step "Checking for pipx..."
    # Detect pipx WITHOUT relying on a non-zero exit or stderr: Windows PowerShell
    # 5.1 turns a native command's redirected stderr into a terminating error under
    # ErrorActionPreference=Stop, so "pipx --version" failing would abort the script.
    # This one-liner always exits 0 and prints 1 (present) or 0 (absent).
    $pipxProbe = & $python -c "import importlib.util as u; print(1 if u.find_spec('pipx') else 0)"
    $pipxInstalled = ("$pipxProbe".Trim() -eq '1')
    $pathMayHaveChanged = $false

    if ($pipxInstalled) {
        Write-Ok "pipx is already installed."
    }
    else {
        Write-Note "pipx not found - installing it now..."
        Invoke-Native $python @('-m', 'pip', 'install', '--user', 'pipx')
        Invoke-Native $python @('-m', 'pipx', 'ensurepath')
        $pathMayHaveChanged = $true
        Write-Ok "pipx installed."
    }

    # 3. Locate the wheel ---------------------------------------------------
    Write-Step "Locating the BugPilot wheel..."
    $wheels = Get-ChildItem -Path $PSScriptRoot -Filter 'bugpilot-*.whl' -File |
        Sort-Object LastWriteTime -Descending
    if (-not $wheels) {
        throw "No BugPilot wheel (bugpilot-*.whl) found in '$PSScriptRoot'."
    }
    $wheel = $wheels[0]
    if ($wheels.Count -gt 1) {
        Write-Note "Multiple wheels found; using the newest: $($wheel.Name)"
    }
    Write-Ok "Using $($wheel.Name)"

    # 4. Install via pipx ---------------------------------------------------
    Write-Step "Installing BugPilot with pipx..."
    # --force lets the installer double as an upgrader when re-run.
    Invoke-Native $python @('-m', 'pipx', 'install', '--force', $wheel.FullName)
    Write-Ok "BugPilot installed."

    # 5. Verify -------------------------------------------------------------
    Write-Step "Verifying installation..."
    # pipx's bin dir may not be on PATH in this session yet; add it so the
    # verification below can find the freshly installed 'bugpilot' command.
    # try/catch: on Windows PowerShell 5.1 a native command's redirected stderr
    # under ErrorActionPreference=Stop is terminating, so probe defensively.
    $pipxBin = $null
    try { $pipxBin = (& $python -m pipx environment --value PIPX_BIN_DIR 2>$null | Select-Object -First 1) } catch { $pipxBin = $null }
    if ([string]::IsNullOrWhiteSpace($pipxBin)) {
        $pipxBin = Join-Path $env:USERPROFILE '.local\bin'
    }
    if (Test-Path $pipxBin) {
        $env:PATH = "$pipxBin;$env:PATH"
    }

    $bugpilotCmd = Get-Command bugpilot -ErrorAction SilentlyContinue
    if ($bugpilotCmd) {
        $bugpilotExe = $bugpilotCmd.Source
    }
    else {
        $bugpilotExe = Join-Path $pipxBin 'bugpilot.exe'
    }
    Invoke-Native $bugpilotExe @('--help')
    Write-Ok "'bugpilot --help' ran successfully."

    # 6. Done ---------------------------------------------------------------
    Write-Host ""
    Write-Host "Installation completed successfully!" -ForegroundColor Green
    Write-Host ""

    # 7. Configure now (bugpilot setup). Called by full path because PATH isn't
    # refreshed in this session yet. Interactive; skipped if we can't prompt.
    $runSetup = $Setup
    if (-not $runSetup) {
        try { $answer = Read-Host "Configure Jira now with 'bugpilot setup'? [Y/n]" }
        catch { $answer = 'n' }
        $runSetup = ($answer -eq '' -or $answer -match '^[Yy]')
    }
    if ($runSetup) {
        Write-Host ""
        & $bugpilotExe setup
        if ($pathMayHaveChanged) {
            Write-Reopen "Then the 'bugpilot' command will work by name."
        }
    }
    else {
        Write-Host "Next step:" -ForegroundColor White
        Write-Host ""
        Write-Host "    bugpilot setup" -ForegroundColor Cyan
        Write-Host ""
        if ($pathMayHaveChanged) {
            Write-Reopen "The 'bugpilot' command works only in a NEW terminal, so open one before 'bugpilot setup'."
        }
    }
}
catch {
    Write-Host ""
    Write-Fail "Installation failed."
    Write-Fail $_.Exception.Message
    Write-Host ""
    Write-Fail "Troubleshooting:"
    Write-Fail "  - Ensure Python 3.10+ is installed and on PATH ('python --version')."
    Write-Fail "  - Try running the failed command manually to see the full output."
    Write-Fail "  - If pipx was just installed, restart PowerShell and re-run this script."
    exit 1
}
