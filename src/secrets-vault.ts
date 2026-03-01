import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from './logger.js';

const HKDF_INFO = 'sovereign-secrets-v1';
const SALT_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_MASTER_KEY_BYTES = 32;
const SECRETS_FILENAME = '.secrets.enc';

function validateMasterKey(masterKey: string): void {
  if (masterKey.length < MIN_MASTER_KEY_BYTES * 2) {
    throw new Error(
      'SOVEREIGN_MASTER_KEY must be at least 32 bytes (64 hex characters).',
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(masterKey)) {
    throw new Error(
      'SOVEREIGN_MASTER_KEY must contain only hex characters (0-9, a-f).',
    );
  }
}

function validateSecretName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error('Secret name must not be empty.');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('Secret name must not contain path separators.');
  }
}

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(masterKey, 'hex'),
      salt,
      HKDF_INFO,
      KEY_LEN,
    ),
  );
}

function encrypt(masterKey: string, plaintext: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const derivedKey = deriveKey(masterKey, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // salt || nonce || ciphertext || auth_tag
  const blob = Buffer.concat([salt, nonce, encrypted, authTag]);
  return blob.toString('base64');
}

function decrypt(masterKey: string, base64Blob: string): string {
  const buf = Buffer.from(base64Blob, 'base64');

  const salt = buf.subarray(0, SALT_LEN);
  const nonce = buf.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
  const authTag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(SALT_LEN + NONCE_LEN, buf.length - TAG_LEN);

  const derivedKey = deriveKey(masterKey, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, nonce);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

type SecretsData = Record<string, string>;

function readSecrets(filePath: string): SecretsData {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as SecretsData;
}

function writeSecretsAtomic(filePath: string, data: SecretsData): void {
  const tmpPath = filePath + '.tmp.' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    throw err;
  }
}

export class SecretsVault {
  private masterKey: string;
  private secretsFile: string;

  private constructor(masterKey: string, groupDir: string) {
    this.masterKey = masterKey;
    this.secretsFile = path.join(groupDir, SECRETS_FILENAME);
  }

  static async create(
    masterKey: string,
    groupDir: string,
  ): Promise<SecretsVault> {
    validateMasterKey(masterKey);
    const vault = new SecretsVault(masterKey, groupDir);

    // Create empty secrets file if none exists
    if (!fs.existsSync(vault.secretsFile)) {
      writeSecretsAtomic(vault.secretsFile, {});
    }

    return vault;
  }

  async store(name: string, value: string): Promise<void> {
    validateSecretName(name);
    const data = readSecrets(this.secretsFile);
    data[name] = encrypt(this.masterKey, value);
    writeSecretsAtomic(this.secretsFile, data);
    logger.debug({ secret: name }, 'Secret stored');
  }

  async get(name: string): Promise<string | undefined> {
    const data = readSecrets(this.secretsFile);
    const blob = data[name];
    if (blob === undefined) {
      return undefined;
    }
    return decrypt(this.masterKey, blob);
  }

  async list(): Promise<string[]> {
    const data = readSecrets(this.secretsFile);
    return Object.keys(data);
  }

  async delete(name: string): Promise<void> {
    const data = readSecrets(this.secretsFile);
    delete data[name];
    writeSecretsAtomic(this.secretsFile, data);
    logger.debug({ secret: name }, 'Secret deleted');
  }

  async rotate(newMasterKey: string): Promise<void> {
    validateMasterKey(newMasterKey);

    const data = readSecrets(this.secretsFile);

    // Decrypt all with old key, re-encrypt with new key
    const reEncrypted: SecretsData = {};
    for (const [name, blob] of Object.entries(data)) {
      const plaintext = decrypt(this.masterKey, blob);
      reEncrypted[name] = encrypt(newMasterKey, plaintext);
    }

    // Write atomically — on failure, old file is preserved
    writeSecretsAtomic(this.secretsFile, reEncrypted);

    // Update in-memory master key
    this.masterKey = newMasterKey;
    logger.info({ secretCount: Object.keys(reEncrypted).length }, 'Secrets vault rotated');
  }
}
