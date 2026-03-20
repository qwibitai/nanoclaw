#!/usr/bin/env npx tsx
/**
 * X Integration - Health Check
 *
 * Exercises the x-client-transaction-id pipeline by creating a Scraper
 * with xClientTransactionId enabled and calling isLoggedIn(). If the
 * underlying package is broken (e.g. "Couldn't get KEY_BYTE indices"),
 * the call throws before any network request.
 *
 * Usage: echo '{}' | npx tsx health-check.ts
 */

// Polyfill ArrayBuffer.transfer for Node < 21 (required by x-client-transaction-id)
if (!ArrayBuffer.prototype.transfer) {
  ArrayBuffer.prototype.transfer = function (newByteLength?: number): ArrayBuffer {
    const len = newByteLength !== undefined ? newByteLength : this.byteLength;
    const newBuffer = new ArrayBuffer(len);
    const src = new Uint8Array(this);
    const dst = new Uint8Array(newBuffer);
    dst.set(src.subarray(0, Math.min(this.byteLength, len)));
    return newBuffer;
  };
}

import { Scraper } from '@the-convocation/twitter-scraper';
import { readInput, writeResult, type ScriptResult } from '../lib/browser.js';

async function healthCheck(_input: Record<string, unknown>): Promise<ScriptResult> {
  const scraper = new Scraper({
    experimental: {
      xClientTransactionId: true,
    },
  });

  // isLoggedIn() will return false (no cookies), but the important thing
  // is that it exercises the transaction ID generation pipeline. If the
  // x-client-transaction-id package is broken, this throws.
  await scraper.isLoggedIn();

  return {
    success: true,
    message: 'x-client-transaction-id is healthy',
    data: { isTransactionIdError: false },
  };
}

// Script protocol: read stdin JSON, run handler, write JSON to stdout
try {
  const input = await readInput<Record<string, unknown>>();
  const result = await healthCheck(input);
  writeResult(result);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const isTransactionIdError = message.includes('KEY_BYTE');
  writeResult({
    success: false,
    message: `Health check failed: ${message}`,
    data: { isTransactionIdError },
  });
  process.exitCode = 1;
}
