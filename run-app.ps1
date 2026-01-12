# run-app.ps1 - Run the React app from this repository root
# Usage: Right-click -> Run with PowerShell, or run from an elevated PS session if needed.

#$PSScriptRoot isn't available in older PowerShell versions when script is dot-sourced, so use this method for robustness
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

# If node_modules missing, run npm install
if (-not (Test-Path -Path "$scriptDir\node_modules")) {
n    Write-Host "node_modules not found. Running npm install..."
    npm install
}

nWrite-Host "Starting app (npm start)... Press Ctrl+C to stop."
npm start
