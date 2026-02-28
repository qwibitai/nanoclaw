// Signal IPC handlers - merge into src/ipc.ts
// Add these cases to the switch (data.type) block in processTaskIpc,
// before the `default:` case.

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { RegisteredGroup } from './types.js';
import { getRecentMessages } from './db.js';
import { logger } from './logger.js';
import {
  SIGNAL_ACCOUNT,
  SIGNAL_HTTP_HOST,
  SIGNAL_HTTP_PORT,
} from './config.js';
import {
  signalReact,
  signalRemoveReaction,
  signalCreatePoll,
  signalClosePoll,
  signalVotePoll,
  signalSetTyping,
  signalSendSticker,
  signalListStickerPacks,
  signalSendReceipt,
  signalDeleteMessage,
  signalUpdateProfile,
  signalCreateGroup,
  signalUpdateGroup,
  signalAddGroupMembers,
  signalRemoveGroupMembers,
  signalQuitGroup,
  signalSendV2,
  signalDownloadAttachment,
} from './signal/client.js';

const SIGNAL_BASE_URL = `http://${SIGNAL_HTTP_HOST}:${SIGNAL_HTTP_PORT}`;

/**
 * Query the messages database to verify that a given (sender, timestamp)
 * pair actually exists. This turns the "call get_recent_messages first"
 * instruction into a hard gate: if the agent fabricates a phone number or
 * timestamp, the IPC call is rejected before it reaches the Signal API.
 *
 * Validation modes:
 * - 'exact': Match both sender and source_timestamp (reactions)
 * - 'own':   Match source_timestamp where is_from_me is true (edit, delete)
 * - 'any':   Match source_timestamp for any sender (receipts)
 *
 * Returns null on success, or an error string describing why validation failed.
 */
type ValidationMode = 'exact' | 'own' | 'any';

function validateMessageReference(
  chatJid: string,
  targetAuthor: string | undefined,
  targetTimestamp: number | undefined,
  mode: ValidationMode = 'exact',
): string | null {
  if (!targetTimestamp) {
    return 'Missing targetTimestamp';
  }
  if (mode === 'exact' && !targetAuthor) {
    return 'Missing targetAuthor (required for exact match)';
  }

  const messages = getRecentMessages(chatJid, 100);

  const match = messages.find((m) => {
    const msgTimestamp = Number(m.id) || null;
    if (msgTimestamp !== targetTimestamp) return false;
    switch (mode) {
      case 'exact': return m.sender === targetAuthor;
      case 'own':   return m.is_from_me === 1;
      case 'any':   return true;
    }
  });

  if (!match) {
    const context = mode === 'exact' ? `author="${targetAuthor}" ` : mode === 'own' ? 'own message ' : '';
    return `No ${context}message found with timestamp=${targetTimestamp} in chat ${chatJid}. The agent must call get_recent_messages first and use exact values.`;
  }

  return null;
}

/**
 * Convert a NanoClaw JID or raw recipient to the format signal-cli REST API expects.
 * - signal:group:XXXBASE64XXX -> group.BASE64(XXXBASE64XXX) (double-encoded)
 * - signal:+1234567890 -> +1234567890
 * - already in group.X or phone format -> pass through
 */
function jidToRecipient(jidOrRecipient: string): string {
  if (jidOrRecipient.startsWith('signal:group:')) {
    const internalId = jidOrRecipient.replace('signal:group:', '');
    return `group.${Buffer.from(internalId).toString('base64')}`;
  }
  if (jidOrRecipient.startsWith('signal:')) {
    return jidOrRecipient.replace('signal:', '');
  }
  return jidOrRecipient;
}

// Additional fields for the processTaskIpc data parameter type:
export interface SignalIpcData {
  about?: string;
  recipient?: string;
  targetAuthor?: string;
  targetTimestamp?: number;
  reaction?: string;
  timestamp?: number;
  question?: string;
  answers?: string[];
  allowMultipleSelections?: boolean;
  pollTimestamp?: string;
  votes?: number[];
  isTyping?: boolean;
  packId?: string;
  stickerId?: number;
  groupId?: string;
  groupName?: string;
  name?: string;
  description?: string;
  avatarBase64?: string;
  members?: string[];
  receiptType?: string;
  chatJid?: string;
  responseId?: string;
  openOnly?: boolean;
  attachmentId?: string;
  filename?: string;
  originalTimestamp?: number;
  newText?: string;
  message?: string;
  url?: string;
  title?: string;
  thumbnailBase64?: string;
}

/**
 * Verify a non-main group can act on the given chatJid.
 * Enforces the same authorisation pattern as the existing message IPC handler:
 * main can target any chat, non-main can only target chats belonging to their
 * own group folder.
 */
export function authorizeSignalChat(
  data: { chatJid?: string },
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  if (isMain) return true;
  if (!data.chatJid) {
    logger.warn({ sourceGroup }, 'Signal IPC missing chatJid from non-main group');
    return false;
  }
  const target = registeredGroups[data.chatJid];
  if (!target || target.folder !== sourceGroup) {
    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized Signal IPC attempt blocked');
    return false;
  }
  return true;
}

/**
 * Handle Signal IPC cases. Call from the processTaskIpc switch block.
 * Returns true if the case was handled, false if it should fall through.
 */
export async function handleSignalIpc(
  data: SignalIpcData & { type: string },
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  dataDir: string,
): Promise<boolean> {
  switch (data.type) {
    // --- Signal messaging IPC (all groups, scoped to own chats) ---

    case 'signal_react':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.targetAuthor && data.targetTimestamp && data.reaction) {
        const reactErr = validateMessageReference(data.chatJid || '', data.targetAuthor, data.targetTimestamp, 'exact');
        if (reactErr) { logger.warn({ err: reactErr, type: 'signal_react' }, 'Message reference validation failed'); break; }
        try {
          await signalReact({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            targetAuthor: data.targetAuthor,
            targetTimestamp: data.targetTimestamp,
            reaction: data.reaction,
          });
          logger.info({ recipient: data.recipient, reaction: data.reaction }, 'Signal reaction sent via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to send Signal reaction via IPC');
        }
      }
      break;

    case 'signal_remove_reaction':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.targetAuthor && data.targetTimestamp && data.reaction) {
        const removeReactErr = validateMessageReference(data.chatJid || '', data.targetAuthor, data.targetTimestamp, 'exact');
        if (removeReactErr) { logger.warn({ err: removeReactErr, type: 'signal_remove_reaction' }, 'Message reference validation failed'); break; }
        try {
          await signalRemoveReaction({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            targetAuthor: data.targetAuthor,
            targetTimestamp: data.targetTimestamp,
            reaction: data.reaction,
          });
          logger.info({ recipient: data.recipient, reaction: data.reaction }, 'Signal reaction removed via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to remove Signal reaction via IPC');
        }
      }
      break;

    case 'signal_create_poll':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.question && data.answers) {
        try {
          const pollResult = await signalCreatePoll({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            question: data.question,
            answers: data.answers,
            allowMultipleSelections: data.allowMultipleSelections ?? true,
          });
          // Register in poll store so votes can be tracked
          if (data.chatJid && pollResult.pollTimestamp) {
            const { registerPoll } = await import('./signal/poll-store.js');
            registerPoll(data.chatJid, SIGNAL_ACCOUNT, parseInt(pollResult.pollTimestamp, 10), data.question, data.answers);
          }
          logger.info({ recipient: data.recipient, question: data.question }, 'Signal poll created via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to create Signal poll via IPC');
        }
      }
      break;

    case 'signal_close_poll':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.pollTimestamp) {
        try {
          await signalClosePoll({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            pollTimestamp: data.pollTimestamp,
          });
          logger.info({ recipient: data.recipient, pollTimestamp: data.pollTimestamp }, 'Signal poll closed via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to close Signal poll via IPC');
        }
      }
      break;

    case 'signal_vote_poll':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.pollTimestamp && data.votes) {
        try {
          await signalVotePoll({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            pollTimestamp: data.pollTimestamp,
            pollAuthor: SIGNAL_ACCOUNT,
            selectedAnswers: data.votes || [],
          });
          logger.info({ recipient: data.recipient, votes: data.votes }, 'Signal poll vote submitted via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to vote on Signal poll via IPC');
        }
      }
      break;

    case 'signal_typing':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && typeof data.isTyping === 'boolean') {
        try {
          await signalSetTyping({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            isTyping: data.isTyping,
          });
          logger.info({ recipient: data.recipient, isTyping: data.isTyping }, 'Signal typing indicator set via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to set Signal typing indicator via IPC');
        }
      }
      break;

    case 'signal_send_sticker':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.packId && typeof data.stickerId === 'number') {
        try {
          await signalSendSticker({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            packId: data.packId,
            stickerId: data.stickerId,
          });
          logger.info({ recipient: data.recipient, packId: data.packId, stickerId: data.stickerId }, 'Signal sticker sent via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to send Signal sticker via IPC');
        }
      }
      break;

    case 'signal_list_sticker_packs':
      try {
        const packs = await signalListStickerPacks({
          baseUrl: SIGNAL_BASE_URL,
          account: SIGNAL_ACCOUNT,
        });
        const responseFile = path.join(dataDir, 'ipc', sourceGroup, 'responses', `stickers-${Date.now()}.json`);
        fs.mkdirSync(path.dirname(responseFile), { recursive: true });
        fs.writeFileSync(responseFile, JSON.stringify(packs, null, 2));
        logger.info({ count: packs.length, responseFile }, 'Signal sticker packs listed via IPC');
      } catch (err) {
        logger.error({ err }, 'Failed to list Signal sticker packs via IPC');
      }
      break;

    case 'signal_send_receipt':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.timestamp) {
        // Receipts target other people's messages, so validate timestamp exists for any sender
        const receiptErr = validateMessageReference(data.chatJid || '', undefined, data.timestamp, 'any');
        if (receiptErr) { logger.warn({ err: receiptErr, type: 'signal_send_receipt' }, 'Message reference validation failed'); break; }
        try {
          await signalSendReceipt({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            timestamp: data.timestamp,
            receiptType: (data.receiptType as 'read' | 'viewed') || 'read',
          });
          logger.info({ recipient: data.recipient }, 'Signal receipt sent via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to send Signal receipt via IPC');
        }
      }
      break;

    case 'signal_delete_message':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.timestamp) {
        const deleteErr = validateMessageReference(data.chatJid || '', undefined, data.timestamp, 'own');
        if (deleteErr) { logger.warn({ err: deleteErr, type: 'signal_delete_message' }, 'Message reference validation failed'); break; }
        try {
          await signalDeleteMessage({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipient: jidToRecipient(data.recipient!),
            timestamp: data.timestamp,
          });
          logger.info({ recipient: data.recipient, timestamp: data.timestamp }, 'Signal message deleted via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to delete Signal message via IPC');
        }
      }
      break;

    // --- Signal admin IPC (main channel only) ---

    case 'update_signal_profile':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized update_signal_profile attempt blocked');
        break;
      }
      if (data.name || data.about || data.avatarBase64) {
        try {
          await signalUpdateProfile({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            name: data.name,
            about: data.about,
            avatarBase64: data.avatarBase64,
          });
          logger.info({ name: data.name, about: data.about }, 'Signal profile updated via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to update Signal profile via IPC');
        }
      }
      break;

    case 'signal_create_group':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized signal_create_group attempt blocked');
        break;
      }
      if (data.groupName && data.members) {
        try {
          const result = await signalCreateGroup({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            name: data.groupName,
            members: data.members,
            description: data.description,
          });
          logger.info({ groupName: data.groupName, groupId: result.groupId }, 'Signal group created via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to create Signal group via IPC');
        }
      }
      break;

    case 'signal_update_group':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized signal_update_group attempt blocked');
        break;
      }
      if (data.groupId) {
        try {
          await signalUpdateGroup({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            groupId: data.groupId,
            name: data.groupName,
            description: data.description,
            avatarBase64: data.avatarBase64,
          });
          logger.info({ groupId: data.groupId }, 'Signal group updated via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to update Signal group via IPC');
        }
      }
      break;

    case 'signal_add_group_members':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized signal_add_group_members attempt blocked');
        break;
      }
      if (data.groupId && data.members) {
        try {
          await signalAddGroupMembers({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            groupId: data.groupId,
            members: data.members,
          });
          logger.info({ groupId: data.groupId, members: data.members }, 'Signal group members added via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to add Signal group members via IPC');
        }
      }
      break;

    case 'signal_remove_group_members':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized signal_remove_group_members attempt blocked');
        break;
      }
      if (data.groupId && data.members) {
        try {
          await signalRemoveGroupMembers({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            groupId: data.groupId,
            members: data.members,
          });
          logger.info({ groupId: data.groupId, members: data.members }, 'Signal group members removed via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to remove Signal group members via IPC');
        }
      }
      break;

    case 'signal_quit_group':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized signal_quit_group attempt blocked');
        break;
      }
      if (data.groupId) {
        try {
          await signalQuitGroup({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            groupId: data.groupId,
          });
          logger.info({ groupId: data.groupId }, 'Left Signal group via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to leave Signal group via IPC');
        }
      }
      break;

    case 'signal_get_poll_results': {
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      const { getPollResults, getChatPolls } = await import('./signal/poll-store.js');

      let pollData: unknown;
      if (data.pollTimestamp) {
        pollData = getPollResults(data.chatJid || '', parseInt(data.pollTimestamp, 10));
      } else {
        pollData = getChatPolls(data.chatJid || '', data.openOnly ?? false);
      }

      const responseId = data.responseId || `poll-results-${Date.now()}`;
      const responseFile = path.join(dataDir, 'ipc', sourceGroup, 'responses', `${responseId}.json`);
      fs.mkdirSync(path.dirname(responseFile), { recursive: true });
      fs.writeFileSync(responseFile, JSON.stringify(pollData, null, 2));
      logger.info({ sourceGroup, responseFile }, 'Signal poll results written via IPC');
      break;
    }

    case 'signal_download_attachment': {
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.attachmentId) {
        try {
          const buffer = await signalDownloadAttachment(SIGNAL_BASE_URL, data.attachmentId);
          const filename = path.basename(data.filename || `attachment-${data.attachmentId}`);
          const responseFile = path.join(dataDir, 'ipc', sourceGroup, 'responses', filename);
          fs.mkdirSync(path.dirname(responseFile), { recursive: true });
          fs.writeFileSync(responseFile, buffer);
          logger.info({ attachmentId: data.attachmentId, responseFile }, 'Signal attachment downloaded via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to download Signal attachment via IPC');
        }
      }
      break;
    }

    case 'signal_edit_message':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.originalTimestamp && data.newText) {
        const editErr = validateMessageReference(data.chatJid || '', undefined, data.originalTimestamp, 'own');
        if (editErr) { logger.warn({ err: editErr, type: 'signal_edit_message' }, 'Message reference validation failed'); break; }
        try {
          const editRecipient = jidToRecipient(data.recipient);
          await signalSendV2({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipients: editRecipient.startsWith('group.') ? undefined : [editRecipient],
            groupId: editRecipient.startsWith('group.') ? editRecipient : undefined,
            message: data.newText,
            editTimestamp: data.originalTimestamp,
          });
          logger.info({ recipient: data.recipient, originalTimestamp: data.originalTimestamp }, 'Signal message edited via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to edit Signal message via IPC');
        }
      }
      break;

    case 'signal_send_with_preview':
      if (!authorizeSignalChat(data, sourceGroup, isMain, registeredGroups)) break;
      if (data.recipient && data.message && data.url) {
        try {
          const previewRecipient = jidToRecipient(data.recipient);
          await signalSendV2({
            baseUrl: SIGNAL_BASE_URL,
            account: SIGNAL_ACCOUNT,
            recipients: previewRecipient.startsWith('group.') ? undefined : [previewRecipient],
            groupId: previewRecipient.startsWith('group.') ? previewRecipient : undefined,
            message: data.message,
            linkPreview: {
              url: data.url,
              title: data.title,
              description: data.description,
              base64_thumbnail: data.thumbnailBase64,
            },
          });
          logger.info({ recipient: data.recipient, url: data.url }, 'Signal message with preview sent via IPC');
        } catch (err) {
          logger.error({ err }, 'Failed to send Signal message with preview via IPC');
        }
      }
      break;

    default:
      return false;
  }

  return true;
}
