#!/usr/bin/env npx tsx
/**
 * IDDI Platform Integration for NanoClaw
 * Wraps the IDDI REST API for vending machine performance data.
 *
 * Usage:
 *   npx tsx tools/iddi/iddi.ts inventory
 *   npx tsx tools/iddi/iddi.ts expiring [--days 7]
 *   npx tsx tools/iddi/iddi.ts redistribution
 *   npx tsx tools/iddi/iddi.ts shopping-list
 *   npx tsx tools/iddi/iddi.ts top-products [--limit 20]
 *   npx tsx tools/iddi/iddi.ts swipe-results --machine-id <id>
 *   npx tsx tools/iddi/iddi.ts analytics
 *
 * Environment:
 *   IDDI_BASE_URL - API base URL
 *   IDDI_EMAIL - Login email
 *   IDDI_PASSWORD - Login password
 */

import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.IDDI_BASE_URL;
const EMAIL = process.env.IDDI_EMAIL;
const PASSWORD = process.env.IDDI_PASSWORD;

// Token cached per-group in workspace
const TOKEN_FILE = path.join(process.cwd(), 'groups', 'snak-group', 'iddi-token.json');

interface TokenCache {
  token: string;
  expires_at: number;
}

async function getToken(): Promise<string> {
  // Try cached token
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const cached: TokenCache = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (cached.expires_at > Date.now()) {
        return cached.token;
      }
    } catch { /* stale cache, re-auth */ }
  }

  if (!BASE_URL || !EMAIL || !PASSWORD) {
    throw new Error('Missing IDDI_BASE_URL, IDDI_EMAIL, or IDDI_PASSWORD environment variables');
  }

  const res = await fetch(`${BASE_URL}/api/auth/vendor/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://vending-front-end.vercel.app' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!res.ok) {
    throw new Error(`IDDI auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const token = data.token || data.accessToken || data.access_token;
  if (!token) {
    throw new Error(`IDDI auth response missing token: ${JSON.stringify(data)}`);
  }

  // Cache for 23 hours (JWT typically expires in 24h)
  const cache: TokenCache = { token, expires_at: Date.now() + 23 * 60 * 60 * 1000 };
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(cache));

  return token;
}

async function apiGet(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken();
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, 'Origin': 'https://vending-front-end.vercel.app' },
  });

  if (res.status === 401) {
    // Token expired, delete cache and retry once
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    const newToken = await getToken();
    const retry = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${newToken}`, 'Origin': 'https://vending-front-end.vercel.app' },
    });
    if (!retry.ok) throw new Error(`IDDI API error: ${retry.status} ${await retry.text()}`);
    return retry.json();
  }

  if (!res.ok) {
    throw new Error(`IDDI API error: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

function parseFlag(args: string[], flag: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('Commands: inventory, expiring, redistribution, shopping-list, top-products, swipe-results, analytics');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'inventory': {
        const data = await apiGet('/api/vendor/inventory');
        console.log(JSON.stringify({ status: 'success', data }));
        break;
      }

      case 'expiring': {
        const days = parseFlag(args, '--days', '7');
        const data = await apiGet('/api/vendor/expiring', { days: days! });
        console.log(JSON.stringify({ status: 'success', days, data }));
        break;
      }

      case 'redistribution': {
        const data = await apiGet('/api/vendor/redistribution');
        console.log(JSON.stringify({ status: 'success', data }));
        break;
      }

      case 'shopping-list': {
        const data = await apiGet('/api/vendor/shopping-list');
        console.log(JSON.stringify({ status: 'success', data }));
        break;
      }

      case 'top-products': {
        const limit = parseFlag(args, '--limit', '20');
        const data = await apiGet('/api/vendor/top-products', { limit: limit! });
        console.log(JSON.stringify({ status: 'success', data }));
        break;
      }

      case 'swipe-results': {
        const machineId = parseFlag(args, '--machine-id');
        if (!machineId) {
          console.error('Usage: iddi swipe-results --machine-id <id>');
          process.exit(1);
        }
        const data = await apiGet(`/api/vendor/machines/${machineId}/swipe-results`);
        console.log(JSON.stringify({ status: 'success', machine_id: machineId, data }));
        break;
      }

      case 'analytics': {
        const data = await apiGet('/api/vendor/analytics');
        console.log(JSON.stringify({ status: 'success', data }));
        break;
      }

      default:
        console.error(`Unknown command: ${command}. Use: inventory, expiring, redistribution, shopping-list, top-products, swipe-results, analytics`);
        process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
