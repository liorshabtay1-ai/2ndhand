const input    = document.getElementById('api-key-input');
const saveBtn  = document.getElementById('save-btn');
const feedback = document.getElementById('feedback');
const toggle   = document.getElementById('key-toggle');
const badge    = document.getElementById('status-badge');
const statusTx = document.getElementById('status-text');

// Load saved key
chrome.storage.local.get('anthropicApiKey', ({ anthropicApiKey }) => {
  if (anthropicApiKey) {
    input.value = anthropicApiKey;
    showFeedback('Key saved ✓', 'ok');
  }
});

// Page status
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.url) return;
  const on =
    /facebook\.com\/marketplace\/item\//.test(tab.url) ||
    /yad2\.co\.il/.test(tab.url);
  badge.className = `status-badge ${on ? 'active' : 'inactive'}`;
  statusTx.textContent = on ? 'Active on this page' : 'Navigate to a listing';
});

// Show/hide key
toggle.addEventListener('click', () => {
  input.type = input.type === 'password' ? 'text' : 'password';
});

// Save
saveBtn.addEventListener('click', () => {
  const key = input.value.trim();
  if (!key.startsWith('sk-ant-')) {
    showFeedback('Key must start with sk-ant-', 'err');
    return;
  }
  saveBtn.disabled = true;
  chrome.storage.local.set({ anthropicApiKey: key }, () => {
    showFeedback('Saved successfully ✓', 'ok');
    saveBtn.disabled = false;
  });
});

function showFeedback(msg, type) {
  feedback.textContent = msg;
  feedback.className = `feedback ${type}`;
}
