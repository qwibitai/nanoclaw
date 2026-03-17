import { execFile } from 'child_process';
import crypto from 'crypto';
import { access, mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import { CREDENTIAL_PROXY_PORT } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Use absolute paths — launchd doesn't include /opt/homebrew/bin in PATH
const PDFINFO =
  process.platform === 'darwin' ? '/opt/homebrew/bin/pdfinfo' : 'pdfinfo';
const PDFTOTEXT =
  process.platform === 'darwin' ? '/opt/homebrew/bin/pdftotext' : 'pdftotext';

// Page thresholds
const SMALL_PDF_MAX_PAGES = 20;
const LARGE_PDF_MAX_PAGES = 500;

// Adapter timeout
const ADAPTER_TIMEOUT_MS = 90_000;

// ─── Interfaces ───────────────────────────────────────────────────────

export interface PageIndexNode {
  title: string;
  node_id?: string;
  start_index: number;
  end_index: number;
  summary?: string;
  nodes: PageIndexNode[];
}

export interface MountMapping {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface IndexResult {
  success: boolean;
  tree?: PageIndexNode;
  pageCount?: number;
  fallbackText?: string;
  error?: string;
}

export interface IndexOptions {
  vaultDir?: string;
  contentHash?: string;
  fileBuffer?: Buffer;
}

// ─── Task 1: Page counting and content hashing ───────────────────────

/**
 * Count pages in a PDF using pdfinfo. Returns 0 on failure.
 */
export async function countPdfPages(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(PDFINFO, [filePath]);
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Compute sha256 hash of a buffer, return first 8 hex chars.
 */
export function computeFileHash(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').substring(0, 8);
}

// ─── Task 2: Cache lookup and path resolution ────────────────────────

/**
 * Strip .pdf extension from filename for cache key.
 */
function baseName(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, '');
}

/**
 * Look for cached pageindex tree at .pageindex/{baseName}-{hash}.json.
 * Returns parsed JSON or null.
 */
export async function findCachedTree(
  pdfDir: string,
  pdfName: string,
  hash: string,
): Promise<PageIndexNode | null> {
  try {
    const cachePath = path.join(
      pdfDir,
      '.pageindex',
      `${baseName(pdfName)}-${hash}.json`,
    );
    const data = await readFile(cachePath, 'utf-8');
    return JSON.parse(data) as PageIndexNode;
  } catch {
    return null;
  }
}

/**
 * Save tree JSON to .pageindex/ with atomic tmp+rename. Catches errors.
 */
export async function saveCachedTree(
  pdfDir: string,
  pdfName: string,
  hash: string,
  tree: PageIndexNode,
): Promise<void> {
  try {
    const cacheDir = path.join(pdfDir, '.pageindex');
    await mkdir(cacheDir, { recursive: true });
    const finalPath = path.join(cacheDir, `${baseName(pdfName)}-${hash}.json`);
    const tmpPath = `${finalPath}.tmp.${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(tree, null, 2));
    await rename(tmpPath, finalPath);
  } catch (err) {
    logger.warn({ err }, 'Failed to save pageindex cache');
  }
}

/**
 * Map a container path to its host path using mount mappings.
 * Security: uses separator-safe prefix check. Returns null for traversal
 * attempts or unknown prefixes.
 */
export function resolveContainerPath(
  containerPath: string,
  mounts: MountMapping[],
): string | null {
  // Reject traversal attempts
  if (containerPath.includes('..')) {
    return null;
  }

  for (const mount of mounts) {
    const prefix = mount.containerPath + '/';
    if (containerPath.startsWith(prefix)) {
      const relativePath = containerPath.slice(prefix.length);
      const resolved = path.resolve(mount.hostPath, relativePath);
      // Verify resolved path hasn't escaped the mount root
      if (
        !resolved.startsWith(mount.hostPath + path.sep) &&
        resolved !== mount.hostPath
      ) {
        return null;
      }
      return resolved;
    }
    // Exact match (unlikely but handle it)
    if (containerPath === mount.containerPath) {
      return mount.hostPath;
    }
  }

  return null;
}

// ─── Task 3: Flat text extraction and page-range fetch ───────────────

/**
 * Extract full text from PDF using pdftotext -layout. Returns empty string on failure.
 */
export async function extractFlatText(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT, [
      '-layout',
      filePath,
      '-',
    ]);
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Extract text from a specific page range. Returns empty string on failure.
 */
export async function fetchPageRange(
  filePath: string,
  startPage: number,
  endPage: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT, [
      '-f',
      String(startPage),
      '-l',
      String(endPage),
      '-layout',
      filePath,
      '-',
    ]);
    return stdout;
  } catch {
    return '';
  }
}

// ─── Task 4: indexPdf orchestrator with fallback ─────────────────────

/**
 * Resolve the path to the Python adapter script relative to the project root.
 */
function adapterPath(): string {
  // Resolve from cwd, which is the project root at runtime
  return path.resolve('scripts/pageindex/venv/bin/python3');
}

function adapterScriptPath(): string {
  return path.resolve('scripts/pageindex/adapter.py');
}

/**
 * Orchestrate PDF indexing with fallback.
 * NEVER throws — all errors caught and returned as fallback.
 */
export async function indexPdf(
  filePath: string,
  fileName: string,
  opts?: IndexOptions,
): Promise<IndexResult> {
  try {
    // Step 1: Count pages
    const pageCount = await countPdfPages(filePath);

    if (pageCount === 0) {
      const fallbackText = await extractFlatText(filePath);
      return {
        success: false,
        pageCount: 0,
        fallbackText,
        error: fallbackText ? 'Could not determine page count' : 'All extraction failed',
      };
    }

    // Small PDFs: return flat text directly
    if (pageCount <= SMALL_PDF_MAX_PAGES) {
      const text = await extractFlatText(filePath);
      return {
        success: false,
        pageCount,
        fallbackText: text,
      };
    }

    // Very large PDFs: skip indexing
    if (pageCount > LARGE_PDF_MAX_PAGES) {
      const text = await extractFlatText(filePath);
      return {
        success: false,
        pageCount,
        fallbackText: text,
        error: `PDF exceeds ${LARGE_PDF_MAX_PAGES} pages (${pageCount}), skipping indexing`,
      };
    }

    // Step 2: Compute hash
    let hash = opts?.contentHash;
    if (!hash) {
      let buf = opts?.fileBuffer;
      if (!buf) {
        buf = (await readFile(filePath)) as Buffer;
      }
      hash = computeFileHash(buf);
    }

    // Step 3: Check cache
    if (opts?.vaultDir) {
      const cached = await findCachedTree(opts.vaultDir, fileName, hash);
      if (cached) {
        logger.info({ fileName, hash }, 'PageIndex cache hit');
        return {
          success: true,
          tree: cached,
          pageCount,
        };
      }
    }

    // Also check cache in the PDF's own directory
    const pdfDir = path.dirname(filePath);
    if (pdfDir !== opts?.vaultDir) {
      const cached = await findCachedTree(pdfDir, fileName, hash);
      if (cached) {
        logger.info({ fileName, hash }, 'PageIndex cache hit (pdf dir)');
        return {
          success: true,
          tree: cached,
          pageCount,
        };
      }
    }

    // Step 4: Check if adapter exists
    const pythonBin = adapterPath();
    const scriptPath = adapterScriptPath();
    try {
      await access(scriptPath);
    } catch {
      // Adapter not installed, fall back to flat text
      const text = await extractFlatText(filePath);
      return {
        success: false,
        pageCount,
        fallbackText: text,
        error: 'PageIndex adapter not installed',
      };
    }

    // Step 5: Run Python adapter
    try {
      const { stdout } = await execFileAsync(
        pythonBin,
        [scriptPath, filePath],
        {
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: `http://localhost:${CREDENTIAL_PROXY_PORT}`,
            ANTHROPIC_API_KEY: 'placeholder',
          },
          timeout: ADAPTER_TIMEOUT_MS,
        },
      );

      // Step 6: Parse result
      const tree = JSON.parse(stdout.trim()) as PageIndexNode;

      // Save to cache
      if (opts?.vaultDir) {
        await saveCachedTree(opts.vaultDir, fileName, hash, tree);
      }
      await saveCachedTree(pdfDir, fileName, hash, tree);

      return {
        success: true,
        tree,
        pageCount,
      };
    } catch (adapterErr) {
      // Step 7: Fall back to flat text
      logger.warn({ err: adapterErr, fileName }, 'PageIndex adapter failed');
      const text = await extractFlatText(filePath);
      return {
        success: false,
        pageCount,
        fallbackText: text,
        error: `Adapter failed: ${adapterErr instanceof Error ? adapterErr.message : String(adapterErr)}`,
      };
    }
  } catch (err) {
    // Top-level catch — NEVER throws
    logger.error({ err, fileName }, 'indexPdf unexpected error');
    return {
      success: false,
      error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
