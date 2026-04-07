/**
 * Pip Reports — flat-file Markdown store for transactional agent-authored reports.
 *
 * Reports are throwaway artifacts produced by Pip when an answer is too long
 * or table-shaped to live comfortably in chat. They are NOT vault knowledge:
 * they have no lifecycle, no status, no editing, no wikilinks. Pip writes,
 * Boris reads, the file accumulates or gets pruned without affecting anything
 * else.
 *
 * Storage: one Markdown file per report under data/reports/ at the NanoClaw
 * project root, alongside data/ipc/ and data/sessions/. Frontmatter holds id,
 * title, summary, created_at, created_by; body is the rendered markdown.
 *
 * Change notification: createReport() invokes a single registered onChange
 * callback synchronously after each successful write. The dashboard SSE layer
 * registers itself once at startup. No fs.watch (flakey on macOS, and reports
 * only change via createReport which is the only writer).
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// --- Constants ---

let reportsDir = path.join(DATA_DIR, 'reports');

/** Override reports directory (for tests). */
export function _setReportsDir(dir: string): void {
  reportsDir = dir;
}

export function getReportsDir(): string {
  return reportsDir;
}

// --- Types ---

export interface ReportMeta {
  id: string;
  title: string;
  summary: string;
  created_at: string;
  created_by: string;
}

export interface Report extends ReportMeta {
  body_markdown: string;
}

// --- Change notification ---

let onChange: (() => void) | null = null;

/**
 * Register a single callback fired synchronously after each successful
 * createReport(). Replaces any previously registered callback. Phase 1 has
 * one consumer (dashboard SSE) — no need for a multi-subscriber registry.
 */
export function setReportsChangeCallback(cb: (() => void) | null): void {
  onChange = cb;
}

// --- Storage ---

function ensureReportsDir(): void {
  fs.mkdirSync(reportsDir, { recursive: true });
}

function reportFilePath(id: string): string {
  return path.join(reportsDir, `${id}.md`);
}

/**
 * Strict ID shape: lowercase alphanumerics + hyphens, ≤ 80 chars.
 * Belt-and-braces against path traversal even though all reads are confined
 * to reportsDir via path.join.
 */
const ID_REGEX = /^[a-z0-9-]+$/;
export function isValidReportId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 80 &&
    ID_REGEX.test(id)
  );
}

/**
 * Create a report. The caller (the IPC handler) supplies the fully-formed ID,
 * which Pip's MCP tool generated deterministically before writing the IPC file
 * so the chat reply URL matches the eventual filename.
 *
 * Atomic write: temp file then rename, so partial reads can never see a
 * half-written report.
 */
export function createReport(input: {
  id: string;
  title: string;
  summary: string;
  body_markdown: string;
  created_by: string;
}): Report {
  if (!isValidReportId(input.id)) {
    throw new Error(`Invalid report id: ${input.id}`);
  }

  ensureReportsDir();

  const meta: ReportMeta = {
    id: input.id,
    title: input.title,
    summary: input.summary,
    created_at: new Date().toISOString(),
    created_by: input.created_by,
  };

  // gray-matter serializes the frontmatter as YAML, escaping any quotes,
  // newlines, or `---` separators in title/summary correctly.
  const fileContent = matter.stringify(input.body_markdown, {
    id: meta.id,
    title: meta.title,
    summary: meta.summary,
    created_at: meta.created_at,
    created_by: meta.created_by,
  });

  const finalPath = reportFilePath(input.id);
  const tempPath = `${finalPath}.tmp`;
  fs.writeFileSync(tempPath, fileContent);
  fs.renameSync(tempPath, finalPath);

  const report: Report = { ...meta, body_markdown: input.body_markdown };

  if (onChange) {
    try {
      onChange();
    } catch (err) {
      logger.warn(
        { err, reportId: input.id },
        'Reports onChange callback threw',
      );
    }
  }

  return report;
}

/**
 * List all reports, frontmatter only. Sorted newest first by created_at.
 * Skips files that fail to parse — surfaces a warning but doesn't crash
 * the listing.
 */
export function listReports(): ReportMeta[] {
  ensureReportsDir();

  let files: string[];
  try {
    files = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const reports: ReportMeta[] = [];
  for (const file of files) {
    const fullPath = path.join(reportsDir, file);
    try {
      // lstat instead of stat: skip symlinks. data/reports/ is meant to be
      // a flat directory of regular .md files only.
      const stat = fs.lstatSync(fullPath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const parsed = matter(content);
      const fm = parsed.data as Partial<ReportMeta>;
      if (!fm.id || !fm.title || !fm.created_at) {
        logger.warn({ file }, 'Report file missing required frontmatter');
        continue;
      }
      reports.push({
        id: fm.id,
        title: fm.title,
        summary: fm.summary || '',
        created_at: fm.created_at,
        created_by: fm.created_by || '',
      });
    } catch (err) {
      logger.warn({ file, err }, 'Failed to parse report file');
    }
  }

  reports.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return reports;
}

/**
 * Read a single report by ID, with full body. Returns null for unknown IDs
 * rather than throwing — callers (HTTP API) can map null to 404.
 */
export function getReport(id: string): Report | null {
  if (!isValidReportId(id)) return null;

  const fullPath = reportFilePath(id);
  if (!fs.existsSync(fullPath)) return null;

  try {
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile()) return null;

    const content = fs.readFileSync(fullPath, 'utf-8');
    const parsed = matter(content);
    const fm = parsed.data as Partial<ReportMeta>;
    if (!fm.id || !fm.title || !fm.created_at) {
      logger.warn({ id }, 'Report file missing required frontmatter');
      return null;
    }
    return {
      id: fm.id,
      title: fm.title,
      summary: fm.summary || '',
      created_at: fm.created_at,
      created_by: fm.created_by || '',
      body_markdown: parsed.content.trim(),
    };
  } catch (err) {
    logger.warn({ id, err }, 'Failed to read report');
    return null;
  }
}
