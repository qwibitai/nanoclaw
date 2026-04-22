/**
 * On-disk persistence for WeChat accounts.
 *
 * Layout under STORE_DIR/weixin/:
 *   accounts/<accountId>.account.json         - { token, baseUrl, userId }
 *   accounts/<accountId>.context-tokens.json  - { [userId]: contextToken }
 *   accounts/<accountId>.sync.json            - { get_updates_buf }
 *   default-account                           - plain-text file, the accountId to auto-load
 *
 * All filenames use a normalized accountId: the raw iLink bot id
 * `xxx@im.bot` is rewritten to `xxx-im-bot` so it's filesystem-safe.
 */
import fs from 'node:fs';
import path from 'node:path';

import { STORE_DIR } from '../../config.js';
import { logger } from '../../logger.js';

export const WEIXIN_STORE_DIR = path.join(STORE_DIR, 'weixin');
const ACCOUNTS_DIR = path.join(WEIXIN_STORE_DIR, 'accounts');
const DEFAULT_ACCOUNT_FILE = path.join(WEIXIN_STORE_DIR, 'default-account');

export interface WeixinAccountData {
  token: string;
  baseUrl: string;
  userId?: string;
}

export function normalizeAccountId(rawAccountId: string): string {
  return rawAccountId.replace(/[@.]/g, '-');
}

function accountFilePath(accountId: string, suffix: string): string {
  return path.join(ACCOUNTS_DIR, `${accountId}.${suffix}`);
}

function ensureAccountsDir(): void {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

export function saveWeixinAccount(
  accountId: string,
  data: WeixinAccountData,
): void {
  ensureAccountsDir();
  fs.writeFileSync(
    accountFilePath(accountId, 'account.json'),
    JSON.stringify(data, null, 2),
    'utf-8',
  );
}

export function loadWeixinAccount(
  accountId: string,
): WeixinAccountData | undefined {
  try {
    const raw = fs.readFileSync(
      accountFilePath(accountId, 'account.json'),
      'utf-8',
    );
    return JSON.parse(raw) as WeixinAccountData;
  } catch {
    return undefined;
  }
}

export function listWeixinAccountIds(): string[] {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs
    .readdirSync(ACCOUNTS_DIR)
    .filter((f) => f.endsWith('.account.json'))
    .map((f) => f.replace(/\.account\.json$/, ''));
}

export function setDefaultAccount(accountId: string): void {
  fs.mkdirSync(WEIXIN_STORE_DIR, { recursive: true });
  fs.writeFileSync(DEFAULT_ACCOUNT_FILE, accountId, 'utf-8');
}

export function getDefaultAccount(): string | undefined {
  try {
    const raw = fs.readFileSync(DEFAULT_ACCOUNT_FILE, 'utf-8').trim();
    return raw || undefined;
  } catch {
    // If no explicit default, fall back to the first account we find.
    const ids = listWeixinAccountIds();
    return ids[0];
  }
}

export function loadContextTokens(accountId: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(
      accountFilePath(accountId, 'context-tokens.json'),
      'utf-8',
    );
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveContextTokens(
  accountId: string,
  tokens: Record<string, string>,
): void {
  ensureAccountsDir();
  try {
    fs.writeFileSync(
      accountFilePath(accountId, 'context-tokens.json'),
      JSON.stringify(tokens),
      'utf-8',
    );
  } catch (err) {
    logger.warn({ err: String(err) }, 'weixin: persist context tokens failed');
  }
}

export function loadSyncBuf(accountId: string): string | undefined {
  try {
    const raw = fs.readFileSync(
      accountFilePath(accountId, 'sync.json'),
      'utf-8',
    );
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    return typeof data.get_updates_buf === 'string'
      ? data.get_updates_buf
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveSyncBuf(accountId: string, buf: string): void {
  ensureAccountsDir();
  try {
    fs.writeFileSync(
      accountFilePath(accountId, 'sync.json'),
      JSON.stringify({ get_updates_buf: buf }),
      'utf-8',
    );
  } catch (err) {
    logger.warn({ err: String(err) }, 'weixin: persist sync buf failed');
  }
}
