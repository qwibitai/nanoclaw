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
    /* ── Inline mic button ── */
    #mic { background: none; border: 2px solid #5B15EA; border-radius: 50%; width: 42px; height: 42px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background .15s; padding: 0; }
    #mic:hover { background: rgba(91,21,234,.1); }
    #mic.listening { background: #5B15EA; border-color: #5B15EA; animation: pulse 1.2s ease-in-out infinite; }
    #mic.listening svg { fill: white; }
    /* ── Header voice-mode button ── */
    #vm-toggle { margin-left: auto; background: rgba(255,255,255,.2); border: none; border-radius: 20px; color: #fff; padding: 6px 14px; font-size: .85rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: background .15s; }
    #vm-toggle:hover { background: rgba(255,255,255,.35); }
    #vm-toggle.active { background: #22c55e; }
    /* ── Voice mode overlay ── */
    #vm-overlay { display: none; position: fixed; inset: 0; background: linear-gradient(160deg,#1a0a3e 0%,#0d0520 100%); z-index: 100; flex-direction: column; align-items: center; justify-content: center; gap: 32px; }
    #vm-overlay.show { display: flex; }
    #vm-avatar-wrap { position: relative; display: flex; align-items: center; justify-content: center; width: 160px; height: 160px; }
    #vm-ring1, #vm-ring2, #vm-ring3 { position: absolute; border-radius: 50%; border: 2px solid rgba(91,21,234,.5); animation: vmRing 2.4s ease-out infinite; }
    #vm-ring1 { width: 100%; height: 100%; }
    #vm-ring2 { width: 100%; height: 100%; animation-delay: .8s; }
    #vm-ring3 { width: 100%; height: 100%; animation-delay: 1.6s; }
    @keyframes vmRing { 0% { transform: scale(.6); opacity:.8; } 100% { transform: scale(1.6); opacity:0; } }
    #vm-avatar { width: 110px; height: 110px; background: #5B15EA; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 40px rgba(91,21,234,.6); transition: box-shadow .3s; z-index: 1; }
    #vm-avatar.speaking { box-shadow: 0 0 60px rgba(91,21,234,.9), 0 0 0 4px #5B15EA; animation: vmSpeak .5s ease-in-out infinite alternate; }
    #vm-avatar.listening { box-shadow: 0 0 40px rgba(34,197,94,.6); }
    @keyframes vmSpeak { from { transform: scale(1); } to { transform: scale(1.04); } }
    #vm-status { color: rgba(255,255,255,.8); font-size: 1rem; font-weight: 500; letter-spacing: .05em; text-transform: uppercase; min-height: 24px; }
    #vm-transcript { color: rgba(255,255,255,.5); font-size: .9rem; font-style: italic; max-width: 340px; text-align: center; min-height: 20px; }
    #vm-hangup { background: #ef4444; border: none; border-radius: 50%; width: 64px; height: 64px; cursor: pointer; display: flex; align-items: center; justify-content: center; margin-top: 8px; box-shadow: 0 4px 20px rgba(239,68,68,.4); transition: transform .1s, box-shadow .1s; }
    #vm-hangup:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(239,68,68,.6); }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(91,21,234,.45); } 60% { box-shadow: 0 0 0 9px rgba(91,21,234,0); } }
  </style>
</head>
<body>
  <header>
    ${logoSvg} ${assistantName}
    <button id="vm-toggle" onclick="toggleVoiceMode()" title="Mode vocal avancé">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 18.93V22h2v-2.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/></svg>
      Voice
    </button>
  </header>

  <!-- Advanced Voice Mode overlay -->
  <div id="vm-overlay">
    <div id="vm-avatar-wrap">
      <div id="vm-ring1"></div><div id="vm-ring2"></div><div id="vm-ring3"></div>
      <div id="vm-avatar">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 40" width="64" height="46">
          <rect x="0" y="11" width="7" height="16" rx="3" fill="white"/>
          <rect x="49" y="11" width="7" height="16" rx="3" fill="white"/>
          <rect x="8" y="2" width="40" height="36" rx="9" fill="white"/>
          <circle cx="21" cy="15" r="6" fill="#5B15EA"/>
          <circle cx="35" cy="15" r="6" fill="#5B15EA"/>
          <rect x="17" y="27" width="22" height="5" rx="2.5" fill="#5B15EA"/>
        </svg>
      </div>
    </div>
    <div id="vm-status">Prêt</div>
    <div id="vm-transcript"></div>
    <button id="vm-hangup" onclick="exitVoiceMode()" title="Raccrocher">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C11 21 3 13 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
    </button>
  </div>

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
    const vmOverlay = document.getElementById('vm-overlay');
    const vmAvatar = document.getElementById('vm-avatar');
    const vmStatus = document.getElementById('vm-status');
    const vmTranscript = document.getElementById('vm-transcript');
    const vmToggle = document.getElementById('vm-toggle');

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
      if (!voiceMode) input.focus();
    }

    // ─────────────────────────────────────────────────────────
    // INLINE MIC (basic voice-to-text, text mode only)
    // ─────────────────────────────────────────────────────────
    let recognition = null;
    let isListening = false;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    function toggleMic() {
      if (!SpeechRecognition) { alert('Saisie vocale non supportée. Utilisez Chrome ou Edge.'); return; }
      if (isListening) { recognition.stop(); return; }
      startRecognition(false);
    }

    function startRecognition(vmMode) {
      if (!SpeechRecognition) return;
      recognition = new SpeechRecognition();
      recognition.lang = navigator.language || 'fr-FR';
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => {
        isListening = true;
        if (!vmMode) { micBtn.classList.add('listening'); micBtn.title = 'Écoute… (cliquer pour arrêter)'; }
        else { vmAvatar.classList.add('listening'); vmStatus.textContent = 'Écoute…'; vmTranscript.textContent = ''; }
        input.placeholder = '🎙 Écoute en cours…';
      };

      recognition.onresult = (e) => {
        const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
        input.value = transcript;
        if (vmMode) vmTranscript.textContent = transcript;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      };

      recognition.onend = () => {
        isListening = false;
        if (!vmMode) {
          micBtn.classList.remove('listening');
          micBtn.title = 'Saisie vocale';
          input.placeholder = 'Message ${assistantName}…';
          if (input.value.trim()) send();
        } else {
          vmAvatar.classList.remove('listening');
          input.placeholder = 'Message ${assistantName}…';
          if (input.value.trim()) {
            vmStatus.textContent = 'Réflexion…';
            vmTranscript.textContent = input.value;
            send();
          } else if (voiceMode) {
            // Nothing heard — restart listening
            setTimeout(() => { if (voiceMode) startRecognition(true); }, 600);
          }
        }
      };

      recognition.onerror = (e) => {
        if (e.error !== 'aborted' && e.error !== 'no-speech') console.warn('Speech error:', e.error);
        isListening = false;
        vmAvatar.classList.remove('listening');
        if (!vmMode) { micBtn.classList.remove('listening'); micBtn.title = 'Saisie vocale'; }
        input.placeholder = 'Message ${assistantName}…';
        if (vmMode && voiceMode) setTimeout(() => { if (voiceMode) startRecognition(true); }, 800);
      };

      recognition.start();
    }

    // ─────────────────────────────────────────────────────────
    // ADVANCED VOICE MODE (listen → send → speak → listen)
    // ─────────────────────────────────────────────────────────
    let voiceMode = false;
    let currentUtterance = null;

    function stripMarkdown(text) {
      return text
        .replace(/\`\`\`[\s\S]*?\`\`\`/g, '.')
        .replace(/\`[^\`]+\`/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/^[-*+]\s/gm, '')
        .replace(/\n{2,}/g, '. ')
        .trim();
    }

    function getBestVoice() {
      const voices = speechSynthesis.getVoices();
      const lang = navigator.language || 'fr-FR';
      const prefix = lang.split('-')[0];
      return voices.find(v => v.lang === lang && v.localService)
          || voices.find(v => v.lang.startsWith(prefix) && v.localService)
          || voices.find(v => v.lang.startsWith(prefix))
          || voices[0];
    }

    function speakText(text, onDone) {
      speechSynthesis.cancel();
      const clean = stripMarkdown(text);
      if (!clean) { onDone?.(); return; }

      // Split into sentences for more natural delivery
      const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
      let i = 0;

      function speakNext() {
        if (i >= sentences.length || !voiceMode) { onDone?.(); return; }
        const utt = new SpeechSynthesisUtterance(sentences[i++].trim());
        utt.voice = getBestVoice();
        utt.lang = navigator.language || 'fr-FR';
        utt.rate = 1.05;
        utt.pitch = 1;
        utt.onend = speakNext;
        utt.onerror = () => onDone?.();
        currentUtterance = utt;
        speechSynthesis.speak(utt);
      }
      speakNext();
    }

    function toggleVoiceMode() {
      if (voiceMode) exitVoiceMode(); else enterVoiceMode();
    }

    function enterVoiceMode() {
      if (!SpeechRecognition) { alert('Mode vocal non supporté. Utilisez Chrome ou Edge.'); return; }
      voiceMode = true;
      vmToggle.classList.add('active');
      vmToggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C11 21 3 13 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg> Fin';
      vmOverlay.classList.add('show');
      // Pre-load voices
      speechSynthesis.getVoices();
      setTimeout(() => { if (voiceMode) startRecognition(true); }, 400);
    }

    function exitVoiceMode() {
      voiceMode = false;
      vmToggle.classList.remove('active');
      vmToggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm-1 18.93V22h2v-2.07A8 8 0 0 0 20 12h-2a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.93z"/></svg> Voice';
      recognition?.stop();
      speechSynthesis.cancel();
      vmOverlay.classList.remove('show');
      vmAvatar.classList.remove('speaking', 'listening');
      vmStatus.textContent = 'Prêt';
      vmTranscript.textContent = '';
      input.focus();
    }

    // ─────────────────────────────────────────────────────────
    // SSE connection
    // ─────────────────────────────────────────────────────────
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'message') {
        typing.style.display = 'none';
        appendMsg(data.text, data.sender, false);
        if (voiceMode) {
          vmAvatar.classList.remove('listening');
          vmAvatar.classList.add('speaking');
          vmStatus.textContent = 'Répond…';
          vmTranscript.textContent = '';
          speakText(data.text, () => {
            vmAvatar.classList.remove('speaking');
            if (voiceMode) {
              vmStatus.textContent = 'Écoute…';
              setTimeout(() => { if (voiceMode) startRecognition(true); }, 300);
            }
          });
        }
      } else if (data.type === 'typing') {
        typing.style.display = data.isTyping ? 'block' : 'none';
        if (data.isTyping) {
          messages.scrollTop = messages.scrollHeight;
          if (voiceMode) { vmStatus.textContent = 'Réflexion…'; vmTranscript.textContent = ''; }
        }
      }
    };
    es.onerror = () => console.warn('SSE reconnecting…');

    input.focus();
  </script>
</body>
</html>`;
}

registerChannel('web', (opts: ChannelOpts) => new WebChannel(opts));
