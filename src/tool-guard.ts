/**
 * Tool Guard: pre-execution security layer for MCP tool calls.
 *
 * Three rule tiers, evaluated in priority order:
 * 1. block  — patterns matched against tool name + serialized args → hard deny
 * 2. allow  — tool names always permitted (overrides pause)
 * 3. pause  — tool names that require explicit approval → denied unless in allow
 *
 * Config loaded per-agent from tool-guard.json (group → global → built-in defaults).
 * Default config is permissive — only dangerous command patterns are blocked.
 * Agents opt in to restrictions by adding tools to their pause list.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { resolveGroupFolderPath } from './group-folder.js';

// ── Schema ───────────────────────────────────────────────────────────

export const ToolGuardConfigSchema = z.object({
  /** Patterns matched case-insensitively against tool name + serialized args.
   *  If any pattern matches, the call is blocked unconditionally. */
  block: z.array(z.string()).default([]),
  /** Tool names that require explicit approval.
   *  Blocked unless the tool is also in the allow list. */
  pause: z.array(z.string()).default([]),
  /** Tool names always permitted (overrides pause, but NOT block). */
  allow: z.array(z.string()).default([]),
});

export type ToolGuardConfig = z.infer<typeof ToolGuardConfigSchema>;

// ── Default Config ───────────────────────────────────────────────────
// Maximally permissive — only blocks dangerous command patterns.
// Agents restrict themselves via per-group tool-guard.json files.

export const DEFAULT_CONFIG: ToolGuardConfig = {
  block: [
    'rm -rf',
    'rm -r /',
    'DROP TABLE',
    'DROP DATABASE',
    'TRUNCATE TABLE',
    'shutdown',
    'reboot',
    'mkfs',
  ],
  pause: [],
  allow: [],
};

// ── Evaluation ───────────────────────────────────────────────────────

export interface GuardVerdict {
  action: 'allow' | 'block';
  reason: string;
  rule: 'block_pattern' | 'allow_list' | 'pause_list' | 'default';
}

/**
 * Evaluate whether a tool call should proceed.
 *
 * Priority:
 * 1. Block patterns (substring match on `toolName + JSON(args)`) → BLOCK
 * 2. Allow list (exact tool name match) → ALLOW
 * 3. Pause list (exact tool name match) → BLOCK
 * 4. Not in any list → ALLOW
 */
export function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  config: ToolGuardConfig,
): GuardVerdict {
  // 1. Block patterns: case-insensitive substring match, whitespace normalized
  const serialized = `${toolName} ${JSON.stringify(args)}`.toLowerCase().replace(/\s+/g, ' ');

  for (const pattern of config.block) {
    if (serialized.includes(pattern.toLowerCase())) {
      return {
        action: 'block',
        reason: `Matched block pattern: "${pattern}"`,
        rule: 'block_pattern',
      };
    }
  }

  // 2. Allow list (overrides pause, but not block)
  if (config.allow.includes(toolName)) {
    return {
      action: 'allow',
      reason: `Tool "${toolName}" is in allow list`,
      rule: 'allow_list',
    };
  }

  // 3. Pause list — needs explicit approval via allow list
  if (config.pause.includes(toolName)) {
    return {
      action: 'block',
      reason: `Tool "${toolName}" requires approval (in pause list)`,
      rule: 'pause_list',
    };
  }

  // 4. Default: allow
  return {
    action: 'allow',
    reason: 'No matching rule',
    rule: 'default',
  };
}

// ── Config Loading ───────────────────────────────────────────────────

/**
 * Load tool guard config with 3-tier fallback:
 * 1. Group-specific: groups/{folder}/tool-guard.json
 * 2. Global: groups/global/tool-guard.json
 * 3. Built-in defaults
 */
export function loadToolGuardConfig(
  groupFolder: string,
  resolveGroupFolderPathFn: (folder: string) => string = resolveGroupFolderPath,
): ToolGuardConfig {
  // 1. Group-specific
  try {
    const groupDir = resolveGroupFolderPathFn(groupFolder);
    const configPath = path.join(groupDir, 'tool-guard.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const parsed = ToolGuardConfigSchema.parse(raw);
      // Merge: always include default block patterns so group configs can't weaken them
      return {
        ...parsed,
        block: [...new Set([...DEFAULT_CONFIG.block, ...parsed.block])],
      };
    }
  } catch {
    // fall through
  }

  // 2. Global
  try {
    const globalDir = resolveGroupFolderPathFn('global');
    const globalPath = path.join(globalDir, 'tool-guard.json');
    if (fs.existsSync(globalPath)) {
      const raw = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
      const parsed = ToolGuardConfigSchema.parse(raw);
      return {
        ...parsed,
        block: [...new Set([...DEFAULT_CONFIG.block, ...parsed.block])],
      };
    }
  } catch {
    // fall through
  }

  // 3. Defaults
  return DEFAULT_CONFIG;
}
