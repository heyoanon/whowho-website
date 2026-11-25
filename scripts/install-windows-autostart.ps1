# Installs Whoami Now Playing Sync to Windows Startup folder
# This makes what is currently playing sync 100% automatically whenever your PC is on!

$startupFolder = [Environment]::GetFolderPath('Startup')
$targetVbs = Join-Path $startupFolder "WhoamiNowPlayingSync.vbs"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceVbs = Join-Path $scriptDir "start-background-sync.vbs"

Copy-Item -Path $sourceVbs -Destination $targetVbs -Force
Write-Host "[OK] Installed automatic sync to Windows Startup!" -ForegroundColor Green
Write-Host "Location: $targetVbs" -ForegroundColor Gray
Write-Host "It will now run silently in the background whenever Windows starts." -ForegroundColor Cyan

# Also start it right now!
Start-Process "wscript.exe" -ArgumentList "`"$targetVbs`""
Write-Host "[OK] Started background sync process for current session." -ForegroundColor Green
