const source = 'youtube-music';
let lastSignature = '';
let lastSentAt = 0;
let wasPlaying = false;

function firstText(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const text = element && element.textContent ? element.textContent.trim() : '';
    if (text) return text;
  }
  return '';
}

function readTrack() {
  const title = firstText([
    'ytmusic-player-bar .title',
    'ytmusic-player-bar .content-info-wrapper .title',
    'ytmusic-player-bar [aria-label*="song"]'
  ]);
  const video = document.querySelector('video');
  const playButton = document.querySelector('ytmusic-player-bar .play-pause-button');
  const playing = video ? !video.paused && !video.ended : Boolean(playButton && /pause/i.test(playButton.getAttribute('title') || ''));

  if (!playing || !title) {
    return { playing: false };
  }

  const subtitle = document.querySelector('ytmusic-player-bar .subtitle');
  const subtitleLinks = subtitle ? [...subtitle.querySelectorAll('a')].map(link => link.textContent.trim()).filter(Boolean) : [];
  const artist = subtitleLinks[0] || '';
  const album = subtitleLinks.length > 1 ? subtitleLinks[subtitleLinks.length - 1] : '';
  const artwork = document.querySelector('ytmusic-player-bar img.image, ytmusic-player-bar #thumbnail img');
  const artworkUrl = artwork && artwork.src && /^https?:\/\//i.test(artwork.src) ? artwork.src : '';
  const start = video && Number.isFinite(video.currentTime) ? Date.now() - video.currentTime * 1000 : 0;
  const end = video && Number.isFinite(video.duration) && video.duration > 0 ? start + video.duration * 1000 : 0;

  return {
    playing: true,
    source,
    track: {
      title,
      artist,
      album,
      artworkUrl,
      timestamps: start > 0 && end > start ? { start, end } : {}
    }
  };
}

function publishIfChanged() {
  const payload = readTrack();
  const signature = payload.playing
    ? JSON.stringify({ title: payload.track.title, artist: payload.track.artist, album: payload.track.album, artworkUrl: payload.track.artworkUrl })
    : '';
  const now = Date.now();
  const changed = signature !== lastSignature;
  if (!changed && payload.playing && now - lastSentAt < 10000) return;
  if (!changed && !payload.playing && !wasPlaying) return;

  lastSignature = signature;
  lastSentAt = now;
  wasPlaying = payload.playing;
  chrome.runtime.sendMessage({ type: 'youtube-music-presence', payload }, response => {
    if (chrome.runtime.lastError) {
      console.error('YouTube Music bridge could not reach its background worker:', chrome.runtime.lastError.message);
      return;
    }
    if (response && !response.success) {
      console.error('YouTube Music bridge update failed:', response.error);
    }
  });
}

publishIfChanged();
setInterval(publishIfChanged, 3000);
