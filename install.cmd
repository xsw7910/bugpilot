@echo off
REM ============================================================
REM  BugPilot installer (double-click friendly)
REM  Runs installer\install.ps1 with a one-time execution-policy bypass so
REM  it works regardless of the machine's PowerShell policy, and
REM  regardless of whether the files were downloaded (Mark-of-the-Web).
REM  Layout: install.cmd here; install.ps1 and bugpilot-*.whl in .\installer\.
REM ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1"
echo.
pause
