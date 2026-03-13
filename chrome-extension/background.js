// NanoClaw Chrome Extension - Background Service Worker
// Connects to the NanoClaw bridge server via WebSocket and routes
// commands to content scripts running in browser tabs.

const DEFAULT_BRIDGE_URL = 'ws://localhost:3002';
let ws = null;
let reconnectTimer = null;
let connected = false;
let bridgeUrl = DEFAULT_BRIDGE_URL;
let commandQueue = new Map(); // id -> { resolve, reject, timer }

// --- WebSocket Connection ---

async function loadSettings() {
  const result = await chrome.storage.local.get(['bridgeUrl', 'autoConnect']);
  bridgeUrl = result.bridgeUrl || DEFAULT_BRIDGE_URL;
  return result;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(bridgeUrl);
  } catch (e) {
    console.error('[NanoClaw] WebSocket creation failed:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    clearTimeout(reconnectTimer);
    console.log('[NanoClaw] Connected to bridge server');
    updateBadge('ON', '#22c55e');
    broadcastStatus();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error('[NanoClaw] Invalid message from bridge:', e);
      return;
    }

    if (msg.type === 'command') {
      const result = await executeCommand(msg);
      sendToBridge({
        type: 'result',
        id: msg.id,
        success: result.success,
        data: result.data,
        error: result.error
      });
    } else if (msg.type === 'ping') {
      sendToBridge({ type: 'pong' });
    }
  };

  ws.onclose = () => {
    connected = false;
    console.log('[NanoClaw] Disconnected from bridge');
    updateBadge('OFF', '#ef4444');
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[NanoClaw] WebSocket error:', err);
    ws.close();
  };
}

function disconnect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
  connected = false;
  updateBadge('OFF', '#6b7280');
  broadcastStatus();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), 3000);
}

function sendToBridge(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: 'status',
    connected,
    bridgeUrl
  }).catch(() => {}); // popup may not be open
}

// --- Command Execution ---

async function executeCommand(msg) {
  const { action, params } = msg;

  try {
    switch (action) {
      // --- Navigation ---
      case 'navigate':
        return await navigateTo(params.url);
      case 'back':
        return await execInTab(null, () => { history.back(); return { done: true }; });
      case 'forward':
        return await execInTab(null, () => { history.forward(); return { done: true }; });
      case 'reload':
        return await reloadTab();
      case 'new_tab':
        return await newTab(params.url);
      case 'close_tab':
        return await closeTab(params.tabId);
      case 'switch_tab':
        return await switchTab(params.tabId || params.index);
      case 'list_tabs':
        return await listTabs();
      case 'get_url':
        return await getTabInfo('url');
      case 'get_title':
        return await getTabInfo('title');

      // --- Interaction ---
      case 'click':
        return await sendToContent('click', params);
      case 'double_click':
        return await sendToContent('double_click', params);
      case 'right_click':
        return await sendToContent('right_click', params);
      case 'type':
        return await sendToContent('type', params);
      case 'fill':
        return await sendToContent('fill', params);
      case 'clear':
        return await sendToContent('clear', params);
      case 'select':
        return await sendToContent('select', params);
      case 'check':
        return await sendToContent('check', params);
      case 'uncheck':
        return await sendToContent('uncheck', params);
      case 'hover':
        return await sendToContent('hover', params);
      case 'focus':
        return await sendToContent('focus', params);
      case 'blur':
        return await sendToContent('blur', params);
      case 'press_key':
        return await sendToContent('press_key', params);
      case 'scroll':
        return await sendToContent('scroll', params);
      case 'scroll_to_element':
        return await sendToContent('scroll_to_element', params);
      case 'drag_and_drop':
        return await sendToContent('drag_and_drop', params);
      case 'upload_file':
        return await sendToContent('upload_file', params);

      // --- Reading / Extraction ---
      case 'snapshot':
        return await sendToContent('snapshot', params);
      case 'get_text':
        return await sendToContent('get_text', params);
      case 'get_html':
        return await sendToContent('get_html', params);
      case 'get_attribute':
        return await sendToContent('get_attribute', params);
      case 'get_value':
        return await sendToContent('get_value', params);
      case 'get_styles':
        return await sendToContent('get_styles', params);
      case 'get_bounding_box':
        return await sendToContent('get_bounding_box', params);
      case 'query_selector':
        return await sendToContent('query_selector', params);
      case 'query_selector_all':
        return await sendToContent('query_selector_all', params);
      case 'get_table_data':
        return await sendToContent('get_table_data', params);
      case 'get_links':
        return await sendToContent('get_links', params);
      case 'get_forms':
        return await sendToContent('get_forms', params);
      case 'get_page_info':
        return await sendToContent('get_page_info', params);

      // --- Waiting ---
      case 'wait_for_element':
        return await sendToContent('wait_for_element', params);
      case 'wait_for_text':
        return await sendToContent('wait_for_text', params);
      case 'wait_for_navigation':
        return await waitForNavigation(params);
      case 'wait':
        return await wait(params.ms || 1000);

      // --- JavaScript ---
      case 'eval':
        return await evalInPage(params.code);

      // --- Screenshot ---
      case 'screenshot':
        return await takeScreenshot(params);

      // --- Cookies & Storage ---
      case 'get_cookies':
        return await getCookies(params);
      case 'set_cookie':
        return await setCookie(params);
      case 'delete_cookie':
        return await deleteCookie(params);
      case 'get_local_storage':
        return await sendToContent('get_local_storage', params);
      case 'set_local_storage':
        return await sendToContent('set_local_storage', params);

      // --- Downloads ---
      case 'download':
        return await downloadFile(params);

      // --- Clipboard ---
      case 'copy_to_clipboard':
        return await sendToContent('copy_to_clipboard', params);
      case 'read_clipboard':
        return await sendToContent('read_clipboard', params);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

// --- Tab Helpers ---

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

async function navigateTo(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  // Wait for load
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
  const updated = await chrome.tabs.get(tab.id);
  return { success: true, data: { url: updated.url, title: updated.title } };
}

async function reloadTab() {
  const tab = await getActiveTab();
  await chrome.tabs.reload(tab.id);
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
  return { success: true, data: { reloaded: true } };
}

async function newTab(url) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank' });
  return { success: true, data: { tabId: tab.id, url: tab.url } };
}

async function closeTab(tabId) {
  if (tabId) {
    await chrome.tabs.remove(tabId);
  } else {
    const tab = await getActiveTab();
    await chrome.tabs.remove(tab.id);
  }
  return { success: true, data: { closed: true } };
}

async function switchTab(tabIdOrIndex) {
  if (typeof tabIdOrIndex === 'number' && tabIdOrIndex < 100) {
    // Treat as index
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (tabIdOrIndex >= tabs.length) {
      return { success: false, error: `Tab index ${tabIdOrIndex} out of range (${tabs.length} tabs)` };
    }
    await chrome.tabs.update(tabs[tabIdOrIndex].id, { active: true });
  } else {
    await chrome.tabs.update(tabIdOrIndex, { active: true });
  }
  return { success: true, data: { switched: true } };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return {
    success: true,
    data: tabs.map((t, i) => ({
      index: i,
      tabId: t.id,
      url: t.url,
      title: t.title,
      active: t.active
    }))
  };
}

async function getTabInfo(field) {
  const tab = await getActiveTab();
  return { success: true, data: { [field]: tab[field] } };
}

// --- Content Script Communication ---

async function sendToContent(action, params) {
  const tab = await getActiveTab();

  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch (e) {
    // May already be injected or page doesn't allow it
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Content script timeout (30s)' });
    }, 30000);

    chrome.tabs.sendMessage(tab.id, { action, params }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: 'No response from content script' });
      }
    });
  });
}

async function execInTab(tabId, func, args) {
  const tab = tabId ? { id: tabId } : await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args: args || []
  });
  return { success: true, data: results[0]?.result };
}

// --- Screenshot ---

async function takeScreenshot(params) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, {
    format: params?.format || 'png',
    quality: params?.quality || 90
  });
  return { success: true, data: { dataUrl, format: params?.format || 'png' } };
}

// --- Eval ---

async function evalInPage(code) {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (c) => {
      try {
        const result = eval(c);
        return { value: typeof result === 'object' ? JSON.parse(JSON.stringify(result)) : result };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [code],
    world: 'MAIN'
  });
  const res = results[0]?.result;
  if (res?.error) return { success: false, error: res.error };
  return { success: true, data: res?.value };
}

// --- Cookies ---

async function getCookies(params) {
  const tab = await getActiveTab();
  const url = params?.url || tab.url;
  const cookies = await chrome.cookies.getAll({ url });
  return { success: true, data: cookies };
}

async function setCookie(params) {
  await chrome.cookies.set(params);
  return { success: true, data: { set: true } };
}

async function deleteCookie(params) {
  await chrome.cookies.remove({ url: params.url, name: params.name });
  return { success: true, data: { deleted: true } };
}

// --- Downloads ---

async function downloadFile(params) {
  const downloadId = await chrome.downloads.download({
    url: params.url,
    filename: params.filename
  });
  return { success: true, data: { downloadId } };
}

// --- Wait ---

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { success: true, data: { waited: ms } };
}

async function waitForNavigation(params) {
  const tab = await getActiveTab();
  const timeout = params?.timeout || 30000;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ success: false, error: `Navigation timeout (${timeout}ms)` });
    }, timeout);

    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve({ success: true, data: { navigated: true } });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Startup ---

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  updateBadge('OFF', '#6b7280');
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await loadSettings();
  if (settings.autoConnect) {
    connect();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect') {
    loadSettings().then(() => connect());
    sendResponse({ ok: true });
  } else if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
  } else if (msg.type === 'get_status') {
    sendResponse({ connected, bridgeUrl });
  } else if (msg.type === 'update_settings') {
    chrome.storage.local.set(msg.settings).then(() => {
      bridgeUrl = msg.settings.bridgeUrl || bridgeUrl;
      sendResponse({ ok: true });
    });
    return true; // async
  } else if (msg.type === 'test_command') {
    executeCommand(msg.command).then((result) => sendResponse(result));
    return true; // async
  }
});
