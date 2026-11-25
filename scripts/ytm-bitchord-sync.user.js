// ==UserScript==
// @name         YouTube Music & BitChord Now Playing Sync
// @namespace    https://github.com/heyoanon/whowho-website
// @version      2.0.0
// @description  Broadcasts what is currently playing in YouTube Music, Spotify, Apple Music & BitChord to your Whoami website API
// @match        https://music.youtube.com/*
// @match        https://www.youtube.com/*
// @match        https://open.spotify.com/*
// @match        https://music.apple.com/*
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
        return 'Music';
    }

    function sendTrackUpdate(trackData) {
        const payload = JSON.stringify({ ...trackData, secret: API_SECRET });
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

            const video = document.querySelector('video') || document.querySelector('audio');
            const isPlaying = video ? !video.paused && !video.ended : (navigator.mediaSession.playbackState === 'playing');
            const duration = video && Number.isFinite(video.duration) ? Math.round(video.duration) : 0;

            const trackKey = `${platform}:${title}:${artist}:${isPlaying}`;
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
            }
        }
    }

    setInterval(checkNowPlaying, 2000);
    window.addEventListener('beforeunload', () => {
        if (isCurrentlyPlaying) sendTrackUpdate({ isPlaying: false, title: '' });
    });
})();
