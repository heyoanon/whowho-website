chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'youtube-music-presence') {
    return false;
  }

  publishTrack(message.payload)
    .then(() => sendResponse({ success: true }))
    .catch(error => {
      console.error('Unable to publish YouTube Music presence:', error);
      sendResponse({ success: false, error: error.message });
    });

  return true;
});

async function publishTrack(payload) {
  const { endpoint = 'https://whowho-website.vercel.app', token = '' } = await chrome.storage.local.get(['endpoint', 'token']);
  if (!token) {
    throw new Error('Set the publishing token in the extension settings.');
  }

  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/now-playing`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`The music endpoint returned ${response.status}.`);
  }
}
