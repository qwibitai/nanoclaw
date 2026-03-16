#!/usr/bin/env node
// Teller API Proxy — mTLS proxy for container agents
// Runs on host, containers call via http://host.docker.internal:3004
// Certificates stay on host, containers never see them.
// Usage: node teller-api-proxy.mjs

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3004;
const TELLER_API = 'https://api.teller.io';

// Resolve cert paths
const home = process.env.HOME || '/Users/jialingwu';
const certDir = path.join(home, 'tianji', 'secrets', 'teller_certs');
const certPath = path.join(certDir, 'certificate.pem');
const keyPath = path.join(certDir, 'private_key.pem');
const tokenPath = path.join(certDir, 'teller_access_token');

// Load certs and token
let cert, key, token;
try {
  cert = fs.readFileSync(certPath);
  key = fs.readFileSync(keyPath);
  token = fs.readFileSync(tokenPath, 'utf8').trim();
} catch (err) {
  console.error(`Failed to load Teller credentials from ${certDir}:`, err.message);
  process.exit(1);
}

// Create mTLS agent
const tlsAgent = new https.Agent({ cert, key });

function tellerFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const url = `${TELLER_API}${apiPath}`;
    const auth = Buffer.from(`${token}:`).toString('base64');

    const req = https.request(url, {
      agent: tlsAgent,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Teller API ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Route: /accounts, /accounts/:id/balances, /accounts/:id/transactions?count=N
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const apiPath = url.pathname;
  const query = url.search; // e.g., ?count=10

  try {
    const data = await tellerFetch(apiPath + query);
    res.writeHead(200);
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Teller API proxy listening on port ${PORT}`);
});
