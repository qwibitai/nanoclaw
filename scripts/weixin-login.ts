#!/usr/bin/env tsx
/**
 * Interactive WeChat QR-code login.
 *
 * Usage:  npx tsx scripts/weixin-login.ts [--base-url <url>]
 *
 * Reads WEIXIN_BASE_URL from .env if --base-url is not given.
 * Renders the QR code to the terminal and writes bot_token, baseUrl, userId
 * to store/weixin/accounts/<accountId>.account.json on success.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_WEIXIN_BASE_URL } from '../src/channels/weixin/api.js';
import { runQrLogin } from '../src/channels/weixin/auth.js';

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function readEnvBaseUrl(): string | undefined {
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const m = /^\s*WEIXIN_BASE_URL\s*=\s*(.+?)\s*$/.exec(line);
      if (m) {
        return m[1].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    /* no .env */
  }
  return undefined;
}

async function renderQrToTerminal(qrUrl: string): Promise<void> {
  try {
    const qrterm = await import('qrcode-terminal');
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qrUrl, { small: true }, (qr: string) => {
        process.stdout.write(qr + '\n');
        resolve();
      });
    });
  } catch {
    process.stdout.write(
      '(qrcode-terminal not available — open this URL on another device to scan)\n',
    );
  }
  process.stdout.write(
    `\n二维码链接（如果终端渲染失败可手动打开）：\n${qrUrl}\n\n`,
  );
}

async function main(): Promise<void> {
  const baseUrl =
    parseArg('--base-url') ||
    process.env.WEIXIN_BASE_URL ||
    readEnvBaseUrl() ||
    DEFAULT_WEIXIN_BASE_URL;

  process.stdout.write(`正在获取登录二维码... (baseUrl=${baseUrl})\n\n`);

  const result = await runQrLogin({
    baseUrl,
    events: {
      onQr: async (qrUrl, isRefresh) => {
        if (isRefresh) {
          process.stdout.write('\n🔄 二维码已刷新，请重新扫描：\n\n');
        } else {
          process.stdout.write('使用微信扫描以下二维码以登录：\n\n');
        }
        await renderQrToTerminal(qrUrl);
      },
      onScanned: () => {
        process.stdout.write('\n👀 已扫码，请在微信中继续确认...\n');
      },
    },
  });

  if (result.connected) {
    process.stdout.write(
      `\n${result.message}\naccountId=${result.accountId}\nuserId=${result.userId ?? '(unknown)'}\n`,
    );
    process.exit(0);
  }
  process.stderr.write(`\n${result.message}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Login failed: ${String(err)}\n`);
  process.exit(1);
});
