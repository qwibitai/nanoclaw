import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------- mocks ----------

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock pageindex functions
const mockFetchPageRange = vi.fn();
const mockIndexPdf = vi.fn();
const mockResolveContainerPath = vi.fn();

vi.mock('./pageindex.js', () => ({
  fetchPageRange: (...args: unknown[]) => mockFetchPageRange(...args),
  indexPdf: (...args: unknown[]) => mockIndexPdf(...args),
  resolveContainerPath: (...args: unknown[]) =>
    mockResolveContainerPath(...args),
}));

import { handlePageindexIpc } from './pageindex-ipc.js';
import type { MountMapping } from './pageindex.js';

// ---------- helpers ----------

let tmpDir: string;
const mounts: MountMapping[] = [
  {
    hostPath: '/host/vault',
    containerPath: '/workspace/extra/vault',
    readonly: true,
  },
  {
    hostPath: '/host/group',
    containerPath: '/workspace/group',
    readonly: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pageindex-ipc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readResult(requestId: string): Record<string, unknown> {
  const resultPath = path.join(
    tmpDir,
    'ipc',
    'test-group',
    'pageindex_results',
    `${requestId}.json`,
  );
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
}

// ---------- general ----------

describe('handlePageindexIpc', () => {
  it('returns false for non-pageindex types', async () => {
    const result = await handlePageindexIpc(
      { type: 'something_else' },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(false);
  });

  it('returns true but warns for missing requestId', async () => {
    const result = await handlePageindexIpc(
      { type: 'pageindex_fetch' },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);
  });

  it('returns false for unknown pageindex_ subtype', async () => {
    const result = await handlePageindexIpc(
      { type: 'pageindex_unknown', requestId: 'req-1' },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(false);
  });
});

// ---------- pageindex_fetch ----------

describe('pageindex_fetch', () => {
  it('writes error when required fields are missing', async () => {
    const result = await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'req-1',
        pdfPath: '/workspace/extra/vault/test.pdf',
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);
    const data = readResult('req-1');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Missing required fields');
  });

  it('writes error when path cannot be resolved', async () => {
    mockResolveContainerPath.mockReturnValue(null);

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'req-2',
        pdfPath: '/unknown/path/test.pdf',
        startPage: 1,
        endPage: 5,
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);
    const data = readResult('req-2');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Cannot resolve path');
  });

  it('writes error when file does not exist', async () => {
    mockResolveContainerPath.mockReturnValue('/host/vault/nonexistent.pdf');

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'req-3',
        pdfPath: '/workspace/extra/vault/nonexistent.pdf',
        startPage: 1,
        endPage: 5,
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);
    const data = readResult('req-3');
    expect(data.success).toBe(false);
    expect(data.error).toContain('File not found');
  });

  it('calls fetchPageRange and writes successful result', async () => {
    // Create a real file for the existsSync check
    const hostFile = path.join(tmpDir, 'test.pdf');
    fs.writeFileSync(hostFile, 'fake pdf');

    mockResolveContainerPath.mockReturnValue(hostFile);
    mockFetchPageRange.mockResolvedValue('Page 5 content\nPage 6 content\n');

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'req-4',
        pdfPath: '/workspace/extra/vault/test.pdf',
        startPage: 5,
        endPage: 6,
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);

    expect(mockFetchPageRange).toHaveBeenCalledWith(hostFile, 5, 6);

    const data = readResult('req-4');
    expect(data.success).toBe(true);
    expect(data.text).toBe('Page 5 content\nPage 6 content\n');
  });
});

// ---------- pageindex_index ----------

describe('pageindex_index', () => {
  it('writes error when pdfPath is missing', async () => {
    const result = await handlePageindexIpc(
      { type: 'pageindex_index', requestId: 'req-10' },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);
    const data = readResult('req-10');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Missing required field');
  });

  it('writes error when path cannot be resolved', async () => {
    mockResolveContainerPath.mockReturnValue(null);

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_index',
        requestId: 'req-11',
        pdfPath: '/unknown/path/test.pdf',
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);
    const data = readResult('req-11');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Cannot resolve path');
  });

  it('writes error when file does not exist', async () => {
    mockResolveContainerPath.mockReturnValue('/host/vault/nonexistent.pdf');

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_index',
        requestId: 'req-12',
        pdfPath: '/workspace/extra/vault/nonexistent.pdf',
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);
    const data = readResult('req-12');
    expect(data.success).toBe(false);
    expect(data.error).toContain('File not found');
  });

  it('writes success result with tree and pageCount on successful indexing', async () => {
    const hostFile = path.join(tmpDir, 'paper.pdf');
    fs.writeFileSync(hostFile, 'fake pdf');

    mockResolveContainerPath.mockReturnValue(hostFile);
    mockIndexPdf.mockResolvedValue({
      success: true,
      tree: {
        title: 'Root',
        start_index: 1,
        end_index: 50,
        nodes: [{ title: 'Ch1', start_index: 1, end_index: 25, nodes: [] }],
      },
      pageCount: 50,
    });

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_index',
        requestId: 'req-13',
        pdfPath: '/workspace/extra/vault/paper.pdf',
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);

    expect(mockIndexPdf).toHaveBeenCalledWith(hostFile, 'paper.pdf', {
      vaultDir: tmpDir,
    });

    const data = readResult('req-13');
    expect(data.success).toBe(true);
    expect(data.pageCount).toBe(50);
    expect(data.tree).toEqual({
      title: 'Root',
      start_index: 1,
      end_index: 50,
      nodes: [{ title: 'Ch1', start_index: 1, end_index: 25, nodes: [] }],
    });
  });

  it('writes fallback result with fallbackText on indexing failure', async () => {
    const hostFile = path.join(tmpDir, 'failing.pdf');
    fs.writeFileSync(hostFile, 'fake pdf');

    mockResolveContainerPath.mockReturnValue(hostFile);
    mockIndexPdf.mockResolvedValue({
      success: false,
      pageCount: 15,
      fallbackText: 'The flat text content of the PDF',
      error: 'PageIndex adapter not installed',
    });

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_index',
        requestId: 'req-14',
        pdfPath: '/workspace/extra/vault/failing.pdf',
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);

    const data = readResult('req-14');
    expect(data.success).toBe(false);
    expect(data.pageCount).toBe(15);
    expect(data.fallbackText).toBe('The flat text content of the PDF');
    expect(data.error).toBe('PageIndex adapter not installed');
  });
});

// ---------- error handling ----------

describe('error handling', () => {
  it('catches unexpected errors and writes error result', async () => {
    const hostFile = path.join(tmpDir, 'crash.pdf');
    fs.writeFileSync(hostFile, 'fake pdf');

    mockResolveContainerPath.mockReturnValue(hostFile);
    mockFetchPageRange.mockRejectedValue(new Error('Unexpected crash'));

    const result = await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'req-20',
        pdfPath: '/workspace/extra/vault/crash.pdf',
        startPage: 1,
        endPage: 5,
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );
    expect(result).toBe(true);

    const data = readResult('req-20');
    expect(data.success).toBe(false);
    expect(data.error).toContain('Unexpected crash');
  });

  it('writes result atomically (tmp + rename)', async () => {
    const hostFile = path.join(tmpDir, 'atomic.pdf');
    fs.writeFileSync(hostFile, 'fake pdf');

    mockResolveContainerPath.mockReturnValue(hostFile);
    mockFetchPageRange.mockResolvedValue('some text');

    await handlePageindexIpc(
      {
        type: 'pageindex_fetch',
        requestId: 'req-21',
        pdfPath: '/workspace/extra/vault/atomic.pdf',
        startPage: 1,
        endPage: 1,
      },
      'test-group',
      false,
      tmpDir,
      mounts,
    );

    // Verify the final file exists and no tmp file remains
    const resultsDir = path.join(
      tmpDir,
      'ipc',
      'test-group',
      'pageindex_results',
    );
    const files = fs.readdirSync(resultsDir);
    expect(files).toContain('req-21.json');
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });
});
