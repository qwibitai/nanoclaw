/**
 * CredentialStore — file-based CRUD with AES-256-GCM encryption.
 *
 * Credentials stored at ~/.config/nanoclaw/credentials/{scope}/{service}.json
 * Encryption key at ~/.config/nanoclaw/encryption-key (hex, mode 0600)
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import type { StoredCredential } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ENC_PREFIX = 'enc:';

const CONFIG_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
);
const CREDENTIALS_DIR = path.join(CONFIG_DIR, 'credentials');
const KEY_PATH = path.join(CONFIG_DIR, 'encryption-key');

let encryptionKey: Buffer | null = null;

/** Ensure key file exists and load it. */
export function initCredentialStore(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (!fs.existsSync(KEY_PATH)) {
    const key = crypto.randomBytes(KEY_BYTES).toString('hex');
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
    logger.info('Generated new encryption key');
  }

  const hex = fs.readFileSync(KEY_PATH, 'utf-8').trim();
  encryptionKey = Buffer.from(hex, 'hex');
  if (encryptionKey.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be ${KEY_BYTES} bytes, got ${encryptionKey.length}`,
    );
  }
}

function requireKey(): Buffer {
  if (!encryptionKey) {
    throw new Error('CredentialStore not initialized — call initCredentialStore() first');
  }
  return encryptionKey;
}

function keyHash16(): string {
  const key = requireKey();
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function credPath(scope: string, service: string): string {
  return path.join(CREDENTIALS_DIR, scope, `${service}.json`);
}

export function hasCredential(scope: string, service: string): boolean {
  return fs.existsSync(credPath(scope, service));
}

export function loadCredential(
  scope: string,
  service: string,
): StoredCredential | null {
  const p = credPath(scope, service);
  try {
    const data = fs.readFileSync(p, 'utf-8');
    return JSON.parse(data) as StoredCredential;
  } catch {
    return null;
  }
}

export function saveCredential(
  scope: string,
  service: string,
  cred: StoredCredential,
): void {
  const p = credPath(scope, service);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
}

export function deleteCredential(scope: string, service: string): void {
  const p = credPath(scope, service);
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** Encrypt plaintext → enc:aes-256-gcm:<keyHash16>:<iv>:<tag>:<ciphertext> */
export function encrypt(plaintext: string): string {
  const key = requireKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'enc',
    ALGORITHM,
    keyHash16(),
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/** Decrypt enc: prefixed string, or return plaintext as-is. */
export function decrypt(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;

  const parts = value.split(':');
  // enc : algorithm : keyHash : iv : tag : ciphertext
  if (parts.length !== 6) throw new Error('Malformed encrypted value');

  const key = requireKey();
  const iv = Buffer.from(parts[3], 'base64');
  const tag = Buffer.from(parts[4], 'base64');
  const ciphertext = Buffer.from(parts[5], 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf-8');
}
