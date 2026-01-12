# run-local.ps1
# Detect if the project is on a network/mapped drive. If so, copy/sync to a local folder and run the app from there.
# This helps avoid filesystem/watch problems when running dev servers from network drives.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "Script location: $scriptDir"

try {
    $drive = $scriptDir.Substring(0,2) # e.g. 'Z:'
} catch {
    Write-Host "Unable to determine drive letter. Running in place." -ForegroundColor Yellow
    Set-Location $scriptDir
    goto StartApp
}

# Get drive info. DriveType: 3 = Local Disk, 4 = Network
$disk = Get-WmiObject -Class Win32_LogicalDisk -Filter "DeviceID='$drive'" -ErrorAction SilentlyContinue
$driveType = if ($null -eq $disk) { 0 } else { $disk.DriveType }

if ($driveType -eq 4) {
    # Network drive detected
    $localBase = Join-Path $env:LOCALAPPDATA "MapleSight"
    $dest = Join-Path $localBase "current"

    Write-Host "Network drive detected for $drive. Preparing local copy at: $dest"

    if (-not (Test-Path $localBase)) { New-Item -ItemType Directory -Path $localBase | Out-Null }

    # Use robocopy to sync files. Exclude heavy or unwanted dirs.
    $excludeDirs = @("node_modules",".git",".github",".vscode","dist","build")
    $robocopyArgs = @()
    $robocopyArgs += ('"' + $scriptDir.TrimEnd('\') + '"')
    $robocopyArgs += ('"' + $dest + '"')
    $robocopyArgs += '/E'  # copy subdirectories, including empty ones
    foreach ($d in $excludeDirs) { $robocopyArgs += '/XD'; $robocopyArgs += $d }
    # Ensure robocopy doesn't prompt and returns quickly
    $robocopyArgs += '/NFL'; $robocopyArgs += '/NDL'; $robocopyArgs += '/NJH'; $robocopyArgs += '/NJS';

    Write-Host "Syncing files (this may take a moment)..."
    $rc = Start-Process -FilePath robocopy -ArgumentList $robocopyArgs -NoNewWindow -Wait -PassThru
    if ($rc.ExitCode -ge 8) {
        Write-Host "Robocopy failed (exit code $($rc.ExitCode)). Aborting." -ForegroundColor Red
        exit $rc.ExitCode
    }

    Write-Host "Files copied/synced to: $dest"
    Set-Location $dest
} else {
    Write-Host "Local drive detected. Running in place: $scriptDir"
    Set-Location $scriptDir
}

:StartApp
# Ensure node and npm are present
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm not found on PATH. Please install Node.js or add npm to PATH." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path .\node_modules)) {
    Write-Host "node_modules not found. Running npm install..."
    npm install
}

Write-Host "Starting app (npm start)... Press Ctrl+C to stop."
npm start
