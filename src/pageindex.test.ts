import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import path from 'path';
import crypto from 'crypto';

// ---------- mocks ----------

// Mock config
vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 3001,
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// We need to mock child_process and fs/promises at the module level
const mockExecFile = vi.fn();
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockRename = vi.fn();
const mockAccess = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  access: (...args: unknown[]) => mockAccess(...args),
}));

import {
  countPdfPages,
  computeFileHash,
  findCachedTree,
  saveCachedTree,
  resolveContainerPath,
  extractFlatText,
  fetchPageRange,
  indexPdf,
  type PageIndexNode,
  type MountMapping,
  type IndexResult,
} from './pageindex.js';

// ---------- helpers ----------

/** Make mockExecFile resolve with given stdout/stderr */
function execFileResolves(stdout: string, stderr = '') {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      optsOrCb: unknown,
      maybeCb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      if (cb) cb(null, { stdout, stderr });
    },
  );
}

/** Make mockExecFile reject with given error */
function execFileRejects(err: Error) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      optsOrCb: unknown,
      maybeCb?: (err: Error) => void,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      if (cb) cb(err);
    },
  );
}

// ---------- Task 1 tests ----------

describe('countPdfPages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses page count from pdfinfo output', async () => {
    execFileResolves(
      'Title:          Sample\nPages:          42\nFile size:      12345\n',
    );
    const count = await countPdfPages('/tmp/test.pdf');
    expect(count).toBe(42);
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringContaining('pdfinfo'),
      ['/tmp/test.pdf'],
      expect.any(Function),
    );
  });

  it('returns 0 when pdfinfo fails', async () => {
    execFileRejects(new Error('pdfinfo not found'));
    const count = await countPdfPages('/tmp/bad.pdf');
    expect(count).toBe(0);
  });

  it('returns 0 when Pages line is missing', async () => {
    execFileResolves('Title:          Sample\nFile size:      12345\n');
    const count = await countPdfPages('/tmp/nopages.pdf');
    expect(count).toBe(0);
  });
});

describe('computeFileHash', () => {
  it('returns first 8 hex chars of sha256', () => {
    const buf = Buffer.from('hello world');
    const expected = crypto
      .createHash('sha256')
      .update(buf)
      .digest('hex')
      .substring(0, 8);
    expect(computeFileHash(buf)).toBe(expected);
  });

  it('returns different hashes for different content', () => {
    const h1 = computeFileHash(Buffer.from('aaa'));
    const h2 = computeFileHash(Buffer.from('bbb'));
    expect(h1).not.toBe(h2);
  });

  it('returns exactly 8 characters', () => {
    const hash = computeFileHash(Buffer.from('test'));
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------- Task 2 tests ----------

describe('findCachedTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed JSON when cache file exists', async () => {
    const tree: PageIndexNode = {
      title: 'Root',
      start_index: 1,
      end_index: 10,
      nodes: [],
    };
    mockReadFile.mockResolvedValue(JSON.stringify(tree));
    const result = await findCachedTree('/docs', 'paper.pdf', 'abcd1234');
    expect(result).toEqual(tree);
    expect(mockReadFile).toHaveBeenCalledWith(
      path.join('/docs', '.pageindex', 'paper-abcd1234.json'),
      'utf-8',
    );
  });

  it('returns null when cache file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await findCachedTree('/docs', 'paper.pdf', 'abcd1234');
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not json{{{');
    const result = await findCachedTree('/docs', 'paper.pdf', 'abcd1234');
    expect(result).toBeNull();
  });

  it('strips .pdf extension from cache key', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    await findCachedTree('/docs', 'report.pdf', 'ff00ff00');
    expect(mockReadFile).toHaveBeenCalledWith(
      path.join('/docs', '.pageindex', 'report-ff00ff00.json'),
      'utf-8',
    );
  });
});

describe('saveCachedTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  });

  it('creates .pageindex dir, writes tmp, renames atomically', async () => {
    const tree: PageIndexNode = {
      title: 'Root',
      start_index: 1,
      end_index: 50,
      nodes: [],
    };
    await saveCachedTree('/docs', 'paper.pdf', 'abcd1234', tree);

    expect(mockMkdir).toHaveBeenCalledWith(path.join('/docs', '.pageindex'), {
      recursive: true,
    });
    // Should write to tmp file first
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      JSON.stringify(tree, null, 2),
    );
    // Then rename to final location
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      path.join('/docs', '.pageindex', 'paper-abcd1234.json'),
    );
  });

  it('catches errors without throwing', async () => {
    mockMkdir.mockRejectedValue(new Error('EPERM'));
    // Should not throw
    await saveCachedTree('/docs', 'paper.pdf', 'hash1234', {
      title: 'R',
      start_index: 1,
      end_index: 1,
      nodes: [],
    });
  });
});

describe('resolveContainerPath', () => {
  const mounts: MountMapping[] = [
    {
      hostPath: '/host/docs',
      containerPath: '/workspace/docs',
      readonly: true,
    },
    {
      hostPath: '/host/extra',
      containerPath: '/workspace/extra',
      readonly: false,
    },
  ];

  it('maps container path to host path', () => {
    const result = resolveContainerPath('/workspace/docs/paper.pdf', mounts);
    expect(result).toBe('/host/docs/paper.pdf');
  });

  it('handles nested paths correctly', () => {
    const result = resolveContainerPath(
      '/workspace/extra/sub/dir/file.pdf',
      mounts,
    );
    expect(result).toBe('/host/extra/sub/dir/file.pdf');
  });

  it('returns null for unknown prefixes', () => {
    const result = resolveContainerPath('/unknown/path/file.pdf', mounts);
    expect(result).toBeNull();
  });

  it('returns null for directory traversal attempts', () => {
    const result = resolveContainerPath(
      '/workspace/docs/../extra/secret.pdf',
      mounts,
    );
    expect(result).toBeNull();
  });

  it('returns null for partial prefix matches (separator-safe)', () => {
    // /workspace/docsevil should NOT match /workspace/docs
    const result = resolveContainerPath('/workspace/docsevil/file.pdf', mounts);
    expect(result).toBeNull();
  });

  it('handles exact mount path (file at mount root)', () => {
    // The containerPath itself with a trailing file
    const result = resolveContainerPath('/workspace/docs/file.pdf', mounts);
    expect(result).toBe('/host/docs/file.pdf');
  });
});

// ---------- Task 3 tests ----------

describe('extractFlatText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls pdftotext with -layout and returns stdout', async () => {
    execFileResolves('Page 1 text\nPage 2 text\n');
    const text = await extractFlatText('/tmp/test.pdf');
    expect(text).toBe('Page 1 text\nPage 2 text\n');
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringContaining('pdftotext'),
      ['-layout', '/tmp/test.pdf', '-'],
      expect.any(Function),
    );
  });

  it('returns empty string on failure', async () => {
    execFileRejects(new Error('pdftotext failed'));
    const text = await extractFlatText('/tmp/bad.pdf');
    expect(text).toBe('');
  });
});

describe('fetchPageRange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls pdftotext with -f and -l flags', async () => {
    execFileResolves('Page 5 content\n');
    const text = await fetchPageRange('/tmp/test.pdf', 5, 10);
    expect(text).toBe('Page 5 content\n');
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringContaining('pdftotext'),
      ['-f', '5', '-l', '10', '-layout', '/tmp/test.pdf', '-'],
      expect.any(Function),
    );
  });

  it('returns empty string on failure', async () => {
    execFileRejects(new Error('pdftotext failed'));
    const text = await fetchPageRange('/tmp/bad.pdf', 1, 5);
    expect(text).toBe('');
  });
});

// ---------- Task 4 tests ----------

describe('indexPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(new Error('ENOENT')); // no cache by default
    mockAccess.mockRejectedValue(new Error('ENOENT')); // adapter not found by default
  });

  it('returns fallback text for PDFs with 0 pages', async () => {
    // pdfinfo returns 0 pages
    execFileResolves('Title: Bad\n');
    const result = await indexPdf('/tmp/empty.pdf', 'empty.pdf');
    expect(result.success).toBe(false);
    expect(result.pageCount).toBe(0);
  });

  it('returns flat text fallback for PDFs with <=20 pages', async () => {
    // First call: pdfinfo
    let callCount = 0;
    mockExecFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        callCount++;
        if (cmd.includes('pdfinfo')) {
          if (cb) cb(null, { stdout: 'Pages:          15\n', stderr: '' });
        } else if (cmd.includes('pdftotext')) {
          if (cb)
            cb(null, { stdout: 'This is the flat text content\n', stderr: '' });
        }
      },
    );

    const result = await indexPdf('/tmp/small.pdf', 'small.pdf');
    expect(result.success).toBe(false);
    expect(result.pageCount).toBe(15);
    expect(result.fallbackText).toBe('This is the flat text content\n');
  });

  it('returns fallback with warning for PDFs >500 pages', async () => {
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (cmd.includes('pdfinfo')) {
          if (cb) cb(null, { stdout: 'Pages:          600\n', stderr: '' });
        } else if (cmd.includes('pdftotext')) {
          if (cb) cb(null, { stdout: 'lots of text\n', stderr: '' });
        }
      },
    );

    const result = await indexPdf('/tmp/huge.pdf', 'huge.pdf');
    expect(result.success).toBe(false);
    expect(result.pageCount).toBe(600);
    expect(result.error).toContain('500');
  });

  it('returns cached tree when available', async () => {
    const cachedTree: PageIndexNode = {
      title: 'Cached',
      start_index: 1,
      end_index: 100,
      nodes: [],
    };
    // pdfinfo returns >20 pages
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (cmd.includes('pdfinfo')) {
          if (cb) cb(null, { stdout: 'Pages:          100\n', stderr: '' });
        }
      },
    );
    // Cache hit
    mockReadFile.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.pageindex')) {
        return Promise.resolve(JSON.stringify(cachedTree));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await indexPdf('/tmp/cached.pdf', 'cached.pdf', {
      vaultDir: '/vault',
      fileBuffer: Buffer.from('test content'),
    });
    expect(result.success).toBe(true);
    expect(result.tree).toEqual(cachedTree);
    expect(result.pageCount).toBe(100);
  });

  it('runs python adapter and parses result on cache miss', async () => {
    const adapterTree: PageIndexNode = {
      title: 'Adapter Result',
      start_index: 1,
      end_index: 50,
      nodes: [
        {
          title: 'Chapter 1',
          start_index: 1,
          end_index: 25,
          nodes: [],
        },
      ],
    };

    mockExecFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        // Handle both 2-arg and 3-arg callback styles
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (typeof cmd === 'string' && cmd.includes('pdfinfo')) {
          if (cb) cb(null, { stdout: 'Pages:          50\n', stderr: '' });
        } else if (typeof cmd === 'string' && cmd.includes('python3')) {
          if (cb) cb(null, { stdout: JSON.stringify(adapterTree), stderr: '' });
        } else if (typeof cmd === 'string' && cmd.includes('pdftotext')) {
          if (cb) cb(null, { stdout: 'fallback text\n', stderr: '' });
        }
      },
    );

    // No cache
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    // Adapter exists
    mockAccess.mockResolvedValue(undefined);

    const result = await indexPdf('/tmp/medium.pdf', 'medium.pdf', {
      vaultDir: '/vault',
      fileBuffer: Buffer.from('pdf content'),
    });

    expect(result.success).toBe(true);
    expect(result.tree).toEqual(adapterTree);
    expect(result.pageCount).toBe(50);

    // Should have saved cache
    expect(mockMkdir).toHaveBeenCalled();
  });

  it('falls back to flat text when adapter fails', async () => {
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (typeof cmd === 'string' && cmd.includes('pdfinfo')) {
          if (cb) cb(null, { stdout: 'Pages:          30\n', stderr: '' });
        } else if (typeof cmd === 'string' && cmd.includes('python3')) {
          if (cb)
            cb(
              new Error('adapter crashed') as Error & {
                stdout: string;
                stderr: string;
              },
              { stdout: '', stderr: 'error' },
            );
        } else if (typeof cmd === 'string' && cmd.includes('pdftotext')) {
          if (cb) cb(null, { stdout: 'extracted text\n', stderr: '' });
        }
      },
    );

    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockAccess.mockResolvedValue(undefined);

    const result = await indexPdf('/tmp/failing.pdf', 'failing.pdf', {
      fileBuffer: Buffer.from('data'),
    });

    expect(result.success).toBe(false);
    expect(result.fallbackText).toBe('extracted text\n');
    expect(result.error).toBeDefined();
  });

  it('never throws — returns error result instead', async () => {
    // Everything fails
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        optsOrCb: unknown,
        maybeCb?: (err: Error) => void,
      ) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (cb) cb(new Error('total failure'));
      },
    );

    const result = await indexPdf('/tmp/doom.pdf', 'doom.pdf');
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
  });

  it('reads file from disk when no fileBuffer provided', async () => {
    mockExecFile.mockImplementation(
      (
        cmd: string,
        _args: string[],
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (typeof cmd === 'string' && cmd.includes('pdfinfo')) {
          if (cb) cb(null, { stdout: 'Pages:          25\n', stderr: '' });
        } else if (typeof cmd === 'string' && cmd.includes('python3')) {
          if (cb)
            cb(null, {
              stdout: JSON.stringify({
                title: 'T',
                start_index: 1,
                end_index: 25,
                nodes: [],
              }),
              stderr: '',
            });
        } else if (typeof cmd === 'string' && cmd.includes('pdftotext')) {
          if (cb) cb(null, { stdout: 'text\n', stderr: '' });
        }
      },
    );

    // readFile for file content (not cache)
    mockReadFile.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.pageindex')) {
        return Promise.reject(new Error('ENOENT'));
      }
      // Reading the actual PDF file for hashing
      return Promise.resolve(Buffer.from('pdf bytes'));
    });
    mockAccess.mockResolvedValue(undefined);

    const result = await indexPdf('/tmp/readfile.pdf', 'readfile.pdf', {
      vaultDir: '/vault',
    });
    expect(result.success).toBe(true);
  });
});
