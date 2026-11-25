# Windows Now Playing Broadcast Script for Whoami
# Automatically detects current audio playback from Spotify, YouTube Music, Apple Music, and any browser/desktop app
# and syncs it in real-time to your Whoami website whenever a track changes or pauses, including device location.

param(
    [string]$ApiUrl = "https://whowho-website.vercel.app/api/now-playing",
    [string]$Secret = ""
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ★ WHOAMI NOW PLAYING MULTI-STREAMING SYNC (WINDOWS)" -ForegroundColor Cyan
Write-Host "  Tracks Spotify, YouTube Music & Apple Music in Real Time" -ForegroundColor Gray
Write-Host "  Target API: $ApiUrl" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan

# Setup WinRT Async helper for PowerShell 5.1 & PowerShell Core
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    }[0]

    Function Await-WinRT($asyncOp, $type) {
        $asTask = $asTaskGeneric.MakeGenericMethod($type)
        $netTask = $asTask.Invoke($null, @($asyncOp))
        $netTask.Wait(-1) | Out-Null
        return $netTask.Result
    }

    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    $op = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $manager = Await-WinRT $op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    Write-Host "[OK] Connected to Windows System Media Transport Controls." -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Unable to access Windows Media Session: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$lastTrack = ""

while ($true) {
    try {
        $session = $manager.GetCurrentSession()
        if ($session) {
            $propOp = $session.TryGetMediaPropertiesAsync()
            $mediaInfo = Await-WinRT $propOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $playbackInfo = $session.GetPlaybackInfo()
            $status = $playbackInfo.PlaybackStatus

            $title = $mediaInfo.Title
            $artist = $mediaInfo.Artist
            $album = $mediaInfo.AlbumTitle
            $sourceApp = $session.SourceAppUserModelId

            # PlaybackStatus: 4 = Playing, 5 = Paused, 3 = Stopped
            $isPlaying = ($status -eq 4 -or $status -eq "Playing")
            $trackKey = "$title - $artist - $album - $isPlaying - $sourceApp"

            if ($title -and ($trackKey -ne $lastTrack)) {
                $lastTrack = $trackKey

                # Determine streaming platform
                $source = "Music"
                $appLower = if ($sourceApp) { $sourceApp.ToLower() } else { "" }
                $titleLower = if ($title) { $title.ToLower() } else { "" }

                # Determine friendly device info ("where it plays")
                $deviceApp = "Desktop"
                if ($appLower -match "spotify") {
                    $source = "Spotify"
                    $deviceApp = "Spotify App"
                } elseif ($appLower -match "applemusic|itunes|cider") {
                    $source = "Apple Music"
                    $deviceApp = "Apple Music"
                } elseif ($appLower -match "youtube|ytm|music.youtube") {
                    $source = "YouTube Music"
                    $deviceApp = "YouTube Music App"
                } elseif ($appLower -match "bitchord") {
                    $source = "BitChord"
                    $deviceApp = "BitChord"
                } elseif ($appLower -match "brave") {
                    $deviceApp = "Brave Browser"
                    if ($titleLower -match "youtube music") { $source = "YouTube Music" }
                    elseif ($titleLower -match "apple music") { $source = "Apple Music" }
                    elseif ($titleLower -match "spotify") { $source = "Spotify" }
                    else { $source = "YouTube Music" }
                } elseif ($appLower -match "chrome") {
                    $deviceApp = "Chrome Browser"
                    if ($titleLower -match "youtube music") { $source = "YouTube Music" }
                    elseif ($titleLower -match "apple music") { $source = "Apple Music" }
                    elseif ($titleLower -match "spotify") { $source = "Spotify" }
                    else { $source = "YouTube Music" }
                } elseif ($appLower -match "msedge") {
                    $deviceApp = "Edge Browser"
                    if ($titleLower -match "youtube music") { $source = "YouTube Music" }
                    elseif ($titleLower -match "apple music") { $source = "Apple Music" }
                    elseif ($titleLower -match "spotify") { $source = "Spotify" }
                    else { $source = "YouTube Music" }
                } elseif ($appLower -match "firefox") {
                    $deviceApp = "Firefox Browser"
                    if ($titleLower -match "youtube music") { $source = "YouTube Music" }
                    elseif ($titleLower -match "apple music") { $source = "Apple Music" }
                    elseif ($titleLower -match "spotify") { $source = "Spotify" }
                    else { $source = "YouTube Music" }
                } else {
                    $deviceApp = if ($sourceApp) { $sourceApp } else { "Desktop Audio" }
                }

                $device = "Desktop PC • $deviceApp"

                $payload = @{
                    source = $source
                    title = $title
                    artist = $artist
                    album = $album
                    isPlaying = $isPlaying
                    device = $device
                    deviceType = "desktop"
                }
                if ($Secret) {
                    $payload["secret"] = $Secret
                }
                $jsonBody = $payload | ConvertTo-Json

                Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $jsonBody -ContentType "application/json" -TimeoutSec 5 | Out-Null
                $stateIcon = if ($isPlaying) { "▶ PLAYING" } else { "⏸ PAUSED" }
                Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] Track Changed -> $stateIcon: $title by $artist on $source ($device)" -ForegroundColor Green
            }
        } else {
            # If playback was active but session is now closed, broadcast paused state
            if ($lastTrack -ne "") {
                $lastTrack = ""
                $payload = @{
                    isPlaying = $false
                    title = ""
                } | ConvertTo-Json
                Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $payload -ContentType "application/json" -TimeoutSec 5 | Out-Null
                Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] Playback stopped. Broadcasted standby." -ForegroundColor Yellow
            }
        }
    } catch {
        # ignore transient COM or network errors
    }

    # Fast 1-second check for instant track change detection
    Start-Sleep -Seconds 1
}
