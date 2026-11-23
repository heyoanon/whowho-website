// ==UserScript==
// @name         YouTube Music & BitChord Now Playing Sync
// @namespace    https://github.com/heyoanon/whowho-website
// @version      1.0.0
// @description  Broadcasts what is currently playing in YouTube Music / BitChord to your Whoami website API
// @match        https://music.youtube.com/*
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    // REPLACE with your website domain (e.g. 'https://whowho-website.vercel.app')
    const API_ENDPOINT = window.location.origin.includes('localhost') 
        ? 'http://localhost:3000/api/now-playing'
        : 'https://whowho-website.vercel.app/api/now-playing';

    // Optional secret key if you set NOW_PLAYING_SECRET in your Vercel environment variables
    const API_SECRET = '';

    let lastTrackKey = '';
    let isCurrentlyPlaying = false;

    function sendTrackUpdate(trackData) {
        const payload = JSON.stringify({
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

    function checkNowPlaying() {
        // 1. Try MediaSession API (most reliable across browsers)
        if (navigator.mediaSession && navigator.mediaSession.metadata) {
            const meta = navigator.mediaSession.metadata;
            const title = (meta.title || '').trim();
            const artist = (meta.artist || '').trim();
            const album = (meta.album || '').trim();
            const artworkUrl = meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : '';

            const video = document.querySelector('video');
            const isPlaying = video ? !video.paused && !video.ended : true;
            const duration = video && Number.isFinite(video.duration) ? Math.round(video.duration) : 0;

            const trackKey = `${title} - ${artist} - ${isPlaying}`;
            if (title && trackKey !== lastTrackKey) {
                lastTrackKey = trackKey;
                isCurrentlyPlaying = isPlaying;
                sendTrackUpdate({
                    source: window.location.host.includes('music.youtube') ? 'YouTube Music' : 'YouTube',
                    title,
                    artist,
                    album,
                    artworkUrl,
                    url: window.location.href,
                    duration,
                    isPlaying
                });
            }
            return;
        }

        // 2. DOM fallback for YouTube Music Player Bar
        const titleEl = document.querySelector('ytmusic-player-bar .title');
        const bylineEl = document.querySelector('ytmusic-player-bar .byline');
        const artEl = document.querySelector('ytmusic-player-bar .image');
        const playBtn = document.querySelector('ytmusic-player-bar #play-pause-button');

        if (titleEl && bylineEl) {
            const title = (titleEl.textContent || '').trim();
            const artist = (bylineEl.textContent || '').trim();
            const artworkUrl = artEl ? (artEl.src || '') : '';
            const isPlaying = playBtn ? playBtn.getAttribute('aria-label') === 'Pause' : true;

            const trackKey = `${title} - ${artist} - ${isPlaying}`;
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
    }

    // Check every 2 seconds
    setInterval(checkNowPlaying, 2000);

    // Stop broadcast when tab is closed
    window.addEventListener('beforeunload', () => {
        if (isCurrentlyPlaying) {
            sendTrackUpdate({ isPlaying: false, title: '' });
        }
    });
})();
