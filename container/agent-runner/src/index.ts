/**
 * NanoClaw Agent Runner (Provider-Agnostic)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses CLI invocation (via RunnerBackend) instead of SDK query().
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createBackend } from './backend-factory.js';
import { writeMcpConfig } from './mcp-config.js';
import type { RunnerBackend, RunOptions, RunResult } from './runner-backend.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface UsageSnapshot {
  inputTokens: number;
  contextWindow: number;
}

// ── Auto-compact configuration ──────────────────────────────────────────────

const AUTO_COMPACT_ENABLED = process.env.AUTO_COMPACT_ENABLED === 'true';
const AUTO_COMPACT_THRESHOLD = Math.min(
  1,
  Math.max(0, parseFloat(process.env.AUTO_COMPACT_THRESHOLD || '0.8')),
);

// ── IPC configuration ───────────────────────────────────────────────────────

const IPC_INPUT_DIR = process.env.NANOCLAW_IPC_INPUT_DIR || '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Determine if auto-compact should trigger based on usage and config.
 * Exported for testing.
 */
export function shouldTriggerAutoCompact(
  usage: UsageSnapshot | null,
  config: { enabled: boolean; threshold: number },
  alreadyCompactedThisSession: boolean,
): boolean {
  if (!config.enabled) return false;
  if (alreadyCompactedThisSession) return false;
  if (!usage) return false;
  if (usage.contextWindow <= 0) return false;
  const ratio = usage.inputTokens / usage.contextWindow;
  return ratio >= config.threshold;
}

// ── IPC functions ───────────────────────────────────────────────────────────

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ── Build run options ───────────────────────────────────────────────────────

function buildRunOptions(
  containerInput: ContainerInput,
  mcpConfigPath: string,
  sessionId?: string,
): RunOptions {
  const groupDir = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
  const globalDir = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';

  // Load global CLAUDE.md as appended system prompt (shared across all groups)
  let appendSystemPrompt: string | undefined;
  if (!containerInput.isMain) {
    const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
    if (fs.existsSync(globalClaudeMdPath)) {
      appendSystemPrompt = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirs: string[] = [];
  const extraBase = process.env.NANOCLAW_EXTRA_DIR || '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirs.push(fullPath);
      }
    }
  }
  if (additionalDirs.length > 0) {
    log(`Additional directories: ${additionalDirs.join(', ')}`);
  }

  return {
    sessionId,
    cwd: groupDir,
    mcpConfigPath,
    appendSystemPrompt,
    additionalDirs: additionalDirs.length > 0 ? additionalDirs : undefined,
    env: { ...process.env } as Record<string, string | undefined>,
    model: process.env.AGENT_MODEL,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Set up MCP config
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const mcpConfigPath = writeMcpConfig({
    mcpServerPath,
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isMain: containerInput.isMain,
  });

  // Create backend
  const backend: RunnerBackend = createBackend();

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // ── Slash command handling ──────────────────────────────────────────────

  const KNOWN_SESSION_COMMANDS = new Set(['/compact', '/clear']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand && trimmedPrompt === '/clear') {
    // /clear: signal the host to archive, then exit
    log('Handling /clear session command');
    writeOutput({ status: 'success', result: null });
    return;
  }

  if (isSessionSlashCommand && trimmedPrompt === '/compact') {
    // /compact: invoke backend with /compact as prompt
    log('Handling /compact session command');
    try {
      const options = buildRunOptions(containerInput, mcpConfigPath, sessionId);
      const result = await backend.invoke('/compact', options);
      writeOutput({
        status: result.exitCode === 0 ? 'success' : 'error',
        result: result.output || 'Conversation compacted.',
        newSessionId: result.newSessionId,
        error: result.exitCode !== 0 ? `CLI exited with code ${result.exitCode}` : undefined,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`/compact error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }
    return;
  }

  // ── Query loop ────────────────────────────────────────────────────────────

  let autoCompactedThisSession = false;

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const options = buildRunOptions(containerInput, mcpConfigPath, sessionId);
      const result = await backend.invoke(prompt, options);

      if (result.newSessionId) {
        sessionId = result.newSessionId;
      }

      // Write the result
      if (result.exitCode === 0) {
        writeOutput({
          status: 'success',
          result: result.output,
          newSessionId: sessionId,
        });
      } else {
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: result.output || `CLI exited with code ${result.exitCode}`,
        });
      }

      // Auto-compact: check if context usage exceeds threshold
      if (shouldTriggerAutoCompact(
        result.usage || null,
        { enabled: AUTO_COMPACT_ENABLED, threshold: AUTO_COMPACT_THRESHOLD },
        autoCompactedThisSession,
      )) {
        const usagePct = result.usage
          ? (result.usage.inputTokens / result.usage.contextWindow * 100).toFixed(1)
          : '?';
        log(`Auto-compact: usage at ${usagePct}%, threshold ${AUTO_COMPACT_THRESHOLD * 100}%`);
        writeOutput({
          status: 'success',
          result: `[Auto-compacting context (${usagePct}% used)]`,
          newSessionId: sessionId,
        });

        const compactOptions = buildRunOptions(containerInput, mcpConfigPath, sessionId);
        const compactResult = await backend.invoke('/compact', compactOptions);
        autoCompactedThisSession = true;

        if (compactResult.newSessionId) {
          sessionId = compactResult.newSessionId;
          writeOutput({ status: 'success', result: null, newSessionId: sessionId });
        }
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Drain any messages that arrived during the CLI invocation
      const buffered = drainIpcInput();
      if (buffered.length > 0) {
        log(`Found ${buffered.length} buffered IPC messages, processing immediately`);
        prompt = buffered.join('\n');
        continue;
      }

      // Check close sentinel
      if (shouldClose()) {
        log('Close sentinel received, exiting');
        break;
      }

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);

    const isSessionError = /no conversation found|session.*not found/i.test(errorMessage);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: isSessionError ? undefined : sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }

  // Clean up temp MCP config
  try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
}

main();
