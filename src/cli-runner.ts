/**
 * CLI Runner for NanoClaw
 * Spawns Claude Code CLI on the host (using Max subscription) instead of a container.
 * Used for scheduled tasks to avoid API credit costs.
 *
 * CRITICAL: All CLI spawns go through ensureFreshToken() which uses a file lock
 * to prevent concurrent OAuth token refresh. Without this, two simultaneous
 * `claude` processes can race on ~/.claude/.credentials.json and kill the
 * refresh token via OAuth2 rotation — causing daily auth death.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CLI_MCP_CONFIG,
  CLI_MODEL,
  CLI_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { readEnvFile } from './env.js';
import { audit, logger } from './logger.js';

// ── Token freshness gate ─────────────────────────────────────────
// Ensures the OAuth access token is fresh BEFORE spawning a CLI process.
// If the token is expired, acquires a lock and refreshes it so that only
// ONE process hits the OAuth server. All other callers wait for the lock.

const TOKEN_LOCK_PATH = path.join(DATA_DIR, '.cli-token-refresh.lock');
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

function getCredentialsPath(): string {
  const home = process.env.HOME || require('os').homedir();
  return path.join(home, '.claude', '.credentials.json');
}

function isTokenFresh(): boolean {
  try {
    const creds = JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf-8'));
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return false;
    if (!oauth.expiresAt) return true; // No expiry info, assume fresh
    return oauth.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive file lock for token refresh.
 * Returns true if we acquired the lock, false if another process holds it.
 */
function acquireRefreshLock(): boolean {
  try {
    // Use exclusive file creation — fails if file already exists
    fs.writeFileSync(TOKEN_LOCK_PATH, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // Lock file exists — check if the holding process is still alive
    try {
      const lockPid = parseInt(fs.readFileSync(TOKEN_LOCK_PATH, 'utf-8').trim());
      if (lockPid === process.pid) return true; // We hold it
      // Check if lock is stale (>2 min old) — holder might have crashed
      const stat = fs.statSync(TOKEN_LOCK_PATH);
      if (Date.now() - stat.mtimeMs > 120_000) {
        fs.unlinkSync(TOKEN_LOCK_PATH);
        fs.writeFileSync(TOKEN_LOCK_PATH, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch { /* lock race — another process grabbed it */ }
    return false;
  }
}

function releaseRefreshLock(): void {
  try { fs.unlinkSync(TOKEN_LOCK_PATH); } catch { /* already gone */ }
}

/**
 * Ensure the OAuth access token is fresh before spawning a CLI process.
 * If expired, acquires a lock and runs `claude -p ping` to trigger refresh.
 * Other callers wait (polling) until the refresh completes.
 */
async function ensureFreshToken(): Promise<void> {
  if (isTokenFresh()) return;

  if (acquireRefreshLock()) {
    // We hold the lock — do the refresh
    try {
      logger.info('CLI token expired — refreshing (lock acquired)');
      await new Promise<void>((resolve) => {
        const proc = spawn('claude', ['-p', 'ping', '--max-turns', '1', '--output-format', 'json'], {
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.stdin?.end();
        proc.on('close', (code) => {
          if (code === 0 && isTokenFresh()) {
            logger.info('CLI token refresh succeeded');
          } else {
            logger.warn({ code }, 'CLI token refresh failed');
          }
          resolve();
        });
        proc.on('error', () => {
          logger.warn('CLI token refresh spawn error');
          resolve();
        });
      });
    } finally {
      releaseRefreshLock();
    }
  } else {
    // Another process is refreshing — wait for it (up to 90s)
    logger.debug('Waiting for another process to refresh CLI token...');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (isTokenFresh()) {
        logger.debug('CLI token refreshed by another process');
        return;
      }
      // Check if lock is gone (refresh finished but token still bad)
      try { fs.statSync(TOKEN_LOCK_PATH); } catch {
        break; // Lock released, token might still be bad but we tried
      }
    }
  }
}

const PROJECT_ROOT = process.cwd();

// Reuse secret scoping from container-runner (same logic, keep in sync)
const SECRETS_CORE = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
const SECRETS_GOOGLE = [
  'GOOGLE_SERVICE_ACCOUNT_KEY',
  'GOOGLE_SPREADSHEET_ID',
  'GOOGLE_CALENDAR_ID',
  'GMAIL_USER_EMAIL',
] as const;
const SECRETS_EMAIL = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
] as const;
const SECRETS_SQUARE = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_LOCATION_ID',
  'SQUARE_ENVIRONMENT',
  'SHERIDAN_SPREADSHEET_ID',
] as const;
const SECRETS_SOCIAL = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
  'FB_PAGE_ID',
  'FB_PAGE_ACCESS_TOKEN',
  'LINKEDIN_ACCESS_TOKEN',
  'LINKEDIN_PERSON_URN',
] as const;
const SECRETS_IDDI = [
  'IDDI_BASE_URL',
  'IDDI_EMAIL',
  'IDDI_PASSWORD',
] as const;
const SECRETS_LEADS = ['GOOGLE_MAPS_API_KEY', 'INSTANTLY_API_KEY'] as const;

const ALL_SECRET_KEYS = [
  ...SECRETS_CORE,
  ...SECRETS_EMAIL,
  ...SECRETS_SOCIAL,
  ...SECRETS_GOOGLE,
  ...SECRETS_LEADS,
  ...SECRETS_IDDI,
  ...SECRETS_SQUARE,
] as const;

const STANDARD_SECRET_KEYS = [
  ...SECRETS_CORE,
  ...SECRETS_GOOGLE,
  ...SECRETS_EMAIL,
  ...SECRETS_SQUARE,
] as const;

const SCOPE_MAP: Record<string, readonly string[]> = {
  social: SECRETS_SOCIAL,
  iddi: SECRETS_IDDI,
  leads: SECRETS_LEADS,
};

function readSecrets(
  isMain: boolean,
  extraScopes?: string[],
  secretOverrides?: Record<string, string>,
): Record<string, string> {
  if (isMain) return readEnvFile([...ALL_SECRET_KEYS]);
  const keys: string[] = [...STANDARD_SECRET_KEYS];
  if (extraScopes) {
    for (const scope of extraScopes) {
      const scopeKeys = SCOPE_MAP[scope];
      if (scopeKeys) keys.push(...scopeKeys);
    }
  }
  const secrets = readEnvFile(keys);

  // Apply per-group secret overrides: read group-specific env var, inject as standard name
  if (secretOverrides) {
    const overrideKeys = Object.values(secretOverrides);
    const overrideValues = readEnvFile(overrideKeys);
    for (const [standardKey, groupKey] of Object.entries(secretOverrides)) {
      if (overrideValues[groupKey]) {
        secrets[standardKey] = overrideValues[groupKey];
      }
    }
  }

  return secrets;
}

export interface CliInput {
  prompt: string;
  groupFolder: string;
  isMain: boolean;
  model?: string;
  extraSecretScopes?: string[];
  secretOverrides?: Record<string, string>;
}

export interface CliOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

// Tools allowed for CLI runs (full tool access for scheduled tasks)
const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'mcp__playwright__*',
].join(',');

// Interactive CLI runs also get nanoclaw MCP tools (send_message, schedule_task, etc.)
const ALLOWED_TOOLS_INTERACTIVE = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'mcp__playwright__*',
  'mcp__nanoclaw__*',
].join(',');

/**
 * Sync skills from container/skills/ into a .claude/skills/ directory for the CLI agent.
 * Rewrites container paths (/workspace/project/, /workspace/group/) to host paths.
 */
/** Validate that a group folder name is safe (no path traversal). */
function validateGroupFolder(folder: string): void {
  if (
    folder.includes('..') ||
    folder.includes('/') ||
    folder.includes('\\') ||
    path.isAbsolute(folder) ||
    folder !== path.basename(folder)
  ) {
    throw new Error(`Invalid group folder name: ${folder}`);
  }
}

/**
 * Sync skills from container/skills/ into .claude/skills/ under the CLI agent's cwd.
 * Rewrites container paths to host paths. For skills that use agent-browser,
 * strips the browser-specific command blocks and replaces with Playwright MCP guidance,
 * since the CLI agent uses Playwright MCP (not agent-browser).
 */
function syncSkillsForCli(groupFolder: string, cwd: string): void {
  const skillsSrc = path.join(PROJECT_ROOT, 'container', 'skills');
  if (!fs.existsSync(skillsSrc)) return;

  const groupDir = path.join(GROUPS_DIR, groupFolder);
  // Place skills in {cwd}/.claude/skills/ so Claude Code discovers them
  const skillsDst = path.join(cwd, '.claude', 'skills');

  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;

    // Skip agent-browser skill — CLI uses Playwright MCP instead
    if (skillDir === 'agent-browser') continue;

    const dstDir = path.join(skillsDst, skillDir);
    fs.mkdirSync(dstDir, { recursive: true });

    for (const file of fs.readdirSync(srcDir)) {
      const srcFile = path.join(srcDir, file);
      let content = fs.readFileSync(srcFile, 'utf-8');

      // Rewrite container paths to host paths
      content = content.replace(/\/workspace\/project/g, PROJECT_ROOT);
      content = content.replace(/\/workspace\/group/g, groupDir);

      // Replace allowed-tools frontmatter references
      content = content.replace(
        /Bash\(agent-browser:\*\)/g,
        'mcp__playwright__*',
      );

      // Replace agent-browser command blocks with Playwright MCP equivalents.
      // Rather than garbling individual commands, replace entire bash blocks
      // that use agent-browser with a Playwright MCP note.
      content = content.replace(
        /```bash\n((?:.*agent-browser.*\n)+)```/g,
        '```\n# Use Playwright MCP tools instead:\n# browser_navigate, browser_snapshot, browser_click, browser_type,\n# browser_wait_for_text, browser_close, etc.\n```',
      );

      // Replace any remaining inline agent-browser references
      content = content.replace(
        /`agent-browser\b[^`]*`/g,
        '`Playwright MCP tool`',
      );
      content = content.replace(
        /\bagent-browser\b/g,
        'Playwright MCP',
      );

      fs.writeFileSync(path.join(dstDir, file), content);
    }
  }

  // Write settings.json with env vars matching container-runner
  const settingsDir = path.join(cwd, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }
}

/** System prompt appended to CLI runs explaining the host environment. */
function buildSystemPrompt(groupFolder: string): string {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  return [
    'You are running on the HOST machine via Claude Code CLI (not in a Docker container).',
    'Key differences from the container environment:',
    '',
    '## Tool Paths',
    `- Project root: ${PROJECT_ROOT}`,
    `- Group directory: ${groupDir}`,
    `- Tools are at: ${PROJECT_ROOT}/tools/ (run with: npx tsx ${PROJECT_ROOT}/tools/...)`,
    '',
    '## Browser Automation',
    'You have Playwright MCP tools available (mcp__playwright__* tools).',
    'Use these for ALL browser automation (logging into IDDI, HahaVending, Vendera, etc.).',
    'Do NOT try to use agent-browser — it does not exist on the host.',
    'Playwright MCP provides tools like: browser_navigate, browser_click, browser_fill, browser_snapshot, browser_wait_for_text, etc.',
    '',
    '## Channel Awareness',
    'The prompt includes a `<channel>` tag indicating which channel this message arrived on (sms, whatsapp, web, messenger, email).',
    'Use the channel tag to select the correct formatting rules from your CLAUDE.md "Message Formatting" section.',
    '',
    '## Sending Messages',
    'You cannot send messages directly. Instead, write your final output as your response.',
    'The NanoClaw scheduler will relay your output to the appropriate channel.',
    '',
    '## IPC',
    `IPC directory: ${path.join(DATA_DIR, 'ipc', groupFolder)}`,
    'Write files here if you need to communicate structured data back to NanoClaw.',
  ].join('\n');
}

/**
 * Spawns `claude` CLI on the host using the Max subscription.
 * Returns structured output parsed from --output-format json.
 */
export async function runCliAgent(
  input: CliInput,
  onProcess?: (proc: ChildProcess) => void,
): Promise<CliOutput> {
  const startTime = Date.now();

  // Ensure OAuth token is fresh BEFORE spawning — prevents concurrent refresh race
  await ensureFreshToken();

  // Validate group folder to prevent path traversal
  validateGroupFolder(input.groupFolder);

  const groupDir = path.join(GROUPS_DIR, input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const model = input.model || CLI_MODEL;

  logger.info(
    { group: input.groupFolder, model },
    'Spawning CLI agent (Max subscription)',
  );
  audit('cli_spawn', { group: input.groupFolder, model });

  // Set cwd to the group's directory so Claude Code picks up its CLAUDE.md
  const cwd = input.isMain ? PROJECT_ROOT : groupDir;

  // Sync skills into {cwd}/.claude/skills/ so Claude Code discovers them
  syncSkillsForCli(input.groupFolder, cwd);

  // Build the prompt with group context
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  let fullPrompt = input.prompt;
  if (fs.existsSync(claudeMdPath)) {
    const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    fullPrompt = `<group-context>\n${claudeMd}\n</group-context>\n\n${input.prompt}`;
  }

  // Read secrets scoped to the group
  const secrets = readSecrets(input.isMain, input.extraSecretScopes, input.secretOverrides);

  // Build system prompt explaining host environment
  const systemPrompt = buildSystemPrompt(input.groupFolder);

  // Build CLI args
  const args = [
    '-p', fullPrompt,
    '--output-format', 'json',
    '--model', model,
    '--allowedTools', ALLOWED_TOOLS,
    '--append-system-prompt', systemPrompt,
    '--dangerously-skip-permissions',
  ];

  // Add MCP config if the file exists
  if (fs.existsSync(CLI_MCP_CONFIG)) {
    args.push('--mcp-config', CLI_MCP_CONFIG);
  }

  // Build environment: inherit current env + add scoped secrets
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const [key, value] of Object.entries(secrets)) {
    env[key] = value;
  }

  // Remove API auth keys so the CLI uses its own OAuth credentials
  // from ~/.claude/.credentials.json (Max subscription, free) instead of
  // the API key (credits) or a stale OAuth token from .env.
  // This matches the interactive runner's behavior (line 673-674).
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  // Ensure logs directory exists
  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (onProcess) onProcess(proc);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exited = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: input.groupFolder },
        `CLI agent timeout after ${CLI_TIMEOUT}ms`,
      );
      audit('cli_timeout', { group: input.groupFolder });
      proc.kill('SIGTERM');
      // Force kill after 15s if process hasn't exited
      setTimeout(() => {
        if (!exited) {
          logger.warn({ group: input.groupFolder }, 'SIGTERM failed, force killing');
          proc.kill('SIGKILL');
        }
      }, 15000);
    }, CLI_TIMEOUT);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log stderr lines at debug level
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ cli: input.groupFolder }, line);
      }
    });

    proc.on('close', (code) => {
      exited = true;
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `cli-${timestamp}.log`);
      const logLines = [
        `=== CLI Agent Run Log${timedOut ? ' (TIMEOUT)' : ''} ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${input.groupFolder}`,
        `Model: ${model}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Timed Out: ${timedOut}`,
        ``,
      ];

      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      if (isVerbose || code !== 0) {
        logLines.push(
          `=== Prompt ===`,
          input.prompt.slice(0, 2000),
          ``,
          `=== Stderr ===`,
          stderr.slice(-5000),
          ``,
          `=== Stdout ===`,
          stdout.slice(-5000),
        );
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (timedOut) {
        resolve({
          status: 'error',
          result: null,
          error: `CLI agent timed out after ${CLI_TIMEOUT}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: input.groupFolder, code, duration },
          'CLI agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `CLI agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Parse JSON output from claude --output-format json
      // The CLI returns an array of content blocks:
      // [{"type":"text","text":"..."}, {"type":"result","result":"final answer","subtype":"text"}]
      try {
        const output = JSON.parse(stdout);
        let resultText: string | null = null;

        if (Array.isArray(output)) {
          // Find the last block with type === 'result'
          const resultBlock = [...output].reverse().find(
            (b: { type?: string }) => b.type === 'result',
          );
          if (resultBlock?.result) {
            resultText = resultBlock.result;
          } else {
            // Fallback: concatenate all text blocks
            resultText = output
              .filter((b: { type?: string }) => b.type === 'text')
              .map((b: { text?: string }) => b.text)
              .join('\n')
              .trim() || null;
          }
        } else if (typeof output === 'object' && output.result) {
          resultText = output.result;
        } else if (typeof output === 'string') {
          resultText = output;
        }

        logger.info(
          { group: input.groupFolder, duration, hasResult: !!resultText },
          'CLI agent completed',
        );

        resolve({
          status: 'success',
          result: resultText,
        });
      } catch (err) {
        // JSON parsing failed — likely a crash or partial output
        const raw = stdout.trim();
        if (raw) {
          logger.warn(
            { group: input.groupFolder, error: err },
            'Failed to parse CLI JSON output, using raw stdout',
          );
          resolve({ status: 'success', result: raw });
        } else {
          // Empty stdout + unparseable = the CLI crashed or produced nothing
          logger.error(
            { group: input.groupFolder, error: err, stderrTail: stderr.slice(-200) },
            'CLI produced no parseable output — treating as error',
          );
          resolve({
            status: 'error',
            result: null,
            error: `CLI produced no output: ${stderr.slice(-200) || 'unknown error'}`,
          });
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: input.groupFolder, error: err },
        'CLI agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `CLI agent spawn error: ${err.message}`,
      });
    });

    // Close stdin immediately — prompt is passed via -p flag
    proc.stdin.end();
  });
}

// ── Interactive CLI Runner ─────────────────────────────────────────

export interface CliInteractiveInput extends CliInput {
  chatJid: string;
  sessionId?: string;
}

export interface CliInteractiveOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Build a per-invocation MCP config JSON that includes the nanoclaw MCP server
 * with host-appropriate paths and env vars.
 */
function buildInteractiveMcpConfig(
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
): string {
  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  const mcpServerScript = path.join(PROJECT_ROOT, 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts');

  // Merge with existing cowork-mcp.json (playwright etc.)
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(CLI_MCP_CONFIG)) {
    try {
      existing = JSON.parse(fs.readFileSync(CLI_MCP_CONFIG, 'utf-8'));
    } catch { /* ignore */ }
  }

  const config = {
    mcpServers: {
      ...(existing as { mcpServers?: Record<string, unknown> }).mcpServers || {},
      nanoclaw: {
        command: 'node',
        args: ['--import', 'tsx/esm', mcpServerScript],
        env: {
          NANOCLAW_CHAT_JID: chatJid,
          NANOCLAW_GROUP_FOLDER: groupFolder,
          NANOCLAW_IS_MAIN: isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: ipcDir,
        },
      },
    },
  };

  // Write to a temp file
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `mcp-${groupFolder}-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
  return tmpFile;
}

/**
 * Run an interactive message through the CLI (Max subscription, free).
 * The nanoclaw MCP server handles send_message via IPC files,
 * which the host's IPC watcher forwards to WhatsApp in real-time.
 * The final result (if any) is returned for the caller to forward.
 */
export async function runCliInteractive(
  input: CliInteractiveInput,
  onProcess?: (proc: ChildProcess) => void,
): Promise<CliInteractiveOutput> {
  const startTime = Date.now();

  // Ensure OAuth token is fresh BEFORE spawning — prevents concurrent refresh race
  await ensureFreshToken();

  validateGroupFolder(input.groupFolder);

  const groupDir = path.join(GROUPS_DIR, input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const model = input.model || CLI_MODEL;
  const isMain = input.isMain;

  logger.info(
    { group: input.groupFolder, model, mode: 'interactive' },
    'Spawning interactive CLI agent (Max subscription)',
  );
  audit('cli_interactive_spawn', { group: input.groupFolder, model });

  const cwd = isMain ? PROJECT_ROOT : groupDir;
  syncSkillsForCli(input.groupFolder, cwd);

  // Build the prompt with group context
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  let fullPrompt = input.prompt;
  if (fs.existsSync(claudeMdPath)) {
    const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    fullPrompt = `<group-context>\n${claudeMd}\n</group-context>\n\n${input.prompt}`;
  }

  const secrets = readSecrets(isMain, input.extraSecretScopes, input.secretOverrides);
  const systemPrompt = buildSystemPrompt(input.groupFolder);

  // Build MCP config with nanoclaw server
  const mcpConfigFile = buildInteractiveMcpConfig(input.chatJid, input.groupFolder, isMain);

  // Ensure IPC directories exist (for nanoclaw MCP server)
  const groupIpcDir = path.join(DATA_DIR, 'ipc', input.groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });

  // Pass prompt via stdin to avoid E2BIG when CLAUDE.md + history exceeds
  // the OS argument size limit (~128KB on Linux).
  const useStdinPrompt = Buffer.byteLength(fullPrompt) > 80000;

  const args = [
    ...(useStdinPrompt ? ['-p', '-'] : ['-p', fullPrompt]),
    '--output-format', 'json',
    '--model', model,
    '--allowedTools', ALLOWED_TOOLS_INTERACTIVE,
    '--append-system-prompt', systemPrompt,
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfigFile,
  ];

  // NOTE: Do NOT pass --resume with container session IDs.
  // CLI and container sessions are incompatible (different environments).
  // Each CLI invocation starts fresh. Conversation context is maintained
  // via the CLAUDE.md memory system and workspace files.

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const [key, value] of Object.entries(secrets)) {
    env[key] = value;
  }
  // CRITICAL: Remove API auth keys so the CLI uses its own OAuth credentials
  // from ~/.claude/.credentials.json (Max subscription, free) instead of
  // the API key (credits) or a stale OAuth token from .env.
  // Tool-specific secrets (Google, SMTP, etc.) are kept for MCP tools.
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (onProcess) onProcess(proc);

    // Write prompt via stdin if too large for argv
    if (useStdinPrompt && proc.stdin) {
      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exited = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: input.groupFolder, mode: 'interactive' },
        `Interactive CLI timeout after ${CLI_TIMEOUT}ms`,
      );
      audit('cli_interactive_timeout', { group: input.groupFolder });
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!exited) proc.kill('SIGKILL');
      }, 15000);
    }, CLI_TIMEOUT);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ cli: input.groupFolder, mode: 'interactive' }, line);
      }
    });

    proc.on('close', (code) => {
      exited = true;
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Clean up temp MCP config
      try { fs.unlinkSync(mcpConfigFile); } catch { /* ignore */ }

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `cli-interactive-${timestamp}.log`);
      const logLines = [
        `=== Interactive CLI Run Log${timedOut ? ' (TIMEOUT)' : ''} ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${input.groupFolder}`,
        `Model: ${model}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Session: ${input.sessionId || 'new'}`,
        ``,
      ];
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      if (isVerbose || code !== 0) {
        logLines.push(
          `=== Prompt ===`, input.prompt.slice(0, 2000), ``,
          `=== Stderr ===`, stderr.slice(-5000), ``,
          `=== Stdout ===`, stdout.slice(-5000),
        );
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (timedOut) {
        resolve({ status: 'error', result: null, error: `CLI interactive timed out after ${CLI_TIMEOUT}ms` });
        return;
      }

      if (code !== 0) {
        logger.error({ group: input.groupFolder, code, duration, mode: 'interactive' }, 'Interactive CLI exited with error');
        resolve({ status: 'error', result: null, error: `CLI exited with code ${code}: ${stderr.slice(-200)}` });
        return;
      }

      // Parse output — extract result and session ID
      try {
        const output = JSON.parse(stdout);
        let resultText: string | null = null;
        let newSessionId: string | undefined;

        if (Array.isArray(output)) {
          // Extract session ID from init message if present
          const initBlock = output.find((b: { type?: string }) => b.type === 'system' && (b as { subtype?: string }).subtype === 'init');
          if (initBlock && 'session_id' in initBlock) {
            newSessionId = (initBlock as { session_id: string }).session_id;
          }

          const resultBlock = [...output].reverse().find((b: { type?: string }) => b.type === 'result');
          if (resultBlock?.result) {
            resultText = resultBlock.result;
          } else {
            resultText = output
              .filter((b: { type?: string }) => b.type === 'text')
              .map((b: { text?: string }) => b.text)
              .join('\n')
              .trim() || null;
          }
        } else if (typeof output === 'object' && output.result) {
          resultText = output.result;
          newSessionId = output.session_id;
        }

        logger.info(
          { group: input.groupFolder, duration, hasResult: !!resultText, newSessionId, mode: 'interactive' },
          'Interactive CLI completed',
        );

        resolve({ status: 'success', result: resultText, newSessionId });
      } catch (err) {
        const raw = stdout.trim();
        if (raw) {
          logger.warn({ group: input.groupFolder, error: err, mode: 'interactive' }, 'Failed to parse interactive CLI output, using raw');
          resolve({ status: 'success', result: raw });
        } else {
          logger.error({ group: input.groupFolder, error: err, mode: 'interactive' }, 'Interactive CLI produced no output');
          resolve({ status: 'error', result: null, error: `CLI produced no output: ${stderr.slice(-200) || 'unknown error'}` });
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: input.groupFolder, error: err, mode: 'interactive' }, 'Interactive CLI spawn error');
      // Clean up temp MCP config
      try { fs.unlinkSync(mcpConfigFile); } catch { /* ignore */ }
      resolve({ status: 'error', result: null, error: `CLI spawn error: ${err.message}` });
    });

    proc.stdin.end();
  });
}
