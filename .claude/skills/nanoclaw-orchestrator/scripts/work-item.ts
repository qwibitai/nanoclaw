#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

type WorkStatus = 'planned' | 'implementing' | 'testing' | 'done' | 'blocked';

interface WorkItem {
  id: string;
  title: string;
  feature_id: string;
  status: WorkStatus;
  request?: string;
  notes: string[];
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
  return path.join(repoRoot, '.claude', 'progress', 'feature-work-items.json');
}

function loadStore(repoRoot: string): WorkStore {
  const storePath = getStorePath(repoRoot);
  if (!fs.existsSync(storePath)) {
    return {
      schema_version: 1,
      updated_at: nowIso(),
      items: [],
    };
  }
  return JSON.parse(fs.readFileSync(storePath, 'utf8')) as WorkStore;
}

function saveStore(repoRoot: string, store: WorkStore): void {
  store.updated_at = nowIso();
  const storePath = getStorePath(repoRoot);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  const repoRoot = process.cwd();
  const store = loadStore(repoRoot);

  if (!command || command === 'help') {
    console.log('Usage:');
    console.log('  create --feature <feature-id> --title <title> [--request <text>]');
    console.log('  update --id <work-id> --status <planned|implementing|testing|done|blocked> [--note <text>]');
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
    const status = readFlag(args, '--status') as WorkStatus | undefined;
    const note = readFlag(args, '--note');

    if (!id || !status) {
      console.error('update requires --id and --status');
      process.exit(1);
    }

    if (!['planned', 'implementing', 'testing', 'done', 'blocked'].includes(status)) {
      console.error(`invalid status: ${status}`);
      process.exit(1);
    }

    const item = store.items.find((entry) => entry.id === id);
    if (!item) {
      console.error(`work item not found: ${id}`);
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
