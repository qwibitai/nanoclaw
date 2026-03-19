import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeIpcFile, pollForResult } from './ipc-utils.js';
import {
  handleSendMessage,
  handleSendImage,
  handleSendDocument,
  handleScheduleTask,
  handleCaseMarkDone,
  handleListTasks,
  handleListCases,
  type McpConfig,
} from './ipc-handlers.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// writeIpcFile

describe('writeIpcFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  /**
   * INVARIANT: writeIpcFile creates a JSON file in the target directory
   * with the provided data, using atomic write (temp file + rename).
   */
  it('creates a JSON file with correct data', () => {
    const data = { type: 'message', text: 'hello' };
    const filename = writeIpcFile(tmpDir, data);

    const filepath = path.join(tmpDir, filename);
    expect(fs.existsSync(filepath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(content).toEqual(data);
  });

  it('creates the directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    const data = { type: 'test' };

    const filename = writeIpcFile(nestedDir, data);

    expect(fs.existsSync(path.join(nestedDir, filename))).toBe(true);
  });

  it('generates unique filenames across calls', () => {
    const f1 = writeIpcFile(tmpDir, { a: 1 });
    const f2 = writeIpcFile(tmpDir, { b: 2 });

    expect(f1).not.toBe(f2);
  });

  it('does not leave temp files behind', () => {
    writeIpcFile(tmpDir, { test: true });

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it('produces valid JSON files', () => {
    const data = { nested: { key: 'value' }, array: [1, 2, 3] };
    const filename = writeIpcFile(tmpDir, data);

    const content = fs.readFileSync(path.join(tmpDir, filename), 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
    expect(JSON.parse(content)).toEqual(data);
  });
});

// pollForResult

describe('pollForResult', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  /**
   * INVARIANT: pollForResult reads a result file matching the requestId,
   * returns its parsed JSON content, and cleans up the file.
   */
  it('returns parsed JSON when result file exists', async () => {
    const requestId = 'req-test-123';
    const resultData = { success: true, id: 'case-1' };

    // Write result file before polling starts
    const resultFile = path.join(tmpDir, `${requestId}.json`);
    fs.writeFileSync(resultFile, JSON.stringify(resultData));

    const result = await pollForResult(tmpDir, requestId, 3);
    expect(result).toEqual(resultData);
  });

  it('cleans up the result file after reading', async () => {
    const requestId = 'req-cleanup';
    const resultFile = path.join(tmpDir, `${requestId}.json`);
    fs.writeFileSync(resultFile, JSON.stringify({ done: true }));

    await pollForResult(tmpDir, requestId, 3);

    expect(fs.existsSync(resultFile)).toBe(false);
  });

  it('returns null on timeout when no result file appears', async () => {
    const result = await pollForResult(tmpDir, 'req-nonexistent', 2);
    expect(result).toBeNull();
  });

  it('waits for a result file written after polling starts', async () => {
    const requestId = 'req-delayed';

    // Write the file after a short delay
    setTimeout(() => {
      const resultFile = path.join(tmpDir, `${requestId}.json`);
      fs.writeFileSync(resultFile, JSON.stringify({ delayed: true }));
    }, 600);

    const result = await pollForResult(tmpDir, requestId, 5);
    expect(result).toEqual({ delayed: true });
  });
});

// McpConfig helper

function testConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    chatJid: 'tg:-1001234567890',
    groupFolder: 'telegram_test',
    isMain: false,
    ipcDir: mkTmpDir(),
    ...overrides,
  };
}

// handleSendMessage

describe('handleSendMessage', () => {
  let config: McpConfig;

  beforeEach(() => {
    config = testConfig();
  });

  afterEach(() => {
    rmDir(config.ipcDir);
  });

  /**
   * INVARIANT: handleSendMessage writes a message IPC file with correct
   * structure and returns a success response.
   */
  it('writes IPC file with correct message data', async () => {
    const result = await handleSendMessage({ text: 'hello world' }, config);

    expect(result.content[0].text).toBe('Message sent.');

    const messagesDir = path.join(config.ipcDir, 'messages');
    const files = fs.readdirSync(messagesDir);
    expect(files.length).toBe(1);

    const data = JSON.parse(
      fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'),
    );
    expect(data.type).toBe('message');
    expect(data.text).toBe('hello world');
    expect(data.chatJid).toBe(config.chatJid);
    expect(data.groupFolder).toBe(config.groupFolder);
  });

  it('includes sender when provided', async () => {
    await handleSendMessage({ text: 'update', sender: 'Researcher' }, config);

    const messagesDir = path.join(config.ipcDir, 'messages');
    const files = fs.readdirSync(messagesDir);
    const data = JSON.parse(
      fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'),
    );
    expect(data.sender).toBe('Researcher');
  });
});

// handleSendImage

describe('handleSendImage', () => {
  let config: McpConfig;
  let tmpFile: string;

  beforeEach(() => {
    config = testConfig();
    tmpFile = path.join(config.ipcDir, 'test-image.png');
    fs.writeFileSync(tmpFile, 'fake image data');
  });

  afterEach(() => {
    rmDir(config.ipcDir);
  });

  /**
   * INVARIANT: handleSendImage rejects non-existent files and writes
   * IPC file for valid images.
   */
  it('returns error when image file does not exist', async () => {
    const result = await handleSendImage(
      { image_path: '/nonexistent/image.png' },
      config,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('writes IPC file for existing image', async () => {
    const result = await handleSendImage(
      { image_path: tmpFile, caption: 'test image' },
      config,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Image sent.');

    const messagesDir = path.join(config.ipcDir, 'messages');
    const files = fs.readdirSync(messagesDir);
    const data = JSON.parse(
      fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'),
    );
    expect(data.type).toBe('image');
    expect(data.imagePath).toBe(tmpFile);
    expect(data.caption).toBe('test image');
  });
});

// handleSendDocument

describe('handleSendDocument', () => {
  let config: McpConfig;
  let tmpFile: string;

  beforeEach(() => {
    config = testConfig();
    tmpFile = path.join(config.ipcDir, 'report.pdf');
    fs.writeFileSync(tmpFile, 'fake pdf data');
  });

  afterEach(() => {
    rmDir(config.ipcDir);
  });

  /**
   * INVARIANT: handleSendDocument rejects non-existent files and writes
   * IPC file for valid documents.
   */
  it('returns error when document does not exist', async () => {
    const result = await handleSendDocument(
      { document_path: '/nonexistent/doc.pdf' },
      config,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('writes IPC file for existing document', async () => {
    const result = await handleSendDocument(
      { document_path: tmpFile, filename: 'Report.pdf' },
      config,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Document sent.');
  });
});

// handleScheduleTask

describe('handleScheduleTask', () => {
  let config: McpConfig;

  beforeEach(() => {
    config = testConfig();
  });

  afterEach(() => {
    rmDir(config.ipcDir);
  });

  /**
   * INVARIANT: handleScheduleTask validates schedule values and rejects
   * invalid ones before writing IPC.
   */
  it('rejects invalid cron expression', async () => {
    const result = await handleScheduleTask(
      {
        prompt: 'test',
        schedule_type: 'cron' as const,
        schedule_value: 'not a cron',
        context_mode: 'isolated' as const,
      },
      config,
    );

    expect(result.isError).toBe(true);
  });

  it('accepts valid cron and writes IPC', async () => {
    const result = await handleScheduleTask(
      {
        prompt: 'check status',
        schedule_type: 'cron' as const,
        schedule_value: '0 9 * * *',
        context_mode: 'group' as const,
      },
      config,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('scheduled');

    const tasksDir = path.join(config.ipcDir, 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files.length).toBe(1);
  });

  it('non-main groups cannot set target_group_jid', async () => {
    const result = await handleScheduleTask(
      {
        prompt: 'test',
        schedule_type: 'cron' as const,
        schedule_value: '0 9 * * *',
        context_mode: 'group' as const,
        target_group_jid: 'tg:-999',
      },
      { ...config, isMain: false },
    );

    // Should succeed but use own chatJid, not the target
    expect(result.isError).toBeUndefined();

    const tasksDir = path.join(config.ipcDir, 'tasks');
    const files = fs.readdirSync(tasksDir);
    const data = JSON.parse(
      fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'),
    );
    expect(data.targetJid).toBe(config.chatJid);
  });

  it('main group can set target_group_jid', async () => {
    const mainConfig = { ...config, isMain: true };
    const result = await handleScheduleTask(
      {
        prompt: 'test',
        schedule_type: 'cron' as const,
        schedule_value: '0 9 * * *',
        context_mode: 'group' as const,
        target_group_jid: 'tg:-999',
      },
      mainConfig,
    );

    expect(result.isError).toBeUndefined();

    const tasksDir = path.join(config.ipcDir, 'tasks');
    const files = fs.readdirSync(tasksDir);
    const data = JSON.parse(
      fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'),
    );
    expect(data.targetJid).toBe('tg:-999');
  });
});

// handleCaseMarkDone — L3 enforcement

describe('handleCaseMarkDone', () => {
  let config: McpConfig;

  beforeEach(() => {
    config = testConfig();
  });

  afterEach(() => {
    rmDir(config.ipcDir);
  });

  /**
   * INVARIANT: case_mark_done L3 enforcement requires either kaizen
   * reflections OR explicit no_kaizen_needed=true with reason.
   * Empty reflections are rejected.
   */
  it('rejects when no kaizen and no opt-out', async () => {
    const result = await handleCaseMarkDone(
      {
        case_id: 'case-123',
        conclusion: 'Done.',
      },
      config,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty kaizen array');
  });

  it('rejects when no_kaizen_needed=true but no reason', async () => {
    const result = await handleCaseMarkDone(
      {
        case_id: 'case-123',
        conclusion: 'Done.',
        no_kaizen_needed: true,
      },
      config,
    );

    expect(result.isError).toBe(true);
  });

  it('accepts with valid kaizen reflections', async () => {
    const result = await handleCaseMarkDone(
      {
        case_id: 'case-123',
        conclusion: 'Implemented feature.',
        kaizen: [
          {
            issue: 'Slow CI',
            suggestion: 'Cache node_modules',
            severity: 'medium' as const,
          },
        ],
      },
      config,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('marked as done');
    expect(result.content[0].text).toContain('1 kaizen');
  });

  it('accepts with no_kaizen_needed and reason', async () => {
    const result = await handleCaseMarkDone(
      {
        case_id: 'case-123',
        conclusion: 'Config change.',
        no_kaizen_needed: true,
        no_kaizen_reason: 'Trivial config update with no friction',
      },
      config,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('marked as done');
  });

  it('writes case_mark_done AND case_suggest_dev IPC files for each kaizen', async () => {
    await handleCaseMarkDone(
      {
        case_id: 'case-123',
        conclusion: 'Done.',
        kaizen: [
          { issue: 'A', suggestion: 'Fix A', severity: 'low' as const },
          { issue: 'B', suggestion: 'Fix B', severity: 'high' as const },
        ],
      },
      config,
    );

    const tasksDir = path.join(config.ipcDir, 'tasks');
    const files = fs.readdirSync(tasksDir);
    // 1 case_mark_done + 2 case_suggest_dev = 3 files
    expect(files.length).toBe(3);

    const data = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8')),
    );
    const types = data.map((d) => d.type).sort();
    expect(types).toEqual([
      'case_mark_done',
      'case_suggest_dev',
      'case_suggest_dev',
    ]);
  });
});

// handleListTasks

describe('handleListTasks', () => {
  let config: McpConfig;

  beforeEach(() => {
    config = testConfig();
  });

  afterEach(() => {
    rmDir(config.ipcDir);
  });

  /**
   * INVARIANT: handleListTasks reads current_tasks.json and filters
   * by group for non-main users.
   */
  it('returns no tasks message when file does not exist', async () => {
    const result = await handleListTasks(config);

    expect(result.content[0].text).toContain('No scheduled tasks');
  });

  it('returns all tasks for main group', async () => {
    const tasks = [
      {
        id: 'task-1',
        prompt: 'Check weather',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        next_run: '2026-03-20T09:00:00',
        groupFolder: 'telegram_test',
      },
      {
        id: 'task-2',
        prompt: 'Other group task',
        schedule_type: 'interval',
        schedule_value: '3600000',
        status: 'active',
        next_run: 'N/A',
        groupFolder: 'telegram_other',
      },
    ];
    fs.writeFileSync(
      path.join(config.ipcDir, 'current_tasks.json'),
      JSON.stringify(tasks),
    );

    const mainConfig = { ...config, isMain: true };
    const result = await handleListTasks(mainConfig);

    expect(result.content[0].text).toContain('task-1');
    expect(result.content[0].text).toContain('task-2');
  });

  it('filters tasks for non-main group', async () => {
    const tasks = [
      {
        id: 'task-1',
        prompt: 'Own task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        next_run: '',
        groupFolder: 'telegram_test',
      },
      {
        id: 'task-2',
        prompt: 'Other task',
        schedule_type: 'interval',
        schedule_value: '3600000',
        status: 'active',
        next_run: '',
        groupFolder: 'telegram_other',
      },
    ];
    fs.writeFileSync(
      path.join(config.ipcDir, 'current_tasks.json'),
      JSON.stringify(tasks),
    );

    const result = await handleListTasks(config);

    expect(result.content[0].text).toContain('task-1');
    expect(result.content[0].text).not.toContain('task-2');
  });
});

// handleListCases

describe('handleListCases', () => {
  let config: McpConfig;

  beforeEach(() => {
    config = testConfig();
  });

  afterEach(() => {
    rmDir(config.ipcDir);
  });

  /**
   * INVARIANT: handleListCases reads active_cases.json and returns
   * formatted case information.
   */
  it('returns no cases message when file does not exist', async () => {
    const result = await handleListCases(config);

    expect(result.content[0].text).toContain('No active cases');
  });

  it('formats case information correctly', async () => {
    const cases = [
      {
        name: '260319-test',
        type: 'work',
        status: 'active',
        description: 'Test case for unit testing',
        last_message: 'Working on it',
        last_activity_at: '2026-03-19T10:00:00Z',
        total_cost_usd: 1.5,
        time_spent_ms: 60000,
        blocked_on: null,
        initiator: 'agent',
      },
    ];
    fs.writeFileSync(
      path.join(config.ipcDir, 'active_cases.json'),
      JSON.stringify(cases),
    );

    const result = await handleListCases(config);

    expect(result.content[0].text).toContain('260319-test');
    expect(result.content[0].text).toContain('work');
    expect(result.content[0].text).toContain('$1.50');
  });
});
