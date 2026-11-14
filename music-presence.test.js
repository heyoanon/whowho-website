const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { after, before, test } = require('node:test');

const projectRoot = path.join(__dirname, '..');
const port = 32000 + Math.floor(Math.random() * 2000);
const token = 'music-presence-test-token';
const endpoint = `http://127.0.0.1:${port}/api/now-playing`;
let server;
let serverOutput = '';

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      VERCEL: '',
      ADMIN_PASSWORD: '',
      MUSIC_PRESENCE_TOKEN: token
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited during startup:\n${serverOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Server did not become ready:\n${serverOutput}`);
});

after(async () => {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await exited;
});

test('protects YouTube Music publishing, serves its track, and rejects other sources', async () => {
  const unauthenticated = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'youtube-music', playing: true, track: { title: 'Track' } })
  });
  assert.equal(unauthenticated.status, 401);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  const publish = await fetch(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      source: 'youtube-music',
      playing: true,
      track: {
        title: 'YouTube Music track',
        artist: 'Test artist',
        album: 'Test album',
        artworkUrl: '',
        timestamps: {}
      }
    })
  });
  assert.equal(publish.status, 200);

  const active = await fetch(endpoint).then(response => response.json());
  assert.deepEqual(active.tracks.map(track => track.source), ['youtube-music']);
  assert.equal(active.tracks[0].title, 'YouTube Music track');

  const unsupportedSource = await fetch(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      source: 'bitchord',
      playing: true,
      track: { title: 'BitChord track' }
    })
  });
  assert.equal(unsupportedSource.status, 400);

  const stop = await fetch(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ source: 'youtube-music', playing: false })
  });
  assert.equal(stop.status, 200);

  const remaining = await fetch(endpoint).then(response => response.json());
  assert.deepEqual(remaining.tracks, []);

  const unsafeArtwork = await fetch(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      source: 'youtube-music',
      playing: true,
      track: { title: 'Track', artworkUrl: 'javascript:alert(1)' }
    })
  });
  assert.equal(unsafeArtwork.status, 400);
});
