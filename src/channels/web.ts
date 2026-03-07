/**
 * Web Chat Channel for NanoClaw
 * Serves a browser chat UI at WEB_CHAT_BIND:WEB_CHAT_PORT
 * Set WEB_CHAT_PASSWORD for basic-auth protection when exposed to the network.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { ASSISTANT_NAME, WEB_CHAT_BIND, WEB_CHAT_NAME, WEB_CHAT_PASSWORD, WEB_CHAT_PORT, WEB_CHAT_USER } from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

export const WEB_JID = 'web@web.local';

export class WebChannel implements Channel {
  name = 'web';
  private server: http.Server | null = null;
  private connected = false;
  private sseClients = new Map<string, http.ServerResponse>();
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.server = http.createServer(this.handleRequest.bind(this));

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error({ port: WEB_CHAT_PORT }, 'Web chat port already in use — skipping web channel');
      } else {
        logger.error({ err }, 'Web chat server error');
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(WEB_CHAT_PORT, WEB_CHAT_BIND, () => {
        this.connected = true;
        const authNote = WEB_CHAT_PASSWORD ? ' (basic auth enabled)' : '';
        logger.info({ port: WEB_CHAT_PORT, bind: WEB_CHAT_BIND }, `Web chat available at http://${WEB_CHAT_BIND}:${WEB_CHAT_PORT}${authNote}`);
        resolve();
      });
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    const data = JSON.stringify({ type: 'message', sender: ASSISTANT_NAME, text, ts: new Date().toISOString() });
    for (const res of this.sseClients.values()) {
      res.write(`data: ${data}\n\n`);
    }
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    const data = JSON.stringify({ type: 'typing', isTyping });
    for (const res of this.sseClients.values()) {
      res.write(`data: ${data}\n\n`);
    }
  }

  isConnected(): boolean { return this.connected; }

  ownsJid(jid: string): boolean { return jid === WEB_JID; }

  async disconnect(): Promise<void> {
    for (const res of this.sseClients.values()) res.end();
    this.sseClients.clear();
    if (this.server) {
      this.server.closeAllConnections?.();
      this.server.close();
    }
    this.connected = false;
  }

  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!WEB_CHAT_PASSWORD) return true;
    const auth = req.headers['authorization'] ?? '';
    const expected = 'Basic ' + Buffer.from(`${WEB_CHAT_USER}:${WEB_CHAT_PASSWORD}`).toString('base64');
    if (auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DMY-Bot"' }).end('Unauthorized');
      return false;
    }
    return true;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.checkAuth(req, res)) return;
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);

    if (req.method === 'GET' && url.pathname === '/events') {
      this.handleSSE(req, res);
    } else if (req.method === 'POST' && url.pathname === '/send') {
      this.handlePost(req, res);
    } else if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildUiHtml(WEB_CHAT_NAME, WEB_CHAT_PORT));
    } else {
      res.writeHead(404).end();
    }
  }

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const clientId = randomUUID();
    this.sseClients.set(clientId, res);
    logger.debug({ clientId }, 'Web chat SSE client connected');

    // Keep-alive heartbeat
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(clientId);
    });
  }

  private handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body) as { text: string };
        if (!text?.trim()) { res.writeHead(400).end('Missing text'); return; }

        const now = new Date().toISOString();
        this.opts.onChatMetadata(WEB_JID, now, 'Web Chat', 'web', false);
        this.opts.onMessage(WEB_JID, {
          id: randomUUID(),
          chat_jid: WEB_JID,
          sender: 'user@web.local',
          sender_name: 'You',
          content: text.trim(),
          timestamp: now,
          is_from_me: false,
          is_bot_message: false,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400).end('Bad JSON');
      }
    });
  }
}

function buildUiHtml(assistantName: string, port: number): string {
  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 40" width="38" height="27" aria-hidden="true">
    <rect x="0" y="11" width="7" height="16" rx="3" fill="white"/>
    <rect x="49" y="11" width="7" height="16" rx="3" fill="white"/>
    <rect x="8" y="2" width="40" height="36" rx="9" fill="white"/>
    <circle cx="21" cy="15" r="6" fill="#5B15EA"/>
    <circle cx="35" cy="15" r="6" fill="#5B15EA"/>
    <rect x="17" y="27" width="22" height="5" rx="2.5" fill="#5B15EA"/>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${assistantName}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0eeff; height: 100dvh; display: flex; flex-direction: column; }
    header { background: #5B15EA; color: #fff; padding: 14px 20px; font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 8px rgba(91,21,234,.3); }
    #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 80%; padding: 10px 14px; border-radius: 18px; line-height: 1.5; word-break: break-word; }
    .msg.user { align-self: flex-end; background: #5B15EA; color: #fff; border-bottom-right-radius: 4px; }
    .msg.assistant { align-self: flex-start; background: #fff; color: #222; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .msg.assistant p { margin: 0 0 8px; } .msg.assistant p:last-child { margin: 0; }
    .msg.assistant pre { background: #f0f0f0; padding: 8px; border-radius: 6px; overflow-x: auto; font-size: .85rem; margin: 6px 0; }
    .msg.assistant code { font-family: monospace; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
    .msg.assistant ul, .msg.assistant ol { padding-left: 20px; margin: 4px 0; }
    .typing { align-self: flex-start; background: #fff; color: #888; padding: 10px 14px; border-radius: 18px; border-bottom-left-radius: 4px; font-style: italic; box-shadow: 0 1px 3px rgba(0,0,0,.1); display: none; }
    #form { padding: 14px; background: #fff; border-top: 1px solid #e0e0e0; display: flex; gap: 10px; }
    #input { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 22px; font-size: 1rem; outline: none; resize: none; max-height: 120px; font-family: inherit; }
    #input:focus { border-color: #5B15EA; box-shadow: 0 0 0 2px rgba(91,21,234,.15); }
    #send { background: #5B15EA; color: #fff; border: none; border-radius: 22px; padding: 10px 20px; font-size: 1rem; cursor: pointer; white-space: nowrap; }
    #send:hover { background: #4a10c5; }
    #send:disabled { opacity: .5; cursor: default; }
    #mic { background: none; border: 2px solid #5B15EA; border-radius: 50%; width: 42px; height: 42px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background .15s; padding: 0; }
    #mic:hover { background: rgba(91,21,234,.1); }
    #mic.listening { background: #5B15EA; border-color: #5B15EA; animation: pulse 1.2s ease-in-out infinite; }
    #mic.listening svg { fill: white; }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(91,21,234,.45); } 60% { box-shadow: 0 0 0 9px rgba(91,21,234,0); } }
  </style>
</head>
<body>
  <header>${logoSvg} ${assistantName}</header>
  <div id="messages"></div>
  <div class="typing" id="typing">${assistantName} is thinking…</div>
  <div id="form">
    <button id="mic" onclick="toggleMic()" title="Saisie vocale">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="#5B15EA" xmlns="http://www.w3.org/2000/svg">
        <rect x="9" y="2" width="6" height="12" rx="3"/>
        <path d="M5 11a7 7 0 0 0 14 0" stroke="#5B15EA" stroke-width="2" fill="none" stroke-linecap="round"/>
        <line x1="12" y1="18" x2="12" y2="22" stroke="#5B15EA" stroke-width="2" stroke-linecap="round"/>
        <line x1="8" y1="22" x2="16" y2="22" stroke="#5B15EA" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>
    <textarea id="input" rows="1" placeholder="Message ${assistantName}…"></textarea>
    <button id="send" onclick="send()">Send</button>
  </div>
  <script>
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const micBtn = document.getElementById('mic');
    const typing = document.getElementById('typing');

    // Resize textarea automatically
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    function appendMsg(text, sender, isUser) {
      const div = document.createElement('div');
      div.className = 'msg ' + (isUser ? 'user' : 'assistant');
      if (isUser) {
        div.textContent = text;
      } else {
        try { div.innerHTML = typeof marked !== 'undefined' ? marked.parse(text) : text; }
        catch { div.textContent = text; }
      }
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;
      appendMsg(text, 'You', true);
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
      try {
        await fetch('/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
      } catch (e) { appendMsg('Failed to send message.', '${assistantName}', false); }
      sendBtn.disabled = false;
      input.focus();
    }

    // Voice input
    let recognition = null;
    let isListening = false;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    function toggleMic() {
      if (!SpeechRecognition) {
        alert('Saisie vocale non supportée. Utilisez Chrome ou Edge.');
        return;
      }
      if (isListening) { recognition.stop(); return; }

      recognition = new SpeechRecognition();
      recognition.lang = navigator.language || 'fr-FR';
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => {
        isListening = true;
        micBtn.classList.add('listening');
        micBtn.title = 'Écoute… (cliquer pour arrêter)';
        input.placeholder = '🎙 Écoute en cours…';
      };

      recognition.onresult = (e) => {
        const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
        input.value = transcript;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      };

      recognition.onend = () => {
        isListening = false;
        micBtn.classList.remove('listening');
        micBtn.title = 'Saisie vocale';
        input.placeholder = 'Message ${assistantName}…';
        if (input.value.trim()) send();
      };

      recognition.onerror = (e) => {
        if (e.error !== 'aborted') console.warn('Speech error:', e.error);
        isListening = false;
        micBtn.classList.remove('listening');
        micBtn.title = 'Saisie vocale';
        input.placeholder = 'Message ${assistantName}…';
      };

      recognition.start();
    }

    // SSE connection
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'message') {
        typing.style.display = 'none';
        appendMsg(data.text, data.sender, false);
      } else if (data.type === 'typing') {
        typing.style.display = data.isTyping ? 'block' : 'none';
        if (data.isTyping) messages.scrollTop = messages.scrollHeight;
      }
    };
    es.onerror = () => console.warn('SSE reconnecting…');

    input.focus();
  </script>
</body>
</html>`;
}

registerChannel('web', (opts: ChannelOpts) => new WebChannel(opts));
