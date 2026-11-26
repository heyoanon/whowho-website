// ==UserScript==
// @name         YouTube Music & BitChord Now Playing Sync
// @namespace    https://github.com/heyoanon/whowho-website
// @version      2.1.0
// @description  Broadcasts what is currently playing in YouTube Music, Spotify, Apple Music & BitChord to your Whoami website API with multi-device and tablet support
// @match        https://music.youtube.com/*
// @match        https://www.youtube.com/*
// @match        https://open.spotify.com/*
// @match        https://music.apple.com/*
// @match        https://*.bitchord.com/*
// @match        https://bitchord.com/*
// @match        https://*.bitchord.app/*
// @match        https://bitchord.app/*
// @match        https://*.bitchord.io/*
// @match        https://bitchord.io/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const API_ENDPOINT = window.location.origin.includes('localhost')
        ? 'http://localhost:3000/api/now-playing'
        : 'https://whowho-website.vercel.app/api/now-playing';

    const API_SECRET = '';
    let lastTrackKey = '';
    let isCurrentlyPlaying = false;

    function detectPlatform() {
        const host = window.location.hostname.toLowerCase();
        if (host.includes('spotify')) return 'Spotify';
        if (host.includes('apple')) return 'Apple Music';
        if (host.includes('youtube')) return 'YouTube Music';
        if (host.includes('bitchord')) return 'BitChord';
        return 'Music';
    }

    function detectBrowserName() {
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('edg/')) return 'Edge Browser';
        if (ua.includes('opr/') || ua.includes('opera')) return 'Opera Browser';
        if (ua.includes('firefox/')) return 'Firefox Browser';
        if (ua.includes('chrome/')) return 'Chrome Browser';
        if (ua.includes('safari/')) return 'Safari Browser';
        return 'Web Browser';
    }

    function getDeviceLocation() {
        const isTablet = /iPad|tablet|(android(?!.*mobile))/i.test(navigator.userAgent);
        const isMobile = !isTablet && /Android|iPhone|iPod/i.test(navigator.userAgent);
        const browser = detectBrowserName();
        const platform = detectPlatform();
        const devName = platform === 'BitChord' ? `${browser} (BitChord)` : browser;
        let device = `Desktop PC • ${devName}`;
        let deviceType = 'desktop';
        if (isTablet) {
            device = `Tablet • ${devName}`;
            deviceType = 'tablet';
        } else if (isMobile) {
            device = `Mobile Phone • ${devName}`;
            deviceType = 'mobile';
        }
        return {
            device,
            deviceType
        };
    }

    function getLivePlaybackTime(platform) {
        let position = 0;
        let duration = 0;

        const mediaElements = Array.from(document.querySelectorAll('audio, video'));
        const activeMedia = mediaElements.find(el => !el.paused && !el.ended);
        if (activeMedia) {
            if (Number.isFinite(activeMedia.duration) && activeMedia.duration > 0) duration = Math.round(activeMedia.duration);
            if (Number.isFinite(activeMedia.currentTime) && activeMedia.currentTime >= 0) position = Math.round(activeMedia.currentTime);
        }

        if (platform === 'BitChord') {
            const curEl = document.querySelector('.bitchord-time-current, .player-time-current, .current-time, [data-testid="current-time"], .time-current');
            const totalEl = document.querySelector('.bitchord-time-total, .player-time-total, .total-time, [data-testid="total-time"], .time-total, .duration');
            if (curEl && curEl.textContent) {
                const parts = curEl.textContent.trim().split(':').map(Number);
                if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) position = parts[0] * 60 + parts[1];
                else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) position = parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
            if (totalEl && totalEl.textContent) {
                const parts = totalEl.textContent.trim().split(':').map(Number);
                if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) duration = parts[0] * 60 + parts[1];
                else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
        } else if (platform === 'YouTube Music') {
            const timeEl = document.querySelector('ytmusic-player-bar .time-info');
            if (timeEl && timeEl.textContent) {
                const [pStr, dStr] = timeEl.textContent.split('/').map(s => s.trim());
                if (pStr) {
                    const parts = pStr.split(':').map(Number);
                    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) position = parts[0] * 60 + parts[1];
                }
                if (dStr) {
                    const parts = dStr.split(':').map(Number);
                    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) duration = parts[0] * 60 + parts[1];
                }
            }
        }

        return {
            position,
            duration,
            isPlaying: Boolean(activeMedia || (navigator.mediaSession && navigator.mediaSession.playbackState === 'playing'))
        };
    }

    function sendTrackUpdate(trackData) {
        const devInfo = getDeviceLocation();
        const payload = JSON.stringify({
            ...devInfo,
            ...trackData,
            clientTimestamp: Date.now(),
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
            }).catch(() => { });
        }
    }

    function checkNowPlaying() {
        const platform = detectPlatform();
        if (navigator.mediaSession && navigator.mediaSession.metadata) {
            const meta = navigator.mediaSession.metadata;
            const title = (meta.title || '').trim();
            const artist = (meta.artist || '').trim();
            const album = (meta.album || '').trim();
            const artworkUrl = meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : '';

            const liveTiming = getLivePlaybackTime(platform);
            const isPlaying = liveTiming.isPlaying;
            const duration = liveTiming.duration;
            const position = liveTiming.position;

            const trackKey = `${platform}:${title}:${artist}:${isPlaying}:${Math.floor(position / 5)}`;
            if (title && (trackKey !== lastTrackKey || isPlaying !== isCurrentlyPlaying)) {
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
                    position,
                    isPlaying
                });
            }
        }
    }

    setInterval(checkNowPlaying, 2000);
    window.addEventListener('beforeunload', () => {
        if (isCurrentlyPlaying) sendTrackUpdate({ isPlaying: false, title: '' });
    });
})();
