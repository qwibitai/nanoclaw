/**
 * hook-io.ts — Shared I/O for Claude Code hooks running as TypeScript.
 *
 * Claude Code hooks receive JSON on stdin and write advisory text to stdout.
 * This module handles the boilerplate.
 */

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; [key: string]: unknown };
  tool_response?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number | string;
  };
}

/** Read all of stdin and parse as JSON. Returns null on parse failure. */
export async function readHookInput(): Promise<HookInput | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

/** Write advisory output to stdout (shown to the agent in PostToolUse). */
export function writeHookOutput(text: string): void {
  process.stdout.write(text);
}
