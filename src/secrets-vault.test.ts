import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// Dynamic import so tests are individually discoverable even when module doesn't exist yet
async function loadVault() {
  const mod = await import('./secrets-vault.js');
  return mod.SecretsVault;
}

// Helper: generate a valid master key (32 bytes = 64 hex chars)
function validMasterKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Helper: generate a short (invalid) master key
function shortMasterKey(): string {
  return crypto.randomBytes(16).toString('hex'); // 16 bytes = 32 hex chars, < 32 bytes
}

describe('SecretsVault', () => {
  let tmpDir: string;
  let secretsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-vault-test-'));
    secretsDir = path.join(tmpDir, 'test-group');
    fs.mkdirSync(secretsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test Case 1: "should encrypt and decrypt a secret round-trip" ---
  // SPEC: WHEN a secret is stored, THEN generate random salt, derive key via HKDF-SHA256,
  //   encrypt with AES-256-GCM. WHEN retrieved, re-derive key, decrypt, return plaintext.
  it('should encrypt and decrypt a secret round-trip', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    const secretName = 'OPENAI_API_KEY';
    const secretValue = 'sk-proj-abc123xyz789';

    await vault.store(secretName, secretValue);
    const retrieved = await vault.get(secretName);

    expect(retrieved).toBe(secretValue);
  });

  // --- Test Case 2: "should produce different ciphertext for same plaintext (random salt + nonce)" ---
  // SPEC: Each store generates a random 32-byte salt and random 12-byte nonce,
  //   so storing the same plaintext twice must produce different encrypted blobs.
  it('should produce different ciphertext for same plaintext (random salt + nonce)', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();

    // Create two separate vaults (same master key, different dirs) to compare raw storage
    const dir1 = path.join(tmpDir, 'group-a');
    const dir2 = path.join(tmpDir, 'group-b');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const vault1 = await SecretsVault.create(masterKey, dir1);
    const vault2 = await SecretsVault.create(masterKey, dir2);

    const secretName = 'API_KEY';
    const secretValue = 'same-plaintext-value';

    await vault1.store(secretName, secretValue);
    await vault2.store(secretName, secretValue);

    // Read the raw encrypted files — storage format is groups/{name}/.secrets.enc
    const file1 = fs.readFileSync(path.join(dir1, '.secrets.enc'), 'utf-8');
    const file2 = fs.readFileSync(path.join(dir2, '.secrets.enc'), 'utf-8');

    // The encrypted blobs must differ due to random salt + nonce
    expect(file1).not.toBe(file2);

    // But both must still decrypt to the same value
    const val1 = await vault1.get(secretName);
    const val2 = await vault2.get(secretName);
    expect(val1).toBe(secretValue);
    expect(val2).toBe(secretValue);
  });

  // --- Test Case 3: "should reject tampered ciphertext (auth tag mismatch)" ---
  // SPEC: On auth tag mismatch (tampered data), throw descriptive error.
  it('should reject tampered ciphertext (auth tag mismatch)', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    await vault.store('MY_SECRET', 'sensitive-data');

    // Tamper with the encrypted file
    const secretsFile = path.join(secretsDir, '.secrets.enc');
    const raw = fs.readFileSync(secretsFile, 'utf-8');
    const parsed = JSON.parse(raw);

    // Find the stored blob and corrupt it
    const key = Object.keys(parsed)[0];
    const blob = parsed[key];
    // Decode base64, flip some bytes in the ciphertext portion, re-encode
    const buf = Buffer.from(blob, 'base64');
    // Corrupt a byte in the middle of the buffer (past salt + nonce = 32 + 12 = 44 bytes)
    if (buf.length > 50) {
      buf[50] ^= 0xff;
    }
    parsed[key] = buf.toString('base64');
    fs.writeFileSync(secretsFile, JSON.stringify(parsed));

    // Re-create vault to read tampered data
    const vault2 = await SecretsVault.create(masterKey, secretsDir);
    await expect(vault2.get('MY_SECRET')).rejects.toThrow();
  });

  // --- Test Case 4: "should reject master key shorter than 32 bytes" ---
  // SPEC: WHEN SOVEREIGN_MASTER_KEY is not set or < 32 bytes, THEN refuse to start.
  //   Log clear error: "SOVEREIGN_MASTER_KEY must be at least 32 bytes (64 hex characters)."
  it('should reject master key shorter than 32 bytes', async () => {
    const SecretsVault = await loadVault();
    const tooShort = shortMasterKey(); // 16 bytes = 32 hex chars

    await expect(
      SecretsVault.create(tooShort, secretsDir)
    ).rejects.toThrow('SOVEREIGN_MASTER_KEY must be at least 32 bytes (64 hex characters)');
  });

  // --- Test Case 4b: empty master key variant ---
  it('should reject empty master key', async () => {
    const SecretsVault = await loadVault();

    await expect(
      SecretsVault.create('', secretsDir)
    ).rejects.toThrow('SOVEREIGN_MASTER_KEY must be at least 32 bytes (64 hex characters)');
  });

  // --- Test Case 5: "should list secret names without exposing values" ---
  // SPEC: WHEN secrets are listed, THEN return names only -- never return decrypted values.
  it('should list secret names without exposing values', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    await vault.store('API_KEY', 'sk-secret-123');
    await vault.store('DB_PASSWORD', 'super-secret-pw');
    await vault.store('WEBHOOK_TOKEN', 'tok-abc');

    const names = await vault.list();

    // Should return all three names
    expect(names).toHaveLength(3);
    expect(names).toContain('API_KEY');
    expect(names).toContain('DB_PASSWORD');
    expect(names).toContain('WEBHOOK_TOKEN');

    // Should be an array of strings (names only), not objects with values
    for (const entry of names) {
      expect(typeof entry).toBe('string');
    }

    // Ensure no secret values leak in the list result
    const serialized = JSON.stringify(names);
    expect(serialized).not.toContain('sk-secret-123');
    expect(serialized).not.toContain('super-secret-pw');
    expect(serialized).not.toContain('tok-abc');
  });

  // --- Test Case 6: "should overwrite existing secret with same name" ---
  // SPEC: WHEN a secret with the same name already exists, THEN overwrite (update, not duplicate).
  it('should overwrite existing secret with same name', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    await vault.store('API_KEY', 'old-value');
    await vault.store('API_KEY', 'new-value');

    const retrieved = await vault.get('API_KEY');
    expect(retrieved).toBe('new-value');

    // Should still only have one entry, not two
    const names = await vault.list();
    const count = names.filter((n: string) => n === 'API_KEY').length;
    expect(count).toBe(1);
  });

  // --- Test Case 7: "should rotate all secrets to new master key atomically" ---
  // SPEC: WHEN key rotation is requested, THEN decrypt all with old key, re-encrypt with new key,
  //   write atomically (temp file + rename). On failure, old file preserved.
  it('should rotate all secrets to new master key atomically', async () => {
    const SecretsVault = await loadVault();
    const oldKey = validMasterKey();
    const newKey = validMasterKey();
    const vault = await SecretsVault.create(oldKey, secretsDir);

    // Store multiple secrets
    await vault.store('SECRET_A', 'value-a');
    await vault.store('SECRET_B', 'value-b');
    await vault.store('SECRET_C', 'value-c');

    // Capture file content before rotation
    const secretsFile = path.join(secretsDir, '.secrets.enc');
    const beforeRotation = fs.readFileSync(secretsFile, 'utf-8');

    // Rotate to new key
    await vault.rotate(newKey);

    // File content should have changed (re-encrypted)
    const afterRotation = fs.readFileSync(secretsFile, 'utf-8');
    expect(afterRotation).not.toBe(beforeRotation);

    // New vault with new key should decrypt all secrets
    const newVault = await SecretsVault.create(newKey, secretsDir);
    expect(await newVault.get('SECRET_A')).toBe('value-a');
    expect(await newVault.get('SECRET_B')).toBe('value-b');
    expect(await newVault.get('SECRET_C')).toBe('value-c');

    // Old key should no longer work
    const oldVault = await SecretsVault.create(oldKey, secretsDir);
    await expect(oldVault.get('SECRET_A')).rejects.toThrow();
  });

  // --- Test Case 8: "should create empty secrets file if none exists" ---
  // SPEC: WHEN SOVEREIGN_MASTER_KEY is set but no secrets file exists, THEN create empty secrets file.
  it('should create empty secrets file if none exists', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const freshDir = path.join(tmpDir, 'fresh-group');
    fs.mkdirSync(freshDir, { recursive: true });

    const secretsFile = path.join(freshDir, '.secrets.enc');
    expect(fs.existsSync(secretsFile)).toBe(false);

    const vault = await SecretsVault.create(masterKey, freshDir);

    // After creation, the secrets file should exist
    expect(fs.existsSync(secretsFile)).toBe(true);

    // Listing should return empty array
    const names = await vault.list();
    expect(names).toEqual([]);
  });

  // --- Test Case 9: "should reject secret names with path separators" ---
  // SPEC: REJECTS: Secret names with path separators.
  it('should reject secret names with path separators', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    await expect(vault.store('../etc/passwd', 'malicious')).rejects.toThrow();
    await expect(vault.store('foo/bar', 'value')).rejects.toThrow();
    await expect(vault.store('foo\\bar', 'value')).rejects.toThrow();
    await expect(vault.store('path/to/secret', 'value')).rejects.toThrow();
  });

  // --- Additional: reject empty secret names ---
  // SPEC: REJECTS: Empty secret names.
  it('should reject empty secret names', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    await expect(vault.store('', 'some-value')).rejects.toThrow();
  });

  // --- Additional: delete a secret ---
  // SPEC: Implied by the SecretsVault interface having a delete method.
  it('should delete a stored secret', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    await vault.store('TO_DELETE', 'doomed-value');
    expect(await vault.get('TO_DELETE')).toBe('doomed-value');

    await vault.delete('TO_DELETE');

    // After deletion, get should return null/undefined or throw
    const result = await vault.get('TO_DELETE');
    expect(result).toBeUndefined();
  });

  // --- Additional: get non-existent secret returns undefined ---
  it('should return undefined for non-existent secret', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    const result = await vault.get('DOES_NOT_EXIST');
    expect(result).toBeUndefined();
  });

  // --- Additional: rotation preserves atomicity on failure ---
  // SPEC: On failure, old file preserved.
  it('should preserve old secrets file if rotation fails', async () => {
    const SecretsVault = await loadVault();
    const oldKey = validMasterKey();
    const vault = await SecretsVault.create(oldKey, secretsDir);

    await vault.store('PRESERVED', 'keep-me');

    const secretsFile = path.join(secretsDir, '.secrets.enc');
    const beforeContent = fs.readFileSync(secretsFile, 'utf-8');

    // Attempt rotation with an invalid new key (too short) — should fail
    await expect(vault.rotate(shortMasterKey())).rejects.toThrow();

    // Original file should be unchanged
    const afterContent = fs.readFileSync(secretsFile, 'utf-8');
    expect(afterContent).toBe(beforeContent);

    // Original vault should still work
    const checkVault = await SecretsVault.create(oldKey, secretsDir);
    expect(await checkVault.get('PRESERVED')).toBe('keep-me');
  });

  // --- Additional: storage format is base64(salt || nonce || ciphertext || auth_tag) ---
  // SPEC: store as: salt || nonce || ciphertext || auth_tag (all base64).
  it('should store encrypted data in the expected binary format', async () => {
    const SecretsVault = await loadVault();
    const masterKey = validMasterKey();
    const vault = await SecretsVault.create(masterKey, secretsDir);

    await vault.store('FORMAT_TEST', 'check-format');

    const secretsFile = path.join(secretsDir, '.secrets.enc');
    const raw = fs.readFileSync(secretsFile, 'utf-8');
    const parsed = JSON.parse(raw);

    // There should be an entry for FORMAT_TEST
    expect(parsed).toHaveProperty('FORMAT_TEST');

    // The stored value should be valid base64
    const blob = parsed['FORMAT_TEST'];
    expect(typeof blob).toBe('string');
    const decoded = Buffer.from(blob, 'base64');

    // Minimum size: 32 (salt) + 12 (nonce) + 1 (min ciphertext) + 16 (auth tag) = 61 bytes
    expect(decoded.length).toBeGreaterThanOrEqual(61);
  });
});
