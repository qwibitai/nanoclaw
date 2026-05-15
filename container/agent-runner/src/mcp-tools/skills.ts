/**
 * Procedural skill memory tools.
 *
 * Shared/bundled skills live at /app/skills and are read-only. Local skills
 * live at /workspace/agent/skills and are writable by this agent group only.
 * The tools below make skill edits structured and validated instead of
 * relying on arbitrary Write/Edit calls into long-lived procedural memory.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const LOCAL_SKILLS_ROOT = '/workspace/agent/skills';
const SHARED_SKILLS_ROOT = '/app/skills';
const USAGE_FILE = '.usage.json';
const ARCHIVE_DIR = '.archived';
const SNAPSHOT_DIR = '.snapshots';
const PROPOSAL_DIR = '.proposals';
const MAX_SKILL_BYTES = 100 * 1024;
const MAX_SUPPORT_BYTES = 1024 * 1024;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORT_DIRS = new Set(['references', 'templates', 'scripts', 'assets']);

interface UsageEntry {
  createdBy: 'agent' | 'shared';
  origin: 'foreground' | 'background' | 'shared';
  createdAt: string;
  updatedAt: string;
  sourceTurnIds: string[];
  sourceConversationIds: string[];
  reviewStatus: 'unreviewed' | 'reviewed' | 'proposed';
  viewCount: number;
  useCount: number;
  patchCount: number;
  lastViewedAt: string | null;
  lastUsedAt: string | null;
  lastPatchedAt: string | null;
  state: 'active' | 'archived';
  pinned: boolean;
  lastOutcome?: string;
  lastNotes?: string;
  archivedAt?: string;
  archivePath?: string;
}

interface UsageData {
  version: 1;
  skills: Record<string, UsageEntry>;
}

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, string>;
}

interface Risk {
  code: string;
  severity: 'block' | 'warn';
  message: string;
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function okJson(value: unknown) {
  return ok(JSON.stringify(value, null, 2));
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeTimestamp(): string {
  return nowIso().replace(/[:.]/g, '-');
}

export function isSafeSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function ensureLocalRoot(): void {
  fs.mkdirSync(LOCAL_SKILLS_ROOT, { recursive: true });
  fs.mkdirSync(path.join(LOCAL_SKILLS_ROOT, ARCHIVE_DIR), { recursive: true });
  fs.mkdirSync(path.join(LOCAL_SKILLS_ROOT, SNAPSHOT_DIR), { recursive: true });
  fs.mkdirSync(path.join(LOCAL_SKILLS_ROOT, PROPOSAL_DIR), { recursive: true });
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function localSkillDir(name: string): string {
  return path.join(LOCAL_SKILLS_ROOT, name);
}

function sharedSkillDir(name: string): string {
  return path.join(SHARED_SKILLS_ROOT, name);
}

function archivedSkillDir(name: string): string {
  return path.join(LOCAL_SKILLS_ROOT, ARCHIVE_DIR, name);
}

function skillExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'SKILL.md'));
  } catch {
    return false;
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function usagePath(): string {
  return path.join(LOCAL_SKILLS_ROOT, USAGE_FILE);
}

function readUsage(): UsageData {
  ensureLocalRoot();
  const file = usagePath();
  if (!fs.existsSync(file)) return { version: 1, skills: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as UsageData;
    if (parsed && parsed.version === 1 && parsed.skills && typeof parsed.skills === 'object') return parsed;
  } catch {
    /* fall through */
  }
  return { version: 1, skills: {} };
}

function writeUsage(data: UsageData): void {
  atomicWrite(usagePath(), JSON.stringify(data, null, 2) + '\n');
}

function defaultUsageEntry(source: 'local' | 'shared', createdAt = nowIso()): UsageEntry {
  return {
    createdBy: source === 'shared' ? 'shared' : 'agent',
    origin: source === 'shared' ? 'shared' : 'foreground',
    createdAt,
    updatedAt: createdAt,
    sourceTurnIds: [],
    sourceConversationIds: [],
    reviewStatus: 'unreviewed',
    viewCount: 0,
    useCount: 0,
    patchCount: 0,
    lastViewedAt: null,
    lastUsedAt: null,
    lastPatchedAt: null,
    state: 'active',
    pinned: false,
  };
}

function updateUsage(name: string, source: 'local' | 'shared', update: (entry: UsageEntry) => void): UsageEntry {
  const data = readUsage();
  const entry = data.skills[name] ?? defaultUsageEntry(source);
  update(entry);
  data.skills[name] = entry;
  writeUsage(data);
  return entry;
}

export function parseSkillDocument(content: string): ParsedSkill | { error: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { error: 'SKILL.md must start with YAML frontmatter.' };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { error: 'SKILL.md frontmatter must end with a --- line.' };
  const after = normalized.slice(end + '\n---'.length);
  if (after.length > 0 && !after.startsWith('\n')) return { error: 'SKILL.md frontmatter closing line must contain only ---.' };

  const rawFrontmatter = normalized.slice(4, end);
  const frontmatter: Record<string, string> = {};
  for (const line of rawFrontmatter.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[match[1]] = value;
  }

  const name = frontmatter.name?.trim() || '';
  const description = frontmatter.description?.trim() || '';
  if (!name) return { error: 'SKILL.md frontmatter must include name.' };
  if (!description) return { error: 'SKILL.md frontmatter must include description.' };

  const body = normalized.slice(end + '\n---'.length).trim();
  if (!body) return { error: 'SKILL.md body must be non-empty.' };
  return { name, description, body, frontmatter };
}

export function scanSkillContent(content: string): Risk[] {
  const risks: Risk[] = [];
  const add = (code: string, severity: Risk['severity'], message: string) => risks.push({ code, severity, message });

  if (/\b(sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/.test(content)) {
    add('secret-token', 'block', 'Content appears to contain a real API token or access token.');
  }
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/.test(content)) {
    add('private-key', 'block', 'Content appears to contain a private key.');
  }
  const secretAssignment =
    /^\s*[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*\s*=\s*['"]?(?!<|your-|placeholder|example|redacted|xxx|\.\.\.)[^\s'"]{12,}/gim;
  if (secretAssignment.test(content)) {
    add('secret-assignment', 'block', 'Content appears to contain credential assignment text.');
  }
  if (/^```(?:bash|sh|zsh|shell)\s*$/im.test(content)) {
    add('blind-shell-block', 'block', 'Skills should describe commands and decision points, not contain executable shell blocks.');
  }
  if (/\b(?:bypass|skip|disable|circumvent)\b.{0,50}\b(?:approval|approvals|permission|permissions)\b/i.test(content)) {
    add('approval-bypass', 'block', 'Content appears to instruct bypassing NanoClaw approvals or permissions.');
  }
  if (/\/var\/run\/docker\.sock|docker socket/i.test(content)) {
    add('docker-socket', 'warn', 'Content mentions Docker socket access; verify this belongs in a skill and preserves container boundaries.');
  }
  if (/\b(?:edit|modify|patch|rewrite)\b.{0,50}\b(?:src\/|container\/|Dockerfile|package\.json)\b.{0,80}\b(?:without|no)\b.{0,20}\bapproval\b/i.test(content)) {
    add('source-without-approval', 'block', 'Content appears to modify platform code without approval.');
  }
  return risks;
}

export function validateSkillDocument(content: string, expectedName?: string): { parsed?: ParsedSkill; risks: Risk[]; errors: string[] } {
  const errors: string[] = [];
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    errors.push(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes.`);
  }

  const parsed = parseSkillDocument(content);
  if ('error' in parsed) {
    errors.push(parsed.error);
  } else {
    if (!isSafeSkillName(parsed.name)) errors.push(`Invalid skill name in frontmatter: ${parsed.name}`);
    if (expectedName && parsed.name !== expectedName) {
      errors.push(`Frontmatter name "${parsed.name}" must match skill directory "${expectedName}".`);
    }
  }

  const risks = scanSkillContent(content);
  for (const risk of risks) {
    if (risk.severity === 'block') errors.push(risk.message);
  }

  return { parsed: 'error' in parsed ? undefined : parsed, risks, errors };
}

function resolveSupportFile(skillDir: string, filePath: string): string | { error: string } {
  const clean = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean === 'SKILL.md') return { error: 'Use create/edit/patch for SKILL.md; write_file is only for support files.' };
  const parts = clean.split('/').filter(Boolean);
  if (parts.length < 2) return { error: 'Support files must live under references/, templates/, scripts/, or assets/.' };
  if (!SUPPORT_DIRS.has(parts[0])) return { error: 'Support files must live under references/, templates/, scripts/, or assets/.' };
  if (parts.some((p) => p === '.' || p === '..' || p.startsWith('.'))) return { error: 'Unsafe support file path.' };
  const resolved = path.resolve(skillDir, ...parts);
  if (!isInside(resolved, skillDir)) return { error: 'Support file path escapes the skill directory.' };
  return resolved;
}

function resolveReadableFile(skillDir: string, filePath: string): string | { error: string } {
  if (filePath === 'SKILL.md') return path.join(skillDir, 'SKILL.md');
  return resolveSupportFile(skillDir, filePath);
}

function readSkillSummary(dir: string): { name: string; description: string } {
  try {
    const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const parsed = parseSkillDocument(content);
    if (!('error' in parsed)) return { name: parsed.name, description: parsed.description };
  } catch {
    /* ignore */
  }
  return { name: path.basename(dir), description: '' };
}

function listSkillDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => isSafeSkillName(entry))
    .filter((entry) => skillExists(path.join(root, entry)));
}

function resolveSkillDir(name: string, source: string | undefined): { dir: string; source: 'local' | 'shared' | 'archived' } | { error: string } {
  if (!isSafeSkillName(name)) return { error: `Invalid skill name: ${name}` };
  ensureLocalRoot();

  if (source === 'local') {
    const dir = localSkillDir(name);
    return skillExists(dir) ? { dir, source: 'local' } : { error: `Local skill not found: ${name}` };
  }
  if (source === 'shared') {
    const dir = sharedSkillDir(name);
    return skillExists(dir) ? { dir, source: 'shared' } : { error: `Shared skill not found: ${name}` };
  }
  if (source === 'archived') {
    const dir = archivedSkillDir(name);
    return skillExists(dir) ? { dir, source: 'archived' } : { error: `Archived skill not found: ${name}` };
  }

  const localDir = localSkillDir(name);
  if (skillExists(localDir)) return { dir: localDir, source: 'local' };
  const sharedDir = sharedSkillDir(name);
  if (skillExists(sharedDir)) return { dir: sharedDir, source: 'shared' };
  return { error: `Skill not found: ${name}` };
}

function createSnapshot(name: string, reason: string): string | null {
  const dir = localSkillDir(name);
  if (!skillExists(dir)) return null;
  const snapshot = path.join(LOCAL_SKILLS_ROOT, SNAPSHOT_DIR, `${safeTimestamp()}-${name}-${reason}`);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.cpSync(dir, snapshot, { recursive: true });
  return snapshot;
}

function buildSkillContent(args: Record<string, unknown>, name: string): string | { error: string } {
  const content = asString(args.content);
  if (content) return content;

  const description = asString(args.description).trim();
  const body = asString(args.body).trim();
  const title = asString(args.title).trim() || name;
  if (!description || !body) {
    return { error: 'Provide either full content or both description and body.' };
  }
  if (description.includes('\n')) return { error: 'description must be a single line.' };
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${title}\n\n${body}\n`;
}

function requestedName(args: Record<string, unknown>): string | { error: string } {
  const explicit = asString(args.name).trim();
  const name = explicit || slugify(asString(args.title));
  if (!name) return { error: 'name is required.' };
  if (!isSafeSkillName(name)) return { error: `Invalid skill name: ${name}` };
  return name;
}

function ensureNoCollision(name: string): string | null {
  if (skillExists(localSkillDir(name))) return `Local skill already exists: ${name}`;
  if (skillExists(sharedSkillDir(name))) return `Cannot create local skill "${name}" because a shared skill has the same name.`;
  return null;
}

function writeProposal(action: string, args: Record<string, unknown>, risks: Risk[]): string {
  ensureLocalRoot();
  const proposalPath = path.join(LOCAL_SKILLS_ROOT, PROPOSAL_DIR, `${safeTimestamp()}-${action}.json`);
  atomicWrite(
    proposalPath,
    JSON.stringify(
      {
        type: 'self_improvement_candidate',
        visibility: 'internal',
        action,
        createdAt: nowIso(),
        sourceTurnIds: asStringArray(args.sourceTurnIds),
        sourceConversationIds: asStringArray(args.sourceConversationIds),
        title: asString(args.title) || asString(args.name),
        name: asString(args.name),
        summary: asString(args.summary),
        risk: risks.some((r) => r.severity === 'block') ? 'blocked' : risks.length ? 'review' : 'low',
        risks,
        payload: args,
      },
      null,
      2,
    ) + '\n',
  );
  return proposalPath;
}

export const skillView: McpToolDefinition = {
  tool: {
    name: 'skill_view',
    description: 'List or read shared and per-group local skills. Use before updating procedural memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'read_file'], description: 'Operation to perform' },
        name: { type: 'string', description: 'Skill name for read/read_file' },
        source: { type: 'string', enum: ['auto', 'local', 'shared', 'archived'], description: 'Skill source; auto prefers local then shared' },
        filePath: { type: 'string', description: 'Support file path for read_file; use SKILL.md for the main skill file' },
        includeArchived: { type: 'boolean', description: 'Include archived local skills in list results' },
      },
      required: ['action'],
    },
  },
  async handler(args) {
    const action = asString(args.action) || 'list';
    ensureLocalRoot();

    if (action === 'list') {
      const usage = readUsage();
      const skills: unknown[] = [];
      for (const name of listSkillDirs(SHARED_SKILLS_ROOT)) {
        const dir = sharedSkillDir(name);
        skills.push({ ...readSkillSummary(dir), source: 'shared', path: dir });
      }
      for (const name of listSkillDirs(LOCAL_SKILLS_ROOT)) {
        const dir = localSkillDir(name);
        skills.push({ ...readSkillSummary(dir), source: 'local', path: dir, usage: usage.skills[name] ?? null });
      }
      if (args.includeArchived === true) {
        const archivedRoot = path.join(LOCAL_SKILLS_ROOT, ARCHIVE_DIR);
        for (const name of listSkillDirs(archivedRoot)) {
          const dir = path.join(archivedRoot, name);
          skills.push({ ...readSkillSummary(dir), source: 'archived', path: dir });
        }
      }
      return okJson({ skills });
    }

    const name = asString(args.name);
    if (!name) return err('name is required');
    const resolved = resolveSkillDir(name, asString(args.source) || 'auto');
    if ('error' in resolved) return err(resolved.error);

    if (action === 'read') {
      const content = fs.readFileSync(path.join(resolved.dir, 'SKILL.md'), 'utf8');
      if (resolved.source !== 'archived') {
        updateUsage(name, resolved.source, (entry) => {
          entry.viewCount += 1;
          entry.lastViewedAt = nowIso();
        });
      }
      return ok(content);
    }

    if (action === 'read_file') {
      const filePath = asString(args.filePath);
      if (!filePath) return err('filePath is required');
      const resolvedFile = resolveReadableFile(resolved.dir, filePath);
      if (typeof resolvedFile !== 'string') return err(resolvedFile.error);
      if (!fs.existsSync(resolvedFile)) return err(`File not found: ${filePath}`);
      if (fs.statSync(resolvedFile).size > MAX_SUPPORT_BYTES) return err(`File exceeds ${MAX_SUPPORT_BYTES} bytes.`);
      return ok(fs.readFileSync(resolvedFile, 'utf8'));
    }

    return err(`Unknown skill_view action: ${action}`);
  },
};

export const skillManage: McpToolDefinition = {
  tool: {
    name: 'skill_manage',
    description: 'Create, validate, patch, archive, pin, or record use of per-group local skills. Never modifies shared skills.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['validate', 'create', 'propose_create', 'edit', 'patch', 'propose_update', 'write_file', 'archive', 'pin', 'unpin', 'record_use'],
        },
        name: { type: 'string', description: 'Local skill slug' },
        title: { type: 'string', description: 'Human title, used to build content or proposals' },
        description: { type: 'string', description: 'One-line skill description when building content' },
        body: { type: 'string', description: 'Skill body when building content' },
        content: { type: 'string', description: 'Full SKILL.md content, or support file content for write_file' },
        filePath: { type: 'string', description: 'Support file path, or SKILL.md for patch' },
        oldText: { type: 'string', description: 'Text to replace for patch' },
        newText: { type: 'string', description: 'Replacement text for patch' },
        reason: { type: 'string', description: 'Reason for archive/proposal/update' },
        outcome: { type: 'string', description: 'Outcome for record_use' },
        notes: { type: 'string', description: 'Notes for record_use or proposals' },
        sourceTurnIds: { type: 'array', items: { type: 'string' }, description: 'Turn IDs that motivated this change' },
        sourceConversationIds: { type: 'array', items: { type: 'string' }, description: 'Conversation IDs that motivated this change' },
      },
      required: ['action'],
    },
  },
  async handler(args) {
    const action = asString(args.action);
    ensureLocalRoot();

    if (action === 'validate') {
      const content = asString(args.content);
      if (!content) return err('content is required');
      const name = asString(args.name) || undefined;
      const result = validateSkillDocument(content, name);
      return okJson({ ok: result.errors.length === 0, errors: result.errors, risks: result.risks, parsed: result.parsed });
    }

    if (action === 'create' || action === 'propose_create') {
      const name = requestedName(args);
      if (typeof name !== 'string') return err(name.error);
      const content = buildSkillContent(args, name);
      if (typeof content !== 'string') return err(content.error);
      const validation = validateSkillDocument(content, name);
      if (validation.errors.length > 0) return err(validation.errors.join('\n'));

      if (action === 'propose_create') {
        const proposalPath = writeProposal(action, { ...args, name, content }, validation.risks);
        return okJson({ proposed: true, proposalPath, risks: validation.risks });
      }

      const collision = ensureNoCollision(name);
      if (collision) return err(collision);
      const dir = localSkillDir(name);
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(path.join(dir, 'SKILL.md'), content);
      const entry = updateUsage(name, 'local', (usage) => {
        const t = nowIso();
        usage.createdAt = usage.createdAt || t;
        usage.updatedAt = t;
        usage.sourceTurnIds = [...new Set([...usage.sourceTurnIds, ...asStringArray(args.sourceTurnIds)])];
        usage.sourceConversationIds = [...new Set([...usage.sourceConversationIds, ...asStringArray(args.sourceConversationIds)])];
      });
      log(`skill_manage create: ${name}`);
      return okJson({ created: name, path: dir, usage: entry, risks: validation.risks });
    }

    const name = asString(args.name);
    if (!name || !isSafeSkillName(name)) return err('A valid local skill name is required.');

    if (action === 'propose_update') {
      const content = asString(args.content) || asString(args.body) || asString(args.newText);
      const risks = content ? scanSkillContent(content) : [];
      if (risks.some((risk) => risk.severity === 'block')) return err(risks.map((r) => r.message).join('\n'));
      const proposalPath = writeProposal(action, args, risks);
      return okJson({ proposed: true, proposalPath, risks });
    }

    const dir = localSkillDir(name);
    if (action !== 'record_use' && !skillExists(dir)) return err(`Local skill not found: ${name}`);

    if (action === 'edit') {
      const content = asString(args.content);
      if (!content) return err('content is required');
      const validation = validateSkillDocument(content, name);
      if (validation.errors.length > 0) return err(validation.errors.join('\n'));
      const snapshot = createSnapshot(name, 'edit');
      atomicWrite(path.join(dir, 'SKILL.md'), content);
      const entry = updateUsage(name, 'local', (usage) => {
        usage.updatedAt = nowIso();
        usage.patchCount += 1;
        usage.lastPatchedAt = nowIso();
      });
      return okJson({ edited: name, snapshot, usage: entry, risks: validation.risks });
    }

    if (action === 'patch') {
      const filePath = asString(args.filePath) || 'SKILL.md';
      const oldText = asString(args.oldText);
      const newText = asString(args.newText);
      if (!oldText) return err('oldText is required');
      const target = filePath === 'SKILL.md' ? path.join(dir, 'SKILL.md') : resolveSupportFile(dir, filePath);
      if (typeof target !== 'string') return err(target.error);
      if (!fs.existsSync(target)) return err(`File not found: ${filePath}`);
      const current = fs.readFileSync(target, 'utf8');
      const first = current.indexOf(oldText);
      if (first < 0) return err('oldText was not found.');
      if (current.indexOf(oldText, first + oldText.length) >= 0) return err('oldText appears more than once; patch would be ambiguous.');
      const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
      if (filePath === 'SKILL.md') {
        const validation = validateSkillDocument(next, name);
        if (validation.errors.length > 0) return err(validation.errors.join('\n'));
      } else if (Buffer.byteLength(next, 'utf8') > MAX_SUPPORT_BYTES) {
        return err(`Support file exceeds ${MAX_SUPPORT_BYTES} bytes.`);
      }
      const risks = scanSkillContent(next);
      if (risks.some((risk) => risk.severity === 'block')) return err(risks.map((r) => r.message).join('\n'));
      const snapshot = createSnapshot(name, 'patch');
      atomicWrite(target, next);
      const entry = updateUsage(name, 'local', (usage) => {
        usage.updatedAt = nowIso();
        usage.patchCount += 1;
        usage.lastPatchedAt = nowIso();
      });
      return okJson({ patched: name, filePath, snapshot, usage: entry, risks });
    }

    if (action === 'write_file') {
      const filePath = asString(args.filePath);
      const content = asString(args.content);
      if (!filePath) return err('filePath is required');
      if (Buffer.byteLength(content, 'utf8') > MAX_SUPPORT_BYTES) return err(`Support file exceeds ${MAX_SUPPORT_BYTES} bytes.`);
      const risks = scanSkillContent(content);
      if (risks.some((risk) => risk.severity === 'block')) return err(risks.map((r) => r.message).join('\n'));
      const target = resolveSupportFile(dir, filePath);
      if (typeof target !== 'string') return err(target.error);
      const snapshot = createSnapshot(name, 'write-file');
      atomicWrite(target, content);
      const entry = updateUsage(name, 'local', (usage) => {
        usage.updatedAt = nowIso();
        usage.patchCount += 1;
        usage.lastPatchedAt = nowIso();
      });
      return okJson({ written: filePath, skill: name, snapshot, usage: entry, risks });
    }

    if (action === 'archive') {
      const usage = readUsage();
      if (usage.skills[name]?.pinned) return err(`Skill "${name}" is pinned; unpin before archiving.`);
      const snapshot = createSnapshot(name, 'archive');
      const archiveName = `${safeTimestamp()}-${name}`;
      const archivePath = path.join(LOCAL_SKILLS_ROOT, ARCHIVE_DIR, archiveName);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.renameSync(dir, archivePath);
      const entry = updateUsage(name, 'local', (item) => {
        item.updatedAt = nowIso();
        item.state = 'archived';
        item.archivedAt = nowIso();
        item.archivePath = archivePath;
        item.lastNotes = asString(args.reason);
      });
      return okJson({ archived: name, archivePath, snapshot, usage: entry });
    }

    if (action === 'pin' || action === 'unpin') {
      const entry = updateUsage(name, 'local', (usage) => {
        usage.pinned = action === 'pin';
        usage.updatedAt = nowIso();
      });
      return okJson({ skill: name, pinned: entry.pinned, usage: entry });
    }

    if (action === 'record_use') {
      const source = skillExists(localSkillDir(name)) ? 'local' : skillExists(sharedSkillDir(name)) ? 'shared' : null;
      if (!source) return err(`Skill not found: ${name}`);
      const entry = updateUsage(name, source, (usage) => {
        usage.useCount += 1;
        usage.lastUsedAt = nowIso();
        usage.lastOutcome = asString(args.outcome) || undefined;
        usage.lastNotes = asString(args.notes) || undefined;
        usage.sourceTurnIds = [...new Set([...usage.sourceTurnIds, ...asStringArray(args.sourceTurnIds)])];
        usage.sourceConversationIds = [...new Set([...usage.sourceConversationIds, ...asStringArray(args.sourceConversationIds)])];
      });
      return okJson({ recorded: name, usage: entry });
    }

    return err(`Unknown skill_manage action: ${action}`);
  },
};

registerTools([skillView, skillManage]);
