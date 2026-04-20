import http from 'http';

import { ASSISTANT_NAME } from '../config.js';
import { getAllRegisteredGroups, getMessagesForDisplay } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const HISTORY_LIMIT = 100;

export class WebChannel implements Channel {
  name = 'web';
  private server: http.Server | null = null;

  constructor(
    private port: number,
    private token: string | null,
    private opts: ChannelOpts,
  ) {}

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (!this.checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      // GET /                        → conversation index
      // GET /c/<folder>              → chat UI
      // GET /c/<folder>/history      → history API
      // POST /c/<folder>/send        → send API
      // GET /manifest.json           → PWA manifest

      if (req.method === 'GET' && url.pathname === '/') {
        this.serveIndex(res);
      } else if (req.method === 'GET' && url.pathname === '/manifest.json') {
        this.serveManifest(res);
      } else if (parts[0] === 'c' && parts[1]) {
        const folder = parts[1];
        if (req.method === 'GET' && parts.length === 2) {
          this.serveChat(res, folder);
        } else if (req.method === 'GET' && parts[2] === 'history') {
          this.serveHistory(req, res, folder);
        } else if (req.method === 'POST' && parts[2] === 'send') {
          this.handleSend(req, res, folder);
        } else {
          res.writeHead(404).end('Not found');
        }
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
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    logger.info('Web channel stopped');
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {}

  isConnected(): boolean {
    return this.server?.listening ?? false;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  // --- Private ---

  private conversations(): Array<{ folder: string; name: string }> {
    const groups = getAllRegisteredGroups();
    return Object.entries(groups)
      .filter(([jid]) => !jid.startsWith('web:'))
      .map(([, g]) => ({ folder: g.folder, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private targetJid(folder: string): string | null {
    const groups = this.opts.registeredGroups();
    const entry = Object.entries(groups).find(
      ([jid, g]) => g.folder === folder && !jid.startsWith('web:'),
    );
    return entry?.[0] ?? null;
  }

  private jidsForFolder(folder: string): string[] {
    const groups = getAllRegisteredGroups();
    return Object.entries(groups)
      .filter(([jid, g]) => g.folder === folder && !jid.startsWith('web:'))
      .map(([jid]) => jid);
  }

  private checkAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): boolean {
    if (!this.token) return true;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cookie = this.parseCookie(req.headers['cookie'] ?? '');
    if (
      url.searchParams.get('token') === this.token ||
      (req.headers['authorization'] ?? '') === `Bearer ${this.token}` ||
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

  private cookieHeader(): Record<string, string> {
    return this.token
      ? {
          'Set-Cookie': `nc_token=${this.token}; Path=/; HttpOnly; SameSite=Strict`,
        }
      : {};
  }

  private serveIndex(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...this.cookieHeader(),
    });
    res.end(buildIndex(ASSISTANT_NAME, this.conversations()));
  }

  private serveChat(res: http.ServerResponse, folder: string): void {
    const groups = getAllRegisteredGroups();
    const entry = Object.entries(groups).find(
      ([jid, g]) => g.folder === folder && !jid.startsWith('web:'),
    );
    if (!entry) {
      res.writeHead(404).end('Conversation not found');
      return;
    }
    const [, g] = entry;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...this.cookieHeader(),
    });
    res.end(buildChat(ASSISTANT_NAME, folder, g.name));
  }

  private serveManifest(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' }).end(
      JSON.stringify({
        name: ASSISTANT_NAME,
        short_name: ASSISTANT_NAME,
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [],
      }),
    );
  }

  private serveHistory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    folder: string,
  ): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const since = url.searchParams.get('since') ?? new Date(0).toISOString();
    const limit = since === new Date(0).toISOString() ? HISTORY_LIMIT : 50;
    const jids = this.jidsForFolder(folder);
    const msgs = getMessagesForDisplay(jids, since, limit);
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(msgs));
  }

  private handleSend(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    folder: string,
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

        const routeJid = this.targetJid(folder);
        if (!routeJid) {
          res
            .writeHead(404)
            .end(JSON.stringify({ error: 'conversation not found' }));
          return;
        }

        const timestamp = new Date().toISOString();
        const msgId = `web-${Date.now()}`;

        this.opts.onChatMetadata(routeJid, timestamp, 'Web', 'web', false);
        this.opts.onMessage(routeJid, {
          id: msgId,
          chat_jid: routeJid,
          sender: 'web',
          sender_name: 'Web User',
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
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildIndex(
  assistantName: string,
  convs: Array<{ folder: string; name: string }>,
): string {
  const items = convs
    .map(
      (c) =>
        `<a href="/c/${esc(c.folder)}" class="conv"><span class="cname">${esc(c.name)}</span><span class="cfolder">${esc(c.folder)}</span></a>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json">
<title>${esc(assistantName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f172a;--surface:#1e293b;--text:#f1f5f9;--muted:#64748b;--border:#334155;--accent:#2563eb}
html,body{min-height:100dvh;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#app{max-width:480px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;font-weight:700;margin-bottom:8px}
.sub{color:var(--muted);font-size:14px;margin-bottom:28px}
.conv{display:flex;flex-direction:column;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:12px;text-decoration:none;color:var(--text);margin-bottom:10px;gap:3px;transition:border-color .15s}
.conv:hover,.conv:focus{border-color:var(--accent);outline:none}
.cname{font-weight:600}
.cfolder{font-size:12px;color:var(--muted);font-family:'SF Mono','Fira Code',monospace}
.empty{color:var(--muted);font-size:14px}
</style>
</head>
<body>
<div id="app">
  <h1>${esc(assistantName)}</h1>
  <p class="sub">Choose a conversation</p>
  ${items || '<p class="empty">No conversations registered yet.</p>'}
</div>
</body>
</html>`;
}

function buildChat(
  assistantName: string,
  folder: string,
  groupName: string,
): string {
  const histUrl = `/c/${esc(folder)}/history`;
  const sendUrl = `/c/${esc(folder)}/send`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${esc(assistantName)}">
<link rel="manifest" href="/manifest.json">
<title>${esc(groupName)} — ${esc(assistantName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f172a;--surface:#1e293b;--user:#2563eb;--text:#f1f5f9;--muted:#64748b;--border:#334155}
html,body{height:100dvh;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#app{display:flex;flex-direction:column;height:100dvh;max-width:680px;margin:0 auto}
#hdr{padding:12px max(16px,env(safe-area-inset-right)) 12px max(16px,env(safe-area-inset-left));background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
#back{color:var(--muted);text-decoration:none;font-size:22px;line-height:1;flex-shrink:0;padding:0 4px}
#back:hover{color:var(--text)}
#hdr-info{display:flex;flex-direction:column;flex:1;min-width:0}
#hdr-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hdr-sub{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}
#dot{width:7px;height:7px;border-radius:50%;background:#22c55e;flex-shrink:0;transition:background .3s}
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
.b p{margin:6px 0}.b p:first-child{margin-top:0}.b p:last-child{margin-bottom:0}
.b ul,.b ol{padding-left:20px;margin:4px 0}
.b strong{font-weight:600}
.b h1,.b h2,.b h3{font-weight:700;margin:10px 0 4px;line-height:1.3}
.b h1{font-size:1.2em}.b h2{font-size:1.1em}.b h3{font-size:1em}
.b table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}
.b th,.b td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
.b th{background:rgba(255,255,255,.06);font-weight:600}
.b blockquote{border-left:3px solid var(--muted);margin:6px 0;padding:2px 12px;opacity:.8}
.b blockquote p{margin:2px 0}
.b hr{border:none;border-top:1px solid var(--border);margin:8px 0}
.b a{color:#60a5fa;text-decoration:underline}
.b img{max-width:100%;border-radius:6px;margin:4px 0}
#ftr{padding:12px max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:var(--surface);border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end}
#inp{flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:20px;padding:10px 16px;font-size:15px;resize:none;min-height:42px;max-height:160px;outline:none;line-height:1.4;font-family:inherit}
#inp:focus{border-color:var(--user)}
#btn{width:42px;height:42px;border-radius:50%;background:var(--user);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;transition:opacity .15s}
#btn.dim{opacity:.35}
</style>
</head>
<body>
<div id="app">
  <div id="hdr">
    <a id="back" href="/" title="All conversations">‹</a>
    <div id="hdr-info">
      <div id="hdr-name">${esc(groupName)}</div>
      <div id="hdr-sub"><div id="dot" class="off"></div><span id="st">connecting…</span></div>
    </div>
  </div>
  <div id="msgs"></div>
  <form id="frm"><div id="ftr"><textarea id="inp" placeholder="Message…" rows="1"></textarea><button type="submit" id="btn" class="dim">↑</button></div></form>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
const HIST='${histUrl}',SEND='${sendUrl}';
const msgs=document.getElementById('msgs'),inp=document.getElementById('inp'),btn=document.getElementById('btn'),dot=document.getElementById('dot'),st=document.getElementById('st'),seen=new Set();
function fmt(ts){try{return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}catch(e){return '';}}
function addMsg(isBot,content,ts,id){
  if(id&&seen.has(id))return;if(id)seen.add(id);
  const w=document.createElement('div');w.className='m '+(isBot?'a':'u');
  const b=document.createElement('div');b.className='b';
  if(isBot){try{b.innerHTML=typeof marked!=='undefined'?marked.parse(content||'',{gfm:true}):(content||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');}catch(e){b.textContent=content||'';}}else b.textContent=content||'';
  const t=document.createElement('div');t.className='ts';t.textContent=fmt(ts);
  w.appendChild(b);w.appendChild(t);msgs.appendChild(w);msgs.scrollTop=msgs.scrollHeight;
}
let lastTs='1970-01-01T00:00:00.000Z';
function poll(){
  fetch(HIST+'?since='+encodeURIComponent(lastTs))
    .then(r=>{const ok=r.ok;dot.classList.toggle('off',!ok);st.textContent=ok?'connected':'reconnecting…';return r.json();})
    .then(ms=>{for(const m of ms){if(m.timestamp>lastTs)lastTs=m.timestamp;try{addMsg(!!m.is_bot_message,m.content,m.timestamp,m.id);}catch(e){}}})
    .catch(()=>{dot.classList.add('off');st.textContent='offline';});
}
poll();setInterval(poll,2000);
function upd(){btn.classList.toggle('dim',!inp.value.trim());}
inp.addEventListener('input',()=>{inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,160)+'px';upd();});
inp.addEventListener('keyup',upd);inp.addEventListener('change',upd);
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
document.getElementById('frm').addEventListener('submit',e=>{e.preventDefault();send();});
function send(){const text=inp.value.trim();if(!text)return;inp.value='';inp.style.height='auto';btn.classList.add('dim');fetch(SEND,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}).catch(()=>{});}
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
