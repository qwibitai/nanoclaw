/**
 * Extract NanoClaw v1 state into portable JSON.
 *
 * Runs from a v2 worktree against an arbitrary v1 project root. Writes the
 * extracted state under `<v1Root>/.nanoclaw-migrations/v1-data/` so the
 * data travels with the v1 checkout across the worktree swap.
 *
 * This is a library function — invoked from `setup/migrate.ts`, not a
 * standalone CLI. Emits progress via the returned result, not via stdout.
 *
 * Read-only. Never writes into v1 tables; never reads secrets.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { CHANNEL_INSTALL_SKILL, inferChannelTypeFromJid } from './jid.js';
import { proposeOwner, type OwnerProposal, type RegisteredGroupLite, type V1Allowlist } from './owner-propose.js';

// Allowlist of non-secret .env keys. Anything else is dropped on the floor —
// secrets never leave the extraction step.
const SAFE_ENV_KEYS = new Set([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'IDLE_TIMEOUT',
  'MAX_CONCURRENT_CONTAINERS',
  'POLL_INTERVAL',
  'SCHEDULER_POLL_INTERVAL',
  // Owner hints (not secrets — channel handles)
  'OWNER_JID',
  'OWNER_PHONE',
  'OWNER_USER_ID',
  'NANOCLAW_ADMIN_USER_IDS',
]);

// Known upstream skill branches (v1 era). Used to classify skill merges so
// the guide can list the matching v2 install commands.
const KNOWN_SKILL_BRANCHES = new Set([
  'skill/whatsapp',
  'skill/telegram',
  'skill/discord',
  'skill/slack',
  'skill/imessage',
  'skill/webex',
  'skill/matrix',
  'skill/github',
  'skill/linear',
  'skill/teams',
  'skill/gchat',
  'skill/wechat',
  'skill/resend',
  'skill/whatsapp-cloud',
  'skill/voice-transcription',
  'skill/image-vision',
  'skill/pdf-reader',
  'skill/reactions',
  'skill/compact',
  'skill/apple-container',
  'skill/dashboard',
  'skill/vercel',
  'skill/ollama-tool',
  'skill/parallel',
]);

const SKILL_BRANCH_TO_V2: Record<string, string> = {
  'skill/whatsapp': '/add-whatsapp',
  'skill/telegram': '/add-telegram',
  'skill/discord': '/add-discord',
  'skill/slack': '/add-slack',
  'skill/imessage': '/add-imessage',
  'skill/webex': '/add-webex',
  'skill/matrix': '/add-matrix',
  'skill/github': '/add-github',
  'skill/linear': '/add-linear',
  'skill/teams': '/add-teams',
  'skill/gchat': '/add-gchat',
  'skill/wechat': '/add-wechat',
  'skill/resend': '/add-resend',
  'skill/whatsapp-cloud': '/add-whatsapp-cloud',
  'skill/voice-transcription': '/add-voice-transcription',
  'skill/image-vision': '/add-image-vision',
  'skill/pdf-reader': '/add-pdf-reader',
  'skill/reactions': '/add-reactions',
  'skill/compact': '/add-compact',
  'skill/apple-container': '/convert-to-apple-container',
  'skill/dashboard': '/add-dashboard',
  'skill/vercel': '/add-vercel',
  'skill/ollama-tool': '/add-ollama-tool',
  'skill/parallel': '/add-parallel',
};

export interface V1Group {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: unknown | null;
  requires_trigger: number;
  is_main: boolean;
  inferred_channel_type: string;
  inferred_is_group: number;
}

export interface V1ExtractResult {
  v1Root: string;
  outDir: string;
  env: Record<string, string>;
  registeredGroups: V1Group[];
  sessions: Array<{ group_folder: string; session_id: string }>;
  scheduledTasks: unknown[];
  routerState: Record<string, string>;
  groups: Array<{ folder: string; has_claude_md: boolean; claude_md_bytes: number; files: string[] }>;
  senderAllowlist: V1Allowlist | null;
  mountAllowlist: unknown | null;
  gitHead: string;
  gitMergeBase: string | null;
  gitUpstreamRef: string | null;
  appliedSkillMerges: Array<{ branch: string; merge_commit: string; v2_install?: string }>;
  userAuthoredSkillDirs: string[];
  customizedFiles: Array<{ path: string; additions: number; deletions: number }>;
  channelsInUse: string[];
  unknownJids: string[];
  chatRowCount: number;
  ownerProposal: OwnerProposal;
  requiredChannelSkills: string[];
}

export async function runExtract(v1Root: string): Promise<V1ExtractResult> {
  const outDir = path.join(v1Root, '.nanoclaw-migrations', 'v1-data');
  fs.mkdirSync(outDir, { recursive: true });

  const env = readSafeEnv(path.join(v1Root, '.env'));
  const senderAllowlist = readJson<V1Allowlist>(
    path.join(os.homedir(), '.config', 'nanoclaw', 'sender-allowlist.json'),
  );
  const mountAllowlist = readJson<unknown>(
    path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json'),
  );

  const db = extractDb(path.join(v1Root, 'store', 'messages.db'));
  const git = extractGit(v1Root);
  const groups = extractGroupsDir(path.join(v1Root, 'groups'));

  const channelsInUse = [...new Set(db.registeredGroups.map((g) => g.inferred_channel_type))].filter(
    (c) => c !== 'unknown',
  );
  const requiredChannelSkills = [
    ...new Set(channelsInUse.map((c) => CHANNEL_INSTALL_SKILL[c] ?? `/add-${c}`)),
  ];

  const ownerProposal = proposeOwner(
    env,
    db.registeredGroups as RegisteredGroupLite[],
    senderAllowlist,
  );

  const result: V1ExtractResult = {
    v1Root,
    outDir,
    env,
    registeredGroups: db.registeredGroups,
    sessions: db.sessions,
    scheduledTasks: db.scheduledTasks,
    routerState: db.routerState,
    groups,
    senderAllowlist,
    mountAllowlist,
    gitHead: git.head,
    gitMergeBase: git.mergeBase,
    gitUpstreamRef: git.upstreamRef,
    appliedSkillMerges: git.appliedSkillMerges,
    userAuthoredSkillDirs: git.userSkillDirs,
    customizedFiles: git.customizedFiles,
    channelsInUse,
    unknownJids: db.unknownJids,
    chatRowCount: db.chatRowCount,
    ownerProposal,
    requiredChannelSkills,
  };

  writeAllArtifacts(result);
  return result;
}

// ── v1 DB reader ──

interface DbExtract {
  registeredGroups: V1Group[];
  sessions: Array<{ group_folder: string; session_id: string }>;
  scheduledTasks: unknown[];
  routerState: Record<string, string>;
  unknownJids: string[];
  chatRowCount: number;
}

function extractDb(dbPath: string): DbExtract {
  const empty: DbExtract = {
    registeredGroups: [],
    sessions: [],
    scheduledTasks: [],
    routerState: {},
    unknownJids: [],
    chatRowCount: 0,
  };
  if (!fs.existsSync(dbPath)) return empty;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const result: DbExtract = { ...empty };

  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  for (const row of rows) {
    const inferred = inferChannelTypeFromJid(row.jid);
    if (inferred.channel_type === 'unknown') result.unknownJids.push(row.jid);
    result.registeredGroups.push({
      jid: row.jid,
      name: row.name,
      folder: row.folder,
      trigger_pattern: row.trigger_pattern,
      added_at: row.added_at,
      container_config: row.container_config ? safeJsonParse(row.container_config) : null,
      requires_trigger: row.requires_trigger ?? 1,
      is_main: row.is_main === 1,
      inferred_channel_type: inferred.channel_type,
      inferred_is_group: inferred.is_group,
    });
  }

  try {
    result.sessions = db.prepare('SELECT group_folder, session_id FROM sessions').all() as Array<{
      group_folder: string;
      session_id: string;
    }>;
  } catch {
    /* pre-1.2 DBs may not have this table */
  }

  try {
    result.scheduledTasks = db
      .prepare(
        'SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, ' +
          "COALESCE(context_mode, 'isolated') AS context_mode, status, created_at " +
          "FROM scheduled_tasks WHERE status IN ('active', 'paused')",
      )
      .all();
  } catch {
    /* older DBs may not have scheduled_tasks */
  }

  try {
    const rs = db.prepare('SELECT key, value FROM router_state').all() as Array<{
      key: string;
      value: string;
    }>;
    for (const r of rs) result.routerState[r.key] = r.value;
  } catch {
    /* optional */
  }

  try {
    const c = db.prepare('SELECT COUNT(*) AS c FROM chats').get() as { c: number };
    result.chatRowCount = c.c;
  } catch {
    /* optional */
  }

  db.close();
  return result;
}

// ── git state ──

interface GitState {
  head: string;
  mergeBase: string | null;
  upstreamRef: string | null;
  appliedSkillMerges: Array<{ branch: string; merge_commit: string; v2_install?: string }>;
  userSkillDirs: string[];
  customizedFiles: Array<{ path: string; additions: number; deletions: number }>;
}

function extractGit(v1Root: string): GitState {
  const head = sh('git rev-parse HEAD', v1Root);
  const { base, upstream } = findMergeBase(v1Root);

  const appliedSkillMerges: GitState['appliedSkillMerges'] = [];
  if (head) {
    const merges = sh(
      `git log --merges --pretty=format:"%H%x09%s" ${base ? `${base}..HEAD` : ''}`,
      v1Root,
    );
    for (const line of merges.split('\n').filter(Boolean)) {
      const [hash, ...rest] = line.split('\t');
      const subject = rest.join('\t');
      for (const branch of KNOWN_SKILL_BRANCHES) {
        const slug = branch.replace('skill/', '');
        if (subject.includes(branch) || subject.includes(slug)) {
          appliedSkillMerges.push({
            branch,
            merge_commit: hash,
            v2_install: SKILL_BRANCH_TO_V2[branch],
          });
          break;
        }
      }
    }
  }

  const customizedFiles: GitState['customizedFiles'] = [];
  if (base) {
    const numstat = sh(`git diff --numstat ${base}..HEAD`, v1Root);
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [addStr, delStr, file] = line.split('\t');
      if (!file) continue;
      customizedFiles.push({
        path: file,
        additions: addStr === '-' ? 0 : parseInt(addStr, 10) || 0,
        deletions: delStr === '-' ? 0 : parseInt(delStr, 10) || 0,
      });
    }
  }

  const userSkillDirs: string[] = [];
  const claudeSkills = path.join(v1Root, '.claude', 'skills');
  if (fs.existsSync(claudeSkills)) {
    for (const entry of fs.readdirSync(claudeSkills)) {
      const full = path.join(claudeSkills, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      const added = sh(
        `git log --diff-filter=A --pretty=format:"%H" -- .claude/skills/${entry}/SKILL.md`,
        v1Root,
      );
      const addedHash = added.split('\n')[0];
      const fromSkillMerge = appliedSkillMerges.some((m) => m.merge_commit === addedHash);
      if (!fromSkillMerge) userSkillDirs.push(entry);
    }
  }

  return { head, mergeBase: base, upstreamRef: upstream, appliedSkillMerges, userSkillDirs, customizedFiles };
}

function findMergeBase(cwd: string): { base: string | null; upstream: string | null } {
  for (const remote of ['upstream', 'origin']) {
    for (const branch of ['main', 'master']) {
      const ref = `${remote}/${branch}`;
      if (sh(`git rev-parse --verify --quiet ${ref}`, cwd)) {
        const base = sh(`git merge-base HEAD ${ref}`, cwd);
        if (base) return { base, upstream: ref };
      }
    }
  }
  return { base: null, upstream: null };
}

// ── groups dir ──

function extractGroupsDir(
  groupsDir: string,
): Array<{ folder: string; has_claude_md: boolean; claude_md_bytes: number; files: string[] }> {
  if (!fs.existsSync(groupsDir)) return [];
  const out: Array<{ folder: string; has_claude_md: boolean; claude_md_bytes: number; files: string[] }> = [];
  for (const entry of fs.readdirSync(groupsDir)) {
    const full = path.join(groupsDir, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    const claudeMd = path.join(full, 'CLAUDE.md');
    const hasClaude = fs.existsSync(claudeMd);
    out.push({
      folder: entry,
      has_claude_md: hasClaude,
      claude_md_bytes: hasClaude ? fs.statSync(claudeMd).size : 0,
      files: fs.readdirSync(full),
    });
  }
  return out;
}

// ── helpers ──

function readSafeEnv(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!SAFE_ENV_KEYS.has(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

function readJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function sh(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// ── write artifacts ──

function writeAllArtifacts(r: V1ExtractResult): void {
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(r.outDir, name), JSON.stringify(data, null, 2) + '\n');

  write('env.json', r.env);
  write('sender-allowlist.json', r.senderAllowlist ?? {});
  write('mount-allowlist.json', r.mountAllowlist ?? {});
  write('registered-groups.json', r.registeredGroups);
  write('sessions.json', r.sessions);
  write('scheduled-tasks.json', r.scheduledTasks);
  write('router-state.json', r.routerState);
  write('groups.json', r.groups);
  write('applied-skills.json', {
    merges: r.appliedSkillMerges,
    user_authored_skill_dirs: r.userAuthoredSkillDirs,
  });
  write('git-customizations.json', {
    head: r.gitHead,
    merge_base: r.gitMergeBase,
    upstream_ref: r.gitUpstreamRef,
    files: r.customizedFiles,
  });
  write('owner.json', r.ownerProposal);
}
