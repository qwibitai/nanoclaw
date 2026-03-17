#!/usr/bin/env npx tsx
/**
 * Router diagnostic tool — test the case router in isolation.
 *
 * Usage:
 *   npx tsx scripts/test-router.ts "your test message"
 *   npx tsx scripts/test-router.ts --sender "DeMarco" "תשלח לי את הקובץ"
 *   npx tsx scripts/test-router.ts --dry-run "hello"
 *   npx tsx scripts/test-router.ts --chat-jid "tg:1211743323" "fix the bug"
 *
 * Modes:
 *   --dry-run   Show the prompt that would be sent (no API call)
 *   --live      Actually call the API via credential proxy (default)
 *   --container Run the full container router (same as production)
 *
 * Options:
 *   --sender NAME     Sender name (default: "TestUser")
 *   --chat-jid JID    Chat JID to load cases from (default: first group with active cases)
 *   --cases JSON      Override cases with JSON array instead of reading from DB
 */

import path from 'path';
import { request as httpRequest } from 'http';

// We need to initialize the DB before importing cases
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
process.chdir(PROJECT_ROOT);

// Dynamically import after chdir so config.ts resolves paths correctly
const { initDatabase } = await import('../src/db.js');
const { getActiveCases, getRoutableCases } = await import('../src/cases.js');
const { buildRouterPrompt } = await import('../src/router-prompt.js');
const { CREDENTIAL_PROXY_PORT } = await import('../src/config.js');

// Parse args
const args = process.argv.slice(2);
let mode: 'dry-run' | 'live' | 'container' = 'live';
let sender = 'TestUser';
let chatJid: string | null = null;
let casesOverride: string | null = null;
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--dry-run':
      mode = 'dry-run';
      break;
    case '--live':
      mode = 'live';
      break;
    case '--container':
      mode = 'container';
      break;
    case '--sender':
      sender = args[++i];
      break;
    case '--chat-jid':
      chatJid = args[++i];
      break;
    case '--cases':
      casesOverride = args[++i];
      break;
    default:
      positional.push(args[i]);
  }
}

const messageText = positional.join(' ') || 'Hello, how are you?';

// Init DB
initDatabase();

// Load cases
let cases;
if (casesOverride) {
  cases = JSON.parse(casesOverride);
} else {
  // Find active cases
  const activeCases = chatJid
    ? getRoutableCases(chatJid)
    : (() => {
        // Find the first chat JID that has 2+ routable cases
        const allActive = getActiveCases();
        const byJid = new Map<string, typeof allActive>();
        for (const c of allActive) {
          const list = byJid.get(c.chat_jid) || [];
          list.push(c);
          byJid.set(c.chat_jid, list);
        }
        for (const [jid, jidCases] of byJid) {
          if (jidCases.length >= 2) {
            chatJid = jid;
            return jidCases;
          }
        }
        // Fall back to any active cases
        if (allActive.length > 0) {
          chatJid = allActive[0].chat_jid;
        }
        return allActive;
      })();

  cases = activeCases.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    status: c.status,
    description: c.description,
    lastMessage: c.last_message,
    lastActivityAt: c.last_activity_at,
  }));
}

console.log('\n=== Router Diagnostic ===');
console.log(`Mode: ${mode}`);
console.log(`Chat JID: ${chatJid || '(none)'}`);
console.log(`Sender: ${sender}`);
console.log(`Message: "${messageText}"`);
console.log(`Cases: ${cases.length}`);
for (const c of cases) {
  console.log(
    `  - ${c.name} (${c.type}, ${c.status}) — ${c.description?.slice(0, 80)}`,
  );
}

if (cases.length < 2) {
  console.log(
    '\nNote: Router only activates with 2+ routable cases. With 0-1 cases, routing is deterministic.',
  );
  if (cases.length === 0) {
    console.log('  → No cases: message processed without case context');
  } else {
    console.log(`  → Single case: always routes to "${cases[0].name}"`);
  }
  if (mode === 'dry-run') {
    process.exit(0);
  }
}

const requestId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const routerRequest = {
  type: 'route' as const,
  requestId,
  messageText,
  senderName: sender,
  groupFolder: 'test_diagnostic',
  cases,
};

const prompt = buildRouterPrompt(routerRequest);

if (mode === 'dry-run') {
  console.log('\n=== Router Prompt ===');
  console.log(prompt);
  console.log(`\n=== Request ID: ${requestId} ===`);
  console.log('The agent should call route_decision with this request_id ^');
  process.exit(0);
}

if (mode === 'container') {
  console.log('\n=== Running container router (production path) ===');
  const { routeMessage } = await import('../src/router-container.js');
  try {
    const response = await routeMessage(routerRequest);
    console.log('\n=== Router Response ===');
    console.log(JSON.stringify(response, null, 2));
  } catch (err) {
    console.error('\n=== Router Error ===');
    console.error(err);
    process.exit(1);
  }
  process.exit(0);
}

// Live mode: call Haiku API directly (no container overhead)
console.log('\n=== Calling Haiku API directly (bypassing container) ===');

const body = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 300,
  messages: [{ role: 'user', content: prompt }],
});

const apiResponse = await new Promise<string>((resolve, reject) => {
  const req = httpRequest(
    {
      hostname: '127.0.0.1',
      port: CREDENTIAL_PROXY_PORT,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.content?.[0]?.text) {
          resolve(data.content[0].text.trim());
        } else if (data.error) {
          reject(new Error(`API error: ${JSON.stringify(data.error)}`));
        } else {
          reject(new Error(`Unexpected response: ${JSON.stringify(data)}`));
        }
      });
    },
  );
  req.on('error', reject);
  req.setTimeout(30000, () => {
    req.destroy(new Error('API timeout'));
  });
  req.write(body);
  req.end();
});

console.log('\n=== Raw API Response ===');
console.log(apiResponse);

// Try to parse as JSON (the agent might output JSON despite being told to use a tool)
try {
  const parsed = JSON.parse(apiResponse);
  console.log('\n=== Parsed Decision ===');
  console.log(JSON.stringify(parsed, null, 2));
} catch {
  console.log(
    '\n(Response is not JSON — in production, the agent uses the route_decision MCP tool instead)',
  );
}

process.exit(0);
