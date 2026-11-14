const endpointInput = document.getElementById('endpoint');
const tokenInput = document.getElementById('token');
const status = document.getElementById('status');

chrome.storage.local.get(['endpoint', 'token'], settings => {
  if (settings.endpoint) endpointInput.value = settings.endpoint;
  if (settings.token) tokenInput.value = settings.token;
});

document.getElementById('save').addEventListener('click', () => {
  const endpoint = endpointInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  if (!/^https:\/\//i.test(endpoint) || !token) {
    status.textContent = 'Enter an HTTPS website URL and publishing token.';
    return;
  }

  chrome.storage.local.set({ endpoint, token }, () => {
    status.textContent = chrome.runtime.lastError ? 'Unable to save settings.' : 'Settings saved.';
  });
});
