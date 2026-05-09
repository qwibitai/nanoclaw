/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 *
 * Fork customizations layered on top of v2 (Bucket D):
 *   - Photo → image-vision: detects image attachments, resizes via processImage,
 *     injects base64 into content so the agent receives multimodal input.
 *   - PDF attachment routing: detects PDF file attachments, saves to the wired
 *     agent group's workspace (groups/<folder>/attachments/).
 *   - Voice transcription: detects audio attachments, transcribes via Whisper,
 *     injects transcript text into the message content.
 *   - /auth command: surfaces auth-mode status and switching to the user.
 *
 * Note on https.globalAgent: The fork passed `agent: https.globalAgent` to
 * grammy's baseFetchConfig to ensure the sandbox credential proxy intercepted
 * all outbound requests. In v2, @chat-adapter/telegram uses fetch() directly
 * and does not expose an agent configuration point at this layer. If the
 * OneCLI credential proxy requires intercepting Telegram API traffic, configure
 * it at the Node.js fetch/undici dispatcher level in src/index.ts instead.
 */
import fs from 'fs';
import path from 'path';

import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { processImage } from '../image.js';
import { transcribeAudio } from '../transcription.js';
import { getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';
import { runPairConsumers } from './pair-consumer-registry.js';
import { dispatchTelegramCommand, registerTelegramCommand } from './telegram-commands.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
export async function sendTelegramText(token: string, platformId: string, text: string, label: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      log.warn(`Telegram ${label} non-OK`, { status: res.status });
    }
  } catch (err) {
    log.warn(`Telegram ${label} failed`, { err });
  }
}

async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  await sendTelegramText(
    token,
    platformId,
    "Pairing success! I'm spinning up the agent now, you'll get a message from them shortly.",
    'pairing confirmation',
  );
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      // Pair-consumer outputs from any registered extensions (e.g. class
      // feature). Captured during the wire-to branch below; delivered
      // after the registration log line.
      const pairResults: Array<{ confirmation?: string; suppressDefaultConfirmation?: boolean }> = [];

      // Wire-to intent: bind this chat to the named agent group folder so
      // future messages route to it. The pairing record has done its job
      // (proving the chat); the wiring step is what actually makes it
      // useful. Idempotent — re-pairing the same chat to the same folder
      // is a no-op.
      if (typeof consumed.intent === 'object' && consumed.intent.kind === 'wire-to') {
        const targetFolder = consumed.intent.folder;
        const ag = getAgentGroupByFolder(targetFolder);
        if (!ag) {
          log.warn('Wire-to pairing: agent group not found, skipping wiring', {
            folder: targetFolder,
            platformId,
          });
        } else {
          const mg =
            getMessagingGroupByPlatform('telegram', platformId) ??
            // Defensive — the create branch above just ran, but a race could
            // theoretically miss it. Re-read explicitly.
            null;
          if (mg) {
            const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
            if (!existing) {
              const isGroup = mg.is_group === 1;
              createMessagingGroupAgent({
                id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                messaging_group_id: mg.id,
                agent_group_id: ag.id,
                engage_mode: isGroup ? 'mention' : 'pattern',
                engage_pattern: isGroup ? null : '.',
                sender_scope: 'all',
                ignored_message_policy: 'drop',
                session_mode: 'shared',
                priority: 0,
                created_at: new Date().toISOString(),
              });
              log.info('Wire-to pairing: messaging group wired to agent group', {
                mg: mg.id,
                ag: ag.id,
                folder: targetFolder,
              });
            }
            // Run extension consumers (e.g. class feature: stamp metadata,
            // create Drive folder, build tailored welcome). Empty when
            // nothing's registered.
            const results = await runPairConsumers(
              {
                agentGroupId: ag.id,
                pairedUserId,
                consumedEmail: consumed.consumed?.email ?? null,
                targetFolder,
                channel: 'telegram',
              },
              (i, err) => log.error('Pair consumer threw', { index: i, err }),
            );
            for (const result of results) pairResults.push(result);
          }
        }
      }

      const suppressDefault = pairResults.some((r) => r.suppressDefaultConfirmation === true);
      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
        email: consumed.consumed?.email,
        consumerCount: pairResults.length,
        suppressedDefault: suppressDefault,
      });

      // Deliver each consumer-provided confirmation, in order. If none
      // suppressed the default, send the generic confirmation last so
      // the user always gets at least one acknowledgement.
      for (const result of pairResults) {
        if (result.confirmation) {
          await sendTelegramText(token, platformId, result.confirmation, 'pair-consumer reply');
        }
      }
      if (!suppressDefault) {
        await sendPairingConfirmation(token, platformId);
      }
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

// ---------------------------------------------------------------------------
// Fork customization helpers (Bucket D)
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace folder for the first wired agent group reachable from
 * a messaging group. Returns null if the messaging group is unknown or has no
 * wired agent groups — processing is skipped for unregistered chats.
 */
function resolveWorkspaceForPlatform(platformId: string): string | null {
  const mg = getMessagingGroupByPlatform('telegram', platformId);
  if (!mg) return null;
  const agents = getMessagingGroupAgents(mg.id);
  if (agents.length === 0) return null;
  // Use the highest-priority agent group's workspace.
  const agentGroup = getAgentGroup(agents[0].agent_group_id);
  if (!agentGroup) return null;
  try {
    return resolveGroupFolderPath(agentGroup.folder);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentRecord = Record<string, any>;

/**
 * Process fork-specific attachment types (image, audio/voice, PDF) on an
 * already-downloaded chat-sdk InboundMessage. Mutates `content` in place so
 * the enriched data reaches the router/agent.
 *
 * The Chat SDK bridge (chat-sdk-bridge.ts) fetches attachment data before
 * serialising the message, so `content.attachments[].data` is already a
 * base64-encoded Buffer. We re-decode it here, apply processing, and update
 * the content fields the agent receives.
 */
async function processAttachments(platformId: string, message: InboundMessage): Promise<InboundMessage> {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return message;
  }

  const content = message.content as ContentRecord;
  const attachments: ContentRecord[] = Array.isArray(content.attachments) ? content.attachments : [];
  if (attachments.length === 0) return message;

  const workspaceDir = resolveWorkspaceForPlatform(platformId);
  const attachDir = workspaceDir ? path.join(workspaceDir, 'attachments') : null;

  const updatedContent = { ...content };
  let modified = false;

  for (const att of attachments) {
    const attType: string = att.type ?? '';
    const rawData: string | undefined = att.data; // base64 string from bridge

    // -----------------------------------------------------------------------
    // Photo → image-vision
    // -----------------------------------------------------------------------
    if (attType === 'image' && rawData) {
      try {
        const buffer = Buffer.from(rawData, 'base64');
        const msgId = message.id ?? `img_${Date.now()}`;

        if (attachDir) {
          fs.mkdirSync(attachDir, { recursive: true });
          const savePath = path.join(attachDir, `photo_${msgId}.jpg`);
          const processed = await processImage(buffer, savePath);

          // Inject processed image into content for multimodal delivery
          updatedContent.images = [
            ...(Array.isArray(updatedContent.images) ? updatedContent.images : []),
            { base64: processed.base64, mimeType: processed.mimeType },
          ];
          // Update text to reference the saved file
          const caption = updatedContent.text ? ` ${updatedContent.text}` : '';
          updatedContent.text = `[Photo: attachments/photo_${msgId}.jpg]${caption}`;
        } else {
          // No workspace yet (unregistered chat) — still pass base64 so the
          // pairing flow can succeed; the agent won't be reached anyway.
          updatedContent.images = [
            ...(Array.isArray(updatedContent.images) ? updatedContent.images : []),
            { base64: rawData, mimeType: 'image/jpeg' },
          ];
        }

        log.info('Processed Telegram photo attachment', { platformId, msgId });
        modified = true;
      } catch (err) {
        log.error('Telegram photo processing failed', { platformId, err });
        updatedContent.text = `[Photo - failed to process]${updatedContent.text ? ' ' + updatedContent.text : ''}`;
        modified = true;
      }
    }

    // -----------------------------------------------------------------------
    // Voice → transcription
    // -----------------------------------------------------------------------
    if (attType === 'audio' && rawData) {
      try {
        const buffer = Buffer.from(rawData, 'base64');
        const transcript = await transcribeAudio(buffer, 'voice.ogg');
        if (transcript) {
          updatedContent.text = `[Voice: ${transcript}]`;
          log.info('Telegram voice message transcribed', { platformId, chars: transcript.length });
        } else {
          updatedContent.text = '[Voice message - transcription unavailable]';
        }
        modified = true;
      } catch (err) {
        log.error('Telegram voice transcription failed', { platformId, err });
        updatedContent.text = '[Voice message - transcription failed]';
        modified = true;
      }
    }

    // -----------------------------------------------------------------------
    // PDF document routing — save to workspace
    // -----------------------------------------------------------------------
    if (attType === 'file' && att.mimeType === 'application/pdf' && rawData && attachDir) {
      try {
        const buffer = Buffer.from(rawData, 'base64');
        fs.mkdirSync(attachDir, { recursive: true });

        const rawName: string = att.name ?? 'document.pdf';
        const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const savePath = path.join(attachDir, safeName);
        fs.writeFileSync(savePath, buffer);

        log.info('Telegram PDF saved to workspace', { platformId, file: safeName, size: buffer.length });

        updatedContent.text = `[PDF document saved: attachments/${safeName} (${Math.round(buffer.length / 1024)}KB)]`;
        modified = true;
      } catch (err) {
        log.error('Telegram PDF save failed', { platformId, err });
        // Fall through — content remains as the raw file placeholder
      }
    }
  }

  if (!modified) return message;

  return {
    ...message,
    content: updatedContent,
  };
}

/**
 * Handle the /playground Telegram command.
 *   /playground       → start the HTTP server (idempotent), reply with URL
 *   /playground stop  → stop the server
 *   /playground       → if already running, just reports the URL
 *
 * Returns true if consumed.
 */
async function handlePlaygroundCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/playground')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { startPlaygroundServer, stopPlaygroundServer, getPlaygroundStatus } = await import('./playground.js');

  const parts = text.trim().split(/\s+/);
  const sub = parts[1]?.toLowerCase();

  let reply: string;
  try {
    if (sub === 'stop') {
      const status = getPlaygroundStatus();
      if (!status.running) {
        reply = 'Playground is not running.';
      } else {
        await stopPlaygroundServer();
        reply = '✅ Playground stopped.';
      }
    } else if (!sub || sub === 'start') {
      const { url, alreadyRunning } = await startPlaygroundServer();
      reply = alreadyRunning ? `Playground already running at ${url}` : `✅ Playground started.\n${url}`;
    } else if (sub === 'status') {
      const status = getPlaygroundStatus();
      reply = status.running ? `Running: ${status.url}` : 'Not running. Send /playground to start.';
    } else {
      reply = `Unknown subcommand: ${sub}\nUsage: /playground | /playground stop | /playground status`;
    }
  } catch (err) {
    reply = `❌ Playground command failed: ${(err as Error).message}`;
  }

  await sendTelegram(token, chatId, reply);
  return true;
}

/**
 * Handle the /model Telegram command.
 * - `/model`        → show current model (per agent group wired to this chat) + hint list
 * - `/model <name>` → persist <name> as the group's model, kill running container
 *                     so the next inbound spawns with the new model.
 *
 * Trust-first: any string is accepted. If the model is invalid, the
 * provider's server-side rejection surfaces as the agent's reply.
 *
 * Returns true if consumed.
 */
async function handleModelCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/model')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { getMessagingGroupByPlatform, getMessagingGroupAgents } = await import('../db/messaging-groups.js');
  const { getAgentGroup } = await import('../db/agent-groups.js');
  const { hintsForProvider, resolveEffectiveModel, setModel } = await import('../model-switch.js');
  const { isContainerRunning, killContainer } = await import('../container-runner.js');
  const { getActiveSessions } = await import('../db/sessions.js');

  const mg = getMessagingGroupByPlatform('telegram', platformId);
  const agents = mg ? getMessagingGroupAgents(mg.id) : [];
  if (agents.length === 0) {
    await sendTelegram(token, chatId, 'No agent group wired to this chat.');
    return true;
  }
  if (agents.length > 1) {
    await sendTelegram(
      token,
      chatId,
      `${agents.length} agent groups wired to this chat — /model on multi-agent chats not yet supported.`,
    );
    return true;
  }
  const group = getAgentGroup(agents[0].agent_group_id);
  if (!group) {
    await sendTelegram(token, chatId, 'Agent group lookup failed.');
    return true;
  }

  const parts = text.trim().split(/\s+/);
  const arg = parts.slice(1).join(' ').trim();
  let reply: string;

  if (!arg) {
    const hints = hintsForProvider(group.agent_provider);
    const list =
      hints.length > 0 ? hints.map((h) => `  • ${h.name} — ${h.note}`).join('\n') : '  (no hints for this provider)';
    const effective = resolveEffectiveModel(group);
    const modelLine = group.model ? `Model: ${group.model}` : `Model: ${effective} (provider default)`;
    reply =
      `Group: ${group.name}\n` +
      `Provider: ${group.agent_provider ?? 'claude (default)'}\n` +
      `${modelLine}\n` +
      `\n` +
      `Suggested models:\n${list}\n` +
      `\n` +
      `Use /model <name> to switch. Any string is accepted; the server validates.`;
  } else {
    const newModel = arg === 'reset' || arg === 'default' ? null : arg;
    const ok = setModel(group.folder, newModel);
    if (!ok) {
      reply = 'Failed to persist — group not found by folder.';
    } else {
      // Kill any running container for sessions in this group so the next
      // inbound spawns fresh with the new model.
      const sessions = getActiveSessions().filter((s) => s.agent_group_id === group.id);
      for (const s of sessions) {
        if (isContainerRunning(s.id)) {
          try {
            killContainer(s.id, 'model change');
          } catch {
            /* best-effort */
          }
        }
      }
      reply = newModel
        ? `✅ Model set to \`${newModel}\`. Next message uses it. (Server rejects unknown models with a clear error.)`
        : `✅ Model reset — group will use provider default.`;
    }
  }

  await sendTelegram(token, chatId, reply);
  return true;
}

/**
 * Send a plain-text reply to a Telegram chat. No parse_mode — legacy
 * Markdown collapses single newlines into spaces, MarkdownV2 requires
 * escaping a long list of metacharacters; plain text is the most
 * predictable for multi-line status replies.
 */
async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      log.warn('Telegram sendMessage non-2xx', { chatId, status: res.status, body });
    }
  } catch (err) {
    log.warn('Telegram sendMessage threw', { chatId, err });
  }
}

/**
 * Handle the /auth Telegram command.
 * - `/auth`       → show current mode + OAuth status
 * - `/auth api`   → switch to API key mode
 * - `/auth oauth` → switch to OAuth mode (checks credentials first)
 *
 * Returns true if the message was consumed (short-circuit), false if not.
 */
async function handleAuthCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/auth')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { getCurrentAuthMode, hasValidOAuthCredentials, switchAuthMode } = await import('../auth-switch.js');

  const parts = text.trim().split(/\s+/);
  const subcommand = parts[1]?.toLowerCase();

  let reply: string;

  if (!subcommand) {
    const mode = getCurrentAuthMode();
    const oauthOk = hasValidOAuthCredentials();
    reply =
      `Current mode: *${mode}*\n` +
      `OAuth credentials: ${oauthOk ? '✅ valid' : '❌ missing or expired'}\n\n` +
      `Use \`/auth api\` or \`/auth oauth\` to switch.`;
  } else if (subcommand === 'api') {
    await switchAuthMode('api-key');
    reply = '✅ Switched to API key mode. Restarting…';
  } else if (subcommand === 'oauth') {
    if (!hasValidOAuthCredentials()) {
      reply = '❌ No valid OAuth credentials found. Run `claude login` first.';
    } else {
      await switchAuthMode('oauth');
      reply = '✅ Switched to OAuth mode. Restarting…';
    }
  } else {
    reply = `Unknown subcommand: \`${subcommand}\`\nUsage: /auth | /auth api | /auth oauth`;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    log.warn('Failed to send /auth reply', { platformId, err });
  }

  return true;
}

/**
 * Handle the /provider Telegram command.
 * - `/provider`        → show current provider (per agent group wired to this chat) + hint list
 * - `/provider <name>` → persist <name>, kill running container so the next
 *                        inbound spawns with the new provider.
 *
 * Trust-first: any string is accepted. If the provider isn't registered
 * the next spawn fails with a clear error, surfaced as the agent's reply.
 *
 * Returns true if consumed.
 */
async function handleProviderCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/provider')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { getMessagingGroupByPlatform, getMessagingGroupAgents } = await import('../db/messaging-groups.js');
  const { getAgentGroup } = await import('../db/agent-groups.js');
  const { getCurrentProvider, listProviderHints, setProvider } = await import('../provider-switch.js');

  const mg = getMessagingGroupByPlatform('telegram', platformId);
  const agents = mg ? getMessagingGroupAgents(mg.id) : [];
  if (agents.length === 0) {
    await sendTelegram(token, chatId, 'No agent group wired to this chat.');
    return true;
  }
  if (agents.length > 1) {
    await sendTelegram(
      token,
      chatId,
      `${agents.length} agent groups wired to this chat — /provider on multi-agent chats not yet supported.`,
    );
    return true;
  }
  const group = getAgentGroup(agents[0].agent_group_id);
  if (!group) {
    await sendTelegram(token, chatId, 'Agent group lookup failed.');
    return true;
  }

  const parts = text.trim().split(/\s+/);
  const arg = parts.slice(1).join(' ').trim();
  let reply: string;

  if (!arg) {
    const current = getCurrentProvider(group.folder);
    const hints = listProviderHints();
    const list = hints.map((h) => `  • ${h.name} — ${h.note}`).join('\n');
    reply =
      `Group: ${group.name}\n` +
      `Provider: ${current?.provider ?? 'claude (default)'}\n` +
      `\n` +
      `Available providers:\n${list}\n` +
      `\n` +
      `Use /provider <name> to switch. Persona, CLAUDE.local.md, skills, and the wiki carry over;\n` +
      `per-turn chat history does not (each provider keeps its own session store).`;
  } else {
    const result = setProvider(group.folder, arg);
    if (!result.ok) {
      switch (result.reason) {
        case 'no-change':
          reply = `Already on \`${arg}\` — no change.`;
          break;
        case 'no-container-json':
          reply = `Failed: no container.json for ${group.folder}.`;
          break;
        case 'group-not-found':
          reply = `Failed: agent group not found by folder.`;
          break;
        default:
          reply = `Failed: ${result.reason ?? 'unknown reason'}.`;
      }
    } else {
      reply =
        `✅ Provider: \`${result.previousProvider}\` → \`${result.newProvider}\`. ` +
        `${result.containersStopped ?? 0} container(s) stopped. Next message respawns with the new provider.`;
    }
  }

  await sendTelegram(token, chatId, reply);
  return true;
}

// ── Built-in command registrations ─────────────────────────────────────────
// /auth, /model, /provider, /playground all ship with main. /login (class
// feature) registers itself from src/class-telegram-commands.ts when imported.

registerTelegramCommand('/auth', (ctx) => handleAuthCommand(ctx.token, ctx.platformId, ctx.text));
registerTelegramCommand('/model', (ctx) => handleModelCommand(ctx.token, ctx.platformId, ctx.text));
registerTelegramCommand('/provider', (ctx) => handleProviderCommand(ctx.token, ctx.platformId, ctx.text));
registerTelegramCommand('/playground', (ctx) => handlePlaygroundCommand(ctx.token, ctx.platformId, ctx.text));

/**
 * Outer interceptor that applies fork customizations (attachment processing,
 * slash-command dispatch) before forwarding to the pairing interceptor.
 * Wraps the already-pairing-wrapped onInbound so the call chain is:
 *   adapter → attachmentInterceptor → pairingInterceptor → hostOnInbound (router)
 */
function createAttachmentInterceptor(
  token: string,
  pairingOnInbound: ChannelSetup['onInbound'],
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    // Slash commands: dispatch to registered handlers. Anything that
    // returns true short-circuits the rest of the chain.
    if (message.kind === 'chat-sdk' && message.content && typeof message.content === 'object') {
      const c = message.content as ContentRecord;
      const text: string = c.text ?? '';
      const authorUserId =
        typeof c.author === 'object' && c.author && typeof (c.author as { userId?: unknown }).userId === 'string'
          ? ((c.author as { userId: string }).userId as string)
          : null;
      if (text.startsWith('/')) {
        const consumed = await dispatchTelegramCommand({ token, platformId, text, authorUserId });
        if (consumed) return;
      }
    }

    // Process attachments (photo, voice, PDF)
    const enriched = await processAttachments(platformId, message);

    await pairingOnInbound(platformId, threadId, enriched);
  };
}

// ---------------------------------------------------------------------------

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      async setup(hostConfig: ChannelSetup) {
        // Build interceptor chain: attachment processing → pairing → router
        const pairingIntercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        const attachmentIntercepted: ChannelSetup = {
          ...pairingIntercepted,
          onInbound: createAttachmentInterceptor(token, pairingIntercepted.onInbound),
        };
        return withRetry(() => bridge.setup(attachmentIntercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
