// ==UserScript==
// @name         Whoami Now Playing Multi-Streaming Sync
// @namespace    https://github.com/heyoanon/whowho-website
// @version      2.1.0
// @description  Automatically broadcasts currently playing audio from Spotify, YouTube Music, and Apple Music Web to your Whoami website in real-time with device info.
// @match        https://open.spotify.com/*
// @match        https://music.youtube.com/*
// @match        https://www.youtube.com/*
// @match        https://music.apple.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const API_ENDPOINT = window.location.origin.includes('localhost') 
        ? 'http://localhost:3000/api/now-playing'
        : 'https://whowho-website.vercel.app/api/now-playing';

    const API_SECRET = '';

    let lastTrackKey = '';
    let isCurrentlyPlaying = false;

    function detectStreamingPlatform() {
        const host = window.location.hostname.toLowerCase();
        if (host.includes('spotify.com')) return 'Spotify';
        if (host.includes('music.youtube.com') || host.includes('youtube.com')) return 'YouTube Music';
        if (host.includes('apple.com')) return 'Apple Music';
        return 'Music';
    }

    function detectBrowserName() {
        const ua = navigator.userAgent || '';
        const uaLower = ua.toLowerCase();

        // 1. Zen Browser
        if (uaLower.includes('zen') || (window.navigator?.userAgentData?.brands?.some(b => /zen/i.test(b.brand)))) {
            return 'Zen Browser';
        }
        // 2. LibreWolf
        if (uaLower.includes('librewolf')) {
            return 'LibreWolf Browser';
        }
        // 3. Opera / Opera GX
        if (uaLower.includes('opr/') || uaLower.includes('opera')) {
            return uaLower.includes('gx') ? 'Opera GX' : 'Opera Browser';
        }
        // 4. Brave
        if (navigator.brave || (window.navigator?.userAgentData?.brands?.some(b => /brave/i.test(b.brand))) || uaLower.includes('brave')) {
            return 'Brave Browser';
        }
        // 5. Vivaldi
        if (uaLower.includes('vivaldi')) {
            return 'Vivaldi Browser';
        }
        // 6. Arc
        if (window.arc || uaLower.includes('arc/')) {
            return 'Arc Browser';
        }
        // 7. Waterfox / Floorp
        if (uaLower.includes('waterfox')) return 'Waterfox Browser';
        if (uaLower.includes('floorp')) return 'Floorp Browser';
        // 8. Edge
        if (uaLower.includes('edg/')) return 'Edge Browser';
        // 9. Firefox
        if (uaLower.includes('firefox/')) return 'Firefox Browser';
        // 10. Chrome / Chromium
        if (uaLower.includes('chrome/')) return 'Chrome Browser';
        // 11. Safari
        if (uaLower.includes('safari/')) return 'Safari Browser';

        return 'Web Browser';
    }

    function getDeviceLocation() {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const browser = detectBrowserName();
        return {
            device: isMobile ? `Mobile Phone • ${browser}` : `Desktop PC • ${browser}`,
            deviceType: isMobile ? 'mobile' : 'desktop'
        };
    }

    function sendTrackUpdate(trackData) {
        const devInfo = getDeviceLocation();
        const payload = JSON.stringify({
            ...devInfo,
            ...trackData,
            secret: API_SECRET
        });

        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_ENDPOINT,
                headers: { 'Content-Type': 'application/json' },
                data: payload
            });
        } else {
            fetch(API_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }).catch(() => {});
        }
    }

    function isAdvertisement(title, artist, album) {
        const t = (title || '').trim().toLowerCase();
        const a = (artist || '').trim().toLowerCase();
        const alb = (album || '').trim().toLowerCase();

        if (/^(advertisement|audio ad|commercial|sponsored|promo|ad|spotify ad)$/i.test(t)) return true;
        if (/^advertisement\b|\badvertisement$/i.test(t)) return true;
        if (t === 'spotify' && (!a || a === 'spotify')) return true;
        if (t === 'spotify free' || a === 'advertisement' || a === 'spotify advertisement') return true;
        if (/^(advertisement|commercial)$/i.test(alb)) return true;

        if (document.querySelector('[data-testid="ad-banner"]') ||
            document.querySelector('.ad-showing') ||
            document.querySelector('.ad-interrupting')) {
            return true;
        }
        return false;
    }

    function checkNowPlaying() {
        const platform = detectStreamingPlatform();

        // 1. MediaSession API (Universal standard across Spotify, YouTube Music, and Apple Music)
        if (navigator.mediaSession && navigator.mediaSession.metadata) {
            const meta = navigator.mediaSession.metadata;
            const title = (meta.title || '').trim();
            const artist = (meta.artist || '').trim();
            const album = (meta.album || '').trim();

            if (isAdvertisement(title, artist, album)) return;
            const artworkUrl = meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : '';

            const mediaElements = Array.from(document.querySelectorAll('audio, video'));
            const activeMedia = mediaElements.find(el => !el.paused && !el.ended && el.currentTime > 0);
            const isPlaying = Boolean(activeMedia || (navigator.mediaSession.playbackState === 'playing'));
            const duration = activeMedia && Number.isFinite(activeMedia.duration) ? Math.round(activeMedia.duration) : 0;

            const trackKey = `${platform}:${title}:${artist}:${album}:${isPlaying}`;
            if (title && trackKey !== lastTrackKey) {
                lastTrackKey = trackKey;
                isCurrentlyPlaying = isPlaying;
                sendTrackUpdate({
                    source: platform,
                    title,
                    artist,
                    album,
                    artworkUrl,
                    url: window.location.href,
                    duration,
                    isPlaying
                });
                return;
            }
            if (title) return;
        }

        // 2. DOM Fallbacks
        if (platform === 'Spotify') {
            const titleEl = document.querySelector('[data-testid="now-playing-widget"] [data-testid="context-item-info-title"] a') ||
                            document.querySelector('.now-playing-bar [data-testid="context-item-link"]') ||
                            document.querySelector('[data-testid="now-playing-widget"] a');
            const artistEl = document.querySelector('[data-testid="now-playing-widget"] [data-testid="context-item-info-subtitles"] a') ||
                             document.querySelector('.now-playing-bar [data-testid="context-item-info-artist"]');
            const imgEl = document.querySelector('[data-testid="now-playing-widget"] img') ||
                          document.querySelector('.now-playing-bar img');
            const playBtn = document.querySelector('[data-testid="control-button-playpause"]');

            if (titleEl) {
                const title = (titleEl.textContent || '').trim();
                const artist = artistEl ? (artistEl.textContent || '').trim() : '';
                const artworkUrl = imgEl ? (imgEl.src || '') : '';
                const isPlaying = playBtn ? playBtn.getAttribute('aria-label') === 'Pause' : true;
                const trackKey = `Spotify:${title}:${artist}:${isPlaying}`;
                if (title && trackKey !== lastTrackKey) {
                    lastTrackKey = trackKey;
                    isCurrentlyPlaying = isPlaying;
                    sendTrackUpdate({
                        source: 'Spotify',
                        title,
                        artist,
                        album: '',
                        artworkUrl,
                        url: titleEl.href || window.location.href,
                        duration: 0,
                        isPlaying
                    });
                }
            }
        } else if (platform === 'YouTube Music') {
            const titleEl = document.querySelector('ytmusic-player-bar .title');
            const bylineEl = document.querySelector('ytmusic-player-bar .byline');
            const artEl = document.querySelector('ytmusic-player-bar .image');
            const playBtn = document.querySelector('ytmusic-player-bar #play-pause-button');

            if (titleEl && bylineEl) {
                const title = (titleEl.textContent || '').trim();
                const artist = (bylineEl.textContent || '').trim();
                const artworkUrl = artEl ? (artEl.src || '') : '';
                const isPlaying = playBtn ? playBtn.getAttribute('aria-label') === 'Pause' : true;
                const trackKey = `YTM:${title}:${artist}:${isPlaying}`;
                if (title && trackKey !== lastTrackKey) {
                    lastTrackKey = trackKey;
                    isCurrentlyPlaying = isPlaying;
                    sendTrackUpdate({
                        source: 'YouTube Music',
                        title,
                        artist,
                        album: '',
                        artworkUrl,
                        url: window.location.href,
                        duration: 0,
                        isPlaying
                    });
                }
            }
        } else if (platform === 'Apple Music') {
            const titleEl = document.querySelector('.playback-description__title') ||
                            document.querySelector('amp-lcd .lcd-meta__title');
            const artistEl = document.querySelector('.playback-description__secondary') ||
                             document.querySelector('amp-lcd .lcd-meta__secondary');
            const imgEl = document.querySelector('.playback-artwork img') ||
                          document.querySelector('amp-lcd img');
            const playBtn = document.querySelector('.playback-play-controls button[data-testid="play-pause-button"]') ||
                            document.querySelector('amp-playback-controls-item button');

            if (titleEl) {
                const title = (titleEl.textContent || '').trim();
                const artist = artistEl ? (artistEl.textContent || '').trim() : '';
                const artworkUrl = imgEl ? (imgEl.src || '') : '';
                const isPlaying = playBtn ? playBtn.getAttribute('aria-label')?.toLowerCase().includes('pause') : true;
                const trackKey = `AppleMusic:${title}:${artist}:${isPlaying}`;
                if (title && trackKey !== lastTrackKey) {
                    lastTrackKey = trackKey;
                    isCurrentlyPlaying = isPlaying;
                    sendTrackUpdate({
                        source: 'Apple Music',
                        title,
                        artist,
                        album: '',
                        artworkUrl,
                        url: window.location.href,
                        duration: 0,
                        isPlaying
                    });
                }
            }
        }
    }

    // 1. Ultra-fast 250ms polling
    setInterval(checkNowPlaying, 250);

    // 2. Instant MediaSession interception: fires the microsecond Spotify/YTM/Apple sets song metadata
    try {
        if (navigator.mediaSession) {
            let currentMeta = navigator.mediaSession.metadata;
            Object.defineProperty(navigator.mediaSession, 'metadata', {
                get() { return currentMeta; },
                set(val) {
                    currentMeta = val;
                    checkNowPlaying();
                    setTimeout(checkNowPlaying, 80);
                },
                configurable: true,
                enumerable: true
            });

            let currentPlaybackState = navigator.mediaSession.playbackState;
            Object.defineProperty(navigator.mediaSession, 'playbackState', {
                get() { return currentPlaybackState; },
                set(val) {
                    currentPlaybackState = val;
                    checkNowPlaying();
                },
                configurable: true,
                enumerable: true
            });
        }
    } catch {}

    // 3. Instant media event triggers (0ms delay as soon as audio starts or unpauses)
    ['play', 'playing', 'loadeddata', 'loadedmetadata', 'ratechange'].forEach(evt => {
        document.addEventListener(evt, () => {
            checkNowPlaying();
            setTimeout(checkNowPlaying, 100);
        }, true);
    });
    document.addEventListener('pause', () => setTimeout(checkNowPlaying, 50), true);
    document.addEventListener('ended', () => setTimeout(checkNowPlaying, 50), true);

    // 4. MutationObserver for DOM player bar changes (Spotify, YTM, Apple Music)
    try {
        const observer = new MutationObserver(() => {
            checkNowPlaying();
        });
        window.addEventListener('DOMContentLoaded', () => {
            const playerBar = document.querySelector('[data-testid="now-playing-widget"]') ||
                              document.querySelector('ytmusic-player-bar') ||
                              document.querySelector('.playback-description') ||
                              document.body;
            if (playerBar) {
                observer.observe(playerBar, { childList: true, subtree: true, characterData: true });
            }
        });
    } catch {}

    // 5. Broadcast pause when tab is closed
    window.addEventListener('beforeunload', () => {
        if (isCurrentlyPlaying) {
            sendTrackUpdate({ isPlaying: false, title: '' });
        }
    });

    console.log(`[Whoami Sync] Loaded ultra-responsive auto-sync for ${detectStreamingPlatform()}.`);
})();
