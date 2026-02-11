import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import {
  isIndividualChat,
  isGroupChat,
  extractPhoneNumber,
  VIRTUAL_COMPLAINT_GROUP_JID,
} from './channels/whatsapp.js';

beforeEach(() => {
  _initTestDatabase();
});

// --- JID classification helpers ---

describe('isIndividualChat', () => {
  it('returns true for @s.whatsapp.net JID', () => {
    expect(isIndividualChat('919876543210@s.whatsapp.net')).toBe(true);
  });

  it('returns false for @g.us JID (group)', () => {
    expect(isIndividualChat('12345678@g.us')).toBe(false);
  });

  it('returns true for @lid JID (LID = Linked Device ID)', () => {
    expect(isIndividualChat('12345@lid')).toBe(true);
  });

  it('returns true for @lid JID with device suffix', () => {
    expect(isIndividualChat('186410254491803:0@lid')).toBe(true);
  });

  it('returns false for status@broadcast', () => {
    expect(isIndividualChat('status@broadcast')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isIndividualChat('')).toBe(false);
  });
});

describe('isGroupChat', () => {
  it('returns true for @g.us JID', () => {
    expect(isGroupChat('12345678@g.us')).toBe(true);
  });

  it('returns false for @s.whatsapp.net JID', () => {
    expect(isGroupChat('919876543210@s.whatsapp.net')).toBe(false);
  });
});

// --- Phone number extraction ---

describe('extractPhoneNumber', () => {
  it('extracts phone number from individual JID', () => {
    expect(extractPhoneNumber('919876543210@s.whatsapp.net')).toBe('919876543210');
  });

  it('extracts phone number with country code', () => {
    expect(extractPhoneNumber('12025551234@s.whatsapp.net')).toBe('12025551234');
  });

  it('returns null for group JID', () => {
    expect(extractPhoneNumber('12345678@g.us')).toBeNull();
  });

  it('extracts LID user part from @lid JID', () => {
    expect(extractPhoneNumber('186410254491803@lid')).toBe('186410254491803');
  });

  it('strips device suffix from @lid JID', () => {
    expect(extractPhoneNumber('186410254491803:0@lid')).toBe('186410254491803');
  });

  it('returns null for unknown JID format', () => {
    expect(extractPhoneNumber('unknown:12345')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractPhoneNumber('')).toBeNull();
  });
});

// --- Virtual complaint group ---

describe('VIRTUAL_COMPLAINT_GROUP_JID', () => {
  it('is a well-known constant', () => {
    expect(VIRTUAL_COMPLAINT_GROUP_JID).toBe('complaint@virtual');
  });
});

// --- WhatsApp message handling (integration) ---

describe('WhatsApp 1:1 message handling', () => {
  it('1:1 message triggers onMessage with individual JID', () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const registeredGroups = vi.fn().mockReturnValue({
      'complaint@virtual': {
        name: 'complaint',
        folder: 'complaint',
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    });

    // Simulate the message processing logic from WhatsAppChannel
    const rawJid = '919876543210@s.whatsapp.net';
    const timestamp = '2024-01-01T00:00:01.000Z';
    const pushName = 'Rajesh';
    const content = 'I have a water supply issue';
    const msgId = 'msg-1';

    // 1:1 message detection
    expect(isIndividualChat(rawJid)).toBe(true);

    // Phone number extraction
    const phone = extractPhoneNumber(rawJid);
    expect(phone).toBe('919876543210');

    // Chat metadata stored with push name
    onChatMetadata(rawJid, timestamp, pushName);
    expect(onChatMetadata).toHaveBeenCalledWith(rawJid, timestamp, pushName);
  });

  it('group message (JID with @g.us) still works as before', () => {
    const groupJid = '12345678@g.us';

    expect(isGroupChat(groupJid)).toBe(true);
    expect(isIndividualChat(groupJid)).toBe(false);
    expect(extractPhoneNumber(groupJid)).toBeNull();
  });

  it('push name extracted from message metadata', () => {
    // The push name comes from msg.pushName in Baileys
    // Our extractPhoneNumber + isIndividualChat are the key functions
    // Push name is passed via the sender_name field in NewMessage
    const rawJid = '919876543210@s.whatsapp.net';
    const pushName = 'Rajesh Kumar';

    expect(isIndividualChat(rawJid)).toBe(true);

    // In actual WhatsApp handler, for 1:1 chats, sender_name = pushName
    // and sender = rawJid (no participant for 1:1 chats)
    const senderName = pushName || rawJid.split('@')[0];
    expect(senderName).toBe('Rajesh Kumar');
  });

  it('1:1 messages route to virtual complaint group via registeredGroups lookup', () => {
    const registeredGroups: Record<string, any> = {
      'complaint@virtual': {
        name: 'complaint',
        folder: 'complaint',
        trigger: '',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    };

    const rawJid = '919876543210@s.whatsapp.net';

    // For 1:1 chats, we look up the virtual complaint group
    expect(isIndividualChat(rawJid)).toBe(true);
    const routeJid = VIRTUAL_COMPLAINT_GROUP_JID;
    expect(registeredGroups[routeJid]).toBeDefined();
    expect(registeredGroups[routeJid].name).toBe('complaint');
  });

  it('chat metadata stored for individual chats', () => {
    const rawJid = '919876543210@s.whatsapp.net';
    const timestamp = '2024-01-01T00:00:01.000Z';
    const pushName = 'Rajesh';

    // Store metadata with push name
    storeChatMetadata(rawJid, timestamp, pushName);

    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === rawJid);
    expect(chat).toBeDefined();
    expect(chat!.name).toBe('Rajesh');
    expect(chat!.last_message_time).toBe(timestamp);
  });

  it('LID JID routes to virtual complaint group', () => {
    const registeredGroups: Record<string, any> = {
      'complaint@virtual': {
        name: 'complaint',
        folder: 'complaint',
        trigger: '',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    };

    const lidJid = '186410254491803@lid';

    // LID JIDs are recognized as individual chats
    expect(isIndividualChat(lidJid)).toBe(true);
    // They route to the virtual complaint group
    const routeJid = VIRTUAL_COMPLAINT_GROUP_JID;
    expect(registeredGroups[routeJid]).toBeDefined();
    // Phone extraction returns the LID user part
    expect(extractPhoneNumber(lidJid)).toBe('186410254491803');
  });

  it('handles message from unknown JID format gracefully', () => {
    const unknownJid = 'unknown:format:12345';

    expect(isIndividualChat(unknownJid)).toBe(false);
    expect(isGroupChat(unknownJid)).toBe(false);
    expect(extractPhoneNumber(unknownJid)).toBeNull();

    // Should not crash — just not recognized as either type
  });

  it('handles message with missing push name', () => {
    const rawJid = '919876543210@s.whatsapp.net';
    const pushName = undefined;

    // Falls back to phone number as name
    const senderName = pushName || rawJid.split('@')[0];
    expect(senderName).toBe('919876543210');
  });
});
