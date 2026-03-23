#!/usr/bin/env node
/**
 * Paperclip Reporter — CLI helper for the container agent.
 * Posts a comment back to a Paperclip run via the REST API.
 *
 * Usage:
 *   node /app/dist/paperclip-reporter.js <runId> <comment text...>
 *
 * Env:
 *   PAPERCLIP_URL      Base URL of Paperclip (default: http://paperclip:3100)
 *   PAPERCLIP_API_KEY  API key for authentication
 *
 * Example:
 *   node /app/dist/paperclip-reporter.js run_abc123 "Done. Fixed the null pointer on line 42."
 */

const [, , runId, ...commentParts] = process.argv;
const comment = commentParts.join(' ').trim();

if (!runId || !comment) {
  console.error('Usage: paperclip-reporter <runId> <comment text>');
  process.exit(1);
}

const BASE = (process.env.PAPERCLIP_URL ?? 'http://paperclip:3100').replace(/\/$/, '');
const apiKey = process.env.PAPERCLIP_API_KEY ?? '';

if (!apiKey) {
  console.error('Error: PAPERCLIP_API_KEY is not set');
  process.exit(1);
}

try {
  const res = await fetch(
    `${BASE}/api/runs/${encodeURIComponent(runId)}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: comment }),
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
