#!/usr/bin/env node
/**
 * scripts/lint-migrations.js
 *
 * Lints SQL migration files for idempotency issues.
 * Runs automatically as a pre-commit hook (staged files only).
 * Pass --all to check every file in migrations/.
 *
 * Errors   → exit 1, output: file:line: [ERROR] message
 * Warnings → exit 0, output: file:line: [WARNING] message
 *
 * Checks:
 *   - ADD COLUMN without IF NOT EXISTS           → [ERROR]
 *   - CREATE INDEX without IF NOT EXISTS         → [ERROR]
 *   - Constraint change outside BEGIN...COMMIT   → [WARNING]
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ALL_MODE = process.argv.includes('--all');

// ── Determine which files to lint ───────────────────────────────────────────

let filesToCheck = [];

if (ALL_MODE) {
  try {
    filesToCheck = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => join('migrations', f))
      .sort();
  } catch {
    // No migrations directory — nothing to do.
  }
} else {
  // Only inspect files staged for this commit.
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
    filesToCheck = out
      .trim()
      .split('\n')
      .filter((f) => f && f.startsWith('migrations/') && f.endsWith('.sql'));
  } catch {
    // Not inside a git repo or git unavailable.
  }
}

if (filesToCheck.length === 0) {
  process.exit(0);
}

// ── Patterns ─────────────────────────────────────────────────────────────────

/** SQL clauses that modify or add constraints. */
const CONSTRAINT_PATTERNS = [
  /\bADD\s+CONSTRAINT\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /\bADD\s+FOREIGN\s+KEY\b/i,
  /\bADD\s+PRIMARY\s+KEY\b/i,
  /\bADD\s+UNIQUE\b/i,
];

// ── Lint ─────────────────────────────────────────────────────────────────────

let hasErrors = false;

for (const filePath of filesToCheck) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`${filePath}: [ERROR] Cannot read file: ${err.message}\n`);
    hasErrors = true;
    continue;
  }

  const lines = content.split('\n');
  let inTransaction = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();

    // Skip blank lines and SQL line comments.
    if (!line || line.startsWith('--')) continue;

    // ── Track transaction boundaries ─────────────────────────────────────────
    if (/^BEGIN(\s+TRANSACTION)?\s*;?$/i.test(line)) {
      inTransaction = true;
    }
    if (/^(COMMIT|ROLLBACK)(\s+TRANSACTION)?\s*;?$/i.test(line)) {
      inTransaction = false;
    }

    // ── ERROR: ADD COLUMN without IF NOT EXISTS ───────────────────────────────
    if (/\bADD\s+COLUMN\b/i.test(line) && !/\bIF\s+NOT\s+EXISTS\b/i.test(line)) {
      process.stderr.write(
        `${filePath}:${lineNum}: [ERROR] ADD COLUMN without IF NOT EXISTS — migration is not idempotent\n`,
      );
      hasErrors = true;
    }

    // ── ERROR: CREATE INDEX without IF NOT EXISTS ─────────────────────────────
    if (/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(line) && !/\bIF\s+NOT\s+EXISTS\b/i.test(line)) {
      process.stderr.write(
        `${filePath}:${lineNum}: [ERROR] CREATE INDEX without IF NOT EXISTS — migration is not idempotent\n`,
      );
      hasErrors = true;
    }

    // ── WARNING: Constraint change outside a transaction ──────────────────────
    for (const pattern of CONSTRAINT_PATTERNS) {
      if (pattern.test(line) && !inTransaction) {
        process.stdout.write(
          `${filePath}:${lineNum}: [WARNING] Constraint change outside BEGIN...COMMIT — wrap in a transaction for atomicity\n`,
        );
        break; // one warning per line is enough
      }
    }
  }
}

process.exit(hasErrors ? 1 : 0);
