/**
 * @fileoverview Tests for per-group credential management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  GroupCredentialManager,
  CredentialType,
  type CredentialInput,
} from '../credentials/group-manager.js';

describe('GroupCredentialManager', () => {
  let manager: GroupCredentialManager;
  const testStoragePath = './test-credentials';

  beforeEach(() => {
    // Clean test directory
    if (fs.existsSync(testStoragePath)) {
      fs.rmSync(testStoragePath, { recursive: true });
    }

    manager = new GroupCredentialManager({
      storagePath: testStoragePath,
      masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      autoRotate: false,
    });
  });

  afterEach(() => {
    manager.destroy();
    if (fs.existsSync(testStoragePath)) {
      fs.rmSync(testStoragePath, { recursive: true });
    }
  });

  describe('storeCredential', () => {
    it('should store and retrieve credential', async () => {
      const credential: CredentialInput = {
        type: 'api_key',
        provider: 'anthropic',
        value: 'sk-test-key',
      };

      const id = await manager.storeCredential('group-1', credential);
      expect(id).toBeDefined();

      const retrieved = await manager.getCredential('group-1', 'anthropic');
      expect(retrieved).toBe('sk-test-key');
    });

    it('should store OAuth token', async () => {
      const credential: CredentialInput = {
        type: 'oauth_token',
        provider: 'claude',
        value: 'oauth-token-123',
      };

      await manager.storeCredential('group-2', credential);

      const retrieved = await manager.getCredential('group-2', 'claude');
      expect(retrieved).toBe('oauth-token-123');
    });

    it('should emit credential_stored event', async () => {
      const eventPromise = new Promise<{ groupId: string; provider: string }>(resolve => {
        manager.on('credential_stored', resolve);
      });

      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'openai',
        value: 'sk-openai',
      });

      const event = await eventPromise;
      expect(event.groupId).toBe('group-1');
      expect(event.provider).toBe('openai');
    });
  });

  describe('getCredential', () => {
    it('should return null for non-existent credential', async () => {
      const result = await manager.getCredential('unknown', 'unknown');
      expect(result).toBe(null);
    });

    it('should return null for expired credential', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'test-key',
        expiresIn: -1, // Already expired
      });

      const eventPromise = new Promise<void>(resolve => {
        manager.on('credential_expired', () => resolve());
      });

      const result = await manager.getCredential('group-1', 'test');
      expect(result).toBe(null);

      await eventPromise; // Verify event was emitted
    });
  });

  describe('hasCredential', () => {
    it('should return true for existing credential', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'test-key',
      });

      expect(manager.hasCredential('group-1', 'test')).toBe(true);
    });

    it('should return false for non-existent credential', () => {
      expect(manager.hasCredential('group-1', 'test')).toBe(false);
    });
  });

  describe('removeCredential', () => {
    it('should remove credential', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'test-key',
      });

      const removed = await manager.removeCredential('group-1', 'test');
      expect(removed).toBe(true);

      const result = await manager.getCredential('group-1', 'test');
      expect(result).toBe(null);
    });

    it('should return false for non-existent credential', async () => {
      const removed = await manager.removeCredential('unknown', 'unknown');
      expect(removed).toBe(false);
    });

    it('should emit credential_removed event', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'test-key',
      });

      const eventPromise = new Promise<{ groupId: string; provider: string }>(resolve => {
        manager.on('credential_removed', resolve);
      });

      await manager.removeCredential('group-1', 'test');

      const event = await eventPromise;
      expect(event.groupId).toBe('group-1');
    });
  });

  describe('rotateCredential', () => {
    it('should rotate credential value', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'old-key',
      });

      await manager.rotateCredential('group-1', 'test', 'new-key');

      const result = await manager.getCredential('group-1', 'test');
      expect(result).toBe('new-key');
    });

    it('should throw for non-existent credential', async () => {
      await expect(
        manager.rotateCredential('unknown', 'unknown', 'new-value')
      ).rejects.toThrow('No credential to rotate');
    });

    it('should emit credential_rotated event', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'old-key',
      });

      const eventPromise = new Promise<{ groupId: string; provider: string }>(resolve => {
        manager.on('credential_rotated', resolve);
      });

      await manager.rotateCredential('group-1', 'test', 'new-key');

      const event = await eventPromise;
      expect(event.groupId).toBe('group-1');
    });
  });

  describe('listProviders', () => {
    it('should list all providers for a group', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'anthropic',
        value: 'key1',
      });
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'openai',
        value: 'key2',
      });

      const providers = manager.listProviders('group-1');
      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
      expect(providers).toHaveLength(2);
    });

    it('should return empty array for unknown group', () => {
      expect(manager.listProviders('unknown')).toEqual([]);
    });
  });

  describe('encryption', () => {
    it('should encrypt credential at rest', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'secret-key',
      });

      // Read raw file
      const files = fs.readdirSync(testStoragePath);
      const credFile = path.join(testStoragePath, files[0]);
      const content = fs.readFileSync(credFile, 'utf8');
      const stored = JSON.parse(content);

      // Should be encrypted, not plaintext
      expect(stored.encrypted).toBeDefined();
      expect(stored.encrypted).not.toContain('secret-key');
      expect(stored.iv).toBeDefined();
      expect(stored.authTag).toBeDefined();
    });
  });

  describe('reauth flow', () => {
    it('should start reauth flow', async () => {
      const flowId = await manager.startReauthFlow('group-1', 'test', 'telegram');
      expect(flowId).toBeDefined();
    });

    it('should emit reauth_started event', async () => {
      const eventPromise = new Promise<any>(resolve => {
        manager.on('reauth_started', resolve);
      });

      await manager.startReauthFlow('group-1', 'test', 'telegram');

      const event = await eventPromise;
      expect(event.groupId).toBe('group-1');
      expect(event.provider).toBe('test');
    });
  });

  describe('persistence', () => {
    it('should persist credentials to disk', async () => {
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'persisted-key',
      });

      // Check file exists
      const files = fs.readdirSync(testStoragePath);
      expect(files.length).toBeGreaterThan(0);
    });

    it('should load credentials on initialization', async () => {
      // Store credential
      await manager.storeCredential('group-1', {
        type: 'api_key',
        provider: 'test',
        value: 'test-key',
      });

      // Create new manager (simulates restart)
      manager.destroy();
      manager = new GroupCredentialManager({
        storagePath: testStoragePath,
        masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      });

      // Should load credential
      const result = await manager.getCredential('group-1', 'test');
      expect(result).toBe('test-key');
    });
  });
});
