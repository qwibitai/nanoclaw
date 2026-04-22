#!/usr/bin/env tsx
/**
 * Manual smoke test for the outbound WeChat media pipeline.
 *
 * Usage:
 *   npx tsx scripts/weixin-send-media.ts <filePath> [--to <ilink_user_id>]
 *
 * Reads the default account from store/weixin/, resolves a recipient
 * (either explicit --to, or the most recent inbound user from the
 * context-tokens cache), then uploads the file and sends it.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_WEIXIN_BASE_URL,
  DEFAULT_WEIXIN_CDN_BASE_URL,
} from '../src/channels/weixin/api.js';
import { sendWeixinMediaFile } from '../src/channels/weixin/send-media.js';
import {
  getDefaultAccount,
  loadContextTokens,
  loadWeixinAccount,
} from '../src/channels/weixin/storage.js';

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath || filePath.startsWith('--')) {
    console.error(
      'Usage: npx tsx scripts/weixin-send-media.ts <filePath> [--to <userId>] [--caption "…"]',
    );
    process.exit(2);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`file not found: ${resolved}`);
    process.exit(2);
  }

  const accountId = getDefaultAccount();
  if (!accountId) {
    console.error('no weixin default account — run scripts/weixin-login.ts');
    process.exit(2);
  }
  const account = loadWeixinAccount(accountId);
  if (!account?.token || !account.baseUrl) {
    console.error(`weixin account ${accountId} incomplete`);
    process.exit(2);
  }

  const tokens = loadContextTokens(accountId);
  const explicitTo = parseArg('--to');
  const to = explicitTo ?? Object.keys(tokens)[0];
  if (!to) {
    console.error(
      'no recipient: pass --to <userId>, or send yourself a text first so a context token is cached',
    );
    process.exit(2);
  }
  const contextToken = tokens[to];

  console.log(
    `sending file=${resolved} to=${to} via baseUrl=${account.baseUrl ?? DEFAULT_WEIXIN_BASE_URL}`,
  );
  console.log(
    `contextToken=${contextToken ? '[cached]' : '[missing — server will likely reject]'}`,
  );

  await sendWeixinMediaFile({
    filePath: resolved,
    to,
    caption: parseArg('--caption'),
    opts: {
      baseUrl: account.baseUrl,
      token: account.token,
      contextToken,
    },
    cdnBaseUrl: DEFAULT_WEIXIN_CDN_BASE_URL,
  });
  console.log('ok');
}

main().catch((err) => {
  console.error('weixin-send-media failed:', err);
  process.exit(1);
});
