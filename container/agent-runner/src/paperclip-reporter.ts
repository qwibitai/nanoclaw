#!/usr/bin/env node
/**
 * Paperclip Reporter — CLI helper for the container agent.
 * Posts a comment back to a Paperclip run via the REST API.
 *
 * Usage:
 *   node /app/dist/paperclip-reporter.js <runId> <issueId> <comment text...>
 *
 * Env:
 *   PAPERCLIP_URL              Base URL of Paperclip (default: http://paperclip:3100)
 *   PAPERCLIP_AGENT_JWT_SECRET  HS256 secret used to sign request JWTs
 *   PAPERCLIP_AGENT_ID          Agent ID (JWT sub claim)
 *   PAPERCLIP_COMPANY_ID        Company ID claim
 *
 * Example:
 *   node /app/dist/paperclip-reporter.js run_abc123 ISSUE-42 "Done. Fixed the null pointer on line 42."
 */

import { createHmac } from 'crypto';

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(
  secret: string,
  claims: Record<string, unknown>,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const sig = base64url(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

const [, , runId, issueId, ...commentParts] = process.argv;
const comment = commentParts.join(' ').trim();

if (!runId || !issueId || !comment) {
  console.error('Usage: paperclip-reporter <runId> <issueId> <comment text>');
  process.exit(1);
}

const BASE = (process.env.PAPERCLIP_URL ?? 'http://paperclip:3100').replace(/\/$/, '');
const jwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET ?? '';
const agentId = process.env.PAPERCLIP_AGENT_ID ?? '';
const companyId = process.env.PAPERCLIP_COMPANY_ID ?? '';

if (!jwtSecret) {
  console.error('Error: PAPERCLIP_AGENT_JWT_SECRET is not set');
  process.exit(1);
}
if (!agentId) {
  console.error('Error: PAPERCLIP_AGENT_ID is not set');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const token = makeJwt(jwtSecret, {
  sub: agentId,
  company_id: companyId,
  adapter_type: 'http',
  run_id: runId,
  iat: now,
  exp: now + 300,
});

try {
  const res = await fetch(
    `${BASE}/api/issues/${encodeURIComponent(issueId)}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: comment }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`Paperclip API error ${res.status}: ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
} catch (err) {
  console.error(
    `Failed to post comment: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
