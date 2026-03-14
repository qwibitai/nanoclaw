/**
 * Per-group GPG key management for secure credential exchange via chat.
 *
 * Each group (scope) gets its own GPG homedir at
 * ~/.config/nanoclaw/credentials/{scope}/.gnupg/
 * with an auto-generated keypair. The public key is shown to the user
 * so they can encrypt secrets locally before pasting into chat.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';

const CONFIG_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
);
const CREDENTIALS_DIR = path.join(CONFIG_DIR, 'credentials');

const GPG_BIN = 'gpg';
const KEY_ID = 'nanoclaw';

function gpgHome(scope: string): string {
  return path.join(CREDENTIALS_DIR, scope, '.gnupg');
}

/** Check if gpg is available on the host. */
export function isGpgAvailable(): boolean {
  try {
    execFileSync(GPG_BIN, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Ensure a GPG keypair exists for the given scope. Creates one if missing. */
export function ensureGpgKey(scope: string): void {
  const home = gpgHome(scope);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  // Check if key already exists
  try {
    const result = execFileSync(GPG_BIN, [
      '--homedir', home,
      '--list-keys', KEY_ID,
    ], { stdio: 'pipe' });
    if (result.length > 0) return;
  } catch {
    // Key doesn't exist — generate it
  }

  const batchConfig = [
    '%no-protection',
    'Key-Type: RSA',
    'Key-Length: 2048',
    'Subkey-Type: RSA',
    'Subkey-Length: 2048',
    `Name-Real: ${KEY_ID}`,
    `Name-Email: ${scope}@nanoclaw.local`,
    'Expire-Date: 0',
    '%commit',
  ].join('\n');

  execFileSync(GPG_BIN, [
    '--homedir', home,
    '--batch',
    '--gen-key',
  ], { input: batchConfig, stdio: ['pipe', 'pipe', 'pipe'] });

  logger.info({ scope }, 'Generated GPG keypair');
}

/** Export the ASCII-armored public key for the given scope. */
export function exportPublicKey(scope: string): string {
  const home = gpgHome(scope);
  const result = execFileSync(GPG_BIN, [
    '--homedir', home,
    '--armor',
    '--export', KEY_ID,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  return result.toString('utf-8').trim();
}

/** Decrypt a PGP-encrypted message. Returns the plaintext. */
export function gpgDecrypt(scope: string, ciphertext: string): string {
  const home = gpgHome(scope);
  const result = execFileSync(GPG_BIN, [
    '--homedir', home,
    '--batch',
    '--quiet',
    '--decrypt',
  ], { input: ciphertext, stdio: ['pipe', 'pipe', 'pipe'] });
  return result.toString('utf-8').trim();
}

/** Detect if a string contains a PGP-encrypted message. */
export function isPgpMessage(text: string): boolean {
  return text.includes('-----BEGIN PGP MESSAGE-----');
}
