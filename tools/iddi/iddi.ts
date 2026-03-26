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
 *   npx tsx tools/iddi/iddi.ts engagement [--days 7]
 *
 * Environment:
 *   IDDI_BASE_URL - API base URL (main IDDI platform)
 *   IDDI_BACKEND_URL - Backend API URL (Render-hosted, e.g. https://vending-backend-nk0m.onrender.com)
 *   IDDI_EMAIL - Login email
 *   IDDI_PASSWORD - Login password
 */

import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.IDDI_BASE_URL;
const BACKEND_URL = process.env.IDDI_BACKEND_URL;

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

async function fetchRetry(url: string, init?: RequestInit, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
}
const EMAIL = process.env.IDDI_EMAIL;
const PASSWORD = process.env.IDDI_PASSWORD;

// Token cache location — works both on host and inside containers.
// Container: /workspace/group/ exists. Host: cwd/groups/snak-group/ exists.
const TOKEN_FILE = fs.existsSync('/workspace/group')
  ? '/workspace/group/iddi-token.json'
  : path.join(process.cwd(), 'groups', 'snak-group', 'iddi-token.json');

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

  const res = await fetchRetry(`${BASE_URL}/api/auth/vendor/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://vending-front-end.vercel.app' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!res.ok) {
    throw new Error(`IDDI auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const token = data.token || data.data?.token || data.accessToken || data.access_token;
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

  const res = await fetchRetry(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, 'Origin': 'https://vending-front-end.vercel.app' },
  });

  if (res.status === 401) {
    // Token expired, delete cache and retry once
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    const newToken = await getToken();
    const retry = await fetchRetry(url.toString(), {
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

// --- IDDI Backend (Render-hosted) helpers ---

const BACKEND_TOKEN_FILE = fs.existsSync('/workspace/group')
  ? '/workspace/group/iddi-backend-token.json'
  : path.join(process.cwd(), 'groups', 'snak-group', 'iddi-backend-token.json');

const BACKEND_WAKE_TIMEOUT_MS = 45_000;

/**
 * Wake up the Render free-tier backend by hitting its health endpoint.
 * Retries for up to ~45s before giving up.
 */
async function wakeBackend(): Promise<boolean> {
  if (!BACKEND_URL) return false;
  const healthUrl = `${BACKEND_URL}/api/health`;
  const startTime = Date.now();
  const pollInterval = 5_000;

  while (Date.now() - startTime < BACKEND_WAKE_TIMEOUT_MS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok || res.status < 500) return true;
    } catch { /* server still waking */ }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  return false;
}

async function getBackendToken(): Promise<string> {
  // Try cached token
  if (fs.existsSync(BACKEND_TOKEN_FILE)) {
    try {
      const cached: TokenCache = JSON.parse(fs.readFileSync(BACKEND_TOKEN_FILE, 'utf-8'));
      if (cached.expires_at > Date.now()) {
        return cached.token;
      }
    } catch { /* stale cache, re-auth */ }
  }

  if (!BACKEND_URL || !EMAIL || !PASSWORD) {
    throw new Error('Missing IDDI_BACKEND_URL, IDDI_EMAIL, or IDDI_PASSWORD environment variables');
  }

  const res = await fetchRetry(`${BACKEND_URL}/api/auth/vendor/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!res.ok) {
    throw new Error(`IDDI backend auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const token = data.token || data.data?.token || data.accessToken || data.access_token;
  if (!token) {
    throw new Error(`IDDI backend auth response missing token: ${JSON.stringify(data)}`);
  }

  const cache: TokenCache = { token, expires_at: Date.now() + 23 * 60 * 60 * 1000 };
  fs.mkdirSync(path.dirname(BACKEND_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(BACKEND_TOKEN_FILE, JSON.stringify(cache));

  return token;
}

async function backendApiGet(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getBackendToken();
  const url = new URL(`${BACKEND_URL}${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetchRetry(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    if (fs.existsSync(BACKEND_TOKEN_FILE)) fs.unlinkSync(BACKEND_TOKEN_FILE);
    const newToken = await getBackendToken();
    const retry = await fetchRetry(url.toString(), {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    if (!retry.ok) throw new Error(`IDDI backend API error: ${retry.status} ${await retry.text()}`);
    return retry.json();
  }

  if (!res.ok) {
    throw new Error(`IDDI backend API error: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('Commands: inventory, expiring, redistribution, shopping-list, top-products, swipe-results, analytics, engagement');
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
        // /api/vendor/expiring is not available; derive from inventory
        const invData = await apiGet('/api/vendor/inventory') as any;
        const items = invData?.data?.inventory || invData?.inventory || [];
        const flagged = items.filter((i: any) => i.stock_status === 'out' || i.stock_status === 'low');
        console.log(JSON.stringify({
          status: 'success',
          days,
          note: 'Derived from inventory (expiring endpoint unavailable)',
          data: { products: flagged, count: flagged.length },
        }));
        break;
      }

      case 'redistribution': {
        // /api/vendor/redistribution is not available; derive from inventory
        const invData2 = await apiGet('/api/vendor/inventory') as any;
        const items2 = invData2?.data?.inventory || invData2?.inventory || [];
        const outOfStock = items2.filter((i: any) => i.stock_status === 'out');
        const lowStock = items2.filter((i: any) => i.stock_status === 'low');
        console.log(JSON.stringify({
          status: 'success',
          note: 'Derived from inventory (redistribution endpoint unavailable)',
          data: {
            out_of_stock: outOfStock.map((i: any) => ({ name: i.product_name, category: i.category, in_field: i.in_field })),
            low_stock: lowStock.map((i: any) => ({ name: i.product_name, category: i.category, quantity_on_hand: i.quantity_on_hand, reorder_threshold: i.reorder_threshold })),
          },
        }));
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
        // /api/vendor/analytics is not available; derive from inventory + top-products
        const [invData3, topData] = await Promise.all([
          apiGet('/api/vendor/inventory') as any,
          apiGet('/api/vendor/top-products', { limit: '10' }) as any,
        ]);
        const summary = invData3?.data?.summary || {};
        console.log(JSON.stringify({
          status: 'success',
          note: 'Derived from inventory + top-products (analytics endpoint unavailable)',
          data: { inventory_summary: summary, top_products: topData?.data },
        }));
        break;
      }

      case 'engagement': {
        const days = parseInt(parseFlag(args, '--days', '7')!);

        if (!BACKEND_URL) {
          console.log(JSON.stringify({
            status: 'error',
            command: 'engagement',
            error: 'IDDI_BACKEND_URL environment variable is not set',
          }));
          process.exit(1);
        }

        // Wake up the Render backend (free tier sleeps after inactivity)
        const awake = await wakeBackend();
        if (!awake) {
          console.log(JSON.stringify({
            status: 'error',
            command: 'engagement',
            error: 'IDDI backend is unavailable (Render free tier may be sleeping). Try again in 30-60 seconds.',
          }));
          process.exit(1);
        }

        // Fetch engagement rankings and daily stats in parallel
        const [engagementData, dailyData] = await Promise.all([
          backendApiGet('/api/analytics/engagement') as Promise<any>,
          backendApiGet('/api/analytics/daily', { days: String(days) }) as Promise<any>,
        ]);

        const rankings = engagementData?.data?.machines || engagementData?.data || [];
        const dailyStats = dailyData?.data?.dailyStats || dailyData?.data || [];

        // Aggregate daily totals across the period
        let totalScans = 0;
        let totalVotes = 0;
        let totalSuggestions = 0;
        for (const day of dailyStats) {
          totalScans += day.qrScans || 0;
          totalVotes += day.pollVotes || 0;
          totalSuggestions += day.suggestions || 0;
        }

        // Build per-machine output from engagement rankings
        const machines = (Array.isArray(rankings) ? rankings : []).map((m: any) => ({
          machine_id: m.machineId || m.machine_id,
          machine_name: m.machineName || m.machine_name || 'Unknown',
          location: m.location || null,
          total_scans: m.qrScans ?? m.qr_scans ?? 0,
          total_votes: m.pollVotes ?? m.poll_votes ?? 0,
          total_suggestions: m.suggestions ?? 0,
          engagement_score: m.engagementScore ?? m.engagement_score ?? 0,
        }));

        // Compute totals; prefer daily aggregation for scans/votes/suggestions,
        // fall back to summing machine data if daily endpoint returned nothing
        const totalsScans = totalScans || machines.reduce((s: number, m: any) => s + m.total_scans, 0);
        const totalsVotes = totalVotes || machines.reduce((s: number, m: any) => s + m.total_votes, 0);
        const totalsSuggestions = totalSuggestions || machines.reduce((s: number, m: any) => s + m.total_suggestions, 0);
        const avgScore = machines.length > 0
          ? Math.round(machines.reduce((s: number, m: any) => s + m.engagement_score, 0) / machines.length)
          : 0;

        console.log(JSON.stringify({
          status: 'success',
          command: 'engagement',
          period_days: days,
          machines,
          totals: {
            total_scans: totalsScans,
            total_votes: totalsVotes,
            total_suggestions: totalsSuggestions,
            avg_engagement_score: avgScore,
          },
        }));
        break;
      }

      default:
        console.error(`Unknown command: ${command}. Use: inventory, expiring, redistribution, shopping-list, top-products, swipe-results, analytics, engagement`);
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
