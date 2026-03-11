#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

type WorkStatus = 'planned' | 'implementing' | 'testing' | 'done' | 'blocked';

const SCHEMA_VERSION = 2;
const ALLOWED_TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
  planned: ['implementing', 'blocked'],
  implementing: ['testing', 'blocked'],
  testing: ['done', 'blocked', 'implementing'],
  blocked: ['planned', 'implementing'],
  done: [],
};

interface WorkItem {
  id: string;
  title: string;
  feature_id: string;
  status: WorkStatus;
  request?: string;
  notes: string[];
  evidence: string[];
  created_at: string;
  updated_at: string;
}

interface WorkStore {
  schema_version: number;
  updated_at: string;
  items: WorkItem[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function getStorePath(repoRoot: string): string {
  return path.join(repoRoot, '.claude', 'archive', 'legacy-work-items.json');
}

function printLegacyNotice(): void {
  console.error(
    'legacy-work-items: .claude/archive/legacy-work-items.json is migration support only; keep authoritative execution state in Linear.',
  );
}

function defaultStore(): WorkStore {
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: nowIso(),
    items: [],
  };
}

function loadStore(repoRoot: string): WorkStore {
  const storePath = getStorePath(repoRoot);
  let contents: string;
  try {
    contents = fs.readFileSync(storePath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return defaultStore();
    }
    throw error;
  }

  const raw = JSON.parse(contents) as WorkStore;
  raw.schema_version = Math.max(raw.schema_version || 1, SCHEMA_VERSION);
  raw.items = raw.items.map((item) => ({
    ...item,
    evidence: item.evidence || [],
  }));
  return raw;
}

function saveStore(repoRoot: string, store: WorkStore): void {
  store.updated_at = nowIso();
  store.schema_version = SCHEMA_VERSION;
  const storePath = getStorePath(repoRoot);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function readFlags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

function validateEvidence(repoRoot: string, entries: string[]): void {
  for (const entry of entries) {
    if (entry.startsWith('http://') || entry.startsWith('https://')) {
      continue;
    }
    const abs = path.join(repoRoot, entry);
    if (!fs.existsSync(abs)) {
      console.error(`evidence file not found: ${entry}`);
      process.exit(1);
    }
  }
}

const VALID_STATUSES: WorkStatus[] = ['planned', 'implementing', 'testing', 'done', 'blocked'];

function ensureStatus(value: string | undefined): WorkStatus {
  if (!value) {
    console.error('update requires --status');
    process.exit(1);
  }
  if (!VALID_STATUSES.includes(value as WorkStatus)) {
    console.error(`invalid status: ${value}`);
    process.exit(1);
  }
  return value as WorkStatus;
}

function main(): void {
  printLegacyNotice();
  const args = process.argv.slice(2);
  const command = args[0];
  const repoRoot = process.cwd();
  const store = loadStore(repoRoot);

  if (!command || command === 'help') {
    console.log('Usage:');
    console.log('  create --feature <feature-id> --title <title> [--request <text>]');
    console.log('  update --id <work-id> --status <planned|implementing|testing|done|blocked> [--note <text>] [--evidence <path-or-url> ...]');
    console.log('  list [--status <status>]');
    console.log('  show --id <work-id>');
    process.exit(0);
  }

  if (command === 'create') {
    const featureId = readFlag(args, '--feature');
    const title = readFlag(args, '--title');
    const request = readFlag(args, '--request');

    if (!featureId || !title) {
      console.error('create requires --feature and --title');
      process.exit(1);
    }

    const id = `work-${featureId}-${Date.now()}`;
    const item: WorkItem = {
      id,
      title,
      feature_id: featureId,
      status: 'planned',
      request,
      notes: [],
      evidence: [],
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    store.items.push(item);
    saveStore(repoRoot, store);

    console.log(JSON.stringify({ success: true, action: 'create', item }, null, 2));
    process.exit(0);
  }

  if (command === 'update') {
    const id = readFlag(args, '--id');
    const status = ensureStatus(readFlag(args, '--status'));
    const note = readFlag(args, '--note');
    const evidence = readFlags(args, '--evidence');

    if (!id) {
      console.error('update requires --id');
      process.exit(1);
    }

    const item = store.items.find((entry) => entry.id === id);
    if (!item) {
      console.error(`work item not found: ${id}`);
      process.exit(1);
    }

    if (item.status !== status) {
      const allowed = ALLOWED_TRANSITIONS[item.status] || [];
      if (!allowed.includes(status)) {
        console.error(`invalid transition: ${item.status} -> ${status}`);
        console.error(`allowed from ${item.status}: ${allowed.join(', ') || 'none'}`);
        process.exit(1);
      }
    }

    if ((status === 'blocked' || status === 'done') && !note) {
      console.error(`status ${status} requires --note`);
      process.exit(1);
    }

    if (evidence.length > 0) {
      validateEvidence(repoRoot, evidence);
      for (const entry of evidence) {
        if (!item.evidence.includes(entry)) {
          item.evidence.push(entry);
        }
      }
    }

    if (status === 'done' && item.evidence.length === 0) {
      console.error('status done requires at least one --evidence entry');
      process.exit(1);
    }

    item.status = status;
    item.updated_at = nowIso();
    if (note) {
      item.notes.push(`${item.updated_at}: ${note}`);
    }

    saveStore(repoRoot, store);
    console.log(JSON.stringify({ success: true, action: 'update', item }, null, 2));
    process.exit(0);
  }

  if (command === 'list') {
    const status = readFlag(args, '--status') as WorkStatus | undefined;
    const items = status
      ? store.items.filter((item) => item.status === status)
      : store.items;
    console.log(JSON.stringify({ success: true, action: 'list', count: items.length, items }, null, 2));
    process.exit(0);
  }

  if (command === 'show') {
    const id = readFlag(args, '--id');
    if (!id) {
      console.error('show requires --id');
      process.exit(1);
    }

    const item = store.items.find((entry) => entry.id === id);
    if (!item) {
      console.error(`work item not found: ${id}`);
      process.exit(1);
    }

    console.log(JSON.stringify({ success: true, action: 'show', item }, null, 2));
    process.exit(0);
  }

  console.error(`unknown command: ${command}`);
  process.exit(1);
}

main();
