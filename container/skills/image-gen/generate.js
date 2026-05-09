#!/usr/bin/env node
// OpenAI image generator — no dependencies, uses Node's global fetch (Node 18+).
//
// Usage:
//   node generate.js --prompt "a cat" \
//                    [--model gpt-image-2] \
//                    [--size 1024x1024] \
//                    [--quality high] \
//                    --output /workspace/group/generated/cat.png
//
// Exits 0 and prints the output path on success. Exits non-zero on any
// error and writes the reason to stderr.

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const prompt = args.prompt;
const model = args.model || 'gpt-image-2';
const size = args.size || '1024x1024';
const quality = args.quality || undefined;
const output = args.output;

if (!prompt) {
  console.error('--prompt is required');
  process.exit(2);
}
if (!output) {
  console.error('--output is required');
  process.exit(2);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set in the container environment');
  process.exit(2);
}

// Containers set OPENAI_BASE_URL to the host credential proxy, which
// already includes /v1. Outside the container (host-side testing)
// OPENAI_BASE_URL is usually unset, so we default to the real API.
const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const endpoint = `${baseUrl.replace(/\/$/, '')}/images/generations`;

fs.mkdirSync(path.dirname(output), { recursive: true });

const body = { model, prompt, size, n: 1 };
if (quality) body.quality = quality;

try {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Non-JSON response (HTTP ${res.status}):`);
    console.error(raw.slice(0, 500));
    process.exit(1);
  }

  if (!res.ok || parsed.error) {
    const msg = parsed.error?.message || `HTTP ${res.status}`;
    console.error(`OpenAI error: ${msg}`);
    process.exit(1);
  }

  const item = parsed.data && parsed.data[0];
  if (!item) {
    console.error('No image data in response:');
    console.error(raw.slice(0, 500));
    process.exit(1);
  }

  if (item.b64_json) {
    fs.writeFileSync(output, Buffer.from(item.b64_json, 'base64'));
    console.log(output);
    process.exit(0);
  }

  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      console.error(`Failed to download image URL: HTTP ${imgRes.status}`);
      process.exit(1);
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    fs.writeFileSync(output, buf);
    console.log(output);
    process.exit(0);
  }

  console.error('Response item has neither b64_json nor url');
  process.exit(1);
} catch (err) {
  console.error(`Request failed: ${err?.message || err}`);
  process.exit(1);
}
