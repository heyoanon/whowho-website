# YouTube Music browser bridge

This Chrome/Edge Manifest V3 extension reads the current track from an open YouTube Music tab and publishes its metadata to the website's protected music endpoint.

## Setup

1. Generate a random token (for example, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), save it as the Vercel Production environment variable `MUSIC_PRESENCE_TOKEN`, and redeploy.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. Select this folder.
3. Open the extension settings and enter the website URL and the same token.
4. Open or refresh `https://music.youtube.com` and start playback. The Now Playing page updates from the bridge.

Keep the token private and do not commit it. The token is stored in the browser's local extension storage. Track metadata is published publicly on the website. Updates expire automatically if the browser stops sending them.
