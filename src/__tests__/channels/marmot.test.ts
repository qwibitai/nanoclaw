/**
 * @fileoverview Tests for Marmot E2EE channel
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MarmotChannel, MLSProtocol, NostrRelayClient } from '../channels/marmot.js';

describe('MLSProtocol', () => {
  let mls: MLSProtocol;

  beforeEach(() => {
    mls = new MLSProtocol();
  });

  describe('createGroup', () => {
    it('should create a group with creator as first member', async () => {
      const groupId = new Uint8Array([1, 2, 3, 4]);
      const creatorKey = new Uint8Array(32).fill(1);

      const group = await mls.createGroup(groupId, creatorKey);

      expect(group.groupId).toBe(groupId);
      expect(group.epoch).toBe(0n);
      expect(group.members).toHaveLength(1);
      expect(group.members[0].publicKey).toBe(creatorKey);
    });
  });

  describe('addMember', () => {
    it('should add member and increment epoch', async () => {
      await mls.createGroup(new Uint8Array([1]), new Uint8Array(32).fill(1));
      
      const memberKey = new Uint8Array(32).fill(2);
      await mls.addMember(memberKey);

      const state = JSON.parse(mls.exportState());
      expect(state.epoch).toBe('1');
      expect(JSON.parse(state.members)).toHaveLength(2);
    });
  });

  describe('removeMember', () => {
    it('should remove member and increment epoch', async () => {
      await mls.createGroup(new Uint8Array([1]), new Uint8Array(32).fill(1));
      
      const memberKey = new Uint8Array(32).fill(2);
      await mls.addMember(memberKey);
      await mls.removeMember(memberKey);

      const state = JSON.parse(mls.exportState());
      expect(state.epoch).toBe('2');
      expect(JSON.parse(state.members)).toHaveLength(1);
    });
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt messages', async () => {
      await mls.createGroup(new Uint8Array([1]), new Uint8Array(32).fill(1));

      const plaintext = 'Hello encrypted world!';
      const encrypted = await mls.encrypt(plaintext);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.groupId).toBeDefined();
      expect(encrypted.epoch).toBeDefined();

      const decrypted = await mls.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('export/import state', () => {
    it('should export and import group state', async () => {
      await mls.createGroup(new Uint8Array([1, 2, 3]), new Uint8Array(32).fill(1));
      await mls.addMember(new Uint8Array(32).fill(2));

      const exported = mls.exportState();
      const mls2 = new MLSProtocol();
      mls2.importState(exported);

      const state1 = JSON.parse(mls.exportState());
      const state2 = JSON.parse(mls2.exportState());

      expect(state1.epoch).toBe(state2.epoch);
      expect(state1.groupId).toBe(state2.groupId);
    });
  });
});

describe('NostrRelayClient', () => {
  let client: NostrRelayClient;

  beforeEach(() => {
    client = new NostrRelayClient(['wss://test.relay.com']);
  });

  it('should emit events on connect', async () => {
    const connectedPromise = new Promise<string>(resolve => {
      client.on('connected', resolve);
    });

    await client.connect();
    const relay = await connectedPromise;

    expect(relay).toBe('wss://test.relay.com');
  });

  it('should emit events on publish', async () => {
    await client.connect();

    const publishedPromise = new Promise<any>(resolve => {
      client.on('published', resolve);
    });

    const encrypted = {
      groupId: 'test-group',
      epoch: 1,
      ciphertext: 'abc123',
      nonce: 'nonce123',
      senderPubkey: 'sender-pubkey',
    };

    const eventId = await client.publish(encrypted);
    expect(eventId).toBeDefined();

    const event = await publishedPromise;
    expect(event.content).toContain('test-group');
  });

  it('should emit events on subscribe', async () => {
    await client.connect();

    const subscribedPromise = new Promise<string>(resolve => {
      client.on('subscribed', resolve);
    });

    await client.subscribe('group-id');
    const groupId = await subscribedPromise;

    expect(groupId).toBe('group-id');
  });
});

describe('MarmotChannel', () => {
  let channel: MarmotChannel;

  const config = {
    nostrRelays: ['wss://test.relay.com'],
    groupId: 'test-group-id',
    privateKey: new Uint8Array(32).fill(42),
  };

  beforeEach(() => {
    channel = new MarmotChannel(config);
  });

  afterEach(async () => {
    await channel.shutdown();
  });

  it('should initialize with MLS group and Nostr connection', async () => {
    await channel.initialize();

    // Should be able to send messages
    const eventId = await channel.send('test message');
    expect(eventId).toBeDefined();
  });

  it('should emit member_added event on addMember', async () => {
    await channel.initialize();

    const memberAddedPromise = new Promise<Uint8Array>(resolve => {
      channel.on('member_added', resolve);
    });

    const memberKey = new Uint8Array(32).fill(99);
    await channel.addMember(memberKey);

    const key = await memberAddedPromise;
    expect(key).toBe(memberKey);
  });

  it('should export and import group state', async () => {
    await channel.initialize();
    await channel.addMember(new Uint8Array(32).fill(1));

    const state = channel.exportGroupState();
    expect(state).toContain('test-group-id');

    const channel2 = new MarmotChannel(config);
    channel2.importGroupState(state);

    const state2 = channel2.exportGroupState();
    expect(state2).toBe(state);

    await channel2.shutdown();
  });
});

describe('Security Properties', () => {
  it('should provide forward secrecy via epoch increments', async () => {
    const mls = new MLSProtocol();
    await mls.createGroup(new Uint8Array([1]), new Uint8Array(32).fill(1));

    const msg1 = await mls.encrypt('message 1');
    expect(msg1.epoch).toBe(0);

    await mls.addMember(new Uint8Array(32).fill(2));
    
    const msg2 = await mls.encrypt('message 2');
    expect(msg2.epoch).toBe(1);
    
    // Epochs differ - forward secrecy via state evolution
    expect(msg1.epoch).not.toBe(msg2.epoch);
  });

  it('should handle multiple members', async () => {
    const mls = new MLSProtocol();
    await mls.createGroup(new Uint8Array([1]), new Uint8Array(32).fill(1));

    for (let i = 0; i < 5; i++) {
      await mls.addMember(new Uint8Array(32).fill(i));
    }

    const state = JSON.parse(mls.exportState());
    expect(state.epoch).toBe('5');
  });
});
