# create_shortcut.ps1 - Create a Desktop shortcut that launches run-app.bat
# Run this script with PowerShell (no elevation required for Desktop)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "MapleSight.lnk"
$target = Join-Path $scriptDir "run-app.bat"

# Use WScript.Shell COM object to create .lnk
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $scriptDir
$shortcut.WindowStyle = 1

# If there is an icon, set it (optional)
$iconPath = Join-Path $scriptDir "public\favicon.ico"
if (Test-Path $iconPath) { $shortcut.IconLocation = $iconPath }

$shortcut.Save()
Write-Host "Shortcut created at: $shortcutPath"