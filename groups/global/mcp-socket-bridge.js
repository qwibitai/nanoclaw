#!/usr/bin/env node
// STDIO <-> UNIX socket bridge for MCP servers exposed via UDS on the host.
// Replaces socat for environments where socat is unavailable.
// Usage: node mcp-socket-bridge.js <socket-path>
const net = require('net');
const sockPath = process.argv[2];
if (!sockPath) {
  console.error('usage: node mcp-socket-bridge.js <socket-path>');
  process.exit(2);
}
const sock = net.connect(sockPath);
sock.on('error', (e) => { console.error('mcp-bridge socket error:', e.message); process.exit(1); });
sock.on('end', () => process.exit(0));
sock.on('close', () => process.exit(0));
process.stdin.on('end', () => { try { sock.end(); } catch(e) {} });
process.stdin.pipe(sock);
sock.pipe(process.stdout);
