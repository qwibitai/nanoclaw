---
name: add-api-server
description: Expose your NanoClaw agent as an OpenAI-compatible HTTP API. Any tool that supports OpenAI format can talk to your agent via /v1/chat/completions.
version: 1.0.0
author: robbyczgw-cla
---

# /add-api-server — OpenAI-Compatible API Server

Expose this NanoClaw agent as an OpenAI-compatible HTTP endpoint so external tools can send chat requests to it.

## When to Use

- User asks to add an API server or HTTP endpoint
- User wants external tools to talk to this agent via HTTP
- User wants to expose the agent as a model provider on the local network

## What It Does

Creates a lightweight Node.js HTTP server that:
- Listens on a configurable port (default: 8643)
- Accepts `POST /v1/chat/completions` in OpenAI format
- Routes requests through `claude -p` (using the container's existing auth)
- Returns responses in OpenAI-compatible JSON
- Supports optional API key authentication
- Includes `/v1/models` and `/health` endpoints

## Pre-flight

1. Check if an API server is already running:

```bash
curl -s --noproxy '*' http://127.0.0.1:8643/health 2>/dev/null && echo "ALREADY RUNNING" || echo "NOT RUNNING"
```

If already running, ask the user if they want to reconfigure or just confirm it's working.

2. Verify `claude` CLI is available:

```bash
claude --version 2>/dev/null || echo "MISSING"
```

## Setup Procedure

### Step 1: Choose configuration

Ask the user:
- **Port** (default: 8643)
- **API key** (default: none — open access on local network)
- **System prompt** (default: none, or user-provided)

### Step 2: Create the server files

Create directory and files:

```bash
mkdir -p /workspace/group/api-server
```

Optionally write `/workspace/group/api-server/system-prompt.txt` with a custom system prompt.

Write `/workspace/group/api-server/server.js`:

```javascript
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.API_PORT || 8643;
const API_KEY = process.env.API_KEY || '';
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'system-prompt.txt');

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleChat(body, res) {
  const messages = body.messages || [];
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (!lastUserMsg) return sendJSON(res, 400, { error: 'No user message' });

  let prompt = lastUserMsg.content;
  if (messages.length > 1) {
    const history = messages.slice(0, -1)
      .map(m => `[${m.role}]: ${m.content}`).join('\n');
    prompt = `Previous conversation:\n${history}\n\nCurrent message: ${lastUserMsg.content}`;
  }

  const args = ['-p', prompt, '--output-format', 'text'];
  if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
    args.push('--system-prompt-file', SYSTEM_PROMPT_FILE);
  }

  let output = '';
  const proc = spawn('claude', args, { env: process.env, timeout: 120000 });
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', () => {});
  proc.on('close', code => {
    if (code !== 0 && !output) return sendJSON(res, 500, { error: 'Claude process failed' });
    sendJSON(res, 200, {
      id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'nanoclaw-agent',
      choices: [{ index: 0, message: { role: 'assistant', content: output.trim() }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  });
  proc.on('error', err => sendJSON(res, 500, { error: err.message }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (API_KEY) {
    const auth = req.headers.authorization || '';
    if (!auth.includes(API_KEY)) return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  if (req.url === '/v1/models' && req.method === 'GET') {
    return sendJSON(res, 200, { object: 'list', data: [
      { id: 'nanoclaw-agent', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'nanoclaw' }
    ]});
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { handleChat(JSON.parse(body), res); }
      catch (e) { sendJSON(res, 400, { error: 'Invalid JSON' }); }
    });
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    return sendJSON(res, 200, { status: 'ok', agent: 'nanoclaw', port: PORT });
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NanoClaw API Server on http://0.0.0.0:${PORT}`);
});
```

### Step 3: Start the server

```bash
node /workspace/group/api-server/server.js &
```

### Step 4: Verify

```bash
# Health check
curl -s --noproxy '*' http://127.0.0.1:8643/health

# Models endpoint
curl -s --noproxy '*' http://127.0.0.1:8643/v1/models

# Chat test
curl -s --noproxy '*' -X POST http://127.0.0.1:8643/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"nanoclaw-agent","messages":[{"role":"user","content":"Hello!"}]}'
```

## Usage Examples

### From curl
```bash
curl -X POST http://YOUR_IP:8643/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"nanoclaw-agent","messages":[{"role":"user","content":"What time is it?"}]}'
```

### From Python (OpenAI SDK)
```python
from openai import OpenAI
client = OpenAI(base_url="http://YOUR_IP:8643/v1", api_key="optional")
response = client.chat.completions.create(
    model="nanoclaw-agent",
    messages=[{"role": "user", "content": "Hey!"}]
)
print(response.choices[0].message.content)
```

## Pitfalls

- **Proxy inside Docker:** `curl` may route through a container proxy. Use `--noproxy '*'` for localhost testing.
- **Auth:** `claude -p` uses OAuth. If auth expires, the server returns 500.
- **Concurrency:** Each request spawns a `claude -p` process. Single-agent endpoint, not for high traffic.
- **Port conflicts:** Check port availability before starting.

## Removal

```bash
pkill -f 'api-server/server.js'
rm -rf /workspace/group/api-server
```
