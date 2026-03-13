// NanoClaw Chrome Extension - Popup Controller

const $ = (sel) => document.querySelector(sel);

const statusDot = $('#statusDot');
const statusText = $('#statusText');
const bridgeUrlInput = $('#bridgeUrl');
const autoConnectCheckbox = $('#autoConnect');
const connectBtn = $('#connectBtn');
const disconnectBtn = $('#disconnectBtn');
const testOutput = $('#testOutput');

// Load saved settings
async function loadSettings() {
  const result = await chrome.storage.local.get(['bridgeUrl', 'autoConnect']);
  bridgeUrlInput.value = result.bridgeUrl || 'ws://localhost:3002';
  autoConnectCheckbox.checked = result.autoConnect || false;
}

function updateUI(connected) {
  statusDot.className = `status-dot ${connected ? 'connected' : ''}`;
  statusText.textContent = connected ? 'Connected' : 'Disconnected';
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
}

// Get current status from background
chrome.runtime.sendMessage({ type: 'get_status' }, (res) => {
  if (res) updateUI(res.connected);
});

// Listen for status changes
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    updateUI(msg.connected);
  }
});

// Connect
connectBtn.addEventListener('click', async () => {
  const url = bridgeUrlInput.value.trim();
  await chrome.storage.local.set({
    bridgeUrl: url,
    autoConnect: autoConnectCheckbox.checked
  });
  chrome.runtime.sendMessage({
    type: 'update_settings',
    settings: { bridgeUrl: url, autoConnect: autoConnectCheckbox.checked }
  });
  chrome.runtime.sendMessage({ type: 'connect' });
});

// Disconnect
disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
});

// Save settings on change
bridgeUrlInput.addEventListener('change', () => {
  chrome.storage.local.set({ bridgeUrl: bridgeUrlInput.value.trim() });
  chrome.runtime.sendMessage({
    type: 'update_settings',
    settings: { bridgeUrl: bridgeUrlInput.value.trim() }
  });
});

autoConnectCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ autoConnect: autoConnectCheckbox.checked });
  chrome.runtime.sendMessage({
    type: 'update_settings',
    settings: { autoConnect: autoConnectCheckbox.checked }
  });
});

// Test buttons
document.querySelectorAll('[data-test]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.test;
    testOutput.classList.add('visible');
    testOutput.textContent = 'Running...';

    const commandMap = {
      snapshot: { action: 'snapshot', params: { interactive: true } },
      page_info: { action: 'get_page_info', params: {} },
      screenshot: { action: 'screenshot', params: {} },
      list_tabs: { action: 'list_tabs', params: {} }
    };

    chrome.runtime.sendMessage(
      { type: 'test_command', command: commandMap[action] },
      (result) => {
        if (result) {
          if (action === 'snapshot' && result.success) {
            // Summarize snapshot for readability
            const data = result.data;
            const summary = `Page: ${data.title}\nURL: ${data.url}\nViewport: ${data.viewport?.width}x${data.viewport?.height}\nInteractive elements: ${data.totalElements}\n\nFirst 10 elements:\n${data.elements?.slice(0, 10).map(e => `  ${e.ref} <${e.tag}> ${e.text?.substring(0, 50) || e.ariaLabel || e.placeholder || ''}`).join('\n')}`;
            testOutput.textContent = summary;
          } else if (action === 'screenshot' && result.success) {
            testOutput.textContent = `Screenshot captured (${result.data?.format})\nData URL length: ${result.data?.dataUrl?.length} chars`;
          } else {
            testOutput.textContent = JSON.stringify(result, null, 2).substring(0, 2000);
          }
        } else {
          testOutput.textContent = 'No response';
        }
      }
    );
  });
});

loadSettings();
