/**
 * IPC watcher — polls `data/ipc/<folder>/messages/*.json` and injects
 * synthetic messages directly into the agent's session inbound DB.
 *
 * Used by out-of-process producers (NSSM-managed `roosync-inbox-standalone`,
 * external scripts) to wake an agent without going through a chat platform.
 *
 * **Trust model:** IPC files come from local services running under the
 * same Windows account as nanoclaw — file system permissions ARE the auth
 * boundary. We therefore bypass `routeInbound` (which runs the
 * access-gate / unknown-sender / engage-mode checks meant for untrusted
 * platform input) and write directly via `writeSessionMessage` + spawn the
 * container via `wakeContainer`. This matches v1 `storeMessageDirect`
 * semantics and explicitly accepts the trade-off: any local code with
 * write access to `data/ipc/` can wake any agent — that's the same trust
 * level as anything that can already touch `data/v2.db` or session DBs.
 *
 * Currently handles `inject_synthetic_message` only — the path used by the
 * RooSync inbox watcher to surface cross-machine dashboard mentions. The v1
 * `message` type (cross-group send) is not ported because no producer in
 * this repo emits it; route through the channel adapter directly if needed.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from './db/messaging-groups.js';
import { findSessionByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';

const POLL_INTERVAL_MS = 15_000;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

interface InboxMsg {
  id: string;
  from: string;
  to?: string;
  subject?: string;
  body?: string;
  tags?: string[];
  priority?: string;
}

interface InjectSyntheticMessage {
  type: 'inject_synthetic_message';
  inboxMsg: InboxMsg;
}

export function startIpcWatcher(): void {
  const baseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(baseDir, { recursive: true });
  log.info('IPC watcher started', { baseDir, pollMs: POLL_INTERVAL_MS });

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pollOnce(baseDir);
    } catch (err) {
      log.error('IPC watcher loop error', { err });
    }
    if (!stopped) timer = setTimeout(loop, POLL_INTERVAL_MS);
  };
  timer = setTimeout(loop, POLL_INTERVAL_MS);
}

export function stopIpcWatcher(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

async function pollOnce(baseDir: string): Promise<void> {
  if (!fs.existsSync(baseDir)) return;
  const folders = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'errors')
    .map((d) => d.name);

  for (const folder of folders) {
    const messagesDir = path.join(baseDir, folder, 'messages');
    if (!fs.existsSync(messagesDir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      log.error('IPC: readdir failed', { folder, err });
      continue;
    }
    for (const file of files) {
      const filePath = path.join(messagesDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        const handled = await processIpcMessage(folder, data);
        if (handled) {
          fs.unlinkSync(filePath);
        } else {
          // Unrecognized payload — quarantine so we don't re-process forever.
          quarantine(baseDir, folder, file, filePath, 'unrecognized payload');
        }
      } catch (err) {
        log.error('IPC: error processing file', { folder, file, err });
        quarantine(baseDir, folder, file, filePath, String(err));
      }
    }
  }
}

function quarantine(baseDir: string, folder: string, file: string, filePath: string, reason: string): void {
  const errorsDir = path.join(baseDir, folder, 'errors');
  try {
    fs.mkdirSync(errorsDir, { recursive: true });
    fs.renameSync(filePath, path.join(errorsDir, file));
    log.warn('IPC: file quarantined', { folder, file, reason });
  } catch (err) {
    log.error('IPC: quarantine failed', { folder, file, reason, err });
  }
}

async function processIpcMessage(folder: string, data: unknown): Promise<boolean> {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Partial<InjectSyntheticMessage>;
  if (obj.type !== 'inject_synthetic_message' || !obj.inboxMsg) return false;
  const inboxMsg = obj.inboxMsg;

  const ag = getAgentGroupByFolder(folder);
  if (!ag) {
    log.warn('IPC inject: no agent group for folder', { folder, msgId: inboxMsg.id });
    return true; // consume — no point retrying when wiring is absent
  }

  // Resolve a target session. Prefer an existing active session for this
  // agent group (typical case: one shared session per cluster manager
  // install). Fall back to creating one against the first wired messaging
  // group so the synthetic message reaches the right container even on a
  // cold install that hasn't seen any traffic yet.
  let session = findSessionByAgentGroup(ag.id);
  let mgChannelType: string | null = null;
  let mgPlatformId: string | null = null;

  if (!session) {
    const mgs = getMessagingGroupsByAgentGroup(ag.id);
    if (mgs.length === 0) {
      log.warn('IPC inject: no messaging group wired and no active session', {
        folder,
        agentGroupId: ag.id,
        msgId: inboxMsg.id,
      });
      return true;
    }
    const mg = mgs[0];
    const resolved = resolveSession(ag.id, mg.id, null, 'shared');
    session = resolved.session;
    mgChannelType = mg.channel_type;
    mgPlatformId = mg.platform_id;
  } else {
    // Look up the messaging group attached to this session for routing
    // metadata. Fall back to the first wired one when the session predates
    // a messaging group rename / re-wire.
    const mgs = getMessagingGroupsByAgentGroup(ag.id);
    const sessionMg = mgs.find((m) => m.id === session!.messaging_group_id) ?? mgs[0];
    if (sessionMg) {
      mgChannelType = sessionMg.channel_type;
      mgPlatformId = sessionMg.platform_id;
    }
  }

  const shortBody = (inboxMsg.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const tagsSuffix = inboxMsg.tags?.length ? ` [${inboxMsg.tags.join(', ')}]` : '';
  const text =
    `[roosync-inbox] Nouvelle mention RooSync reçue.\n\n` +
    `From: ${inboxMsg.from}\nSubject: ${inboxMsg.subject ?? ''}${tagsSuffix}\nMessageId: ${inboxMsg.id}\n\n` +
    `Extrait: ${shortBody}\n\n` +
    `Lis ton inbox (roosync_read mode:"inbox") et agis selon le contenu.`;

  const nowIso = new Date().toISOString();
  const syntheticId = `roosync-${inboxMsg.id}`;
  const chatMsg = {
    _type: 'chat:Message',
    id: syntheticId,
    threadId: mgPlatformId ?? '',
    text,
    author: {
      userId: 'roosync-inbox',
      userName: 'RooSync Inbox',
      fullName: 'RooSync Inbox',
      isBot: false,
      isMe: false,
    },
    metadata: { dateSent: nowIso, edited: false },
    attachments: [],
    isMention: true,
    senderId: 'system:roosync-inbox',
    sender: 'RooSync Inbox',
    senderName: 'RooSync Inbox',
  };

  try {
    writeSessionMessage(ag.id, session.id, {
      id: syntheticId,
      kind: 'chat-sdk',
      timestamp: nowIso,
      platformId: mgPlatformId,
      channelType: mgChannelType,
      threadId: null,
      content: JSON.stringify(chatMsg),
      trigger: 1,
    });
  } catch (err) {
    log.error('IPC: writeSessionMessage failed', {
      folder,
      msgId: inboxMsg.id,
      sessionId: session.id,
      err,
    });
    return false; // quarantine — likely transient; retry next poll cycle
  }

  // Fire-and-forget container wake. wakeContainer is async and may need to
  // pull the image / bind-mount config; surfacing failures here would block
  // the next poll, and the host sweep will also wake on its 60s schedule.
  void wakeContainer(session).catch((err) =>
    log.warn('IPC: wakeContainer failed (host sweep will retry)', { sessionId: session.id, err }),
  );

  log.info('IPC injected synthetic message', {
    folder,
    msgId: inboxMsg.id,
    syntheticId,
    agentGroupId: ag.id,
    sessionId: session.id,
  });

  return true;
}
