/**
 * Per-Group Credential Management System
 *
 * Allows each group to have its own credentials, enabling:
 * - Multi-tenant isolation
 * - Different API keys for different projects
 * - Safe credential rotation per group
 * - Interactive reauth via channels
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

/**
 * Credential types supported
 */
export type CredentialType = 'api_key' | 'oauth_token' | 'custom';

/**
 * Stored credential (encrypted)
 */
export interface StoredCredential {
  id: string;
  groupId: string;
  type: CredentialType;
  provider: string; // 'anthropic', 'openai', etc.
  encrypted: string; // AES-256-GCM encrypted
  iv: string; // Initialization vector
  authTag: string; // GCM authentication tag
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Credential input (plaintext)
 */
export interface CredentialInput {
  type: CredentialType;
  provider: string;
  value: string;
  expiresIn?: number; // Seconds until expiry
  metadata?: Record<string, unknown>;
}

/**
 * Credential manager config
 */
export interface CredentialManagerConfig {
  storagePath: string;
  masterKey?: string; // If not provided, generates random
  autoRotate?: boolean;
  rotationIntervalDays?: number;
}

/**
 * Encryption result
 */
interface EncryptedData {
  encrypted: string;
  iv: string;
  authTag: string;
}

/**
 * Per-Group Credential Manager
 */
export class GroupCredentialManager extends EventEmitter {
  private config: Required<CredentialManagerConfig>;
  private masterKey: Buffer;
  private credentials: Map<string, StoredCredential> = new Map();
  private rotationTimer?: NodeJS.Timeout;

  constructor(config: Partial<CredentialManagerConfig> = {}) {
    super();
    this.config = {
      storagePath: config.storagePath || './data/credentials',
      masterKey: config.masterKey || crypto.randomBytes(32).toString('hex'),
      autoRotate: config.autoRotate ?? false,
      rotationIntervalDays: config.rotationIntervalDays || 90,
    };

    this.masterKey = Buffer.from(this.config.masterKey, 'hex');
    this.ensureStorageDir();
    this.loadCredentials();
    
    if (this.config.autoRotate) {
      this.startAutoRotation();
    }
  }

  /**
   * Store credential for a group
   */
  async storeCredential(
    groupId: string,
    credential: CredentialInput,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const encrypted = this.encrypt(credential.value);

    const stored: StoredCredential = {
      id,
      groupId,
      type: credential.type,
      provider: credential.provider,
      ...encrypted,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: credential.expiresIn 
        ? new Date(Date.now() + credential.expiresIn * 1000)
        : undefined,
      metadata: credential.metadata,
    };

    this.credentials.set(`${groupId}:${credential.provider}`, stored);
    await this.persistCredential(stored);

    this.emit('credential_stored', { groupId, provider: credential.provider });

    return id;
  }

  /**
   * Retrieve credential for a group
   */
  async getCredential(
    groupId: string,
    provider: string,
  ): Promise<string | null> {
    const key = `${groupId}:${provider}`;
    const stored = this.credentials.get(key);

    if (!stored) {
      return null;
    }

    // Check expiry
    if (stored.expiresAt && stored.expiresAt < new Date()) {
      this.emit('credential_expired', { groupId, provider });
      return null;
    }

    return this.decrypt(stored);
  }

  /**
   * Check if group has credential
   */
  hasCredential(groupId: string, provider: string): boolean {
    const stored = this.credentials.get(`${groupId}:${provider}`);
    if (!stored) return false;
    
    // Check expiry
    if (stored.expiresAt && stored.expiresAt < new Date()) {
      return false;
    }
    
    return true;
  }

  /**
   * Remove credential
   */
  async removeCredential(groupId: string, provider: string): Promise<boolean> {
    const key = `${groupId}:${provider}`;
    const stored = this.credentials.get(key);
    
    if (!stored) {
      return false;
    }

    this.credentials.delete(key);
    await this.deleteCredentialFile(stored);

    this.emit('credential_removed', { groupId, provider });

    return true;
  }

  /**
   * Rotate credential
   */
  async rotateCredential(
    groupId: string,
    provider: string,
    newValue: string,
  ): Promise<void> {
    const key = `${groupId}:${provider}`;
    const stored = this.credentials.get(key);

    if (!stored) {
      throw new Error(`No credential to rotate: ${groupId}:${provider}`);
    }

    const encrypted = this.encrypt(newValue);
    
    stored.encrypted = encrypted.encrypted;
    stored.iv = encrypted.iv;
    stored.authTag = encrypted.authTag;
    stored.updatedAt = new Date();

    await this.persistCredential(stored);

    this.emit('credential_rotated', { groupId, provider });
  }

  /**
   * List all providers for a group
   */
  listProviders(groupId: string): string[] {
    const providers: string[] = [];
    
    for (const [key, cred] of this.credentials) {
      if (key.startsWith(`${groupId}:`)) {
        providers.push(cred.provider);
      }
    }

    return providers;
  }

  /**
   * Start interactive reauth flow
   */
  async startReauthFlow(
    groupId: string,
    provider: string,
    channel: string,
  ): Promise<string> {
    const flowId = crypto.randomUUID();
    
    // Store flow state
    const flowData = {
      flowId,
      groupId,
      provider,
      channel,
      startedAt: new Date(),
      status: 'pending',
    };

    this.emit('reauth_started', flowData);

    // In production, would send message to channel asking for new credential
    // User replies with new credential
    // Flow completes when new credential is stored

    return flowId;
  }

  /**
   * Complete reauth flow
   */
  async completeReauthFlow(
    flowId: string,
    credential: CredentialInput,
  ): Promise<void> {
    // In production, would verify flowId and match groupId/provider
    await this.storeCredential(credential.provider, credential);
    
    this.emit('reauth_completed', { flowId, provider: credential.provider });
  }

  /**
   * Encrypt plaintext
   */
  private encrypt(plaintext: string): EncryptedData {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.masterKey,
      iv,
    );

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  /**
   * Decrypt ciphertext
   */
  private decrypt(stored: StoredCredential): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.masterKey,
      Buffer.from(stored.iv, 'base64'),
    );

    decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(stored.encrypted, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Ensure storage directory exists
   */
  private ensureStorageDir(): void {
    fs.mkdirSync(this.config.storagePath, { recursive: true });
  }

  /**
   * Load all credentials from disk
   */
  private loadCredentials(): void {
    const files = fs.readdirSync(this.config.storagePath);
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = fs.readFileSync(
          path.join(this.config.storagePath, file),
          'utf8',
        );
        const stored = JSON.parse(content) as StoredCredential;
        
        // Convert date strings back to Date objects
        stored.createdAt = new Date(stored.createdAt);
        stored.updatedAt = new Date(stored.updatedAt);
        if (stored.expiresAt) {
          stored.expiresAt = new Date(stored.expiresAt);
        }

        const key = `${stored.groupId}:${stored.provider}`;
        this.credentials.set(key, stored);
      } catch (err) {
        this.emit('load_error', { file, error: err });
      }
    }
  }

  /**
   * Persist credential to disk
   */
  private async persistCredential(cred: StoredCredential): Promise<void> {
    const file = path.join(this.config.storagePath, `${cred.id}.json`);
    fs.writeFileSync(file, JSON.stringify(cred, null, 2));
  }

  /**
   * Delete credential file
   */
  private async deleteCredentialFile(cred: StoredCredential): Promise<void> {
    const file = path.join(this.config.storagePath, `${cred.id}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  /**
   * Start auto-rotation timer
   */
  private startAutoRotation(): void {
    const intervalMs = this.config.rotationIntervalDays * 24 * 60 * 60 * 1000;
    
    this.rotationTimer = setInterval(() => {
      this.emit('rotation_check');
    }, intervalMs);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
    }
    this.credentials.clear();
  }
}

export {
  GroupCredentialManager,
  type StoredCredential,
  type CredentialInput,
  type CredentialType,
  type CredentialManagerConfig,
};
