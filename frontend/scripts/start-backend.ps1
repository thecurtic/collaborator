# Starts the Collaborator backend for local frontend development (Windows).
#
# The backend lives in ../backend of this monorepo. This script only launches
# it with the backend's own virtualenv; see ../DEV.md for the one-time setup.
$ErrorActionPreference = 'Stop'

$frontendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot     = Split-Path -Parent $frontendRoot
$backendRoot  = Join-Path $repoRoot 'backend'
$python       = Join-Path $backendRoot '.venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
  Write-Error "Backend venv not found at $python. See DEV.md for one-time setup."
}

Write-Host "Starting Collaborator backend on http://127.0.0.1:8001 ..." -ForegroundColor Cyan
Set-Location $backendRoot
& $python -m uvicorn main:app --host 127.0.0.1 --port 8001
