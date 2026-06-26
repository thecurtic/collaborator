# Starts the local Collaborator backend for dev testing.
#
# The backend lives in a SIBLING directory (../collaborator-backend), kept out
# of this repo on purpose (see AGENTS.md). This script just launches it; it does
# not modify or vendor any backend code.
$ErrorActionPreference = 'Stop'

$frontendRoot = Split-Path -Parent $PSScriptRoot
$appsRoot     = Split-Path -Parent $frontendRoot
$backendRoot  = Join-Path $appsRoot 'collaborator-backend'
$python       = Join-Path $backendRoot 'venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
  Write-Error "Backend venv not found at $python. See DEV.md for one-time setup."
}

Write-Host "Starting Collaborator backend on http://127.0.0.1:8001 ..." -ForegroundColor Cyan
Set-Location (Join-Path $backendRoot 'backend')
& $python -m uvicorn main:app --host 127.0.0.1 --port 8001
