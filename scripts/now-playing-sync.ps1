# Windows Now Playing Broadcast Script for Whoami
# Automatically detects current audio playback from Spotify, YouTube Music, Apple Music, and any browser/desktop app
# and syncs it in real-time to your Whoami website whenever a track changes or pauses, including streaming service & device location.

param(
    [string]$ApiUrl = "https://whowho-website.vercel.app/api/now-playing",
    [string]$Secret = ""
)

# Terminate any duplicate previous instance of now-playing-sync via instant PID check
$pidFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "whowho-now-playing-sync.pid")
if (Test-Path $pidFile) {
    try {
        $oldPid = [int](Get-Content $pidFile -ErrorAction SilentlyContinue)
        if ($oldPid -and $oldPid -ne $PID) {
            $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($oldProc -and $oldProc.ProcessName -match "powershell") {
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}
try { [System.IO.File]::WriteAllText($pidFile, "$PID") } catch {}

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
        if (-not $asyncOp) { return $null }
        $asTask = $asTaskGeneric.MakeGenericMethod($type)
        $netTask = $asTask.Invoke($null, @($asyncOp))
        if (-not $netTask) { return $null }
        $netTask.Wait(-1) | Out-Null
        return $netTask.Result
    }

    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    $op = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $manager = Await-WinRT $op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    Write-Host "[OK] Connected to Windows System Media Transport Controls." -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Unable to access Windows Media Session: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$cachedStreamingService = $null
$lastStreamingServiceCheck = [DateTime]::MinValue

# Automatically detects which streaming service is active in the user's web browsers
Function Detect-BrowserStreamingService {
    # Cache for 20 seconds to prevent blocking disk I/O on every 200ms iteration!
    if ($cachedStreamingService -and ([DateTime]::UtcNow - $lastStreamingServiceCheck).TotalSeconds -lt 20) {
        return $cachedStreamingService
    }
    $paths = @(
        "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\Default\IndexedDB",
        "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\*\IndexedDB",
        "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\IndexedDB",
        "$env:LOCALAPPDATA\Google\Chrome\User Data\*\IndexedDB",
        "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\IndexedDB",
        "$env:LOCALAPPDATA\Microsoft\Edge\User Data\*\IndexedDB",
        "$env:APPDATA\Opera Software\Opera GX Stable\IndexedDB",
        "$env:APPDATA\Opera Software\Opera Stable\IndexedDB",
        "$env:LOCALAPPDATA\Vivaldi\User Data\Default\IndexedDB",
        "$env:APPDATA\zen\Profiles\*\storage\default",
        "$env:APPDATA\LibreWolf\Profiles\*\storage\default",
        "$env:APPDATA\Mozilla\Firefox\Profiles\*\storage\default",
        "$env:APPDATA\Waterfox\Profiles\*\storage\default",
        "$env:APPDATA\Floorp\Profiles\*\storage\default"
    )
    $bestService = $null
    $latestTime = [DateTime]::MinValue
    foreach ($p in $paths) {
        if (Test-Path $p) {
            $spotify = Get-ChildItem $p -Filter "*spotify*" -ErrorAction SilentlyContinue
            foreach ($d in $spotify) {
                if ($d.LastWriteTime -gt $latestTime) {
                    $latestTime = $d.LastWriteTime
                    $bestService = "Spotify"
                }
            }
            $ytm = Get-ChildItem $p -Filter "*music.youtube*" -ErrorAction SilentlyContinue
            foreach ($d in $ytm) {
                if ($d.LastWriteTime -gt $latestTime) {
                    $latestTime = $d.LastWriteTime
                    $bestService = "YouTube Music"
                }
            }
            $apple = Get-ChildItem $p -Filter "*apple*" -ErrorAction SilentlyContinue
            foreach ($d in $apple) {
                if ($d.LastWriteTime -gt $latestTime) {
                    $latestTime = $d.LastWriteTime
                    $bestService = "Apple Music"
                }
            }
            $sc = Get-ChildItem $p -Filter "*soundcloud*" -ErrorAction SilentlyContinue
            foreach ($d in $sc) {
                if ($d.LastWriteTime -gt $latestTime) {
                    $latestTime = $d.LastWriteTime
                    $bestService = "SoundCloud"
                }
            }
        }
    }
    $script:cachedStreamingService = $bestService
    $script:lastStreamingServiceCheck = [DateTime]::UtcNow
    return $bestService
}

$lastTrack = ""
$lastBroadcastTime = [DateTime]::MinValue
$artworkCache = @{}

Function Get-TrackArtwork {
    param(
        [string]$artist = "",
        [string]$title = "",
        [string]$album = ""
    )
    if (-not $title) { return @{ artworkUrl = ""; album = $album } }
    $cacheKey = "$artist - $title - $album"
    if ($artworkCache.ContainsKey($cacheKey)) {
        return $artworkCache[$cacheKey]
    }

    $cleanTitle = $title -replace '[\(\[\{].*?[\)\]\}]', '' -replace '[\?\!\,\.\:\;]', ' ' -replace '\s+', ' '
    $cleanTitle = $cleanTitle.Trim()
    $primaryArtist = ($artist -split '[,&/]|feat\.|ft\.')[0] -replace '[\?\!\,\.\:\;]', ' ' -replace '\s+', ' '
    $primaryArtist = $primaryArtist.Trim()

    $queries = @(
        "$primaryArtist $cleanTitle $album",
        "$primaryArtist $cleanTitle",
        "$cleanTitle"
    )

    foreach ($q in $queries) {
        $trimmedQ = $q.Trim()
        if (-not $trimmedQ) { continue }
        try {
            $enc = [System.Uri]::EscapeDataString($trimmedQ)
            $url = "https://api.deezer.com/search?q=$enc&limit=5"
            $resp = Invoke-RestMethod -Uri $url -Method GET -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($resp -and $resp.data -and $resp.data.Count -gt 0) {
                $match = $resp.data | Where-Object {
                    $itemArtist = if ($_.artist -and $_.artist.name) { $_.artist.name.ToLower() } else { "" }
                    $itemTitle = if ($_.title) { $_.title.ToLower() } else { "" }
                    $primaryLower = $primaryArtist.ToLower()
                    $titleLower = $cleanTitle.ToLower()
                    $artistOk = (-not $primaryLower) -or $itemArtist.Contains($primaryLower) -or $primaryLower.Contains($itemArtist)
                    $titleOk = (-not $titleLower) -or $itemTitle.Contains($titleLower) -or $titleLower.Contains($itemTitle)
                    $artistOk -and $titleOk
                } | Select-Object -First 1

                if ($match -and $match.album) {
                    $art = if ($match.album.cover_xl) { $match.album.cover_xl } elseif ($match.album.cover_big) { $match.album.cover_big } else { $match.album.cover_medium }
                    $alb = if ($album) { $album } else { $match.album.title }
                    $dur = if ($match.duration -and $match.duration -gt 0) { [int]$match.duration } else { 0 }
                    $res = @{ artworkUrl = $art; album = $alb; durationSec = $dur }
                    $artworkCache[$cacheKey] = $res
                    return $res
                }
            }
        } catch {}
    }

    # 2. Try iTunes Search API as secondary fallback
    try {
        $term = [System.Uri]::EscapeDataString("$primaryArtist $cleanTitle")
        $itUrl = "https://itunes.apple.com/search?term=$term&entity=song&limit=5"
        $itResp = Invoke-RestMethod -Uri $itUrl -Method GET -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($itResp -and $itResp.results -and $itResp.results.Count -gt 0) {
            $itMatch = $itResp.results | Where-Object {
                $a = if ($_.artistName) { $_.artistName.ToLower() } else { "" }
                $t = if ($_.trackName) { $_.trackName.ToLower() } else { "" }
                $p = $primaryArtist.ToLower()
                $c = $cleanTitle.ToLower()
                ((-not $p) -or $a.Contains($p) -or $p.Contains($a)) -and ((-not $c) -or $t.Contains($c) -or $c.Contains($t))
            } | Select-Object -First 1

            if ($itMatch) {
                $rawArt = if ($itMatch.artworkUrl100) { $itMatch.artworkUrl100 } else { $itMatch.artworkUrl60 }
                $art = if ($rawArt) { $rawArt -replace '\/\d+x\d+bb\.', '/600x600bb.' } else { "" }
                $alb = if ($album) { $album } else { $itMatch.collectionName }
                $dur = if ($itMatch.trackTimeMillis -and $itMatch.trackTimeMillis -gt 0) { [Math]::Round($itMatch.trackTimeMillis / 1000) } else { 0 }
                $res = @{ artworkUrl = $art; album = $alb; durationSec = $dur }
                $artworkCache[$cacheKey] = $res
                return $res
            }
        }
    } catch {}

    $res = @{ artworkUrl = ""; album = $album; durationSec = 0 }
    $artworkCache[$cacheKey] = $res
    return $res
}

Function Test-IsAdvertisement {
    param(
        [string]$title = "",
        [string]$artist = "",
        [string]$album = "",
        [string]$app = ""
    )
    $t = if ($title) { $title.Trim().ToLower() } else { "" }
    $a = if ($artist) { $artist.Trim().ToLower() } else { "" }
    $alb = if ($album) { $album.Trim().ToLower() } else { "" }
    $ap = if ($app) { $app.Trim().ToLower() } else { "" }

    if ($t -match '^(advertisement|audio ad|commercial|sponsored|promo|ad|spotify ad)$') { return $true }
    if ($t.StartsWith("advertisement") -or $t.EndsWith("advertisement")) { return $true }
    if ($t -eq "spotify" -and (-not $a -or $a -eq "spotify")) { return $true }
    if ($t -eq "spotify free" -or $a -eq "advertisement" -or $a -eq "spotify advertisement") { return $true }
    if ($alb -match '^(advertisement|commercial)$') { return $true }
    return $false
}

while ($true) {
    try {
        # Ensure manager is valid
        if (-not $manager) {
            try {
                $op = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
                $manager = Await-WinRT $op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
            } catch {
                Start-Sleep -Milliseconds 500
                continue
            }
        }

        $session = $null
        try {
            $cur = $manager.GetCurrentSession()
            if ($cur) {
                $pb = $cur.GetPlaybackInfo()
                if ($pb -and ($pb.PlaybackStatus -eq 4 -or $pb.PlaybackStatus -eq "Playing")) {
                    $session = $cur
                }
            }
        } catch {
            $manager = $null
        }

        # If current focused session is not playing, check all sessions for active background playback
        if (-not $session -and $manager) {
            try {
                $allSessions = $manager.GetSessions()
                if ($allSessions) {
                    foreach ($s in $allSessions) {
                        try {
                            $pb = $s.GetPlaybackInfo()
                            if ($pb -and ($pb.PlaybackStatus -eq 4 -or $pb.PlaybackStatus -eq "Playing")) {
                                $session = $s
                                break
                            }
                        } catch {}
                    }
                }
            } catch {
                $manager = $null
            }
        }

        # If still no playing session found, check if there is at least an existing session with metadata
        if (-not $session -and $manager) {
            try {
                $session = $manager.GetCurrentSession()
            } catch {}
        }

        $mediaInfo = $null
        $playbackInfo = $null
        if ($session) {
            try {
                $propOp = $session.TryGetMediaPropertiesAsync()
                $mediaInfo = Await-WinRT $propOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                $playbackInfo = $session.GetPlaybackInfo()
            } catch {
                $session = $null
            }
        }

        if ($session -and $mediaInfo -and $mediaInfo.Title) {
            $status = if ($playbackInfo) { $playbackInfo.PlaybackStatus } else { 0 }
            $title = $mediaInfo.Title
            $artist = $mediaInfo.Artist
            $album = $mediaInfo.AlbumTitle
            $sourceApp = $session.SourceAppUserModelId

            # Filter advertisements (Spotify, YouTube, browser ads)
            if (Test-IsAdvertisement -title $title -artist $artist -album $album -app $sourceApp) {
                Start-Sleep -Milliseconds 200
                continue
            }

            # Retrieve track timeline properties (start to finish duration & live position)
            $durationSec = 0
            $positionSec = 0
            try {
                $tl = $session.GetTimelineProperties()
                if ($tl) {
                    if ($tl.EndTime -and $tl.EndTime.TotalSeconds -gt 0) {
                        $durationSec = [Math]::Round($tl.EndTime.TotalSeconds)
                    }
                    if ($tl.Position -and $tl.Position.TotalSeconds -ge 0) {
                        $positionSec = [Math]::Round($tl.Position.TotalSeconds)
                    }
                }
            } catch {}

            # PlaybackStatus: 4 = Playing, 5 = Paused, 3 = Stopped
            $isPlaying = ($status -eq 4 -or $status -eq "Playing")
            $trackKey = "$title - $artist - $album - $isPlaying - $sourceApp"

            $shouldBroadcast = ($trackKey -ne $lastTrack) -or ($isPlaying -and ([DateTime]::UtcNow - $lastBroadcastTime).TotalSeconds -ge 45)

            if ($title -and $shouldBroadcast) {
                $isNewTrack = ($trackKey -ne $lastTrack)
                $lastTrack = $trackKey
                $lastBroadcastTime = [DateTime]::UtcNow

                # Determine streaming platform
                $source = "Music"
                $appLower = if ($sourceApp) { $sourceApp.ToLower() } else { "" }
                $titleLower = if ($title) { $title.ToLower() } else { "" }

                # Determine friendly device info ("where it plays")
                $deviceApp = "Desktop Audio"
                $isBrowser = $false

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
                } elseif ($appLower -match "tidal") {
                    $source = "Tidal"
                    $deviceApp = "Tidal App"
                } elseif ($appLower -match "deezer") {
                    $source = "Deezer"
                    $deviceApp = "Deezer App"
                } elseif ($appLower -match "foobar2000") {
                    $source = "Music"
                    $deviceApp = "foobar2000"
                } elseif ($appLower -match "vlc") {
                    $source = "Music"
                    $deviceApp = "VLC Media Player"
                } elseif ($appLower -match "musicbee") {
                    $source = "Music"
                    $deviceApp = "MusicBee"
                } elseif ($appLower -match "aimp") {
                    $source = "Music"
                    $deviceApp = "AIMP"
                } elseif ($appLower -match "winamp") {
                    $source = "Music"
                    $deviceApp = "Winamp"
                # --- Multi-Browser Detection ---
                } elseif ($appLower -match "zen") {
                    $deviceApp = "Zen Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "librewolf") {
                    $deviceApp = "LibreWolf Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "operagx") {
                    $deviceApp = "Opera GX"
                    $isBrowser = $true
                } elseif ($appLower -match "opera") {
                    $deviceApp = "Opera Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "brave") {
                    $deviceApp = "Brave Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "vivaldi") {
                    $deviceApp = "Vivaldi Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "arc") {
                    $deviceApp = "Arc Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "waterfox") {
                    $deviceApp = "Waterfox Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "floorp") {
                    $deviceApp = "Floorp Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "thorium") {
                    $deviceApp = "Thorium Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "chromium") {
                    $deviceApp = "Chromium Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "chrome") {
                    $deviceApp = "Chrome Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "msedge|edge") {
                    $deviceApp = "Edge Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "firefox") {
                    $deviceApp = "Firefox Browser"
                    $isBrowser = $true
                } elseif ($appLower -match "tor") {
                    $deviceApp = "Tor Browser"
                    $isBrowser = $true
                } else {
                    $cleanName = $sourceApp -replace '\.exe$', '' -replace '^.*\\', ''
                    $deviceApp = if ($cleanName) { $cleanName } else { "Desktop Audio" }
                    if ($deviceApp -match "browser|web") { $isBrowser = $true }
                }

                # If playing in any browser, accurately detect streaming platform
                if ($isBrowser) {
                    if ($titleLower -match "spotify" -or $sourceApp -match "spotify") {
                        $source = "Spotify"
                    } elseif ($titleLower -match "apple music|itunes" -or $sourceApp -match "apple") {
                        $source = "Apple Music"
                    } elseif ($titleLower -match "youtube music|yt music" -or $sourceApp -match "youtube") {
                        $source = "YouTube Music"
                    } elseif ($titleLower -match "soundcloud") {
                        $source = "SoundCloud"
                    } elseif ($titleLower -match "tidal") {
                        $source = "Tidal"
                    } elseif ($titleLower -match "deezer") {
                        $source = "Deezer"
                    } else {
                        # Auto-detect which streaming platform is actively open/active in the browser
                        $detectedBrowserService = Detect-BrowserStreamingService
                        if ($detectedBrowserService) {
                            $source = $detectedBrowserService
                        } else {
                            $source = "Spotify"
                        }
                    }
                }

                $bullet = [char]0x2022
                $rawDev = "Desktop PC $bullet $deviceApp ($source)"
                $device = ($rawDev -replace '(?:\s*[\.\-\u2022\u00B7\u25CF\uFFFD\?]+\s*)+', " $bullet ").Trim()

                $cacheKey = "$artist - $title - $album"
                $hasCachedArt = $artworkCache.ContainsKey($cacheKey)

                if ($hasCachedArt) {
                    $artInfo = $artworkCache[$cacheKey]
                    $artworkUrl = if ($artInfo.artworkUrl) { $artInfo.artworkUrl } else { "" }
                    if (-not $album -and $artInfo.album) { $album = $artInfo.album }
                    if ($durationSec -le 0 -and $artInfo.durationSec -gt 0) { $durationSec = $artInfo.durationSec }
                } else {
                    $artworkUrl = ""
                }

                # BROADCAST INSTANTLY (0ms delay - do not wait for external artwork lookups)
                $payload = @{
                    source = $source
                    title = $title
                    artist = $artist
                    album = $album
                    artworkUrl = $artworkUrl
                    isPlaying = $isPlaying
                    device = $device
                    deviceType = "desktop"
                    duration = $durationSec
                    position = $positionSec
                }
                if ($Secret) {
                    $payload["secret"] = $Secret
                }
                $jsonBody = $payload | ConvertTo-Json -Compress
                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)

                try {
                    Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $bodyBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 3 | Out-Null
                } catch {}

                $stateIcon = if ($isPlaying) { "PLAYING" } else { "PAUSED" }
                $timeSuffix = if ($durationSec -gt 0) {
                    $m = [int][Math]::Floor($durationSec / 60)
                    $s = [int]($durationSec % 60)
                    " [00:00 / {0:D2}:{1:D2}]" -f $m, $s
                } else { "" }
                if ($isNewTrack) {
                    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] Track Detected Instantly -> [$stateIcon] $title by $artist on $source ($device)$timeSuffix" -ForegroundColor Green
                }

                # If artwork was not cached, resolve it now and send fast enrichment update
                if (-not $hasCachedArt -and $isPlaying -and $title) {
                    $artInfo = Get-TrackArtwork -artist $artist -title $title -album $album
                    if ($artInfo.artworkUrl -or ($artInfo.album -and -not $album) -or ($durationSec -le 0 -and $artInfo.durationSec -gt 0)) {
                        if ($artInfo.artworkUrl) { $payload["artworkUrl"] = $artInfo.artworkUrl }
                        if ($artInfo.album) { $payload["album"] = $artInfo.album }
                        if ($durationSec -le 0 -and $artInfo.durationSec -gt 0) {
                            $durationSec = $artInfo.durationSec
                            $payload["duration"] = $durationSec
                        }
                        $enrichBytes = [System.Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
                        try {
                            Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $enrichBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 3 | Out-Null
                        } catch {}
                    }
                }
            }
        } else {
            # If playback was active but session is now closed, broadcast paused state
            if ($lastTrack -ne "") {
                $lastTrack = ""
                $lastBroadcastTime = [DateTime]::MinValue
                $payloadJson = @{
                    isPlaying = $false
                    title = ""
                } | ConvertTo-Json -Compress
                $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payloadJson)
                try {
                    Invoke-RestMethod -Uri $ApiUrl -Method POST -Body $payloadBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 3 | Out-Null
                    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] Playback stopped. Broadcasted standby." -ForegroundColor Yellow
                } catch {}
            }
        }
    } catch {
        Write-Host "LOOP ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Start-Sleep -Milliseconds 500
    }

    # Ultra-responsive 200ms check for instant track start detection
    Start-Sleep -Milliseconds 200
}
