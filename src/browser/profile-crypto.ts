/**
 * Browser Profile Encryption
 *
 * Encrypts/decrypts browser profile directories at rest using AES-256-GCM.
 * Keys are stored in OneCLI vault, never on disk.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16;
// Encrypted file layout: [IV (12 bytes)] [authTag (16 bytes)] [ciphertext]
const HEADER_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH;

/**
 * Generate a new AES-256 encryption key.
 */
export function generateEncryptionKey(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Encrypt a single file's contents in place.
 * Overwrites the file with: IV || authTag || ciphertext.
 */
function encryptFile(filePath: string, key: Buffer): void {
  const plaintext = fs.readFileSync(filePath);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Write: IV + authTag + ciphertext
  const output = Buffer.concat([iv, authTag, encrypted]);
  fs.writeFileSync(filePath, output);
}

/**
 * Decrypt a single file's contents, returning the plaintext buffer.
 */
function decryptFile(filePath: string, key: Buffer): Buffer {
  const data = fs.readFileSync(filePath);
  if (data.length < HEADER_LENGTH) {
    throw new Error(`File too small to contain encrypted data: ${filePath}`);
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, HEADER_LENGTH);
  const ciphertext = data.subarray(HEADER_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Recursively list all files in a directory.
 */
function listFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Encrypt all files in a browser profile directory in place.
 * After calling this, the files on disk are ciphertext.
 */
export function encryptProfile(profileDir: string, key: Buffer): void {
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile directory does not exist: ${profileDir}`);
  }
  const files = listFiles(profileDir);
  for (const file of files) {
    encryptFile(file, key);
  }
}

/**
 * Decrypt a browser profile directory to a temporary location.
 * Returns the path to the temporary directory containing plaintext files.
 * Caller is responsible for cleaning up the temp directory.
 */
export function decryptProfile(profileDir: string, key: Buffer): string {
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile directory does not exist: ${profileDir}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-browser-'));
  const files = listFiles(profileDir);

  for (const file of files) {
    const relativePath = path.relative(profileDir, file);
    const destPath = path.join(tmpDir, relativePath);
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    const plaintext = decryptFile(file, key);
    fs.writeFileSync(destPath, plaintext);
  }

  return tmpDir;
}

/**
 * Encrypt a plaintext buffer and return the ciphertext (IV || authTag || ciphertext).
 */
export function encryptBuffer(plaintext: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Encrypt a single file in place.
 * Overwrites the file with: IV || authTag || ciphertext.
 */
export function encryptSingleFile(filePath: string, key: Buffer): void {
  encryptFile(filePath, key);
}

/**
 * Decrypt a single file, returning the plaintext buffer.
 * The file on disk remains encrypted.
 */
export function decryptSingleFile(filePath: string, key: Buffer): Buffer {
  return decryptFile(filePath, key);
}
