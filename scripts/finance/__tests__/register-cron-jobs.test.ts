import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerCronJobs, type RegisterOptions } from '../register-cron-jobs';

describe('registerCronJobs', () => {
  let tmpDir: string;
  let inboundPath: string;
  let promptsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-cron-'));
    inboundPath = path.join(tmpDir, 'inbound.db');

    // Create empty inbound.db with messages_in schema
    const db = new Database(inboundPath);
    db.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        platform_id TEXT,
        channel_type TEXT,
        thread_id TEXT,
        content TEXT NOT NULL,
        process_after TEXT,
        recurrence TEXT
      );
    `);
    db.close();

    // Create prompt files
    promptsDir = path.join(tmpDir, 'prompts');
    fs.mkdirSync(promptsDir);
    fs.writeFileSync(path.join(promptsDir, 'sweep-reminder.md'), 'sweep content');
    fs.writeFileSync(path.join(promptsDir, 'daily-digest.md'), 'daily content');
    fs.writeFileSync(path.join(promptsDir, 'weekly-closing.md'), 'weekly content');
    fs.writeFileSync(path.join(promptsDir, 'monthly-closing.md'), 'monthly content');
    fs.writeFileSync(path.join(promptsDir, 'rollover.md'), 'rollover content');

    // Create cron-jobs.json
    fs.writeFileSync(
      path.join(tmpDir, 'cron-jobs.json'),
      JSON.stringify({
        jobs: [
          { id: 'task-finance-sweep', kind: 'scheduled', recurrence: '0 8-22 * * *', promptFile: 'sweep-reminder.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-daily', kind: 'scheduled', recurrence: '0 8 * * *', promptFile: 'daily-digest.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-weekly', kind: 'scheduled', recurrence: '0 19 * * 0', promptFile: 'weekly-closing.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-monthly', kind: 'scheduled', recurrence: '0 21 28-31 * *', promptFile: 'monthly-closing.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-rollover', kind: 'scheduled', recurrence: '30 0 1 * *', promptFile: 'rollover.md', firstRunOffsetMs: 60000 },
        ],
      }),
    );
  });

  it('inserts 5 recurring tasks with correct content from prompt files', () => {
    const opts: RegisterOptions = {
      inboundDbPath: inboundPath,
      configPath: path.join(tmpDir, 'cron-jobs.json'),
      promptsDir,
    };

    registerCronJobs(opts);

    const db = new Database(inboundPath, { readonly: true });
    const rows = db.prepare("SELECT id, kind, recurrence, content FROM messages_in WHERE recurrence IS NOT NULL ORDER BY id").all() as Array<{ id: string; kind: string; recurrence: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(5);
    expect(rows.map(r => r.id).sort()).toEqual([
      'task-finance-daily', 'task-finance-monthly', 'task-finance-rollover',
      'task-finance-sweep', 'task-finance-weekly',
    ]);
    expect(rows.find(r => r.id === 'task-finance-sweep')!.recurrence).toBe('0 8-22 * * *');
    expect(rows.find(r => r.id === 'task-finance-sweep')!.content).toBe('sweep content');
    expect(rows.find(r => r.id === 'task-finance-daily')!.content).toBe('daily content');
  });

  it('is idempotent — re-running does not duplicate', () => {
    const opts: RegisterOptions = {
      inboundDbPath: inboundPath,
      configPath: path.join(tmpDir, 'cron-jobs.json'),
      promptsDir,
    };

    registerCronJobs(opts);
    registerCronJobs(opts);

    const db = new Database(inboundPath, { readonly: true });
    const count = (db.prepare("SELECT COUNT(*) as c FROM messages_in WHERE recurrence IS NOT NULL").get() as { c: number }).c;
    db.close();

    expect(count).toBe(5);
  });

  it('sets process_after to firstRunOffsetMs in the future', () => {
    const before = Date.now();
    const opts: RegisterOptions = {
      inboundDbPath: inboundPath,
      configPath: path.join(tmpDir, 'cron-jobs.json'),
      promptsDir,
    };
    registerCronJobs(opts);
    const after = Date.now();

    const db = new Database(inboundPath, { readonly: true });
    const row = db.prepare("SELECT process_after FROM messages_in WHERE id='task-finance-sweep'").get() as { process_after: string };
    db.close();

    const processAfterMs = new Date(row.process_after).getTime();
    expect(processAfterMs).toBeGreaterThanOrEqual(before + 60000 - 1000); // -1s margin
    expect(processAfterMs).toBeLessThanOrEqual(after + 60000 + 1000);
  });
});
