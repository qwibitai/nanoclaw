import { marked } from '/marked.min.js';
import DOMPurify from '/dompurify.min.js';

marked.setOptions({ breaks: true, gfm: true });

const $ = (sel) => document.querySelector(sel);

// ── Auth bootstrap ────────────────────────────────────────────────────────
let authToken = localStorage.getItem('nanoclaw-token') || '';

function getWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${location.host}/ws`;
  return authToken ? `${base}?token=${encodeURIComponent(authToken)}` : base;
}

function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  return headers;
}

function authFetch(url, opts = {}) {
  if (authToken) {
    opts.headers = { ...opts.headers };
    if (!opts.headers['Authorization'] && !opts.headers['authorization']) {
      opts.headers['Authorization'] = `Bearer ${authToken}`;
    }
  }
  return fetch(url, opts);
}

async function checkAuth() {
  // Localhost doesn't need auth
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return true;
  }
  // Try existing token or tailscale
  try {
    const headers = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
    const res = await fetch('/api/auth/check', { headers });
    if (res.ok) return true;
  } catch {}
  return false;
}

async function initApp() {
  const authed = await checkAuth();
  if (authed) {
    $('#login-screen').hidden = true;
    $('#app').hidden = false;
    connect();
  } else {
    $('#login-screen').hidden = false;
    $('#app').hidden = true;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#login-token').value.trim();
  if (!token) return;
  // Test the token
  try {
    const res = await fetch('/api/auth/check', { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      authToken = token;
      localStorage.setItem('nanoclaw-token', token);
      $('#login-screen').hidden = true;
      $('#app').hidden = false;
      connect();
    } else {
      $('#login-error').textContent = 'Invalid token';
      $('#login-error').hidden = false;
    }
  } catch {
    $('#login-error').textContent = 'Connection failed';
    $('#login-error').hidden = false;
  }
});


const ROOM_COLORS = ['#4fc3f7', '#69f0ae', '#ffd54f', '#ff8a80', '#b388ff', '#80deea', '#ffab91', '#a5d6a7'];

function roomColor(roomId) {
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) hash = ((hash << 5) - hash + roomId.charCodeAt(i)) | 0;
  return ROOM_COLORS[Math.abs(hash) % ROOM_COLORS.length];
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Settings ──────────────────────────────────────────────────────────────
const DEFAULTS = { theme: 'dark', font: 'medium', sendKey: 'enter', notifications: false };

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('nanoclaw-settings') || '{}') };
  } catch { return { ...DEFAULTS }; }
}

function saveSettings(settings) {
  localStorage.setItem('nanoclaw-settings', JSON.stringify(settings));
}

let settings = loadSettings();

function applySettings() {
  document.documentElement.setAttribute('data-theme', settings.theme);
  document.documentElement.setAttribute('data-font', settings.font);
  // Update meta theme-color for mobile browsers
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
    if (surface) meta.setAttribute('content', surface);
  }
}

function renderSettingsModal() {
  // Theme buttons
  document.querySelectorAll('#theme-options .setting-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === settings.theme);
  });
  // Font buttons
  document.querySelectorAll('#font-options .setting-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === settings.font);
  });
  // Send key buttons
  document.querySelectorAll('#send-options .setting-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === settings.sendKey);
  });
  // Notifications
  $('#notif-toggle').checked = settings.notifications;
}

// Apply on load
applySettings();

// Settings modal open/close
function openSettings() {
  renderSettingsModal();
  $('#settings-overlay').hidden = false;
  // Focus trap
  const modal = $('#settings-overlay .modal');
  const focusable = modal.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
  if (focusable.length) focusable[0].focus();
}
function closeSettings() {
  $('#settings-overlay').hidden = true;
}
$('#settings-btn').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('#settings-overlay')) closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#settings-overlay').hidden) closeSettings();
});

// Theme selection
document.querySelectorAll('#theme-options .setting-option').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.value;
    saveSettings(settings);
    applySettings();
    renderSettingsModal();
  });
});

// Font size selection
document.querySelectorAll('#font-options .setting-option').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.font = btn.dataset.value;
    saveSettings(settings);
    applySettings();
    renderSettingsModal();
  });
});

// Send key selection
document.querySelectorAll('#send-options .setting-option').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.sendKey = btn.dataset.value;
    saveSettings(settings);
    renderSettingsModal();
  });
});

// Notifications toggle
$('#notif-toggle').addEventListener('change', async () => {
  if ($('#notif-toggle').checked && Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      $('#notif-toggle').checked = false;
      settings.notifications = false;
      saveSettings(settings);
      return;
    }
  }
  settings.notifications = $('#notif-toggle').checked;
  saveSettings(settings);
});

let ws, currentRoom = null, myIdentity = '';
const pendingMessages = new Map();
const typingUsers = new Map();
const unreadRooms = new Set();
let agentName = '';

function connect() {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    $('#connection-banner').classList.remove('visible');
    ws.send(JSON.stringify({ type: 'auth' }));
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'system':
        if (msg.message && !myIdentity) {
          const m = msg.message.match(/^(?:Connected as|Welcome,)\s+(.+)$/);
          if (m) myIdentity = m[1].trim();
        }
        appendSystem(msg.message);
        return;
      case 'rooms':
        lastRoomsList = msg.rooms;
        // Ensure bots are loaded so we can sort rooms by main status
        if (allBots.length === 0) {
          authFetch('/api/bots').then(r => r.json()).then(b => { allBots = b; renderRooms(msg.rooms); }).catch(() => {});
        }
        renderRooms(msg.rooms);
        if (!currentRoom) {
          const saved = sessionStorage.getItem('lastRoom');
          if (saved) {
            const room = msg.rooms.find(r => r.id === saved);
            if (room) joinRoom(room.id, room.name);
          }
        }
        break;
      case 'history':
        $('#messages').innerHTML = '';
        msg.messages.forEach(appendMessage);
        if (msg.messages.length === 0) {
          $('#messages').innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
        }
        scrollToBottom(true);
        requestAnimationFrame(() => scrollToBottom(true));
        break;
      case 'members':
        if (msg.room_id === currentRoom) renderMembers(msg.members);
        break;
      case 'message':
        if (msg.sender_type === 'agent') {
          const bubble = $('#messages .thinking-bubble');
          if (bubble) bubble.remove();
        }
        // Desktop notification for messages from others when tab is not focused
        if (settings.notifications && document.hidden && msg.sender !== myIdentity) {
          try {
            new Notification(`${msg.sender}`, {
              body: msg.content.slice(0, 100),
              tag: msg.id || 'nanoclaw-msg',
            });
          } catch {}
        }
        if (msg.sender === myIdentity && msg.client_id && pendingMessages.has(msg.client_id)) {
          const el = pendingMessages.get(msg.client_id);
          const status = el.querySelector('.status');
          if (status) status.textContent = '✓✓';
          if (status) status.classList.add('delivered');
          pendingMessages.delete(msg.client_id);
        } else {
          appendMessage(msg);
        }
        if (isNearBottom()) scrollToBottom();
        else $('#scroll-bottom').hidden = false;
        break;
      case 'typing':
        handleTypingEvent(msg);
        break;
      case 'status':
        handleStatusEvent(msg);
        break;
      case 'unread':
        if (msg.room_id && msg.room_id !== currentRoom) {
          unreadRooms.add(msg.room_id);
          updateUnreadDots();
        }
        break;
      case 'error':
        console.error('WS error:', msg.error);
        break;
    }
  };

  ws.onclose = () => {
    $('#connection-banner').classList.add('visible');
    setTimeout(connect, 3000);
  };
}

// ── Rooms ─────────────────────────────────────────────────────────────────
function renderRooms(rooms) {
  const list = $('#room-list');
  list.innerHTML = '';
  // Sort: main rooms first (cross-reference with bots), then alphabetical
  const mainRoomIds = new Set(allBots.filter(b => b.isMain && b.jid.startsWith('chat:')).map(b => b.jid.replace(/^chat:/, '')));
  const sorted = [...rooms].sort((a, b) => {
    const aMain = mainRoomIds.has(a.id);
    const bMain = mainRoomIds.has(b.id);
    if (aMain !== bMain) return aMain ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const lastMainIdx = sorted.reduce((acc, r, i) => mainRoomIds.has(r.id) ? i : acc, -1);
  sorted.forEach((room, i) => {
    const li = document.createElement('li');
    const color = roomColor(room.id);
    li.dataset.roomId = room.id;
    li.style.borderLeftColor = color;
    li.style.display = 'flex';
    li.style.alignItems = 'center';
    if (i === lastMainIdx && lastMainIdx < sorted.length - 1) li.classList.add('main-divider');
    const text = document.createElement('span');
    text.textContent = `# ${room.name}`;
    text.style.flex = '1';
    li.appendChild(text);
    if (unreadRooms.has(room.id)) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.style.background = color;
      li.appendChild(dot);
    }
    if (room.id === currentRoom) li.classList.add('active');
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('click', () => joinRoom(room.id, room.name));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); joinRoom(room.id, room.name); }
    });
    list.appendChild(li);
  });
}

let lastRoomsList = [];
function updateUnreadDots() {
  if (lastRoomsList.length) renderRooms(lastRoomsList);
}

function joinRoom(roomId, roomName) {
  currentRoom = roomId;
  unreadRooms.delete(roomId);
  updateUnreadDots();
  $('#app').classList.add('in-room');
  $('#app').classList.remove('in-dashboard');
  for (const t of typingUsers.values()) clearTimeout(t.timeout);
  typingUsers.clear();
  renderTypingIndicator();
  $('#members-panel').hidden = true;
  $('#members-overlay').classList.remove('visible');
  renderMembers([]);
  $('#messages').innerHTML = '<div class="empty-state">Loading...</div>';
  ws.send(JSON.stringify({ type: 'join', room_id: roomId }));
  sessionStorage.setItem('lastRoom', roomId);
  $('#room-name').textContent = `# ${roomName}`;
  $('#message-input').disabled = false;
  $('button[type=submit]').disabled = false;
  document.querySelectorAll('#room-list li').forEach(li => {
    li.classList.toggle('active', li.dataset.roomId === roomId);
  });
}

// ── Messages ──────────────────────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(msg, statusText) {
  if (msg.type === 'system') { appendSystem(msg.message); return; }
  const div = document.createElement('div');
  const isMine = msg.sender === myIdentity;
  const isAgent = msg.sender_type === 'agent';
  div.className = isMine ? 'msg mine' : (isAgent ? 'msg agent' : 'msg other');
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = isAgent ? `🤖 ${msg.sender}` : (isMine ? 'You' : msg.sender);
  div.appendChild(sender);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.message_type === 'file' && msg.file_meta) {
    bubble.appendChild(renderFileBubble(msg.file_meta));
    // Show caption if content differs from filename
    if (msg.content && msg.content !== msg.file_meta.filename) {
      const caption = document.createElement('div');
      caption.className = 'file-caption';
      caption.textContent = msg.content;
      bubble.appendChild(caption);
    }
  } else if (isAgent) {
    bubble.innerHTML = DOMPurify.sanitize(marked.parse(msg.content));
  } else {
    bubble.textContent = msg.content;
  }
  div.appendChild(bubble);
  // Timestamp
  const timeStr = formatTime(msg.created_at);
  if (timeStr) {
    const time = document.createElement('div');
    time.className = 'timestamp';
    time.textContent = timeStr;
    div.appendChild(time);
  }
  if (isMine && statusText) {
    const status = document.createElement('div');
    status.className = 'status' + (statusText === '✓✓' ? ' delivered' : '');
    status.textContent = statusText;
    div.appendChild(status);
  }
  $('#messages').appendChild(div);
  return div;
}

function appendSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  $('#messages').appendChild(div);
}

function renderFileBubble(meta) {
  const wrap = document.createElement('div');
  wrap.className = 'file-bubble';
  const isImage = meta.mime?.startsWith('image/');
  if (isImage) {
    const img = document.createElement('img');
    img.src = meta.url;
    img.alt = meta.filename;
    img.className = 'file-image-preview';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(meta.url, '_blank'));
    wrap.appendChild(img);
  }
  const info = document.createElement('div');
  info.className = 'file-info';
  const icon = isImage ? '🖼️' : meta.mime?.includes('pdf') ? '📄' : '📎';
  const sizeStr = meta.size < 1024 ? `${meta.size} B`
    : meta.size < 1048576 ? `${(meta.size / 1024).toFixed(1)} KB`
    : `${(meta.size / 1048576).toFixed(1)} MB`;
  info.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${esc(meta.filename)}</span><span class="file-size">${sizeStr}</span>`;
  const dl = document.createElement('a');
  dl.href = meta.url;
  dl.download = meta.filename;
  dl.className = 'file-download';
  dl.textContent = '↓';
  dl.title = 'Download';
  info.appendChild(dl);
  wrap.appendChild(info);
  return wrap;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

let pendingFile = null;

function stageFile(file) {
  if (!currentRoom) return;
  pendingFile = file;
  renderFilePreview();
  $('#message-input').focus();
  $('#message-input').placeholder = `Add a message about ${file.name}...`;
}

function clearStagedFile() {
  // Revoke blob URL to prevent memory leak
  const thumb = $('#file-preview .file-preview-thumb');
  if (thumb) URL.revokeObjectURL(thumb.src);
  pendingFile = null;
  const preview = $('#file-preview');
  if (preview) preview.hidden = true;
  $('#message-input').placeholder = 'Message...';
}

function renderFilePreview() {
  let preview = $('#file-preview');
  if (!preview) return;
  preview.hidden = false;
  const isImage = pendingFile.type.startsWith('image/');
  let html = '<div class="file-preview-content">';
  if (isImage) {
    const url = URL.createObjectURL(pendingFile);
    html += `<img src="${url}" class="file-preview-thumb" alt="">`;
  } else {
    html += `<span class="file-preview-icon">📎</span>`;
  }
  html += `<span class="file-preview-name">${pendingFile.name}</span>`;
  html += `<span class="file-preview-size">${formatFileSize(pendingFile.size)}</span>`;
  html += `<button class="file-preview-remove" id="file-preview-remove">&times;</button>`;
  html += '</div>';
  preview.innerHTML = html;
  $('#file-preview-remove').addEventListener('click', clearStagedFile);
}

async function uploadFile(file, caption) {
  if (!currentRoom) return;
  const form = new FormData();
  form.append('file', file);
  if (caption) form.append('caption', caption);
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Upload failed:', err.error || res.statusText);
      appendSystem('Upload failed: ' + (err.error || res.statusText));
    }
  } catch (err) {
    console.error('Upload error:', err);
    appendSystem('Upload failed: ' + err.message);
  }
}

function scrollToBottom(instant) {
  const el = $('#messages');
  el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function isNearBottom() {
  const el = $('#messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// Show/hide scroll-to-bottom button
$('#messages').addEventListener('scroll', () => {
  $('#scroll-bottom').hidden = isNearBottom();
});
$('#scroll-bottom').addEventListener('click', () => scrollToBottom());

let clientMsgSeq = 0;

function sendCurrentMessage() {
  const input = $('#message-input');
  const text = input.value.trim();
  if (!currentRoom) return;

  // File + optional caption
  if (pendingFile) {
    const file = pendingFile;
    const caption = text;
    clearStagedFile();
    input.value = '';
    uploadFile(file, caption);
    return;
  }

  if (!text) return;
  const clientId = `local-${++clientMsgSeq}-${Date.now()}`;
  ws.send(JSON.stringify({ type: 'message', content: text, client_id: clientId }));
  const el = appendMessage(
    { sender: myIdentity, sender_type: 'user', content: text },
    '✓',
  );
  pendingMessages.set(clientId, el);
  scrollToBottom();
  input.value = '';
  input.style.height = 'auto';
}

$('#message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sendCurrentMessage();
});

$('#message-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (settings.sendKey === 'enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
  // shift-enter mode: Enter inserts newline (default), Shift+Enter sends
  if (settings.sendKey === 'shift-enter' && e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
});

// ── Members panel ─────────────────────────────────────────────────────────
let currentMembers = [];

function renderMembers(members) {
  currentMembers = members;
  const list = $('#members-list');
  const toggle = $('#members-toggle');
  toggle.textContent = members.length;
  toggle.hidden = !currentRoom;

  list.innerHTML = '';
  const sorted = [...members].sort((a, b) => {
    if (a.identity_type !== b.identity_type) return a.identity_type === 'agent' ? -1 : 1;
    return a.identity.localeCompare(b.identity);
  });
  for (const m of sorted) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `member-dot ${m.identity_type}`;
    li.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.identity === myIdentity ? `${m.identity} (you)` : m.identity;
    li.appendChild(name);
    if (m.identity_type === 'agent') {
      const tag = document.createElement('span');
      tag.className = 'member-tag';
      tag.textContent = 'BOT';
      li.appendChild(tag);
    }
    list.appendChild(li);
  }
}

function toggleMembersPanel() {
  const panel = $('#members-panel');
  const overlay = $('#members-overlay');
  const visible = panel.hidden;
  panel.hidden = !visible;
  if (visible) overlay.classList.add('visible');
  else overlay.classList.remove('visible');
}

$('#members-toggle').addEventListener('click', toggleMembersPanel);
$('#members-close').addEventListener('click', toggleMembersPanel);
$('#members-overlay').addEventListener('click', toggleMembersPanel);

// ── Sidebar tabs ──────────────────────────────────────────────────────────
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'bots') fetchBots();
  });
});

// ── Mobile back button ────────────────────────────────────────────────────
$('#mobile-back').addEventListener('click', () => {
  $('#app').classList.remove('in-room');
});

// ── Dashboard ─────────────────────────────────────────────────────────────
let dashboardActive = false;
let dashboardInterval = null;

function toggleDashboard() {
  dashboardActive = !dashboardActive;
  $('#chat').hidden = dashboardActive;
  $('#dashboard').hidden = !dashboardActive;
  $('#dash-toggle').classList.toggle('active', dashboardActive);
  // Mobile: toggle classes for full-screen views
  $('#app').classList.toggle('in-dashboard', dashboardActive);
  $('#app').classList.remove('in-room');
  if (dashboardActive) {
    refreshDashboard();
    dashboardInterval = setInterval(refreshDashboard, 30000);
  } else {
    if (dashboardInterval) clearInterval(dashboardInterval);
  }
}

$('#dash-toggle').addEventListener('click', toggleDashboard);
$('#dash-back').addEventListener('click', toggleDashboard);
$('#dash-refresh').addEventListener('click', refreshDashboard);

function relativeTime(ts) {
  const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
  if (diff < 0) return 'just now';
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function refreshDashboard() {
  const [bots, rooms, health] = await Promise.all([
    authFetch('/api/bots').then(r => r.json()).catch(() => []),
    authFetch('/api/rooms').then(r => r.json()).catch(() => []),
    authFetch('/health').then(r => r.json()).catch(() => ({ ok: false })),
  ]);

  // Fetch last few messages per room (in parallel)
  const roomActivity = await Promise.all(
    rooms.map(async (room) => {
      const msgs = await authFetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`)
        .then(r => r.json()).catch(() => []);
      return { room, messages: msgs, lastMsg: msgs[msgs.length - 1] || null, count: msgs.length };
    })
  );

  renderHealthStrip(health, bots, rooms);
  renderBotRoomGraph(bots, rooms, roomActivity);
  renderActivityFeed(roomActivity);
}

function renderHealthStrip(health, bots, rooms) {
  const el = $('#dash-health');
  const wsOk = ws && ws.readyState === WebSocket.OPEN;
  const pills = [
    { dot: health.ok ? 'ok' : 'err', label: 'Server', value: health.ok ? 'Online' : 'Offline' },
    { dot: 'ok', label: 'Uptime', value: health.uptime ? formatUptime(health.uptime) : '—' },
    { dot: wsOk ? 'ok' : 'err', label: 'WebSocket', value: wsOk ? 'Connected' : 'Disconnected' },
    { dot: bots.length > 0 ? 'ok' : 'warn', label: 'Bots', value: String(bots.length) },
    { dot: rooms.length > 0 ? 'ok' : 'warn', label: 'Rooms', value: String(rooms.length) },
  ];
  el.innerHTML = pills.map(p =>
    `<div class="dash-pill"><span class="pill-dot ${p.dot}"></span><span class="pill-label">${p.label}</span><span class="pill-value">${p.value}</span></div>`
  ).join('');
}

function renderBotRoomGraph(bots, rooms, roomActivity) {
  const el = $('#dash-graph');


  // Rooms column
  let roomsHtml = '<div><div class="dash-col-title">Rooms</div>';
  if (rooms.length === 0) {
    roomsHtml += '<div class="dash-empty">No rooms</div>';
  } else {
    for (const ra of roomActivity) {
      const r = ra.room;
      const color = roomColor(r.id) || 'var(--border)';
      const time = ra.lastMsg ? relativeTime(ra.lastMsg.created_at) : 'no activity';
      roomsHtml += `<div class="dash-card" style="border-left-color:${color}">
        <div class="card-row"><span class="card-name"># ${esc(r.name)}</span><span class="card-badge">${ra.count} msgs</span></div>
        <div class="card-meta">${time}</div>
      </div>`;
    }
  }
  roomsHtml += '</div>';

  // Bots column
  let botsHtml = '<div><div class="dash-col-title">Bots</div>';
  if (bots.length === 0) {
    botsHtml += '<div class="dash-empty">No bots</div>';
  } else {
    const sorted = [...bots].sort((a, b) => {
      if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const bot of sorted) {
      // Color-code chat bots to match their room
      let color = 'var(--border)';
      if (bot.jid.startsWith('chat:')) {
        const roomId = bot.jid.replace(/^chat:/, '');
        color = roomColor(roomId);
      }
      const icon = CHANNEL_ICONS[bot.channel] || '🤖';
      const mainTag = bot.isMain ? '<span class="card-badge main">MAIN</span>' : '';
      botsHtml += `<div class="dash-card" style="border-left-color:${color}">
        <div class="card-row"><span class="card-name">${icon} ${esc(bot.name)}</span>${mainTag}</div>
        <div class="card-meta">${esc(bot.channel)} · ${esc(bot.trigger)}</div>
      </div>`;
    }
  }
  botsHtml += '</div>';

  el.innerHTML = roomsHtml + botsHtml;
}

function renderActivityFeed(roomActivity) {
  const el = $('#dash-activity');

  // Flatten all messages, sort by time, take top 15
  const allMsgs = [];
  roomActivity.forEach((ra) => {
    for (const msg of ra.messages) {
      allMsgs.push({ ...msg, roomName: ra.room.name, roomId: ra.room.id });
    }
  });
  allMsgs.sort((a, b) => b.created_at - a.created_at);
  const recent = allMsgs.slice(0, 15);

  if (recent.length === 0) {
    el.innerHTML = '<div class="dash-empty">No recent activity</div>';
    return;
  }

  el.innerHTML = recent.map(m => {
    const color = roomColor(m.roomId);
    const content = m.message_type === 'file' ? `📎 ${m.content}` : m.content;
    const senderColor = m.sender_type === 'agent' ? 'var(--agent)' : 'var(--text-dim)';
    return `<div class="dash-activity-row">
      <span class="dash-activity-room" style="color:${color}"># ${esc(m.roomName)}</span>
      <span class="dash-activity-sender" style="color:${senderColor}">${m.sender_type === 'agent' ? '🤖 ' : ''}${esc(m.sender)}</span>
      <span class="dash-activity-content">${esc(content.slice(0, 80))}</span>
      <span class="dash-activity-time">${relativeTime(m.created_at)}</span>
    </div>`;
  }).join('');
}

// ── Bot management ────────────────────────────────────────────────────────
const CHANNEL_ICONS = {
  whatsapp: '💬', telegram: '✈️', discord: '🎮', slack: '📡', chat: '🌐', local: '🌐', gmail: '📧',
};

let allBots = [];
let selectedBotJid = null;

async function fetchBots() {
  try {
    const res = await authFetch('/api/bots');
    allBots = await res.json();
    renderBots();
  } catch (err) {
    console.error('Failed to fetch bots:', err);
  }
}

function renderBots() {
  const list = $('#bot-list');
  list.innerHTML = '';
  const sorted = [...allBots].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const lastMainBotIdx = sorted.reduce((acc, b, i) => b.isMain ? i : acc, -1);
  sorted.forEach((bot, idx) => {
    const li = document.createElement('li');
    li.dataset.jid = bot.jid;
    if (bot.jid === selectedBotJid) li.classList.add('active');
    if (idx === lastMainBotIdx && lastMainBotIdx < sorted.length - 1) li.classList.add('main-divider');

    const icon = document.createElement('span');
    icon.className = 'bot-icon';
    icon.textContent = CHANNEL_ICONS[bot.channel] || '🤖';
    li.appendChild(icon);

    const info = document.createElement('span');
    info.className = 'bot-info';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'bot-info-name';
    nameSpan.textContent = bot.name;
    info.appendChild(nameSpan);
    const channelSpan = document.createElement('span');
    channelSpan.className = 'bot-info-channel';
    channelSpan.textContent = `${bot.channel} · ${bot.trigger}`;
    info.appendChild(channelSpan);
    li.appendChild(info);

    if (bot.isMain) {
      const tag = document.createElement('span');
      tag.className = 'bot-main-tag';
      tag.textContent = 'MAIN';
      li.appendChild(tag);
    }

    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('click', () => openBotDetail(bot.jid));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBotDetail(bot.jid); }
    });
    list.appendChild(li);
  });
}

// Templates for bot instructions
const BOT_TEMPLATES = {
  general: `# Bot Name

You are a helpful assistant. You answer questions, help with tasks, and provide clear explanations.

## Communication
- Be concise and direct
- Use markdown formatting
- Ask for clarification when needed`,
  coder: `# Code Reviewer

You are a code review specialist. You analyze code for quality, bugs, security issues, and best practices.

## Focus Areas
- Security vulnerabilities (OWASP top 10)
- Performance issues
- Code readability and maintainability
- Test coverage gaps

## Communication
- Use code blocks with language tags
- Be specific about line numbers and files
- Suggest fixes, don't just identify problems`,
  researcher: `# Research Assistant

You are a research assistant. You search the web, gather information, and synthesize findings into clear reports.

## Approach
- Always cite sources
- Present multiple perspectives
- Distinguish facts from opinions
- Summarize key findings upfront

## Communication
- Use headers and bullet points
- Include relevant links
- Flag uncertainty or conflicting information`,
  writer: `# Writing Assistant

You are a writing assistant. You help draft, edit, and improve written content.

## Capabilities
- Drafting emails, documents, and messages
- Proofreading and grammar correction
- Tone adjustment (formal, casual, technical)
- Content restructuring

## Communication
- Show changes clearly
- Explain your reasoning for edits
- Preserve the author's voice`,
};

async function openBotDetail(jid) {
  const bot = allBots.find(b => b.jid === jid);
  if (!bot) return;
  selectedBotJid = jid;
  renderBots();

  // Show edit view, hide create view
  $('#bot-edit-view').hidden = false;
  $('#bot-create-view').hidden = true;

  $('#bot-detail-title').textContent = bot.name;
  $('#bot-name').value = bot.name;
  $('#bot-trigger').value = bot.trigger;
  $('#bot-requires-trigger').checked = bot.requiresTrigger;
  $('#bot-delete').style.display = bot.isMain ? 'none' : '';

  // Load instructions
  try {
    const res = await authFetch(`/api/bots/${encodeURIComponent(jid)}/instructions`);
    if (res.ok) {
      const { content } = await res.json();
      $('#bot-instructions').value = content;
    }
  } catch {}

  $('#bot-detail').hidden = false;
  $('#members-panel').hidden = true;
}

function closeBotDetail() {
  $('#bot-detail').hidden = true;
  $('#bot-edit-view').hidden = false;
  $('#bot-create-view').hidden = true;
  selectedBotJid = null;
  createChatMessages = [];
  renderBots();
}

$('#bot-detail-close').addEventListener('click', closeBotDetail);
$('#bot-create-close').addEventListener('click', closeBotDetail);

// Template dropdown
$('#bot-template').addEventListener('change', () => {
  const val = $('#bot-template').value;
  if (val && BOT_TEMPLATES[val]) {
    if ($('#bot-instructions').value && !confirm('Replace current instructions with template?')) {
      $('#bot-template').value = '';
      return;
    }
    $('#bot-instructions').value = BOT_TEMPLATES[val];
  }
  $('#bot-template').value = '';
});

// Save existing bot
$('#bot-detail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedBotJid) return;
  const updates = {
    name: $('#bot-name').value.trim(),
    trigger: $('#bot-trigger').value.trim(),
    requiresTrigger: $('#bot-requires-trigger').checked,
  };
  try {
    // Update bot config
    await authFetch(`/api/bots/${encodeURIComponent(selectedBotJid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    // Update instructions
    await authFetch(`/api/bots/${encodeURIComponent(selectedBotJid)}/instructions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: $('#bot-instructions').value }),
    });
    await fetchBots();
    openBotDetail(selectedBotJid);
  } catch (err) {
    console.error('Failed to update bot:', err);
    alert('Failed to save bot: ' + (err.message || 'Unknown error'));
  }
});

// Delete bot
$('#bot-delete').addEventListener('click', async () => {
  if (!selectedBotJid) return;
  const bot = allBots.find(b => b.jid === selectedBotJid);
  if (!confirm(`Delete "${bot?.name}"? This cannot be undone.`)) return;
  try {
    await authFetch(`/api/bots/${encodeURIComponent(selectedBotJid)}`, { method: 'DELETE' });
    closeBotDetail();
    await fetchBots();
  } catch (err) {
    console.error('Failed to delete bot:', err);
  }
});

// ── Create bot via chat ───────────────────────────────────────────────────
let createChatMessages = [];

const BOT_SUGGESTIONS = [
  { label: '🔍 Code Reviewer', desc: 'A bot that reviews code for bugs, security issues, and best practices' },
  { label: '🔬 Researcher', desc: 'A bot that searches the web, gathers information, and writes research summaries' },
  { label: '✍️ Writer', desc: 'A bot that helps draft, edit, and improve written content like emails and docs' },
  { label: '🧪 Test Writer', desc: 'A bot that writes unit and integration tests for TypeScript/JavaScript projects' },
  { label: '📋 Task Runner', desc: 'A bot that runs scheduled tasks, monitors systems, and sends reports' },
  { label: '🏠 Home Assistant', desc: 'A bot that helps manage smart home devices, schedules, and automations' },
];

$('#create-bot-btn').addEventListener('click', () => {
  selectedBotJid = null;
  createChatMessages = [];
  renderBots();

  $('#bot-edit-view').hidden = true;
  $('#bot-create-view').hidden = false;
  $('#bot-create-messages').innerHTML = '';
  $('#bot-create-input').disabled = false;

  appendCreateMsg('system', 'What kind of bot would you like to create?');

  // Render suggestion chips
  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'create-chips';
  for (const s of BOT_SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.className = 'create-chip';
    chip.textContent = s.label;
    chip.addEventListener('click', () => {
      // Remove chips
      chipsWrap.remove();
      // Submit the description
      $('#bot-create-input').value = s.desc;
      $('#bot-create-form').requestSubmit();
    });
    chipsWrap.appendChild(chip);
  }
  $('#bot-create-messages').appendChild(chipsWrap);

  $('#bot-detail').hidden = false;
  $('#members-panel').hidden = true;
  $('#bot-create-input').focus();
});

function appendCreateMsg(role, text) {
  const el = document.createElement('div');
  el.className = `create-msg ${role}`;
  el.textContent = text;
  $('#bot-create-messages').appendChild(el);
  $('#bot-create-messages').scrollTop = $('#bot-create-messages').scrollHeight;
}

$('#bot-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#bot-create-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;

  // Remove chips if still showing
  const chips = $('#bot-create-messages .create-chips');
  if (chips) chips.remove();

  appendCreateMsg('user', text);
  appendCreateMsg('thinking', 'Sending to main agent...');

  try {
    const res = await authFetch('/api/bots/create-from-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: text }),
    });

    const thinking = $('#bot-create-messages .thinking');
    if (thinking) thinking.remove();

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      appendCreateMsg('system', `Error: ${err.error || 'Failed'}`);
      input.disabled = false;
      return;
    }

    const result = await res.json();
    appendCreateMsg('assistant', result.message);
    appendCreateMsg('system', 'Switch to the Rooms tab and open the Control Room to watch the agent create your bot. The bot list will update when it\'s done.');
    input.disabled = false;

    // Poll for new bots
    const pollInterval = setInterval(async () => {
      const oldCount = allBots.length;
      await fetchBots();
      if (allBots.length > oldCount) {
        clearInterval(pollInterval);
        // Refresh rooms
        try {
          const roomsRes = await authFetch('/api/rooms');
          if (roomsRes.ok) {
            lastRoomsList = await roomsRes.json();
            renderRooms(lastRoomsList);
          }
        } catch {}
        appendCreateMsg('system', 'New bot created! Switching to edit view...');
        const newBot = allBots.find(b => !allBots.slice(0, oldCount).some(ob => ob.jid === b.jid));
        if (newBot) setTimeout(() => openBotDetail(newBot.jid), 1000);
      }
    }, 3000);
    // Stop polling after 2 minutes
    setTimeout(() => clearInterval(pollInterval), 120000);
  } catch (err) {
    const thinking = $('#bot-create-messages .thinking');
    if (thinking) thinking.remove();
    appendCreateMsg('system', `Error: ${err.message}`);
    input.disabled = false;
  }
});

// ── Typing indicators ─────────────────────────────────────────────────────
function handleTypingEvent(msg) {
  if (msg.room_id !== currentRoom) return;
  const { identity, identity_type, is_typing } = msg;

  if (is_typing) {
    if (identity_type === 'agent') agentName = identity;
    if (typingUsers.has(identity)) clearTimeout(typingUsers.get(identity).timeout);
    const timeout = setTimeout(() => {
      typingUsers.delete(identity);
      renderTypingIndicator();
    }, identity_type === 'agent' ? 120000 : 5000);
    typingUsers.set(identity, { timeout, identity_type });
  } else {
    if (typingUsers.has(identity)) clearTimeout(typingUsers.get(identity).timeout);
    typingUsers.delete(identity);
  }
  renderTypingIndicator();
}

function renderTypingIndicator() {
  const el = $('#typing-indicator');
  const entries = [...typingUsers.entries()];
  if (entries.length === 0) {
    el.hidden = true;
    el.className = 'typing-indicator';
    const bubble = $('#messages .thinking-bubble');
    if (bubble) bubble.remove();
    return;
  }

  const hasAgent = entries.some(([, v]) => v.identity_type === 'agent');
  const userTypers = entries.filter(([, v]) => v.identity_type !== 'agent');

  let bubble = $('#messages .thinking-bubble');
  if (hasAgent) {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'msg agent thinking-bubble';
      const sender = document.createElement('div');
      sender.className = 'sender';
      sender.textContent = `🤖 ${agentName || 'Agent'} — Thinking`;
      bubble.appendChild(sender);
      const content = document.createElement('div');
      content.className = 'bubble';
      content.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
      bubble.appendChild(content);
      $('#messages').appendChild(bubble);
      scrollToBottom();
    }
  } else if (bubble) {
    bubble.remove();
  }

  if (userTypers.length > 0) {
    const names = userTypers.map(([n]) => n);
    const label = names.length === 1
      ? `${names[0]} is typing`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing`;
    el.innerHTML = `${label}<span class="dots"><span></span><span></span><span></span></span>`;
    el.className = 'typing-indicator';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ── Agent status events ───────────────────────────────────────────────────
const TOOL_LABELS = {
  Bash: 'Running command',
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Glob: 'Searching files',
  Grep: 'Searching code',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching page',
  Task: 'Managing tasks',
  NotebookEdit: 'Editing notebook',
};

function handleStatusEvent(msg) {
  if (msg.room_id !== currentRoom) return;
  if (msg.event === 'tool_use' && msg.detail) {
    updateThinkingBubble(TOOL_LABELS[msg.detail] || `Using ${msg.detail}`);
  } else if (msg.event === 'thinking') {
    updateThinkingBubble('Thinking');
  }
}

function updateThinkingBubble(label) {
  let bubble = $('#messages .thinking-bubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'msg agent thinking-bubble';
    const sender = document.createElement('div');
    sender.className = 'sender';
    bubble.appendChild(sender);
    const content = document.createElement('div');
    content.className = 'bubble';
    content.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
    bubble.appendChild(content);
    $('#messages').appendChild(bubble);
  }
  const sender = bubble.querySelector('.sender');
  if (sender) sender.textContent = `🤖 ${agentName || 'Agent'} — ${label}`;
  scrollToBottom();
}

// ── Typing send (debounced) ───────────────────────────────────────────────
let typingTimeout = null;
let isTyping = false;

$('#message-input').addEventListener('input', function() {
  // Auto-grow textarea
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  if (!currentRoom || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!isTyping) {
    isTyping = true;
    ws.send(JSON.stringify({ type: 'typing', is_typing: true }));
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    ws.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }, 2000);
});

$('#message-form').addEventListener('submit', () => {
  if (isTyping) {
    isTyping = false;
    clearTimeout(typingTimeout);
    ws.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }
});

// ── File upload (drag-drop, paste, picker) ────────────────────────────────
const messagesEl = $('#messages');

messagesEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  messagesEl.classList.add('drag-over');
});
messagesEl.addEventListener('dragleave', () => {
  messagesEl.classList.remove('drag-over');
});
messagesEl.addEventListener('drop', (e) => {
  e.preventDefault();
  messagesEl.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) stageFile(e.dataTransfer.files[0]);
});

document.addEventListener('paste', (e) => {
  if (!currentRoom) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length > 0) {
    e.preventDefault();
    stageFile(files[0]);
  }
});

$('#file-picker').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.addEventListener('change', () => {
    if (input.files.length > 0) stageFile(input.files[0]);
  });
  input.click();
});

// ── Init ──────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

initApp();
