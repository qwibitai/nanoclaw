import fs from 'fs';
import http from 'http';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import {
  DisplayMessage,
  getAllRegisteredGroups,
  getMessagesForDisplay,
  setRegisteredGroup,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const WEB_JID = 'web:main';
const POLL_MS = 2000;
const HISTORY_LIMIT = 100;

export class WebChannel implements Channel {
  name = 'web';
  private server: http.Server | null = null;
  private sseClients = new Set<http.ServerResponse>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastPollAt: string;

  constructor(
    private port: number,
    private token: string | null,
    private opts: ChannelOpts,
  ) {
    this.lastPollAt = new Date().toISOString();
  }

  async connect(): Promise<void> {
    this.ensureGroupRegistered();
    this.ensureSymlink();

    this.server = http.createServer((req, res) => {
      if (!this.checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', `http://localhost`);

      if (req.method === 'GET' && url.pathname === '/') {
        this.serveUI(res);
      } else if (req.method === 'GET' && url.pathname === '/manifest.json') {
        this.serveManifest(res);
      } else if (req.method === 'GET' && url.pathname === '/history') {
        this.serveHistory(req, res);
      } else if (req.method === 'GET' && url.pathname === '/events') {
        this.handleSSE(req, res);
      } else if (req.method === 'POST' && url.pathname === '/send') {
        this.handleSend(req, res);
      } else {
        res.writeHead(404).end('Not found');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port }, 'Web channel listening');
        resolve();
      });
      this.server!.once('error', reject);
    });

    this.pollTimer = setInterval(() => this.pollMessages(), POLL_MS);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    logger.info('Web channel stopped');
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // Web messages are injected into the main channel's JID, so the owning
    // channel (e.g. WhatsApp) handles sending and storage. Nothing to do here.
  }

  isConnected(): boolean {
    return this.server?.listening ?? false;
  }

  ownsJid(jid: string): boolean {
    return jid === WEB_JID;
  }

  // --- Private ---

  private allJidsForTarget(): string[] {
    const targetFolder = this.targetFolder();
    const groups = getAllRegisteredGroups();
    const jids = Object.entries(groups)
      .filter(([, g]) => g.folder === targetFolder)
      .map(([jid]) => jid);
    // Always include web:main (may not be registered yet on first call)
    if (!jids.includes(WEB_JID)) jids.push(WEB_JID);
    return jids;
  }

  private targetFolder(): string {
    const groups = this.opts.registeredGroups();
    const main = Object.values(groups).find(
      (g) => g.isMain && g.folder !== 'web',
    );
    return main?.folder ?? 'main';
  }

  // The real channel JID to route messages through (e.g. the WhatsApp main JID).
  // Web messages injected here so the owning channel (WhatsApp) handles delivery,
  // making the response appear in both WhatsApp and web history.
  private targetJid(): string {
    const groups = this.opts.registeredGroups();
    const entry = Object.entries(groups).find(
      ([jid, g]) => g.isMain && jid !== WEB_JID,
    );
    return entry?.[0] ?? WEB_JID;
  }

  private pollMessages(): void {
    const since = this.lastPollAt;
    this.lastPollAt = new Date().toISOString();
    const jids = this.allJidsForTarget();
    const msgs = getMessagesForDisplay(jids, since);
    for (const msg of msgs) {
      this.pushSSE(msg);
    }
  }

  private pushSSE(msg: DisplayMessage): void {
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of [...this.sseClients]) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private checkAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    if (!this.token) return true;
    const url = new URL(req.url ?? '/', `http://localhost`);
    const queryToken = url.searchParams.get('token');
    const authHeader = req.headers['authorization'] ?? '';
    const cookie = this.parseCookie(req.headers['cookie'] ?? '');
    if (
      queryToken === this.token ||
      authHeader === `Bearer ${this.token}` ||
      cookie['nc_token'] === this.token
    ) {
      return true;
    }
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
    return false;
  }

  private parseCookie(header: string): Record<string, string> {
    return Object.fromEntries(
      header
        .split(';')
        .map((p) => p.trim().split('='))
        .filter((p) => p.length === 2)
        .map(([k, v]) => [k.trim(), v.trim()]),
    );
  }

  private serveUI(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(this.token
        ? {
            'Set-Cookie': `nc_token=${this.token}; Path=/; HttpOnly; SameSite=Strict`,
          }
        : {}),
    });
    res.end(buildUI(ASSISTANT_NAME));
  }

  private serveManifest(res: http.ServerResponse): void {
    const manifest = {
      name: ASSISTANT_NAME,
      short_name: ASSISTANT_NAME,
      start_url: '/',
      display: 'standalone',
      background_color: '#0f172a',
      theme_color: '#0f172a',
      icons: [],
    };
    res
      .writeHead(200, { 'Content-Type': 'application/manifest+json' })
      .end(JSON.stringify(manifest));
  }

  private serveHistory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const since = url.searchParams.get('since') ?? new Date(0).toISOString();
    const limit = since === new Date(0).toISOString() ? HISTORY_LIMIT : 50;
    const jids = this.allJidsForTarget();
    const msgs = getMessagesForDisplay(jids, since, limit);
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(msgs));
  }

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n');
    this.sseClients.add(res);
    req.on('close', () => this.sseClients.delete(res));
    req.on('error', () => this.sseClients.delete(res));
  }

  private handleSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body) as { text?: string };
        if (!text?.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: 'text required' }));
          return;
        }

        const timestamp = new Date().toISOString();
        const msgId = `web-${Date.now()}`;
        const routeJid = this.targetJid();

        this.opts.onChatMetadata(routeJid, timestamp, 'Web', 'web', false);
        this.opts.onMessage(routeJid, {
          id: msgId,
          chat_jid: routeJid,
          sender: 'web',
          sender_name: 'You',
          content: text,
          timestamp,
          is_from_me: false,
        });

        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: true, id: msgId }));

        logger.info({ length: text.length }, 'Web channel: message received');
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private ensureGroupRegistered(): void {
    const groups = this.opts.registeredGroups();
    if (groups[WEB_JID]) return;

    const newGroup: RegisteredGroup = {
      name: 'Web',
      folder: 'web',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
    };

    try {
      setRegisteredGroup(WEB_JID, newGroup);
      groups[WEB_JID] = newGroup;
      logger.info('Web group auto-registered');
    } catch (err) {
      logger.error({ err }, 'Web channel: failed to auto-register group');
    }
  }

  private ensureSymlink(): void {
    const webDir = path.join(GROUPS_DIR, 'web');
    const targetFolder = this.targetFolder();
    const targetDir = path.join(GROUPS_DIR, targetFolder);

    try {
      const stat = fs.lstatSync(webDir);
      if (stat.isSymbolicLink()) return;
      logger.debug(
        { webDir },
        'Web groups/web dir already exists as a directory — leaving it',
      );
      return;
    } catch {
      // Does not exist — create symlink
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    try {
      fs.symlinkSync(targetDir, webDir);
      logger.info(
        { target: targetDir },
        'Web channel: created groups/web symlink',
      );
    } catch (err) {
      logger.error({ err }, 'Web channel: failed to create groups/web symlink');
    }
  }
}

function buildUI(assistantName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${assistantName}">
<link rel="manifest" href="/manifest.json">
<title>${assistantName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f172a;--surface:#1e293b;--user:#2563eb;--bot:#1e293b;--text:#f1f5f9;--muted:#64748b;--border:#334155}
html,body{height:100dvh;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#app{display:flex;flex-direction:column;height:100dvh;max-width:680px;margin:0 auto}
#hdr{padding:12px max(16px,env(safe-area-inset-right)) 12px max(16px,env(safe-area-inset-left));background:var(--surface);border-bottom:1px solid var(--border);font-weight:600;display:flex;align-items:center;gap:8px}
#dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0;transition:background .3s}
#dot.off{background:var(--muted)}
#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.m{max-width:82%;display:flex;flex-direction:column;gap:3px}
.m.u{align-self:flex-end;align-items:flex-end}
.m.a{align-self:flex-start;align-items:flex-start}
.b{padding:10px 14px;border-radius:18px;word-break:break-word;line-height:1.5}
.m.u .b{background:var(--user);border-bottom-right-radius:4px}
.m.a .b{background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:4px}
.ts{font-size:11px;color:var(--muted);padding:0 4px}
.b pre{background:#0f172a;border:1px solid var(--border);border-radius:6px;padding:10px;overflow-x:auto;margin:8px 0;font-size:13px}
.b code{font-family:'SF Mono','Fira Code',monospace;font-size:13px;background:#0f172a;padding:1px 4px;border-radius:4px}
.b pre code{background:none;padding:0}
.b p{margin:4px 0}.b p:first-child{margin-top:0}.b p:last-child{margin-bottom:0}
.b ul,.b ol{padding-left:20px;margin:4px 0}
.b strong{font-weight:600}
#ftr{padding:12px max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:var(--surface);border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end}
#inp{flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:20px;padding:10px 16px;font-size:15px;resize:none;min-height:42px;max-height:160px;outline:none;line-height:1.4;font-family:inherit}
#inp:focus{border-color:var(--user)}
#btn{width:42px;height:42px;border-radius:50%;background:var(--user);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;transition:opacity .15s}
#btn.dim{opacity:.35}
</style>
</head>
<body>
<div id="app">
  <div id="hdr"><div id="dot" class="off"></div>${assistantName}</div>
  <div id="msgs"></div>
  <form id="frm"><div id="ftr"><textarea id="inp" placeholder="Message…" rows="1"></textarea><button type="submit" id="btn" class="dim">↑</button></div></form>
</div>
<script>
// Minimal markdown renderer — no external dependencies
// Uses \\x60 (hex for backtick) in regexes to avoid template-literal conflicts in the host .ts file
function md(src) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const blocks = [];
  // Code blocks: match triple-backtick fences
  src = src.replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, (_,c) => {
    blocks.push('<pre><code>'+esc(c.replace(/^[a-z]+\\n/,''))+'</code></pre>');
    return '\x01'+(blocks.length-1)+'\x01';
  });
  const inline = s => s
    .replace(/\x60([^\x60]+)\x60/g, (_,c) => '<code>'+esc(c)+'</code>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>');
  const lines = src.split('\\n');
  const out = []; let listBuf = [], listType = null;
  const flushList = () => { if(listBuf.length){out.push('<'+listType+'>'+listBuf.map(x=>'<li>'+x+'</li>').join('')+'</'+listType+'>'); listBuf=[]; listType=null;} };
  for (const raw of lines) {
    const bm = raw.match(/^([-*\u2022]) (.+)/); const om = raw.match(/^\d+\. (.+)/);
    if (bm) { if(listType&&listType!=='ul') flushList(); listType='ul'; listBuf.push(inline(bm[2])); continue; }
    if (om) { if(listType&&listType!=='ol') flushList(); listType='ol'; listBuf.push(inline(om[1])); continue; }
    flushList();
    const t = raw.trim();
    if (!t) { out.push(''); continue; }
    if (/^#{1,3} /.test(t)) { const [,...rest]=t.split(' '); out.push('<strong>'+inline(rest.join(' '))+'</strong>'); continue; }
    out.push(inline(t));
  }
  flushList();
  let html = out.join('\\n').replace(/\x01(\d+)\x01/g, (_,i)=>blocks[+i]);
  html = html.replace(/([^\\n<][^\\n]+)/g, s => s.startsWith('<') ? s : '<p>'+s+'</p>');
  return html.replace(/\\n/g,'');
}

const msgs = document.getElementById('msgs');
const inp = document.getElementById('inp');
const btn = document.getElementById('btn');
const dot = document.getElementById('dot');
const seen = new Set();

function fmt(ts){ try { return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); } catch(e){ return ''; } }

function addMsg(isBot, content, ts, id) {
  if(id && seen.has(id)) return; if(id) seen.add(id);
  const wrap = document.createElement('div'); wrap.className = 'm '+(isBot?'a':'u');
  const b = document.createElement('div'); b.className = 'b';
  if(isBot) { try { b.innerHTML = md(content||''); } catch(e) { b.textContent = content||''; } } else b.textContent = content||'';
  const t = document.createElement('div'); t.className = 'ts'; t.textContent = fmt(ts);
  wrap.appendChild(b); wrap.appendChild(t); msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
}

// Load history then poll for new messages every 2s
let lastTs = '1970-01-01T00:00:00.000Z';

function poll() {
  fetch('/history?since='+encodeURIComponent(lastTs))
    .then(r => { dot.classList.toggle('off', !r.ok); return r.json(); })
    .then(ms => {
      for(const m of ms) {
        if(m.timestamp > lastTs) lastTs = m.timestamp;
        try { addMsg(!!m.is_bot_message, m.content, m.timestamp, m.id); } catch(e) {}
      }
    })
    .catch(() => dot.classList.add('off'));
}

poll();
setInterval(poll, 2000);

// Input auto-resize and button state
function updateBtn(){ btn.classList.toggle('dim', !inp.value.trim()); }
inp.addEventListener('input', () => { inp.style.height='auto'; inp.style.height=Math.min(inp.scrollHeight,160)+'px'; updateBtn(); });
inp.addEventListener('keyup', updateBtn);
inp.addEventListener('change', updateBtn);
inp.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} });
document.getElementById('frm').addEventListener('submit', e => { e.preventDefault(); send(); });

function send() {
  const text=inp.value.trim(); if(!text) return;
  inp.value=''; inp.style.height='auto'; btn.classList.add('dim');
  fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}).catch(()=>{});
}
</script>
</body>
</html>`;
}

registerChannel('web', (opts: ChannelOpts) => {
  const env = readEnvFile(['WEB_CHANNEL_PORT', 'WEB_CHANNEL_TOKEN']);
  const port = parseInt(
    process.env.WEB_CHANNEL_PORT || env.WEB_CHANNEL_PORT || '3080',
    10,
  );
  const token = process.env.WEB_CHANNEL_TOKEN || env.WEB_CHANNEL_TOKEN || null;
  return new WebChannel(port, token, opts);
});
