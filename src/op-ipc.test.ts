import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock logger before importing module under test
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock execFile to avoid actually calling `op`
vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  return {
    ...mod,
    execFile: vi.fn(),
  };
});

const mockExecFile = vi.mocked(execFile);

import { handleOpIpc } from './op-ipc.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('handleOpIpc', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-ipc-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  it('returns false for non-op_* types', async () => {
    const handled = await handleOpIpc({ type: 'chat' }, 'main', true, dataDir);
    expect(handled).toBe(false);
  });

  it('returns false for unknown op_* types', async () => {
    const handled = await handleOpIpc(
      { type: 'op_unknown', requestId: 'r1', itemName: 'test' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(false);
  });

  it('blocks non-main groups', async () => {
    const handled = await handleOpIpc(
      { type: 'op_get_item', requestId: 'r1', itemName: 'test' },
      'other-group',
      false,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultPath = path.join(
      dataDir,
      'ipc',
      'other-group',
      'op_results',
      'r1.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('main group');
  });

  it('blocks requests without requestId', async () => {
    const handled = await handleOpIpc(
      { type: 'op_get_item', itemName: 'test' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
    // No result written since there's no requestId to name the file
  });

  it('rejects requests without itemName', async () => {
    const handled = await handleOpIpc(
      { type: 'op_get_item', requestId: 'r1' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultPath = path.join(
      dataDir,
      'ipc',
      'main',
      'op_results',
      'r1.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('Missing itemName');
  });

  // -------------------------------------------------------------------------
  // op_get_item
  // -------------------------------------------------------------------------

  it('handles op_get_item successfully (all fields)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({
            fields: [
              { label: 'username', value: 'alice' },
              { label: 'password', value: 'secret123' },
              { label: 'notes', value: '' },
            ],
          }),
          '',
        );
        return {} as any;
      },
    );

    const handled = await handleOpIpc(
      { type: 'op_get_item', requestId: 'r2', itemName: 'GitHub' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    // Verify `op` was called with correct vault
    expect(mockExecFile).toHaveBeenCalledWith(
      'op',
      ['item', 'get', 'GitHub', '--vault', 'Dev', '--format', 'json'],
      { timeout: 15_000 },
      expect.any(Function),
    );

    const resultPath = path.join(
      dataDir,
      'ipc',
      'main',
      'op_results',
      'r2.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(true);
    // Empty-value fields should be filtered out
    expect(result.data).toEqual([
      { label: 'username', value: 'alice' },
      { label: 'password', value: 'secret123' },
    ]);
  });

  it('handles op_get_item with specific field', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({
            fields: [
              { label: 'username', value: 'alice' },
              { label: 'password', value: 'secret123' },
            ],
          }),
          '',
        );
        return {} as any;
      },
    );

    const handled = await handleOpIpc(
      {
        type: 'op_get_item',
        requestId: 'r3',
        itemName: 'GitHub',
        field: 'password',
      },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultPath = path.join(
      dataDir,
      'ipc',
      'main',
      'op_results',
      'r3.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(true);
    expect(result.message).toBe('secret123');
    expect(result.data).toEqual({ label: 'password', value: 'secret123' });
  });

  it('returns error when field not found', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({
            fields: [{ label: 'username', value: 'alice' }],
          }),
          '',
        );
        return {} as any;
      },
    );

    const handled = await handleOpIpc(
      {
        type: 'op_get_item',
        requestId: 'r4',
        itemName: 'GitHub',
        field: 'nonexistent',
      },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultPath = path.join(
      dataDir,
      'ipc',
      'main',
      'op_results',
      'r4.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('handles op CLI errors', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('item not found'), '', '');
        return {} as any;
      },
    );

    const handled = await handleOpIpc(
      { type: 'op_get_item', requestId: 'r5', itemName: 'nonexistent' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultPath = path.join(
      dataDir,
      'ipc',
      'main',
      'op_results',
      'r5.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('1Password error');
  });

  // -------------------------------------------------------------------------
  // op_get_otp
  // -------------------------------------------------------------------------

  it('handles op_get_otp successfully', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, '123456\n', '');
        return {} as any;
      },
    );

    const handled = await handleOpIpc(
      { type: 'op_get_otp', requestId: 'r6', itemName: 'Google' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    // Verify `op` was called with --otp flag
    expect(mockExecFile).toHaveBeenCalledWith(
      'op',
      ['item', 'get', 'Google', '--otp', '--vault', 'Dev'],
      { timeout: 15_000 },
      expect.any(Function),
    );

    const resultPath = path.join(
      dataDir,
      'ipc',
      'main',
      'op_results',
      'r6.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(true);
    expect(result.message).toBe('123456');
  });

  it('handles op_get_otp errors', async () => {
    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('no one-time password for this item'), '', '');
        return {} as any;
      },
    );

    const handled = await handleOpIpc(
      { type: 'op_get_otp', requestId: 'r7', itemName: 'NoOTP' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const resultPath = path.join(
      dataDir,
      'ipc',
      'main',
      'op_results',
      'r7.json',
    );
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.success).toBe(false);
    expect(result.message).toContain('OTP error');
  });
});
