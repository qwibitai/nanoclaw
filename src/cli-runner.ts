/**
 * CLI Runner for NanoClaw
 * Spawns Claude Code CLI on the host (using Max subscription) instead of a container.
 * Used for scheduled tasks to avoid API credit costs.
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
} from './config.js';
import { readEnvFile } from './env.js';
import { audit, logger } from './logger.js';

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
    '## Sending Messages',
    'You cannot send WhatsApp messages directly. Instead, write your final output as your response.',
    'The NanoClaw scheduler will relay your output to the appropriate WhatsApp group.',
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
        // If JSON parsing fails, use raw stdout as result
        logger.warn(
          { group: input.groupFolder, error: err },
          'Failed to parse CLI JSON output, using raw stdout',
        );
        resolve({
          status: 'success',
          result: stdout.trim() || null,
        });
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
