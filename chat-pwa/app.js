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
        // Load bots and routes, then render
        if (allBots.length === 0) {
          Promise.all([
            authFetch('/api/bots').then(r => r.json()).then(b => { allBots = b; }),
            fetchRoutes(),
          ]).then(() => renderRooms(msg.rooms)).catch(() => renderRooms(msg.rooms));
        } else {
          fetchRoutes().then(() => renderRooms(msg.rooms)).catch(() => renderRooms(msg.rooms));
        }
        if (currentRoom) {
          // Rejoin after reconnect
          ws.send(JSON.stringify({ type: 'join', room_id: currentRoom }));
        } else {
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
        // Extra scrolls for mobile layout settle
        setTimeout(() => scrollToBottom(true), 100);
        setTimeout(() => scrollToBottom(true), 300);
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
        else incrementMissedMessages();
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
    myIdentity = '';
    setTimeout(connect, 3000);
  };
}

// ── Rooms ─────────────────────────────────────────────────────────────────
// ── Room ordering ─────────────────────────────────────────────────────────
function getSavedRoomOrder() {
  try { return JSON.parse(localStorage.getItem('room-order') || '[]'); } catch { return []; }
}
function saveRoomOrder(ids) {
  localStorage.setItem('room-order', JSON.stringify(ids));
}

let dragSrcLi = null;

// ── Pipeline data ─────────────────────────────────────────────────────────
// Format: { "room-id": ["target-room-1", "target-room-2"] }
let serverRoutes = {}; // fetched from /api/routes

function getLocalRoutes() {
  try { return JSON.parse(localStorage.getItem('nanoclaw-routes') || '{}'); } catch { return {}; }
}
function savePipelineRoutes(routes) {
  localStorage.setItem('nanoclaw-routes', JSON.stringify(routes));
}
function getPipelineRoutes() {
  // Merge server routes with local overrides
  const local = getLocalRoutes();
  const merged = { ...serverRoutes };
  for (const [src, dests] of Object.entries(local)) {
    if (!merged[src]) merged[src] = [];
    for (const d of dests) {
      if (!merged[src].includes(d)) merged[src].push(d);
    }
  }
  return merged;
}

async function fetchRoutes() {
  try {
    const res = await authFetch('/api/routes');
    if (res.ok) serverRoutes = await res.json();
  } catch { /* ignore */ }
}

// Build pipeline tree: find root bots (no one routes TO them) and their children
function buildPipelineTree(rooms) {
  const routes = getPipelineRoutes();
  const targets = new Set(); // rooms that are targets of other rooms
  for (const dests of Object.values(routes)) {
    for (const d of dests) targets.add(d);
  }
  // Count incoming connections per room
  const incomingCount = {};
  for (const dests of Object.values(routes)) {
    for (const d of dests) incomingCount[d] = (incomingCount[d] || 0) + 1;
  }
  return { routes, targets, incomingCount };
}

function renderRooms(rooms) {
  const list = $('#room-list');
  list.innerHTML = '';
  // Build lookup maps from bots
  const botByRoomId = new Map();
  for (const b of allBots) {
    if (b.jid.startsWith('chat:')) {
      botByRoomId.set(b.jid.replace(/^chat:/, ''), b);
    }
  }

  const { routes, targets, incomingCount } = buildPipelineTree(rooms);

  // Apply saved order, falling back to default sort for new rooms
  const savedOrder = getSavedRoomOrder();
  const orderMap = new Map(savedOrder.map((id, i) => [id, i]));

  // Main rooms always pinned at top
  const mainRooms = rooms.filter(r => botByRoomId.get(r.id)?.isMain);
  // Non-main rooms, excluding pipeline targets (they render indented under their parent)
  const nonMain = rooms.filter(r => !botByRoomId.get(r.id)?.isMain && !targets.has(r.id));

  nonMain.sort((a, b) => {
    const aIdx = orderMap.get(a.id);
    const bIdx = orderMap.get(b.id);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    // Pipeline roots (not a target) before targets
    const aIsTarget = targets.has(a.id) ? 1 : 0;
    const bIsTarget = targets.has(b.id) ? 1 : 0;
    if (aIsTarget !== bIsTarget) return aIsTarget - bIsTarget;
    const ab = botByRoomId.get(a.id);
    const bb = botByRoomId.get(b.id);
    const aRespondsAll = ab && !ab.requiresTrigger ? 1 : 0;
    const bRespondsAll = bb && !bb.requiresTrigger ? 1 : 0;
    if (aRespondsAll !== bRespondsAll) return bRespondsAll - aRespondsAll;
    const aHasBot = ab ? 1 : 0;
    const bHasBot = bb ? 1 : 0;
    if (aHasBot !== bHasBot) return bHasBot - aHasBot;
    return a.id.localeCompare(b.id);
  });

  const sorted = [...mainRooms, ...nonMain];
  const mainRoomIds = new Set(allBots.filter(b => b.isMain && b.jid.startsWith('chat:')).map(b => b.jid.replace(/^chat:/, '')));
  const lastMainIdx = sorted.reduce((acc, r, i) => mainRoomIds.has(r.id) ? i : acc, -1);

  // Track which rooms have been rendered (to avoid duplicates for pipeline children)
  const rendered = new Set();

  function addRoomLi(room, indent, i) {
    if (rendered.has(room.id)) return;
    rendered.add(room.id);

    const li = document.createElement('li');
    const color = roomColor(room.id);
    li.dataset.roomId = room.id;
    li.style.borderLeftColor = color;
    li.style.display = 'flex';
    li.style.alignItems = 'center';
    if (indent > 0) li.classList.add('pipeline-child');
    if (i === lastMainIdx && lastMainIdx < sorted.length - 1) li.classList.add('main-divider');

    // Pipeline arrow for indented items
    if (indent > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'room-pipe-arrow';
      arrow.textContent = '→';
      arrow.style.color = color;
      li.appendChild(arrow);
    }

    const text = document.createElement('span');
    text.textContent = `#${room.id}`;
    text.style.flex = '1';
    li.appendChild(text);

    // Fan-in badge
    const inc = incomingCount[room.id] || 0;
    if (inc > 1) {
      const badge = document.createElement('span');
      badge.className = 'fan-in-badge';
      badge.textContent = `←${inc}`;
      badge.title = 'Receives from multiple bots';
      li.appendChild(badge);
    }

    if (unreadRooms.has(room.id)) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.style.background = color;
      li.appendChild(dot);
    }
    if (room.id === currentRoom) li.classList.add('active');
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');

    const isMainRoom = mainRoomIds.has(room.id);
    const isPipelineChild = indent > 0;
    if (!isMainRoom && !isPipelineChild) li.setAttribute('draggable', 'true');

    // Drag events (non-main, non-pipeline-child rooms only)
    li.addEventListener('dragstart', (e) => {
      if (isMainRoom || isPipelineChild) { e.preventDefault(); return; }
      dragSrcLi = li;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', room.id);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragSrcLi = null;
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', (e) => {
      if (isMainRoom || isPipelineChild) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcLi && dragSrcLi !== li) li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (!dragSrcLi || dragSrcLi === li) return;
      // Calculate new order from current DOM, then swap
      const items = [...list.children].map(el => el.dataset.roomId);
      const fromId = dragSrcLi.dataset.roomId;
      const toId = li.dataset.roomId;
      const fromIdx = items.indexOf(fromId);
      const toIdx = items.indexOf(toId);
      items.splice(fromIdx, 1);
      items.splice(toIdx, 0, fromId);
      saveRoomOrder(items.filter(Boolean));
      // Re-render to keep pipeline children with parents
      renderRooms(lastRoomsList);
    });

    li.addEventListener('click', () => {
      joinRoom(room.id, room.name);
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); joinRoom(room.id, room.name); }
    });
    list.appendChild(li);

    // Render pipeline children (rooms this bot routes to)
    const children = routes[room.id] || [];
    for (const childId of children) {
      const childRoom = rooms.find(r => r.id === childId);
      if (childRoom) addRoomLi(childRoom, indent + 1, -1);
    }
  }

  sorted.forEach((room, i) => addRoomLi(room, 0, i));
}

let lastRoomsList = [];
function updateUnreadDots() {
  if (lastRoomsList.length) renderRooms(lastRoomsList);
}

function joinRoom(roomId, roomName) {
  currentRoom = roomId;
  unreadRooms.delete(roomId);
  updateUnreadDots();
  // Set agent name for thinking bubble from the bot associated with this room
  const roomBot = allBots.find(b => b.jid === `chat:${roomId}`);
  if (roomBot) agentName = roomBot.trigger || roomBot.name;
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
  $('#room-name').textContent = `#${roomId}`;
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
  return div;
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
  html += `<span class="file-preview-name">${esc(pendingFile.name)}</span>`;
  html += `<span class="file-preview-size">${formatFileSize(pendingFile.size)}</span>`;
  html += `<button class="file-preview-remove" id="file-preview-remove">&times;</button>`;
  html += '</div>';
  preview.innerHTML = html;
  $('#file-preview-remove').addEventListener('click', clearStagedFile);
}

const CHUNK_THRESHOLD = 512 * 1024; // Use chunked upload for files > 512KB
const CHUNK_SIZE = 512 * 1024;      // 512KB per chunk

async function uploadFile(file, caption) {
  if (!currentRoom) return;
  if (file.size > CHUNK_THRESHOLD) {
    return uploadFileChunked(file, caption);
  }
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

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function uploadFileChunked(file, caption) {
  const uploadId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const statusMsg = appendSystem(`Uploading ${file.name} (0/${totalChunks})...`);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const slice = file.slice(start, end);
    const buf = await slice.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);

    const body = {
      uploadId,
      chunkIndex: i,
      totalChunks,
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      data: b64,
    };
    // Include caption on the last chunk
    if (i === totalChunks - 1 && caption) body.caption = caption;

    try {
      const res = await authFetch(
        `/api/rooms/${encodeURIComponent(currentRoom)}/upload/chunk`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (statusMsg) statusMsg.textContent = `Upload failed: ${err.error || res.statusText}`;
        return;
      }
    } catch (err) {
      if (statusMsg) statusMsg.textContent = `Upload failed: ${err.message}`;
      return;
    }
    if (statusMsg) statusMsg.textContent = `Uploading ${file.name} (${i + 1}/${totalChunks})...`;
  }
  if (statusMsg) statusMsg.remove();
}

function scrollToBottom(instant) {
  const el = $('#messages');
  el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  // Also scroll window for mobile where body scrolls instead of #messages
  window.scrollTo({ top: document.body.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function isNearBottom() {
  const el = $('#messages');
  const elNear = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const winNear = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;
  return elNear || winNear;
}

let missedMsgCount = 0;

function updateScrollButton() {
  if (isNearBottom()) {
    $('#scroll-bottom').hidden = true;
    missedMsgCount = 0;
    $('#unread-badge').textContent = '';
  } else {
    $('#scroll-bottom').hidden = false;
    $('#unread-badge').textContent = missedMsgCount > 0 ? String(missedMsgCount) : '';
  }
}

function incrementMissedMessages() {
  if (!isNearBottom()) {
    missedMsgCount++;
    updateScrollButton();
  }
}

// Show/hide scroll-to-bottom button
$('#messages').addEventListener('scroll', () => {
  updateScrollButton();
});
window.addEventListener('scroll', () => {
  updateScrollButton();
});
$('#scroll-bottom').addEventListener('click', () => {
  missedMsgCount = 0;
  $('#unread-badge').textContent = '';
  scrollToBottom();
});

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
  const [health, stats] = await Promise.all([
    authFetch('/health').then(r => r.json()).catch(() => ({ ok: false })),
    authFetch('/api/stats').then(r => r.json()).catch(() => null),
  ]);

  renderHealthStrip(health, stats);
  renderMetrics(stats);
}

function renderHealthStrip(health, stats) {
  const el = $('#dash-health');
  const wsOk = ws && ws.readyState === WebSocket.OPEN;
  const pills = [
    { dot: health.ok ? 'ok' : 'err', label: 'Server', value: health.ok ? 'Online' : 'Offline' },
    { dot: 'ok', label: 'Uptime', value: health.uptime ? formatUptime(health.uptime) : '—' },
    { dot: wsOk ? 'ok' : 'err', label: 'WebSocket', value: wsOk ? 'Connected' : 'Disconnected' },
  ];
  el.innerHTML = pills.map(p =>
    `<div class="dash-pill"><span class="pill-dot ${p.dot}"></span><span class="pill-label">${p.label}</span><span class="pill-value">${p.value}</span></div>`
  ).join('');
}

function renderMetrics(stats) {
  const el = $('#dash-graph');
  if (!stats) {
    el.innerHTML = '<div class="dash-empty">Unable to load metrics</div>';
    return;
  }

  function num(v) { return esc(String(Number(v) || 0)); }

  // Top row: key numbers (clickable)
  const msg24h = `<div class="metric-card clickable" onclick="showMessageDetail()">
    <div class="metric-value">${num(stats.messages24h)}</div>
    <div class="metric-label">Messages (24h)</div>
  </div>`;

  const containers = `<div class="metric-card clickable" onclick="showContainerDetail()">
    <div class="metric-value">${num(stats.activeContainers)}</div>
    <div class="metric-label">Active Containers</div>
  </div>`;

  const bots = `<div class="metric-card clickable" onclick="showBotDetail()">
    <div class="metric-value">${num(stats.bots)}</div>
    <div class="metric-label">Registered Bots</div>
  </div>`;

  const ta = Number(stats.tasks.active) || 0;
  const tp = Number(stats.tasks.paused) || 0;
  const tt = Number(stats.tasks.total) || 0;
  const tc = tt - ta - tp;
  const taskStr = ta > 0
    ? `${ta} active` + (tp > 0 ? ` / ${tp} paused` : '') + (tc > 0 ? ` / ${tc} done` : '')
    : tp > 0 ? `${tp} paused` + (tc > 0 ? ` / ${tc} done` : '')
    : tc > 0 ? `${tc} completed` : 'None';
  const tasks = `<div class="metric-card clickable" onclick="showTaskDetail()">
    <div class="metric-value">${num(tt)}</div>
    <div class="metric-label">Scheduled Tasks</div>
    <div class="metric-sub">${esc(taskStr)}</div>
  </div>`;

  // System
  const sys = stats.system || {};
  const memBar = sys.memoryUsedPct || 0;
  const memColor = memBar > 85 ? 'var(--delete-color)' : memBar > 60 ? '#ffd54f' : 'var(--accent)';
  const loadStr = (sys.loadAvg || []).join(' / ');
  const system = `<div class="metric-card wide">
    <div class="metric-label">System</div>
    <div class="sys-row"><span>Memory</span><span>${num(sys.memoryUsedGB)} / ${num(sys.memoryTotalGB)} GB (${num(memBar)}%)</span></div>
    <div class="progress-bar"><div class="progress-fill" style="width:${num(memBar)}%;background:${memColor}"></div></div>
    <div class="sys-row"><span>CPU Load (1/5/15m)</span><span>${esc(loadStr)}</span></div>
    <div class="sys-row"><span>CPUs</span><span>${num(sys.cpus)}</span></div>
    <div class="sys-row"><span>Platform</span><span>${esc(sys.platform || '')}</span></div>
  </div>`;

  // Ollama
  const oll = stats.ollama || {};
  let ollamaHtml;
  if (!oll.host) {
    ollamaHtml = `<div class="metric-card wide">
      <div class="metric-label">Ollama</div>
      <div class="metric-sub">Not configured</div>
    </div>`;
  } else {
    const dot = oll.ok ? '<span class="pill-dot ok"></span>' : '<span class="pill-dot err"></span>';
    const models = oll.models && oll.models.length > 0
      ? oll.models.map(m => `<span class="model-tag">${esc(m)}</span>`).join(' ')
      : '<span class="metric-sub">No models</span>';
    ollamaHtml = `<div class="metric-card wide">
      <div class="metric-label">${dot} Ollama</div>
      <div class="sys-row"><span>Host</span><span>${esc(oll.host)}</span></div>
      <div class="sys-row"><span>Status</span><span>${oll.ok ? 'Connected' : 'Unreachable'}</span></div>
      <div style="margin-top:6px">${models}</div>
    </div>`;
  }

  // Bots by channel
  const channelHtml = Object.entries(stats.channels)
    .sort((a, b) => b[1] - a[1])
    .map(([ch, count]) => `<div class="channel-row"><span class="channel-name">${esc(ch)}</span><span class="channel-count">${count}</span></div>`)
    .join('');
  const channels = `<div class="metric-card">
    <div class="metric-label">Bots by Channel</div>
    ${channelHtml}
  </div>`;

  // Busiest rooms
  const busyRooms = (stats.busiestRooms || []);
  let busiestHtml;
  if (busyRooms.length === 0) {
    busiestHtml = `<div class="metric-card">
      <div class="metric-label">Busiest Rooms (24h)</div>
      <div class="metric-sub">No activity</div>
    </div>`;
  } else {
    const rows = busyRooms.map(r =>
      `<div class="channel-row"><span class="channel-name">#${esc(r.id)}</span><span class="channel-count">${r.count} msgs</span></div>`
    ).join('');
    busiestHtml = `<div class="metric-card">
      <div class="metric-label">Busiest Rooms (24h)</div>
      ${rows}
    </div>`;
  }

  // IPC queue
  const queueEntries = Object.entries(stats.ipcQueues).filter(([, v]) => v > 0);
  let ipcHtml;
  if (queueEntries.length === 0) {
    ipcHtml = `<div class="metric-card wide">
      <div class="metric-label">IPC Queue</div>
      <div class="metric-sub">All clear</div>
    </div>`;
  } else {
    const rows = queueEntries
      .sort((a, b) => b[1] - a[1])
      .map(([folder, count]) => `<div class="channel-row"><span class="channel-name">${esc(folder)}</span><span class="channel-count">${count} pending</span></div>`)
      .join('');
    ipcHtml = `<div class="metric-card wide">
      <div class="metric-label">IPC Queue</div>
      ${rows}
    </div>`;
  }

  el.innerHTML = `
    <div class="metrics-grid">${msg24h}${containers}${bots}${tasks}</div>
    <div class="metrics-grid two-col">${system}${ollamaHtml}</div>
    <div class="metrics-grid two-col">${channels}${busiestHtml}</div>
    ${ipcHtml}`;
}

// ── Dashboard detail panel ────────────────────────────────────────────────
function showDetail(title, html) {
  $('#dash-detail-title').textContent = title;
  $('#dash-detail-body').innerHTML = html;
  $('#dash-detail').hidden = false;
  $('#dash-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideDetail() {
  $('#dash-detail').hidden = true;
}

$('#dash-detail-close').addEventListener('click', hideDetail);

async function showMessageDetail() {
  const rooms = await authFetch('/api/rooms').then(r => r.json()).catch(() => []);
  const since = Date.now() - 86400000;
  const roomMsgs = await Promise.all(
    rooms.map(room =>
      authFetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`)
        .then(r => r.json())
        .then(msgs => msgs.filter(m => m.created_at > since).map(m => ({ ...m, roomId: room.id })))
        .catch(() => [])
    )
  );
  const allMsgs = roomMsgs.flat();
  allMsgs.sort((a, b) => b.created_at - a.created_at);
  const recent = allMsgs.slice(0, 50);

  if (recent.length === 0) {
    showDetail('Messages (24h)', '<div class="metric-sub">No messages in the last 24 hours</div>');
    return;
  }

  const rows = recent.map(m => {
    const time = new Date(m.created_at).toLocaleTimeString();
    const icon = m.sender_type === 'agent' ? '🤖' : '👤';
    return `<tr>
      <td>${time}</td>
      <td style="color:${roomColor(m.roomId)}">#${esc(m.roomId)}</td>
      <td>${icon} ${esc(m.sender)}</td>
      <td class="msg-content">${esc(m.content?.slice(0, 100) || '')}</td>
    </tr>`;
  }).join('');

  showDetail('Messages (24h)', `<table class="detail-table">
    <thead><tr><th>Time</th><th>Room</th><th>Sender</th><th>Message</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`);
}

async function showTaskDetail() {
  const tasks = await authFetch('/api/tasks').then(r => r.json()).catch(() => []);

  if (tasks.length === 0) {
    showDetail('Scheduled Tasks', '<div class="metric-sub">No scheduled tasks</div>');
    return;
  }

  const rows = tasks.map(t => {
    const statusClass = t.status === 'active' ? 'status-active' : t.status === 'paused' ? 'status-paused' : 'status-completed';
    const nextRun = t.next_run ? new Date(t.next_run).toLocaleString() : '—';
    const lastRun = t.last_run ? relativeTime(t.last_run) : 'never';
    return `<tr>
      <td><span class="status-badge ${statusClass}">${esc(t.status)}</span></td>
      <td>${esc(t.group_folder)}</td>
      <td>${esc(t.schedule_type)}: ${esc(t.schedule_value)}</td>
      <td class="msg-content">${esc(t.prompt?.slice(0, 80) || '')}</td>
      <td>${nextRun}</td>
      <td>${lastRun}</td>
    </tr>`;
  }).join('');

  showDetail('Scheduled Tasks', `<table class="detail-table">
    <thead><tr><th>Status</th><th>Group</th><th>Schedule</th><th>Prompt</th><th>Next Run</th><th>Last Run</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`);
}

async function showContainerDetail() {
  // Fetch active containers from stats (re-fetch to get fresh data)
  const stats = await authFetch('/api/stats').then(r => r.json()).catch(() => null);
  if (!stats || stats.activeContainers === 0) {
    showDetail('Active Containers', '<div class="metric-sub">No containers running</div>');
    return;
  }
  showDetail('Active Containers', `<div class="metric-sub">${stats.activeContainers} container(s) currently running. Check <code>docker ps --filter name=nanoclaw-</code> for details.</div>`);
}

async function showBotDetail() {
  const bots = await authFetch('/api/bots').then(r => r.json()).catch(() => []);
  if (bots.length === 0) {
    showDetail('Registered Bots', '<div class="metric-sub">No bots registered</div>');
    return;
  }

  const sorted = [...bots].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const rows = sorted.map(b => {
    const mainBadge = b.isMain ? '<span class="status-badge status-active">MAIN</span>' : '';
    return `<tr>
      <td>${esc(b.name)} ${mainBadge}</td>
      <td>${esc(b.channel)}</td>
      <td><code>${esc(b.folder)}</code></td>
      <td><code>${esc(b.trigger)}</code></td>
      <td>${b.requiresTrigger ? 'Yes' : 'No'}</td>
    </tr>`;
  }).join('');

  showDetail('Registered Bots', `<table class="detail-table">
    <thead><tr><th>Name</th><th>Channel</th><th>Folder</th><th>Trigger</th><th>Requires Trigger</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`);
}

// Make detail functions globally accessible for onclick handlers
window.showMessageDetail = showMessageDetail;
window.showTaskDetail = showTaskDetail;
window.showContainerDetail = showContainerDetail;
window.showBotDetail = showBotDetail;

// ── Bot management ────────────────────────────────────────────────────────
const CHANNEL_ICONS = {
  whatsapp: '💬', telegram: '✈️', discord: '🎮', slack: '📡', chat: '🌐', local: '🌐', gmail: '📧',
};
const CHANNEL_COLORS = {
  whatsapp: '#25D366', telegram: '#2AABEE', discord: '#5865F2', slack: '#E01E5A', chat: '#888', local: '#888', gmail: '#EA4335',
};

let allBots = [];
let selectedBotJid = null;
let currentBotTags = [];

function renderBotTags(tags) {
  currentBotTags = [...tags];
  const list = $('#bot-tags-list');
  list.innerHTML = '';
  for (const tag of currentBotTags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `${esc(tag)}<span class="tag-remove">&times;</span>`;
    chip.querySelector('.tag-remove').addEventListener('click', () => {
      currentBotTags = currentBotTags.filter(t => t !== tag);
      renderBotTags(currentBotTags);
    });
    list.appendChild(chip);
  }
}

function getCurrentBotTags() {
  return [...currentBotTags];
}

$('#bot-tag-input').addEventListener('keydown', (e) => {
  const input = $('#bot-tag-input');
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = input.value.replace(/,/g, '').trim().toLowerCase();
    if (val && !currentBotTags.includes(val)) {
      currentBotTags.push(val);
      renderBotTags(currentBotTags);
    }
    input.value = '';
  }
  if (e.key === 'Backspace' && input.value === '' && currentBotTags.length > 0) {
    currentBotTags.pop();
    renderBotTags(currentBotTags);
  }
});

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

  // Build room-id routes for pipeline arrows
  const routes = getPipelineRoutes();
  const targets = new Set();
  for (const dests of Object.values(routes)) {
    for (const d of dests) targets.add(d);
  }
  const incomingCount = {};
  for (const dests of Object.values(routes)) {
    for (const d of dests) incomingCount[d] = (incomingCount[d] || 0) + 1;
  }

  // Map bot JID to room ID for chat bots
  function botRoomId(bot) {
    return bot.jid.startsWith('chat:') ? bot.jid.replace(/^chat:/, '') : null;
  }

  // Sort: main first, then non-targets, then alphabetical
  const sorted = [...allBots].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    const aTarget = targets.has(botRoomId(a)) ? 1 : 0;
    const bTarget = targets.has(botRoomId(b)) ? 1 : 0;
    if (aTarget !== bTarget) return aTarget - bTarget;
    return a.name.localeCompare(b.name);
  });

  // Filter out pipeline targets from top level
  const topLevel = sorted.filter(b => !targets.has(botRoomId(b)));

  const lastMainBotIdx = topLevel.reduce((acc, b, i) => b.isMain ? i : acc, -1);
  const rendered = new Set();

  function addBotLi(bot, isPipeChild, idx) {
    const rid = botRoomId(bot);
    if (rid && rendered.has(rid)) return;
    if (rid) rendered.add(rid);

    const li = document.createElement('li');
    li.dataset.jid = bot.jid;
    const chColor = CHANNEL_COLORS[bot.channel] || '';
    if (chColor) li.style.borderLeftColor = chColor;
    if (bot.jid === selectedBotJid) li.classList.add('active');
    if (!isPipeChild && idx === lastMainBotIdx && lastMainBotIdx < topLevel.length - 1) li.classList.add('main-divider');

    // Pipeline arrow
    if (isPipeChild) {
      const arrow = document.createElement('span');
      arrow.className = 'room-pipe-arrow';
      arrow.textContent = '→';
      if (chColor) arrow.style.color = chColor;
      li.appendChild(arrow);
    }

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
    if (bot.tags && bot.tags.length > 0) {
      const tagsWrap = document.createElement('span');
      tagsWrap.className = 'bot-tags';
      for (const t of bot.tags) {
        const tag = document.createElement('span');
        tag.className = 'bot-tag';
        tag.textContent = t;
        tagsWrap.appendChild(tag);
      }
      info.appendChild(tagsWrap);
    }
    li.appendChild(info);

    if (bot.isMain) {
      const tag = document.createElement('span');
      tag.className = 'bot-main-tag';
      tag.textContent = 'MAIN';
      li.appendChild(tag);
    }

    // Fan-in badge
    if (rid && (incomingCount[rid] || 0) > 1) {
      const badge = document.createElement('span');
      badge.className = 'fan-in-badge';
      badge.textContent = `←${incomingCount[rid]}`;
      badge.title = 'Receives from multiple bots';
      li.appendChild(badge);
    }

    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('click', () => {
      if (selectedBotJid === bot.jid && !$('#bot-detail').hidden) {
        closeBotDetail();
      } else {
        openBotDetail(bot.jid);
      }
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBotDetail(bot.jid); }
    });
    list.appendChild(li);

    // Render pipeline children
    if (rid && routes[rid]) {
      for (const targetRoomId of routes[rid]) {
        const childBot = allBots.find(b => botRoomId(b) === targetRoomId);
        if (childBot) addBotLi(childBot, true, -1);
      }
    }
  }

  topLevel.forEach((bot, idx) => addBotLi(bot, false, idx));
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
  tester: `# Test Writer

You are a test engineering specialist. You write unit tests, integration tests, and end-to-end tests.

## Focus Areas
- Edge cases and boundary conditions
- Mocking external dependencies
- Test readability and maintainability
- Coverage of happy paths and error paths

## Communication
- Use code blocks with proper test framework syntax
- Explain what each test validates
- Group tests logically by feature or function`,
  security: `# Security Reviewer

You are a security review specialist. You analyze code and configurations for vulnerabilities.

## Focus Areas
- OWASP Top 10 vulnerabilities
- Authentication and authorization flaws
- Input validation and sanitization
- Dependency vulnerabilities
- Secrets and credential exposure

## Communication
- Rate findings by severity (Critical/High/Medium/Low)
- Provide specific remediation steps
- Reference CWE IDs when applicable`,
  architect: `# Software Architect

You are a software architecture advisor. You evaluate designs and suggest improvements.

## Focus Areas
- System design and component boundaries
- Scalability and performance trade-offs
- Data modeling and storage choices
- API design and integration patterns
- Technical debt assessment

## Communication
- Use diagrams when helpful (mermaid/ASCII)
- Present trade-offs, not just recommendations
- Consider operational complexity`,
  refactor: `# Refactoring Helper

You are a code refactoring specialist. You identify improvement opportunities and guide transformations.

## Focus Areas
- Code duplication and DRY violations
- Long methods and god classes
- Tight coupling and poor abstractions
- Naming and clarity improvements

## Communication
- Show before/after comparisons
- Explain the pattern or principle behind each suggestion
- Prioritize changes by impact`,
  cicd: `# CI/CD Helper

You are a DevOps and CI/CD specialist. You help with build pipelines, deployment, and infrastructure.

## Focus Areas
- GitHub Actions and CI workflows
- Docker and container optimization
- Deployment strategies (blue-green, canary)
- Environment configuration and secrets management

## Communication
- Provide working YAML/config snippets
- Explain each step's purpose
- Flag security concerns in pipelines`,
  docgen: `# Documentation Generator

You are a technical documentation specialist. You generate clear, accurate docs from code.

## Focus Areas
- API documentation with examples
- README files and getting-started guides
- Inline code comments for complex logic
- Architecture decision records (ADRs)

## Communication
- Use consistent formatting
- Include code examples for every endpoint/function
- Keep language concise and scannable`,
  ux: `# UX Reviewer

You are a UX review specialist. You evaluate interfaces for usability and accessibility.

## Focus Areas
- Accessibility (WCAG 2.1 compliance)
- User flow and interaction design
- Visual hierarchy and consistency
- Mobile responsiveness
- Error states and edge cases

## Communication
- Reference specific UI elements
- Suggest concrete improvements
- Prioritize by user impact`,
  prd: `# PRD Writer

You are a product requirements specialist. You help write clear, actionable product documents.

## Focus Areas
- User stories and acceptance criteria
- Feature specifications
- Success metrics and KPIs
- Edge cases and constraints

## Communication
- Use structured templates
- Be specific about scope (in/out)
- Include examples and wireframe descriptions`,
  servermon: `# Server Monitor

You are a server monitoring assistant. You help track system health and diagnose issues.

## Focus Areas
- CPU, memory, and disk utilization
- Process monitoring and alerting
- Log analysis and pattern detection
- Performance baselines and anomalies

## Communication
- Present data clearly with units
- Highlight anomalies and thresholds
- Suggest actionable next steps`,
  docker: `# Docker Manager

You are a Docker and container management specialist.

## Focus Areas
- Container lifecycle management
- Docker Compose configuration
- Image optimization and layer caching
- Volume and network management
- Security best practices (non-root, minimal images)

## Communication
- Provide working docker commands and compose snippets
- Explain resource implications
- Flag deprecated or insecure practices`,
  network: `# Network Admin

You are a network administration specialist for homelab and small-scale environments.

## Focus Areas
- DNS configuration and troubleshooting
- Firewall rules (iptables, UFW, nftables)
- VPN setup (WireGuard, Tailscale)
- Reverse proxy configuration (nginx, Caddy)
- Network diagnostics

## Communication
- Provide working config snippets
- Explain security implications
- Test commands to verify changes`,
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
  renderBotTags(bot.tags || []);

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
    tags: getCurrentBotTags(),
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
  // Coding
  { label: '🔍 Code Reviewer', desc: 'A bot that reviews code for bugs, security issues, and best practices', tag: 'coding' },
  { label: '🧪 Test Writer', desc: 'A bot that writes unit and integration tests for TypeScript/JavaScript projects', tag: 'coding' },
  { label: '🐛 Bug Triager', desc: 'A bot that analyzes bug reports, reproduces issues, and suggests fixes', tag: 'coding' },
  { label: '📐 Architect', desc: 'A bot that reviews architecture decisions, suggests patterns, and evaluates trade-offs', tag: 'coding' },
  { label: '🔒 Security Reviewer', desc: 'A bot that scans code for security vulnerabilities, OWASP top 10, and dependency risks', tag: 'coding' },
  { label: '📝 Doc Generator', desc: 'A bot that generates API docs, README files, and inline documentation from code', tag: 'coding' },
  { label: '♻️ Refactor Helper', desc: 'A bot that identifies code smells, duplication, and suggests refactoring strategies', tag: 'coding' },
  { label: '🚀 CI/CD Helper', desc: 'A bot that helps write and debug GitHub Actions, Docker configs, and deployment scripts', tag: 'coding' },
  // Product Development
  { label: '🎨 UX Reviewer', desc: 'A bot that reviews UI/UX for accessibility, usability, and consistency', tag: 'product' },
  { label: '📋 PRD Writer', desc: 'A bot that helps write product requirements documents and user stories', tag: 'product' },
  { label: '🗺️ Roadmap Planner', desc: 'A bot that helps prioritize features, plan sprints, and manage backlogs', tag: 'product' },
  { label: '📊 Analytics Helper', desc: 'A bot that helps define metrics, write tracking specs, and analyze data', tag: 'product' },
  { label: '🧑‍🎨 Design System', desc: 'A bot that maintains design tokens, component specs, and style guidelines', tag: 'product' },
  // Homelab
  { label: '🏠 Home Assistant', desc: 'A bot that helps manage smart home devices, automations, and schedules', tag: 'homelab' },
  { label: '🖥️ Server Monitor', desc: 'A bot that monitors server health, disk usage, CPU/memory, and alerts on issues', tag: 'homelab' },
  { label: '🐳 Docker Manager', desc: 'A bot that helps manage Docker containers, compose files, and image updates', tag: 'homelab' },
  { label: '🌐 Network Admin', desc: 'A bot that helps with DNS, firewall rules, VPN configs, and network troubleshooting', tag: 'homelab' },
  { label: '💾 Backup Manager', desc: 'A bot that helps schedule and verify backups, check retention policies', tag: 'homelab' },
  { label: '📡 IoT Hub', desc: 'A bot that manages IoT sensors, MQTT topics, and device telemetry', tag: 'homelab' },
  // Research & Writing
  { label: '🔬 Researcher', desc: 'A bot that searches the web, gathers information, and writes research summaries', tag: 'research' },
  { label: '✍️ Writer', desc: 'A bot that helps draft, edit, and improve written content like emails and docs', tag: 'research' },
  { label: '📰 News Digest', desc: 'A bot that monitors topics and delivers daily news summaries', tag: 'research' },
  { label: '📚 Paper Reviewer', desc: 'A bot that reads academic papers, extracts key findings, and writes summaries', tag: 'research' },
  { label: '🌍 Translator', desc: 'A bot that translates text between languages with context awareness', tag: 'research' },
  // Operations & Automation
  { label: '📋 Task Runner', desc: 'A bot that runs scheduled tasks, monitors systems, and sends reports', tag: 'ops' },
  { label: '🔔 Alert Bot', desc: 'A bot that monitors conditions and sends notifications when thresholds are crossed', tag: 'ops' },
  { label: '📈 Report Generator', desc: 'A bot that generates daily/weekly reports from data sources and APIs', tag: 'ops' },
  { label: '🤝 Meeting Notes', desc: 'A bot that summarizes meeting transcripts, extracts action items, and tracks follow-ups', tag: 'ops' },
  { label: '📬 Email Drafter', desc: 'A bot that drafts professional emails based on bullet points or context', tag: 'ops' },
  // General
  { label: '💡 General Assistant', desc: 'A general-purpose bot that answers questions and helps with any task', tag: 'general' },
  { label: '🧮 Math/Data Helper', desc: 'A bot that helps with calculations, data analysis, and spreadsheet formulas', tag: 'general' },
  { label: '🎓 Tutor', desc: 'A bot that explains concepts, creates quizzes, and helps with learning any topic', tag: 'general' },
];

const BOT_TAG_LABELS = {
  all: 'All',
  coding: 'Coding',
  product: 'Product',
  homelab: 'Homelab',
  research: 'Research',
  ops: 'Ops',
  general: 'General',
};
let activeBotTag = 'all';

let pipelineQueue = []; // bots queued for sequential creation
let pendingRouteSync = null; // room names to sync to server after bot creation

function renderBotChips(container) {
  container.innerHTML = '';
  const filtered = activeBotTag === 'all'
    ? BOT_SUGGESTIONS
    : BOT_SUGGESTIONS.filter(s => s.tag === activeBotTag);
  for (const s of filtered) {
    const chip = document.createElement('button');
    chip.className = 'create-chip';
    chip.innerHTML = `<span class="chip-label">${esc(s.label)}</span><span class="chip-desc">${esc(s.desc)}</span>`;
    chip.addEventListener('click', () => {
      addBotToPipeline(s, container);
    });
    container.appendChild(chip);
  }
}

function addBotToPipeline(suggestion, chipsContainer) {
  pipelineQueue.push(suggestion);
  renderPipelinePreview();

  // Reset tag filter to show all options for next bot
  activeBotTag = 'all';
  const filterWrap = $('#bot-create-messages .create-tag-filters');
  if (filterWrap) {
    filterWrap.querySelectorAll('.create-tag-btn').forEach(b => b.classList.toggle('active', b.dataset.tag === 'all'));
  }
  renderBotChips(chipsContainer);
}

function renderPipelinePreview() {
  let preview = $('#pipeline-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'pipeline-preview';
    preview.className = 'pipeline-preview';
    // Insert before the tag filters
    const filters = $('#bot-create-messages .create-tag-filters');
    if (filters) {
      filters.before(preview);
    } else {
      $('#bot-create-messages').prepend(preview);
    }
  }

  const steps = pipelineQueue.map((s, i) => `<span class="pipeline-step">${esc(s.label)}</span>`).join('<span class="pipeline-arrow">→</span>');
  preview.innerHTML = `
    <div class="pipeline-preview-label">Pipeline (${pipelineQueue.length} bot${pipelineQueue.length > 1 ? 's' : ''}):</div>
    <div class="pipeline-flow">${steps}</div>
    <div class="pipeline-preview-actions">
      <button id="pipeline-create-btn" class="btn-save">Create${pipelineQueue.length > 1 ? ' Pipeline' : ''}</button>
      <button id="pipeline-undo-btn" class="btn-delete" style="font-size:11px;padding:4px 10px">Undo</button>
    </div>
  `;

  preview.querySelector('#pipeline-create-btn').addEventListener('click', submitPipeline);
  preview.querySelector('#pipeline-undo-btn').addEventListener('click', () => {
    pipelineQueue.pop();
    if (pipelineQueue.length === 0) {
      preview.remove();
    } else {
      renderPipelinePreview();
    }
  });
}

function submitPipeline() {
  // Remove UI elements
  $('#bot-create-messages .create-tag-filters')?.remove();
  $('#bot-create-messages .create-chips')?.remove();
  $('#pipeline-preview')?.remove();

  const queue = [...pipelineQueue];
  const labels = queue.map(s => s.label);

  let prompt;
  if (queue.length === 1) {
    prompt = queue[0].desc;
  } else {
    // Generate kebab-case room names for the prompt
    const roomNames = queue.map(s => {
      const name = s.label.replace(/^[^\w]+/, '').trim().toLowerCase().replace(/\s+/g, '-');
      return name;
    });

    prompt = `Create a pipeline of ${queue.length} bots that work in sequence:\n\n` +
      queue.map((s, i) =>
        `${i + 1}. ${s.label} (room: "${roomNames[i]}"): ${s.desc}`
      ).join('\n') +
      `\n\nEach bot should forward its output to the next bot in the sequence. ` +
      `Create them as separate bots with rooms named exactly as specified above. ` +
      `The last bot outputs the final result to the user.`;

    // Save pipeline routes locally first (rooms don't exist yet on server)
    if (roomNames.length > 1) {
      const localRoutes = getLocalRoutes();
      for (let i = 0; i < roomNames.length - 1; i++) {
        if (!localRoutes[roomNames[i]]) localRoutes[roomNames[i]] = [];
        if (!localRoutes[roomNames[i]].includes(roomNames[i + 1])) {
          localRoutes[roomNames[i]].push(roomNames[i + 1]);
        }
      }
      savePipelineRoutes(localRoutes);
      // Deferred: sync to server after bots are created
      pendingRouteSync = roomNames;
    }
  }

  appendCreateMsg('user', queue.length > 1 ? `Create pipeline: ${labels.join(' → ')}` : queue[0].desc);
  pipelineQueue = [];
  $('#bot-create-input').value = prompt;
  $('#bot-create-form').requestSubmit();
}

$('#create-bot-btn').addEventListener('click', () => {
  selectedBotJid = null;
  createChatMessages = [];
  renderBots();

  $('#bot-edit-view').hidden = true;
  $('#bot-create-view').hidden = false;
  $('#bot-create-messages').innerHTML = '';
  $('#bot-create-input').disabled = false;

  appendCreateMsg('system', 'What kind of bot would you like to create?');

  // Render tag filters + suggestion chips
  activeBotTag = 'all';
  const filterWrap = document.createElement('div');
  filterWrap.className = 'create-tag-filters';
  for (const [tag, label] of Object.entries(BOT_TAG_LABELS)) {
    const btn = document.createElement('button');
    btn.className = 'create-tag-btn' + (tag === 'all' ? ' active' : '');
    btn.dataset.tag = tag;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      activeBotTag = tag;
      filterWrap.querySelectorAll('.create-tag-btn').forEach(b => b.classList.toggle('active', b.dataset.tag === tag));
      renderBotChips(chipsWrap);
    });
    filterWrap.appendChild(btn);
  }
  $('#bot-create-messages').appendChild(filterWrap);

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'create-chips';
  renderBotChips(chipsWrap);
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
        // Sync pending pipeline routes to server now that bots exist
        if (pendingRouteSync && pendingRouteSync.length > 1) {
          for (let i = 0; i < pendingRouteSync.length - 1; i++) {
            authFetch('/api/routes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source: pendingRouteSync[i], targets: [pendingRouteSync[i + 1]] }),
            }).catch(() => {});
          }
          pendingRouteSync = null;
        }
        // Refresh rooms
        try {
          await fetchRoutes();
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
  } else if (msg.event === 'done') {
    const bubble = $('#messages .thinking-bubble');
    if (bubble) bubble.remove();
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
