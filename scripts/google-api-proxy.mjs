#!/usr/bin/env node
// Google API Proxy — lightweight HTTP wrapper around `gws` CLI
// Runs on host, containers call via http://host.docker.internal:3003
// Usage: node google-api-proxy.mjs

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = 3003;
const GWS = '/opt/homebrew/bin/gws';

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check
  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Route: /<service>/<resource>/<method>
  // e.g., /calendar/events/list?params={"calendarId":"primary"}
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 3) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Path must be /<service>/<resource>/<method>', example: '/calendar/events/list' }));
    return;
  }

  const args = [...parts]; // e.g., ['calendar', 'events', 'list']

  // Add --params if provided
  const params = url.searchParams.get('params');
  if (params) {
    args.push('--params', params);
  }

  // Add --json for POST body
  if (req.method === 'POST') {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    if (body) {
      args.push('--json', body);
    }
  }

  // Add format
  const format = url.searchParams.get('format');
  if (format) {
    args.push('--format', format);
  }

  try {
    const { stdout, stderr } = await execFileAsync(GWS, args, {
      timeout: 30000,
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    });
    res.writeHead(200);
    res.end(stdout);
  } catch (err) {
    const code = err.code === 'ETIMEDOUT' ? 504 : 500;
    res.writeHead(code);
    res.end(JSON.stringify({
      error: err.message,
      stderr: err.stderr?.slice(0, 500),
      exitCode: err.code,
    }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Google API proxy listening on port ${PORT}`);
});
