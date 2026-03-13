/**
 * Snak Group Chat Widget — NanoClaw Edition
 * Connects directly to Andy via Socket.IO.
 *
 * Usage: <script src="https://chat.sheridantrailerrentals.us/widget/snakgroup-chat-widget.js"></script>
 */
(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────
  var SCRIPT = document.currentScript;
  var SERVER_URL = (SCRIPT && SCRIPT.getAttribute('data-server')) || 'https://chat.sheridantrailerrentals.us';

  var TITLE = 'Chat with Snak Group';
  var GREETING =
    "Hey there! I'm Andy from Snak Group. How can I help you today?";

  // Visitor ID for session persistence
  var VISITOR_ID = null;
  try {
    VISITOR_ID = sessionStorage.getItem('snak_visitor_id');
  } catch (e) {}

  // ── Load Socket.IO client ─────────────────────────────────────
  function loadSocketIO(callback) {
    if (window.io) return callback();
    var script = document.createElement('script');
    script.src = SERVER_URL + '/socket.io/socket.io.js';
    script.onload = callback;
    script.onerror = function () {
      console.error('[SnakChat] Failed to load Socket.IO');
    };
    document.head.appendChild(script);
  }

  // ── Load CSS ──────────────────────────────────────────────────
  function loadCSS() {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = SERVER_URL + '/widget/snakgroup-chat-widget.css';
    document.head.appendChild(link);
  }

  // ── Build UI ──────────────────────────────────────────────────
  function buildWidget() {
    var container = document.createElement('div');
    container.id = 'snak-chat-widget';
    container.innerHTML =
      '<div id="snak-chat-bubble" aria-label="Open chat">' +
        '<svg viewBox="0 0 24 24" width="28" height="28" fill="white">' +
          '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>' +
        '</svg>' +
      '</div>' +
      '<div id="snak-chat-window" class="snak-hidden">' +
        '<div id="snak-chat-header">' +
          '<div id="snak-chat-header-info">' +
            '<div id="snak-chat-header-title">' + TITLE + '</div>' +
            '<div id="snak-chat-header-status">Online</div>' +
          '</div>' +
          '<button id="snak-chat-close" aria-label="Close chat">&times;</button>' +
        '</div>' +
        '<div id="snak-chat-messages">' +
          '<div class="snak-typing" id="snak-typing">' +
            '<span class="snak-dot"></span>' +
            '<span class="snak-dot"></span>' +
            '<span class="snak-dot"></span>' +
          '</div>' +
        '</div>' +
        '<div id="snak-chat-input-area">' +
          '<input id="snak-chat-input" type="text" placeholder="Type a message..." autocomplete="off" />' +
          '<button id="snak-chat-send" aria-label="Send message">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(container);
    return container;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ── Main Init ─────────────────────────────────────────────────
  function init() {
    loadCSS();

    buildWidget();

    var bubble = document.getElementById('snak-chat-bubble');
    var chatWindow = document.getElementById('snak-chat-window');
    var closeBtn = document.getElementById('snak-chat-close');
    var messagesEl = document.getElementById('snak-chat-messages');
    var inputEl = document.getElementById('snak-chat-input');
    var sendBtn = document.getElementById('snak-chat-send');
    var typingEl = document.getElementById('snak-typing');

    var socket = null;
    var isOpen = false;
    var socketInitialized = false;
    var typingTimeout = null;
    var greetingShown = false;

    // Toggle chat
    bubble.addEventListener('click', function () {
      isOpen = true;
      chatWindow.classList.remove('snak-hidden');
      bubble.classList.add('snak-hidden');
      inputEl.focus();

      if (!greetingShown) {
        greetingShown = true;
        addMessage('bot', GREETING);
      }
      if (!socketInitialized) {
        connectSocket();
      }
      scrollToBottom();
    });

    closeBtn.addEventListener('click', function () {
      isOpen = false;
      chatWindow.classList.add('snak-hidden');
      bubble.classList.remove('snak-hidden');
    });

    // Send message
    function sendMessage(text) {
      if (!text.trim() || !socket) return;
      addMessage('user', text);
      socket.emit('message', { text: text });
      inputEl.value = '';
    }

    sendBtn.addEventListener('click', function () {
      sendMessage(inputEl.value);
    });

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value);
      }
    });

    // Add message to chat
    function addMessage(sender, content) {
      var msg = document.createElement('div');
      msg.className = 'snak-msg snak-msg-' + (sender === 'user' ? 'user' : 'bot');

      // Convert newlines to <br>
      var lines = content.split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (i > 0) msg.appendChild(document.createElement('br'));
        msg.appendChild(document.createTextNode(lines[i]));
      }

      messagesEl.insertBefore(msg, typingEl);
      scrollToBottom();
    }

    function scrollToBottom() {
      setTimeout(function () {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 50);
    }

    // Connect to Socket.IO
    function connectSocket() {
      socketInitialized = true;
      loadSocketIO(function () {
        var connectOpts = {
          transports: ['websocket', 'polling'],
          query: { business: 'snak-group' },
        };

        if (VISITOR_ID) {
          connectOpts.query.sessionId = VISITOR_ID;
        }

        socket = window.io(SERVER_URL, connectOpts);

        socket.on('connect', function () {
          document.getElementById('snak-chat-header-status').textContent = 'Online';
          console.log('[SnakChat] Connected');
        });

        socket.on('session', function (data) {
          if (data && data.sessionId) {
            VISITOR_ID = data.sessionId;
            try {
              sessionStorage.setItem('snak_visitor_id', data.sessionId);
            } catch (e) {}
          }
        });

        socket.on('message', function (data) {
          // Clear typing indicator
          typingEl.classList.remove('snak-visible');
          if (typingTimeout) {
            clearTimeout(typingTimeout);
            typingTimeout = null;
          }

          addMessage('bot', data.text || data.content);
        });

        socket.on('typing', function (data) {
          var isTyping = data && data.isTyping;
          typingEl.classList.toggle('snak-visible', isTyping);
          if (isTyping) {
            scrollToBottom();
            if (typingTimeout) clearTimeout(typingTimeout);
            typingTimeout = setTimeout(function () {
              typingEl.classList.remove('snak-visible');
            }, 30000);
          }
        });

        socket.on('disconnect', function () {
          document.getElementById('snak-chat-header-status').textContent = 'Reconnecting...';
          console.log('[SnakChat] Disconnected');
        });

        socket.on('connect_error', function (err) {
          document.getElementById('snak-chat-header-status').textContent = 'Connection issue...';
          console.error('[SnakChat] Connection error:', err.message);
        });
      });
    }
  }

  // Init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
