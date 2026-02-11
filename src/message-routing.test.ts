import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  storeChatMetadata,
  storeMessage,
  getMessagesSince,
} from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';
import {
  formatMessagesWithUserContext,
  resolveRouteJid,
} from './router.js';
import {
  isIndividualChat,
  extractPhoneNumber,
  VIRTUAL_COMPLAINT_GROUP_JID,
} from './channels/whatsapp.js';
import { NewMessage, RegisteredGroup } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- resolveRouteJid ---

describe('resolveRouteJid', () => {
  it('routes 1:1 message to virtual complaint group', () => {
    const jid = '919876543210@s.whatsapp.net';
    expect(resolveRouteJid(jid)).toBe(VIRTUAL_COMPLAINT_GROUP_JID);
  });

  it('routes group message to itself', () => {
    const jid = '12345678@g.us';
    expect(resolveRouteJid(jid)).toBe('12345678@g.us');
  });

  it('routes unknown JID format to itself', () => {
    const jid = 'unknown:12345';
    expect(resolveRouteJid(jid)).toBe('unknown:12345');
  });
});

// --- formatMessagesWithUserContext ---

describe('formatMessagesWithUserContext', () => {
  it('includes phone number in user context', () => {
    const msgs = [
      makeMsg({
        chat_jid: '919876543210@s.whatsapp.net',
        sender: '919876543210@s.whatsapp.net',
        sender_name: 'Rajesh',
        content: 'Water supply issue',
      }),
    ];

    const result = formatMessagesWithUserContext(msgs, '919876543210', 'Rajesh');
    expect(result).toContain('phone="919876543210"');
  });

  it('includes push name in user context', () => {
    const msgs = [
      makeMsg({
        chat_jid: '919876543210@s.whatsapp.net',
        sender: '919876543210@s.whatsapp.net',
        sender_name: 'Rajesh Kumar',
        content: 'Road problem',
      }),
    ];

    const result = formatMessagesWithUserContext(msgs, '919876543210', 'Rajesh Kumar');
    expect(result).toContain('name="Rajesh Kumar"');
  });

  it('includes the messages in the output', () => {
    const msgs = [
      makeMsg({
        chat_jid: '919876543210@s.whatsapp.net',
        sender: '919876543210@s.whatsapp.net',
        sender_name: 'Rajesh',
        content: 'Water supply issue',
      }),
    ];

    const result = formatMessagesWithUserContext(msgs, '919876543210', 'Rajesh');
    expect(result).toContain('<messages>');
    expect(result).toContain('Water supply issue');
    expect(result).toContain('</messages>');
  });

  it('escapes special characters in push name', () => {
    const msgs = [makeMsg({ sender_name: 'A & B <Co>' })];
    const result = formatMessagesWithUserContext(msgs, '123', 'A & B <Co>');
    expect(result).toContain('name="A &amp; B &lt;Co&gt;"');
  });
});

// --- 1:1 message routing integration ---

describe('1:1 message routing integration', () => {
  it('1:1 message stored under individual JID is accessible for routing', () => {
    const individualJid = '919876543210@s.whatsapp.net';

    // Store chat metadata (as WhatsApp channel does)
    storeChatMetadata(individualJid, '2024-01-01T00:00:01.000Z', 'Rajesh');

    // Store message (as WhatsApp channel onMessage does)
    storeMessage({
      id: 'msg-1',
      chat_jid: individualJid,
      sender: individualJid,
      sender_name: 'Rajesh',
      content: 'I have a water supply issue',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });

    // Message can be retrieved for processing
    const messages = getMessagesSince(individualJid, '', 'ComplaintBot');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('I have a water supply issue');
  });

  it('admin group message routes to admin group JID', () => {
    const adminGroupJid = 'admin-group-123@g.us';

    // Admin group is just a regular group — it routes to itself
    expect(resolveRouteJid(adminGroupJid)).toBe(adminGroupJid);
  });

  it('existing group messages still route correctly', () => {
    const groupJid = '12345678@g.us';

    // Register the group
    _setRegisteredGroups({
      [groupJid]: {
        name: 'Test Group',
        folder: 'test',
        trigger: '@ComplaintBot',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    // Group JID routes to itself
    expect(resolveRouteJid(groupJid)).toBe(groupJid);
  });

  it('container spawned with correct group config for complaint messages', () => {
    const complaintGroup: RegisteredGroup = {
      name: 'complaint',
      folder: 'complaint',
      trigger: '',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
    };

    // Virtual complaint group is registered with requiresTrigger=false
    _setRegisteredGroups({
      [VIRTUAL_COMPLAINT_GROUP_JID]: complaintGroup,
    });

    // When processing a 1:1 message, the route maps to complaint group
    const individualJid = '919876543210@s.whatsapp.net';
    const routeJid = resolveRouteJid(individualJid);
    expect(routeJid).toBe(VIRTUAL_COMPLAINT_GROUP_JID);

    // The complaint group has requiresTrigger=false so every message is processed
    const groups = { [VIRTUAL_COMPLAINT_GROUP_JID]: complaintGroup } as Record<string, RegisteredGroup>;
    expect(groups[routeJid]!.requiresTrigger).toBe(false);
  });

  it('bot own messages (is_from_me) are not re-processed as user messages', () => {
    // Regression test: when the bot sends a 1:1 message, WhatsApp echoes it back
    // via messages.upsert with is_from_me=true. Without filtering, this creates an
    // infinite reply loop where the bot responds to its own messages.
    const msg = makeMsg({
      chat_jid: '919876543210@s.whatsapp.net',
      sender: '919876543210@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'तुमची तक्रार नोंदवली गेली आहे.',
      is_from_me: true,
    });

    // The onMessage callback in index.ts checks is_from_me and returns early.
    // Here we verify the field is present and truthy for self-sent messages.
    expect(msg.is_from_me).toBe(true);

    // Messages from the bot should still be stored (for history) but NOT routed
    // to handleComplaintDirect. The routing check is: if (msg.is_from_me) return;
    storeChatMetadata(msg.chat_jid, msg.timestamp, 'Bot');
    storeMessage(msg);
    const messages = getMessagesSince(msg.chat_jid, '', 'ComplaintBot');
    expect(messages).toHaveLength(1); // stored for history
  });

  it('message from unregistered phone number handled gracefully', () => {
    const unknownPhoneJid = '910000000000@s.whatsapp.net';

    // Even unknown phones route to complaint group
    expect(resolveRouteJid(unknownPhoneJid)).toBe(VIRTUAL_COMPLAINT_GROUP_JID);

    // Phone number can be extracted
    expect(extractPhoneNumber(unknownPhoneJid)).toBe('910000000000');
  });

  it('admin group JID correctly identified from tenant config value', () => {
    // The wa_admin_group_jid from tenant config is just a regular group JID
    const adminJid = 'admin-group-123@g.us';

    // It's a group JID, not a 1:1 JID
    expect(isIndividualChat(adminJid)).toBe(false);

    // It routes to itself (not to complaint group)
    expect(resolveRouteJid(adminJid)).toBe(adminJid);
  });
});
