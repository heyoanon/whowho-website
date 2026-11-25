# Windows Now Playing Broadcast Script for Whoami
# Automatically detects current audio playback from Spotify, YouTube Music, Apple Music (and any desktop player/browser)
# and syncs it in real-time to your Whoami website.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\now-playing-sync.ps1
#
# Optional custom API endpoint or secret:
#   powershell -ExecutionPolicy Bypass -File .\scripts\now-playing-sync.ps1 -ApiUrl "https://whowho-website.vercel.app/api/now-playing" -Secret "your_secret_here"

param(
    [string]$ApiUrl = "https://whowho-website.vercel.app/api/now-playing",
    [string]$Secret = ""
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  ★ WHOAMI NOW PLAYING MULTI-STREAMING SYNC (WINDOWS)" -ForegroundColor Cyan
Write-Host "  Tracks Spotify, YouTube Music & Apple Music in Real Time" -ForegroundColor Gray
Write-Host "  Target API: $ApiUrl" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan

# Load Windows Media Control WinRT APIs (Windows 10/11)
try {
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    $manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
    Write-Host "[OK] Connected to Windows System Media Transport Controls." -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Unable to access Windows Media Session. Please ensure Windows 10/11." -ForegroundColor Red
    exit 1
}

$lastTrack = ""

while ($true) {
    try {
        $session = $manager.GetCurrentSession()
        if ($session) {
            $mediaInfo = $session.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()
            $playbackInfo = $session.GetPlaybackInfo()
            $status = $playbackInfo.PlaybackStatus

            $title = $mediaInfo.Title
            $artist = $mediaInfo.Artist
            $album = $mediaInfo.AlbumTitle
            $sourceApp = $session.SourceAppUserModelId

            $isPlaying = ($status -eq "Playing")
            $trackKey = "$title - $artist - $isPlaying - $sourceApp"

            if ($title -and ($trackKey -ne $lastTrack)) {
                $lastTrack = $trackKey

                # Determine streaming platform
                $source = "Music"
                $appLower = if ($sourceApp) { $sourceApp.ToLower() } else { "" }
                $titleLower = if ($title) { $title.ToLower() } else { "" }

                if ($appLower -match "spotify") {
                    $source = "Spotify"
                } elseif ($appLower -match "applemusic|itunes|cider") {
                    $source = "Apple Music"
                } elseif ($appLower -match "youtube|ytm|music.youtube") {
                    $source = "YouTube Music"
                } elseif ($appLower -match "bitchord") {
                    $source = "BitChord"
                } elseif ($appLower -match "chrome|msedge|brave|firefox|opera|vivaldi") {
                    # Differentiate browser streaming tabs
                    if ($titleLower -match "youtube music") {
                        $source = "YouTube Music"
                    } elseif ($titleLower -match "apple music") {
                        $source = "Apple Music"
                    } elseif ($titleLower -match "spotify") {
                        $source = "Spotify"
                    } else {
                        # Default browser music stream to YouTube Music
                        $source = "YouTube Music"
                    }
                }

                $payload = @{
                    source = $source
                    title = $title
                    artist = $artist
                    album = $album
                    isPlaying = $isPlaying
                    secret = $Secret
                } | ConvertTo-Json

                Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $payload -ContentType "application/json" -TimeoutSec 5 | Out-Null
                $stateIcon = if ($isPlaying) { "▶ PLAYING" } else { "⏸ PAUSED" }
                Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] $stateIcon: $title by $artist on $source" -ForegroundColor Green
            }
        }
    } catch {
        # ignore transient COM or network errors
    }

    Start-Sleep -Seconds 2
}
