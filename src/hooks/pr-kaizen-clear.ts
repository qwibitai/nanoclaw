/**
 * pr-kaizen-clear.ts — Clears the PR kaizen gate on valid impediment declarations.
 *
 * PostToolUse hook on Bash — always exits 0 (state management, not blocking).
 *
 * Triggers:
 *   1. echo "KAIZEN_IMPEDIMENTS: [...]" — structured impediment declaration
 *   2. echo "KAIZEN_NO_ACTION [category]: <reason>" — restricted bypass
 *
 * Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
 * Migration: kaizen #320 (Phase 3 of #223)
 */

import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HookInput, readHookInput, writeHookOutput } from './hook-io.js';
import { stripHeredocBody } from './parse-command.js';
import {
  DEFAULT_STATE_DIR,
  clearStateWithStatusAnyBranch,
  findNewestStateWithStatusAnyBranch,
  markReflectionDone,
  prUrlToStateKey,
} from './state-utils.js';

// ── Types ────────────────────────────────────────────────────────────

interface Impediment {
  impediment?: string;
  finding?: string;
  type?: string;
  disposition?: string;
  ref?: string;
  reason?: string;
  impact_minutes?: number;
}

// ── Audit logging ────────────────────────────────────────────────────

const __hookDirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = resolve(__hookDirname, '../../.claude/kaizen/audit');

function currentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function logAudit(file: string, line: string): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(join(AUDIT_DIR, file), line);
  } catch {}
}

function logNoAction(category: string, reason: string, prUrl: string): void {
  const ts = new Date().toISOString();
  logAudit(
    'no-action.log',
    `${ts} | branch=${currentBranch()} | category=${category} | pr=${prUrl} | reason=${reason}\n`,
  );
}

function logWaiver(
  desc: string,
  reason: string,
  type: string,
  prUrl: string,
): void {
  const ts = new Date().toISOString();
  logAudit(
    'waiver.log',
    `${ts} | branch=${currentBranch()} | type=${type} | pr=${prUrl} | desc=${desc} | reason=${reason}\n`,
  );
}

// ── Validation ───────────────────────────────────────────────────────

/** Dispositions valid per finding type (kaizen #198: waived eliminated). */
const META_DISPOSITIONS = new Set(['filed', 'fixed-in-pr']);
const POSITIVE_DISPOSITIONS = new Set([
  'filed',
  'incident',
  'fixed-in-pr',
  'no-action',
]);
const STANDARD_DISPOSITIONS = new Set(['filed', 'incident', 'fixed-in-pr']);

function validateImpediments(items: Impediment[]): string[] {
  const errors: string[] = [];
  for (const item of items) {
    const desc = item.impediment || item.finding || '';
    const disposition = item.disposition ?? '';
    const type = item.type ?? '';

    if (!desc) {
      errors.push('missing "impediment" or "finding" field');
      continue;
    }
    if (!disposition) {
      errors.push(`missing "disposition" for: ${desc}`);
      continue;
    }

    // Waived eliminated (kaizen #198)
    if (disposition === 'waived') {
      errors.push(
        `disposition "waived" is no longer accepted (kaizen #198). If "${desc}" is real friction, file it. If not, reclassify as {"type": "positive", "disposition": "no-action", "reason": "..."}.`,
      );
      continue;
    }

    if (type === 'meta' && !META_DISPOSITIONS.has(disposition)) {
      errors.push(
        `meta-finding "${desc}" has disposition "${disposition}" \u2014 must be "filed" or "fixed-in-pr". Reclassify as "positive" with "no-action" if not actionable.`,
      );
      continue;
    }
    if (type === 'positive' && !POSITIVE_DISPOSITIONS.has(disposition)) {
      errors.push(
        `invalid disposition "${disposition}" for: ${desc} (must be filed|incident|fixed-in-pr|no-action)`,
      );
      continue;
    }
    if (
      type !== 'meta' &&
      type !== 'positive' &&
      !STANDARD_DISPOSITIONS.has(disposition)
    ) {
      errors.push(
        `invalid disposition "${disposition}" for impediment: ${desc} (must be filed|incident|fixed-in-pr). File it or reclassify as "positive" if not real friction.`,
      );
      continue;
    }

    if ((disposition === 'filed' || disposition === 'incident') && !item.ref) {
      errors.push(
        `disposition "${disposition}" requires "ref" field for: ${desc}`,
      );
    }
    if (disposition === 'no-action' && !item.reason) {
      errors.push(
        `disposition "no-action" requires "reason" field for: ${desc}`,
      );
    }
  }
  return errors;
}

// ── JSON extraction ──────────────────────────────────────────────────

function extractImpedimentsJson(
  stdout: string,
  cmdLine: string,
  fullCommand: string,
): { json: unknown[] | null; emptyReason: string } {
  let raw = '';

  // Try stdout
  if (stdout) {
    const m = stdout.match(/KAIZEN_IMPEDIMENTS:\s*([\s\S]*)/);
    if (m) raw = m[1].replace(/\n/g, ' ').trim();
  }

  // Fallback: stdout as raw JSON array (kaizen #313)
  if (!raw && stdout) {
    const trimmed = stdout.replace(/\n/g, ' ').trim();
    try {
      if (Array.isArray(JSON.parse(trimmed))) raw = trimmed;
    } catch {}
  }

  // Fallback: heredoc body from full command (kaizen #313)
  if (!raw && fullCommand) {
    const heredocMatch = fullCommand.match(
      /<<.*?IMPEDIMENTS\n([\s\S]*?)\nIMPEDIMENTS/,
    );
    if (heredocMatch) {
      const body = heredocMatch[1].replace(/\n/g, ' ').trim();
      try {
        if (Array.isArray(JSON.parse(body))) raw = body;
      } catch {}
    }
  }

  // Fallback: cmdLine inline
  if (!raw) {
    const m = cmdLine.match(/KAIZEN_IMPEDIMENTS:\s*([\s\S]*)/);
    if (m) raw = m[1].replace(/\n/g, ' ').trim();
  }

  if (!raw) return { json: null, emptyReason: '' };

  // Try full parse
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { json: parsed, emptyReason: '' };
  } catch {}

  // "[] reason" format
  const emptyMatch = raw.match(/^\[\]\s*(.*)/);
  if (emptyMatch) {
    const reason = emptyMatch[1]
      .trim()
      .replace(/^['"]/, '')
      .replace(/['"]$/, '')
      .trim();
    return { json: [], emptyReason: reason };
  }

  return { json: null, emptyReason: '' };
}

// ── KAIZEN_NO_ACTION ─────────────────────────────────────────────────

const VALID_NO_ACTION_CATEGORIES = new Set([
  'docs-only',
  'formatting',
  'typo',
  'config-only',
  'test-only',
  'trivial-refactor',
]);

function extractNoAction(
  stdout: string,
  cmdLine: string,
): { category: string; reason: string } | null {
  for (const src of [stdout, cmdLine].filter(Boolean)) {
    const m = src.match(/KAIZEN_NO_ACTION\s*\[([a-z-]+)\]\s*:\s*(.*)/);
    if (m) {
      return {
        category: m[1],
        reason: m[2].trim().replace(/^['"]/, '').replace(/['"]$/, '').trim(),
      };
    }
  }
  return null;
}

// ── Core logic (extracted for testability) ───────────────────────────

export function processHookInput(
  input: HookInput,
  options: { stateDir?: string } = {},
): string | null {
  if (input.tool_name !== 'Bash') return null;

  const exitCode = String(input.tool_response?.exit_code ?? '0');
  if (exitCode !== '0') return null;

  const command = input.tool_input?.command ?? '';
  const stdout = input.tool_response?.stdout ?? '';
  const cmdLine = stripHeredocBody(command);
  const stateDir =
    options.stateDir ?? process.env.STATE_DIR ?? DEFAULT_STATE_DIR;

  // Check for active kaizen gate
  const gateState = findNewestStateWithStatusAnyBranch(
    'needs_pr_kaizen',
    stateDir,
  );
  if (!gateState) return null;

  const gatePrUrl = gateState.prUrl;
  let shouldClear = false;
  let clearReason = '';
  let allPassive = false;
  const output: string[] = [];

  // ── Trigger 1: KAIZEN_IMPEDIMENTS ──────────────────────────────
  if (
    /KAIZEN_IMPEDIMENTS:/.test(cmdLine) ||
    /KAIZEN_IMPEDIMENTS:/.test(stdout)
  ) {
    const { json, emptyReason } = extractImpedimentsJson(
      stdout,
      cmdLine,
      command,
    );

    if (json === null) {
      return '\nKAIZEN_IMPEDIMENTS: Invalid JSON. Expected a JSON array.\n';
    }

    if (json.length === 0) {
      if (!emptyReason) {
        return "\nKAIZEN_IMPEDIMENTS: Empty array requires a reason.\n  echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix'\n";
      }
      logNoAction('empty-array', emptyReason, gatePrUrl);
      shouldClear = true;
      clearReason = `no impediments identified (${emptyReason})`;
    } else {
      const items = json as Impediment[];
      const errors = validateImpediments(items);
      if (errors.length > 0) {
        return `\nKAIZEN_IMPEDIMENTS: Validation failed:\n${errors.join('\n')}\n\nFix the issues and resubmit.\n`;
      }

      allPassive = items.every((i) => i.disposition === 'no-action');
      shouldClear = true;
      clearReason = `${items.length} finding(s) addressed`;
    }
  }

  // ── Trigger 2: KAIZEN_NO_ACTION ────────────────────────────────
  if (
    !shouldClear &&
    (/KAIZEN_NO_ACTION/.test(cmdLine) || /KAIZEN_NO_ACTION/.test(stdout))
  ) {
    const noAction = extractNoAction(stdout, cmdLine);

    if (!noAction?.category) {
      return `\nKAIZEN_NO_ACTION: Missing category.\n  Valid: ${Array.from(VALID_NO_ACTION_CATEGORIES).join(', ')}\n`;
    }
    if (!VALID_NO_ACTION_CATEGORIES.has(noAction.category)) {
      return `\nKAIZEN_NO_ACTION: Invalid category "${noAction.category}".\n  Valid: ${Array.from(VALID_NO_ACTION_CATEGORIES).join(', ')}\n`;
    }
    if (!noAction.reason) {
      return `\nKAIZEN_NO_ACTION: Missing reason.\n  Format: KAIZEN_NO_ACTION [${noAction.category}]: your reason\n`;
    }

    logNoAction(noAction.category, noAction.reason, gatePrUrl);
    shouldClear = true;
    clearReason = `no action needed [${noAction.category}]: ${noAction.reason}`;
  }

  // ── Clear gate ─────────────────────────────────────────────────
  if (shouldClear) {
    if (allPassive) {
      output.push(
        '\nAll findings classified as no-action \u2014 none filed or fixed-in-pr.\n"Every failure is a gift \u2014 if you file the issue."\n',
      );
    }

    clearStateWithStatusAnyBranch(
      'needs_pr_kaizen',
      stateDir,
      undefined,
      gatePrUrl,
    );
    markReflectionDone(gatePrUrl, currentBranch(), stateDir);

    // Auto-close kaizen issues (best-effort)
    try {
      autoCloseKaizenIssues(gatePrUrl);
    } catch {}

    output.push(
      `\nPR kaizen gate cleared (${clearReason}). You may proceed with other work.\n`,
    );
    return output.join('');
  }

  return null;
}

/** Auto-close kaizen issues referenced in a merged PR body. */
function autoCloseKaizenIssues(prUrl: string): void {
  const prNum = prUrl.match(/(\d+)$/)?.[1];
  const repo = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
  if (!prNum || !repo) return;

  let prState: string;
  try {
    prState = execSync(
      `gh pr view ${prNum} --repo "${repo}" --json state --jq .state`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    return;
  }
  if (prState !== 'MERGED') return;

  let prBody: string;
  try {
    prBody = execSync(
      `gh pr view ${prNum} --repo "${repo}" --json body --jq .body`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    return;
  }

  const issueNums = new Set<string>();
  for (const m of prBody.matchAll(/Garsson-io\/kaizen[#/issues/]*(\d+)/g))
    issueNums.add(m[1]);
  for (const m of prBody.matchAll(
    /github\.com\/Garsson-io\/kaizen\/issues\/(\d+)/g,
  ))
    issueNums.add(m[1]);

  for (const num of issueNums) {
    try {
      const state = execSync(
        `gh issue view ${num} --repo Garsson-io/kaizen --json state --jq .state`,
        {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ).trim();
      if (state === 'OPEN') {
        execSync(
          `gh issue close ${num} --repo Garsson-io/kaizen --comment "Auto-closed: PR merged (${prUrl})"`,
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
      }
    } catch {}
  }
}

// ── Main entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const output = processHookInput(input);
  if (output) writeHookOutput(output);
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('pr-kaizen-clear.ts') ||
  process.argv[1]?.endsWith('pr-kaizen-clear.js')
) {
  main().catch(() => process.exit(0));
}
