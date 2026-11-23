# Windows Now Playing Broadcast Script for Whoami
# Automatically detects current audio playback on Windows and syncs it to /api/now-playing
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\now-playing-sync.ps1

param(
    [string]$ApiUrl = "https://whowho-website.vercel.app/api/now-playing",
    [string]$Secret = ""
)

Write-Host "Whoami Now Playing Sync started..." -ForegroundColor Cyan
Write-Host "Target API: $ApiUrl" -ForegroundColor Gray

# Try loading Windows Media Control WinRT APIs (Windows 10/11)
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()

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
            $trackKey = "$title - $artist - $isPlaying"

            if ($title -and ($trackKey -ne $lastTrack)) {
                $lastTrack = $trackKey

                $source = "Music"
                if ($sourceApp -match "Spotify") { $source = "Spotify" }
                elseif ($sourceApp -match "BitChord") { $source = "BitChord" }
                elseif ($sourceApp -match "Chrome|Edge|Brave|Firefox") { $source = "YouTube Music" }

                $payload = @{
                    source = $source
                    title = $title
                    artist = $artist
                    album = $album
                    isPlaying = $isPlaying
                    secret = $Secret
                } | ConvertTo-Json

                Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $payload -ContentType "application/json" -TimeoutSec 5 | Out-Null
                Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] Broadcast: $title by $artist ($source)" -ForegroundColor Green
            }
        }
    } catch {
        # ignore transient COM or network errors
    }

    Start-Sleep -Seconds 2
}
