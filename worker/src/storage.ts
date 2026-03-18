/**
 * ThagomizerClaw — Cloudflare R2 + KV Storage Adapter
 *
 * Replaces local filesystem operations (groups/, data/) with:
 *   - R2: Large objects (CLAUDE.md, session data, agent runner source, logs)
 *   - KV: Small, frequently-read values (sessions, cursors, state)
 *
 * Key naming conventions:
 *   R2:  groups/{folder}/CLAUDE.md
 *        groups/{folder}/logs/{timestamp}.log
 *        sessions/{folder}/.claude/settings.json
 *   KV:  session:{folder}         → session ID
 *        cursor:{chatJid}         → last processed timestamp
 */

// ─── Group Files (R2) ─────────────────────────────────────────────────────────

export async function getGroupClaudeMd(
  storage: R2Bucket,
  groupFolder: string,
): Promise<string | null> {
  const obj = await storage.get(`groups/${groupFolder}/CLAUDE.md`);
  if (!obj) return null;
  return obj.text();
}

export async function setGroupClaudeMd(
  storage: R2Bucket,
  groupFolder: string,
  content: string,
): Promise<void> {
  await storage.put(`groups/${groupFolder}/CLAUDE.md`, content, {
    httpMetadata: { contentType: 'text/markdown' },
  });
}

export async function getGlobalClaudeMd(storage: R2Bucket): Promise<string | null> {
  const obj = await storage.get('groups/global/CLAUDE.md');
  if (!obj) return null;
  return obj.text();
}

// ─── Session Settings (R2) ────────────────────────────────────────────────────

const DEFAULT_CLAUDE_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

export async function getSessionSettings(
  storage: R2Bucket,
  groupFolder: string,
): Promise<Record<string, unknown>> {
  const obj = await storage.get(`sessions/${groupFolder}/.claude/settings.json`);
  if (!obj) return DEFAULT_CLAUDE_SETTINGS;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return DEFAULT_CLAUDE_SETTINGS;
  }
}

export async function setSessionSettings(
  storage: R2Bucket,
  groupFolder: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await storage.put(
    `sessions/${groupFolder}/.claude/settings.json`,
    JSON.stringify(settings, null, 2),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

// ─── Agent Logs (R2) ──────────────────────────────────────────────────────────

export async function writeAgentLog(
  storage: R2Bucket,
  groupFolder: string,
  log: {
    timestamp: string;
    group: string;
    isMain: boolean;
    durationMs: number;
    status: string;
    promptLength: number;
    model?: string;
    error?: string;
  },
): Promise<void> {
  const ts = log.timestamp.replace(/[:.]/g, '-');
  const key = `groups/${groupFolder}/logs/agent-${ts}.json`;
  await storage.put(key, JSON.stringify(log, null, 2), {
    httpMetadata: { contentType: 'application/json' },
    // Auto-expire logs after 30 days
    customMetadata: { expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
  });
}

// ─── Sender Allowlist (R2) ───────────────────────────────────────────────────

export interface SenderAllowlistConfig {
  mode: 'allow' | 'drop';
  groups: Record<
    string,
    {
      allowedSenders?: string[];
      allowedTriggers?: string[];
      dropMode?: boolean;
    }
  >;
  logDenied?: boolean;
}

export async function getSenderAllowlist(
  storage: R2Bucket,
): Promise<SenderAllowlistConfig | null> {
  const obj = await storage.get('config/sender-allowlist.json');
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

export async function setSenderAllowlist(
  storage: R2Bucket,
  config: SenderAllowlistConfig,
): Promise<void> {
  await storage.put('config/sender-allowlist.json', JSON.stringify(config, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// ─── Snapshots (R2) — available groups and tasks ─────────────────────────────

export async function writeTasksSnapshot(
  storage: R2Bucket,
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): Promise<void> {
  const filtered = isMain ? tasks : tasks.filter((t) => t.groupFolder === groupFolder);
  await storage.put(
    `sessions/${groupFolder}/ipc/current_tasks.json`,
    JSON.stringify(filtered, null, 2),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

export async function writeGroupsSnapshot(
  storage: R2Bucket,
  groupFolder: string,
  isMain: boolean,
  groups: Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }>,
  registeredJids: Set<string>,
): Promise<void> {
  const visibleGroups = isMain ? groups : [];
  await storage.put(
    `sessions/${groupFolder}/ipc/available_groups.json`,
    JSON.stringify({ groups: visibleGroups, lastSync: new Date().toISOString() }, null, 2),
    { httpMetadata: { contentType: 'application/json' } },
  );
}

// ─── KV Helpers ───────────────────────────────────────────────────────────────

export async function getCursor(
  kv: KVNamespace,
  chatJid: string,
): Promise<string> {
  return (await kv.get(`cursor:${chatJid}`)) ?? '';
}

export async function setCursor(
  kv: KVNamespace,
  chatJid: string,
  timestamp: string,
): Promise<void> {
  await kv.put(`cursor:${chatJid}`, timestamp);
}

export async function getSessionId(
  kv: KVNamespace,
  groupFolder: string,
): Promise<string | null> {
  return kv.get(`session:${groupFolder}`);
}

export async function setSessionId(
  kv: KVNamespace,
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  // Sessions expire after 7 days of inactivity
  await kv.put(`session:${groupFolder}`, sessionId, { expirationTtl: 7 * 24 * 60 * 60 });
}
