import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

interface TokenEntry {
  source: string;
  groupJid: string;
  created: string;
}

interface TokensFile {
  tokens: Record<string, TokenEntry>;
}

const TOKENS_PATH = path.join(DATA_DIR, 'webhooks.json');

function readFile(): TokensFile {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
  } catch {
    return { tokens: {} };
  }
}

function writeFile(data: TokensFile): void {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(data, null, 2));
}

export function loadTokens(): Record<string, TokenEntry> {
  return readFile().tokens;
}

export function validateToken(token: string): { source: string; groupJid: string } | null {
  const entry = readFile().tokens[token];
  return entry ? { source: entry.source, groupJid: entry.groupJid } : null;
}

export function generateToken(source: string, groupJid: string): string {
  const data = readFile();
  const token = crypto.randomUUID();
  data.tokens[token] = { source, groupJid, created: new Date().toISOString() };
  writeFile(data);
  return token;
}

export function revokeToken(token: string): boolean {
  const data = readFile();
  if (!data.tokens[token]) return false;
  delete data.tokens[token];
  writeFile(data);
  return true;
}
