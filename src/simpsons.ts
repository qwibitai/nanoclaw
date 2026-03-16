import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const PROJECTS_DIR = path.join(os.homedir(), 'Projects');
const DELIMITER = '<!-- ====== PROJECT SPECIFIC ====== -->';
const SIMPSONS_DIR = path.join(DATA_DIR, 'simpsons');
const STATE_FILE = path.join(DATA_DIR, 'simpsons', 'sessions.json');
const TRUST_CHECK_DELAY = 60_000; // 60 seconds
const POLL_INTERVAL = 5 * 60_000; // 5 minutes
const STATUS_INTERVAL = 15 * 60_000; // 15 minutes

const COMMAND_MAP: Record<string, string> = {
  specify: '/speckit.specify',
  pipeline: '/speckit.pipeline',
  implement: '/speckit.ralph.implement',
  ralph: '/speckit.ralph.implement',
  clarify: '/speckit.homer.clarify',
  homer: '/speckit.homer.clarify',
  analyze: '/speckit.lisa.analyze',
  lisa: '/speckit.lisa.analyze',
};

// prettier-ignore
const GLOBAL_CLAUDE_MD = `# Development Guidelines

## Code Principles

- **Readability first** — clean, human-readable code with meaningful variable names. Clarity over brevity.
- **Functional design** — services take inputs, yield deterministic outputs. No hidden side effects.
- **Maintainability over cleverness** — no premature optimizations. Code must be maintainable by developers who didn't write it.
- **Simplicity (KISS & YAGNI)** — build only what's needed. Prefer simpler solutions that can be validated before investing in sophisticated alternatives.
- **Follow best practices** — established conventions for the languages, frameworks, and packages in use. Community standards over novel approaches.

## Test-First Development

Unit tests for new logic MUST be written before the implementation code:

1. Write the test
2. Run it — verify it **fails**
3. Write the minimum implementation to make it pass

Applies to: new service functions, business logic, hooks, utilities, and bug fixes (reproduce the bug in a test r proceed with failing tests.

## Quality Gates

All changes must pass before committing:

- All tests pass
- Linting passes with zero errors
- Type checking passes with zero errors (typed languages)

## Git Discipline

- **Never push without explicit permission** — commits are fine, pushing is gated
- Commit format: \`type(scope): [ticket] description\`
- One logical change per commit
- Branch naming follows spec directory: \`XXXX-type-description\` where type is \`feat\`, \`fix\`, or \`chore\`

## Process Hygiene

Cleanup is mandatory. Every process started during a session must be stopped before the session ends. A session that completes but leaves orphaned processes is **incomplete**.

- **Dev servers**: before starting one, check if one is already running (\`pgrep -f "vite\\|webpack-dev-server\\|next dev\\|rails s"\`). Reuse it — never start a duplicate.
- **Docker**: any container started during this session MUST be stopped and removed before finishing. Use \`docker stop <id> && docker rm <id>\`, or \`docker composwn\`. Never leave containers running.
- **Watchers, file observers, background build processes**: stop all of them when done.
- **Verification step**: before marking work complete, run \`ps aux | grep <project-pattern>\` to confirm nothing from this session is still running.
- Verify UI and integration work against the running application. Unit tests alone are insufficient.

## Speckit

- Constitution at \`.specify/memory/constitution.md\` is **authoritative** — never modify it during implementation
- Adjust spec, plan, or tasks instead
- **Homer (clarify)** → fix one finding per iteration, loop until \`ALL_FINDINGS_RESOLVED\`
- **Lisa (analyze)** → fix one finding per iteration, loop until \`ALL_FINDINGS_RESOLVED\`
- **Ralph (implement)** → implement one task per iteration, loop until \`ALL_TASKS_COMPLETE\`
- Exit after each iteration — restart with fresh context

${DELIMITER}

<!-- Add project-specific guidelines below (technologies, commands, structure, etc.) -->`;

// prettier-ignore
const GLOBAL_CONSTITUTION = `# Constitution

## Core Principles

### I. Readability First

Code MUST be clean and human-readable with meaningful variable names. Descriptive
names that convey intent are required. Clarity MUST be prioritized over brevity.

**Rationale**: Readable code reduces cognitive load, speeds up onboarding, and
minimizes bugs caused by misunderstanding.

### II. Functional Design

Services MUST take inputs and yield deterministic outputs. Business logic functions
MUST NOT create side effects. Given the same inputs, functions MUST produce the
same results.

**Rationale**: Pure functions are easier to test, reason about, and compose. They
enable confident refactoring and reduce hidden dependencies.

### III. Maintainability Over Cleverness

The codebase values longevity over clever code. Premature optimizations are
prohibited. Code MUST be maintainable by future developers who did not write it.

**Rationale**: Clever code impresses once but costs repeatedly. Maintainable code
enables sustainable development velocity over the project lifetime.

### IV. Best Practices

All code MUST follow established conventions for the languages, frameworks, and
packages in use. Community standards and idioms MUST be adhered to. Proven patterns
SHOULD be leveraged over novel approaches.

**Rationale**: Best practices encode collective wisdom. Following them reduces
surprises and enables developers to apply existing knowledge.

### V. Simplicity (KISS & YAGNI)

Implementations MUST be kept simple and straightforward. Features MUST NOT be
built until needed. Simpler solutions that can be validated MUST be preferred
before investing in sophisticated alternatives.

**Rationale**: Complexity is the enemy of reliability. Simple solutions are faster
to build, easier to verify, and cheaper to change.

## Development Standards

### Spec & Branch Naming Convention

All specification directories and their corresponding Git branches MUST follow
the naming pattern:

\`\`\`
XXXX-type-description
\`\`\`

Where:

- \`XXXX\` is a 4-character alphanumeric ID derived from the last 4 characters of a UUID
- \`type\` is **MANDATORY** and MUST be one of: \`feat\` (new feature), \`fix\` (bug fix), or \`chore\` (maintenance/refactor)
- \`description\` is a kebab-case summary of the spec purpose

**The type segment is NEVER optional.** Omitting the type violates this convention.

**Git Branch Rule**: The Git branch name MUST exactly match the spec directory name.

### Test-First Development

Unit tests for new logic MUST be written before the implementation code. Tests MUST
be executed and verified to FAIL before implementation begins. The implementation is
then written to make the failing tests pass.

This applies to:

- New service functions and business logic
- New hooks and utilities
- Bug fixes (write a test that reproduces the bug, verify it fails, then fix)

**Rationale**: Writing tests first proves they validate the intended behavior and
prevents false-positive test suites. It drives minimal, focused implementations and
provides immediate feedback during development.

### Dev Server Verification

When implementing features that involve web UI or API changes, the development
server MUST be used for implementation verification:

1. **Pre-check**: Check whether a dev server is already running. Reuse it — do NOT
   start a duplicate.
2. **Startup**: If none is running, start it before implementation work requiring
   verification.
3. **Verification**: Implemented features MUST be verified against the running dev
   server. Unit tests alone are insufficient for UI and integration work.
4. **Cleanup**: Stop any dev server processes started during the session when
   implementation is complete.
5. **Process hygiene**: Do NOT leave straggling processes (dev servers, watchers,
   child processes) in the background.

**Rationale**: Verifying against the running application catches integration
issues that unit tests miss. Enforcing cleanup prevents resource leaks and port
conflicts.

### Process Cleanup (Mandatory)

**Every process started during a session MUST be stopped when e session ends.**
This is a hard rule with no exceptions — not for happy paths, not for error paths,
not for "I'll clean it up later."

Scope: dev servers, test watchers, Docker containers, background build processes,
file watchers, any subprocess spawned for the task.

**Docker**: any \`docker run\` or \`docker compose up\` invocation MUST be paired with
cleanup before the session completes:

\`\`\`bash
docker stop <id> && docker rm <id>
# or
docker compose down
\`\`\`

Never leave containers running after work is done. \`docker ps\` MUST be clean.

**Verification**: Before declaring work complete, confirm cleanup:

\`\`\`bash
ps aux | grep <project-pattern>   # no straggling processes
docker ps                          # no running containers from this session
\`\`\`

**Failure to clean up is a constitution violation** equivalent to leaving failing
tests. It degrades the environment for future sessions and causes the exact resource
leak and port conflict problems this constitution is designed to prevent.

**Rationale**: phaned processes accumulate silently — they waste memory, hold
ports, and cause confusing interference in future sessions. Mandatory cleanup keeps
the environment predictable and the host machine healthy.

## Quality Gates

All code changes MUST pass the following gates before merge:

- All tests MUST pass
- Linting MUST pass with zero errors
- Type checking MUST pass with zero errors (typed languages)

## Governance

This constitution supersedes ad-hoc practices and informal conventions. All
development decisions SHOULD align with the principles defined herein.

**Amendment Process**:

1. Propose amendment with documented rationale
2. Review impact on existing code and workflows
3. Update constitution with appropriate version bump:
   - MAJOR: Backward-incompatible principle changes or removals
   - MINOR: New principles or materially expanded guidance
   - PATCH: Clarifications, wording fixes, non-semantic refinements
4. Propagate changes to dependent templates and documentation

**Compliance**: All pulrequests and code reviews MUST verify alignment with
constitutional principles. Violations require justification or remediation.

**Evolution**: This constitution will evolve as the project matures. Principles
may be added, refined, or deprecated based on project needs and lessons learned.

${DELIMITER}

<!-- Add project-specific standards below (language tooling, formatting, lint rules, etc.) -->`;

export function getAvailableCommands(): string[] {
  return Object.keys(COMMAND_MAP);
}

// ---------------------------------------------------------------------------
// Session state persistence (survives NanoClaw restarts)
// ---------------------------------------------------------------------------

interface PersistedSession {
  sessionName: string;
  project: string;
  command: string;
  chatJid: string;
  startedAt: string; // ISO timestamp
  outputFile: string;
  doneFile: string;
  scriptFile: string;
}

function persistState(): void {
  const entries: PersistedSession[] = [];
  for (const s of activeSessions.values()) {
    entries.push({
      sessionName: s.session.name,
      project: s.project,
      command: s.command,
      chatJid: s.chatJid,
      startedAt: s.startedAt.toISOString(),
      outputFile: s.session.outputFile,
      doneFile: s.session.doneFile,
      scriptFile: s.session.scriptFile,
    });
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function loadPersistedState(): PersistedSession[] {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function tmuxSessionAlive(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore simpsons sessions after a NanoClaw restart.
 * - Live tmux sessions get re-attached to polling + status reporting.
 * - Dead sessions are pruned and reported.
 */
export function restoreSimpsons(
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  const persisted = loadPersistedState();
  if (persisted.length === 0) return;

  const alive: PersistedSession[] = [];
  const dead: PersistedSession[] = [];

  for (const p of persisted) {
    if (tmuxSessionAlive(p.sessionName)) {
      alive.push(p);
    } else {
      dead.push(p);
    }
  }

  // Re-attach live sessions to polling
  for (const p of alive) {
    const session: SimpsonsSession = {
      name: p.sessionName,
      outputFile: p.outputFile,
      doneFile: p.doneFile,
      scriptFile: p.scriptFile,
    };

    const active: ActiveSession = {
      session,
      project: p.project,
      command: p.command,
      chatJid: p.chatJid,
      startedAt: new Date(p.startedAt),
    };

    activeSessions.set(p.sessionName, active);

    // Re-start async polling for this session (fire-and-forget)
    pollAndFinalize(session, p.project, p.command, p.chatJid, sendMessage);
  }

  if (alive.length > 0) {
    ensureStatusReporter(sendMessage);
    logger.info(
      { count: alive.length, sessions: alive.map((s) => s.sessionName) },
      'Restored simpsons sessions after restart',
    );
  }

  // Clean up dead sessions and notify
  if (dead.length > 0) {
    const deadNames = dead.map((s) => `${s.project} (${s.command})`);
    logger.info(
      { count: dead.length, sessions: dead.map((s) => s.sessionName) },
      'Cleaned up dead simpsons sessions',
    );

    // Group dead sessions by chatJid and notify
    const byChat = new Map<string, string[]>();
    for (const d of dead) {
      const list = byChat.get(d.chatJid) || [];
      list.push(`${d.project} (${d.command})`);
      byChat.set(d.chatJid, list);
    }
    for (const [chatJid, names] of byChat) {
      sendMessage(
        chatJid,
        `Simpsons sessions ended while NanoClaw was down:\n${names.map((n) => `• ${n}`).join('\n')}`,
      ).catch(() => {});
    }
  }

  // Persist the cleaned-up state
  if (dead.length > 0) {
    persistState();
  }
}

/**
 * Poll a restored session to completion, then finalize.
 */
function pollAndFinalize(
  session: SimpsonsSession,
  project: string,
  command: string,
  chatJid: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  pollForCompletion(session)
    .then(async (result) => {
      const maxLen = 4000;
      const output =
        result.length > maxLen
          ? result.slice(0, maxLen) + '\n... (output truncated)'
          : result;
      await sendMessage(
        chatJid,
        `Simpsons ${command} on ${project} complete:\n\n${output}`,
      );
    })
    .catch(async (err) => {
      logger.error({ err, project, command }, 'Restored simpsons session failed');
      await sendMessage(
        chatJid,
        `Simpsons ${command} on ${project} failed: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    })
    .finally(() => {
      activeSessions.delete(session.name);
      persistState();
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Sanitize a string for use as a tmux session name.
 * tmux session names cannot contain dots or colons.
 */
function sanitizeSessionName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-');
}

// ---------------------------------------------------------------------------
// Active session tracking & periodic status reporter
// ---------------------------------------------------------------------------

interface ActiveSession {
  session: SimpsonsSession;
  project: string;
  command: string;
  chatJid: string;
  startedAt: Date;
}

const activeSessions = new Map<string, ActiveSession>();
let statusTimer: ReturnType<typeof setInterval> | null = null;
let statusSendMessage: ((jid: string, text: string) => Promise<void>) | null =
  null;

function ensureStatusReporter(
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  statusSendMessage = sendMessage;
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    reportStatus().catch((err) =>
      logger.error({ err }, 'Simpsons status report failed'),
    );
  }, STATUS_INTERVAL);
}

async function reportStatus(): Promise<void> {
  if (activeSessions.size === 0 || !statusSendMessage) return;

  // Group sessions by chatJid so each chat gets one consolidated message
  const byChat = new Map<string, ActiveSession[]>();
  for (const s of activeSessions.values()) {
    const list = byChat.get(s.chatJid) || [];
    list.push(s);
    byChat.set(s.chatJid, list);
  }

  for (const [chatJid, sessions] of byChat) {
    const lines: string[] = [`*Active Simpsons Sessions (${sessions.length})*`];

    for (const s of sessions) {
      const elapsed = formatDuration(Date.now() - s.startedAt.getTime());
      lines.push('');
      lines.push(`• *${s.project}* (${s.command}) — ${elapsed}`);

      const activity = getSessionActivity(s.session.name);
      if (activity) {
        lines.push(`  ${activity}`);
      }

      lines.push(`  tmux attach -t ${s.session.name}`);
    }

    await statusSendMessage(chatJid, lines.join('\n'));
  }
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

/**
 * Capture the last non-empty line from the tmux pane to show current activity.
 */
function getSessionActivity(sessionName: string): string {
  try {
    execSync(`tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null`);
  } catch {
    return 'session ended';
  }

  try {
    const pane = execSync(
      `tmux capture-pane -t ${shellQuote(sessionName)} -p`,
      { encoding: 'utf-8' },
    );
    // Find the last non-empty line as a summary of current activity
    const lines = pane.split('\n').filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1]?.trim() || '';
    // Truncate long lines
    return last.length > 120 ? last.slice(0, 120) + '...' : last;
  } catch {
    return '';
  }
}

export async function handleSimpsons(
  data: { project: string; command: string; prompt?: string },
  chatJid: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const { project, command, prompt } = data;
  const projectDir = path.join(PROJECTS_DIR, project);

  if (!fs.existsSync(projectDir)) {
    await sendMessage(
      chatJid,
      `Project "${project}" not found in ~/Projects`,
    );
    return;
  }

  const specCommand = COMMAND_MAP[command.toLowerCase()];
  if (!specCommand) {
    const available = Object.keys(COMMAND_MAP).join(', ');
    await sendMessage(
      chatJid,
      `Unknown simpsons command: "${command}". Available: ${available}`,
    );
    return;
  }

  let session: SimpsonsSession | undefined;

  try {
    // Setup phase — fast, synchronous
    ensureSpeckit(projectDir);
    ensureSimpsonsLoops(projectDir);
    mergeGlobalFile(projectDir, 'CLAUDE.md', GLOBAL_CLAUDE_MD);
    mergeGlobalFile(
      projectDir,
      path.join('.specify', 'memory', 'constitution.md'),
      GLOBAL_CONSTITUTION,
    );
    ensureQualityGates(projectDir);

    // Launch claude in a tmux session
    session = startClaudeSession(projectDir, specCommand, prompt || '');

    // Track session for status reporting and persist to disk
    activeSessions.set(session.name, {
      session,
      project,
      command,
      chatJid,
      startedAt: new Date(),
    });
    persistState();
    ensureStatusReporter(sendMessage);

    await sendMessage(
      chatJid,
      `Simpsons ${command} on ${project} started\ntmux attach -t ${session.name}`,
    );

    // After 60s, check for trust directory prompt and auto-confirm
    await sleep(TRUST_CHECK_DELAY);
    handleTrustPrompt(session.name);

    // Poll until claude finishes (no timeout — pipelines can run for hours)
    const result = await pollForCompletion(session);

    const maxLen = 4000;
    const output =
      result.length > maxLen
        ? result.slice(0, maxLen) + '\n... (output truncated)'
        : result;

    await sendMessage(
      chatJid,
      `Simpsons ${command} on ${project} complete:\n\n${output}`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, project, command }, 'Simpsons command failed');
    await sendMessage(
      chatJid,
      `Simpsons ${command} on ${project} failed: ${errMsg}`,
    );
  } finally {
    if (session) {
      activeSessions.delete(session.name);
      persistState();
    }
  }
}

// ---------------------------------------------------------------------------
// tmux session management
// ---------------------------------------------------------------------------

interface SimpsonsSession {
  name: string;
  outputFile: string;
  doneFile: string;
  scriptFile: string;
}

function startClaudeSession(
  projectDir: string,
  specCommand: string,
  prompt: string,
): SimpsonsSession {
  // Verify claude CLI is available
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'claude CLI not found. Install: npm install -g @anthropic-ai/claude-code',
    );
  }

  fs.mkdirSync(SIMPSONS_DIR, { recursive: true });

  const project = path.basename(projectDir);
  const ts = Date.now().toString(36);
  const sessionName = sanitizeSessionName(`simpsons-${project}-${ts}`);
  const outputFile = path.join(SIMPSONS_DIR, `${sessionName}.log`);
  const doneFile = path.join(SIMPSONS_DIR, `${sessionName}.done`);
  const scriptFile = path.join(SIMPSONS_DIR, `${sessionName}.sh`);

  const fullPrompt = prompt ? `${specCommand} ${prompt}` : specCommand;

  // Write a runner script to avoid shell-escaping issues inside tmux
  fs.writeFileSync(
    scriptFile,
    `#!/usr/bin/env bash
set -o pipefail
cd ${shellQuote(projectDir)}
claude -p ${shellQuote(fullPrompt)} --dangerously-skip-permissions 2>&1 | tee ${shellQuote(outputFile)}
echo \${PIPESTATUS[0]} > ${shellQuote(doneFile)}
`,
    { mode: 0o755 },
  );

  // Create tmux session in the project directory
  execSync(
    `tmux new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(projectDir)} ${shellQuote(scriptFile)}`,
  );

  logger.info(
    { sessionName, project, specCommand },
    'Started simpsons tmux session',
  );

  return { name: sessionName, outputFile, doneFile, scriptFile };
}

/**
 * Read the tmux pane and look for a trust-directory prompt.
 * If found, send 'y' + Enter to auto-confirm.
 */
function handleTrustPrompt(sessionName: string): void {
  try {
    // Check if session still exists
    execSync(`tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null`);
  } catch {
    return; // Session already finished
  }

  try {
    const pane = execSync(
      `tmux capture-pane -t ${shellQuote(sessionName)} -p`,
      { encoding: 'utf-8' },
    );

    if (/trust/i.test(pane)) {
      // Send 'y' + Enter for text-based trust prompts
      execSync(
        `tmux send-keys -t ${shellQuote(sessionName)} y Enter`,
      );
      logger.info({ sessionName }, 'Sent trust confirmation to tmux session');
    }
  } catch (err) {
    logger.warn(
      { err, sessionName },
      'Failed to check/handle trust prompt',
    );
  }
}

/**
 * Poll the done-file until claude finishes. No timeout.
 */
function pollForCompletion(session: SimpsonsSession): Promise<string> {
  return new Promise((resolve) => {
    const check = () => {
      // Primary signal: done file written by the runner script
      if (fs.existsSync(session.doneFile)) {
        const output = safeRead(session.outputFile);
        cleanup(session);
        resolve(output);
        return;
      }

      // Fallback: tmux session gone (killed, crashed, etc.)
      try {
        execSync(
          `tmux has-session -t ${shellQuote(session.name)} 2>/dev/null`,
        );
        // Session still alive — keep polling
        setTimeout(check, POLL_INTERVAL);
      } catch {
        // Session gone without a done file — grab whatever output exists
        // Wait a moment for filesystem flush
        setTimeout(() => {
          const output = safeRead(session.outputFile);
          cleanup(session);
          resolve(output);
        }, 2000);
      }
    };

    check();
  });
}

function safeRead(filePath: string): string {
  try {
    return fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf-8')
      : '';
  } catch {
    return '';
  }
}

function cleanup(session: SimpsonsSession): void {
  for (const f of [session.doneFile, session.scriptFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
  // Keep outputFile — user may want to review it
}

// ---------------------------------------------------------------------------
// Project setup helpers
// ---------------------------------------------------------------------------

function ensureSpeckit(projectDir: string): void {
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  const speckitDir = path.join(skillsDir, 'spec-kit');

  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(path.join(speckitDir, '.git'))) {
    try {
      execSync('git pull --ff-only', { cwd: speckitDir, stdio: 'pipe' });
    } catch {
      logger.warn(
        { dir: speckitDir },
        'spec-kit git pull failed, using existing',
      );
    }
  } else {
    if (fs.existsSync(speckitDir)) {
      fs.rmSync(speckitDir, { recursive: true });
    }
    execSync(
      'git clone https://github.com/github/spec-kit.git spec-kit',
      { cwd: skillsDir, stdio: 'pipe' },
    );
  }

  logger.info({ projectDir }, 'spec-kit ensured');
}

function ensureSimpsonsLoops(projectDir: string): void {
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  const loopsDir = path.join(skillsDir, 'spec-kit-simpsons-loops');

  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(path.join(loopsDir, '.git'))) {
    try {
      execSync('git pull --ff-only', { cwd: loopsDir, stdio: 'pipe' });
    } catch {
      logger.warn(
        { dir: loopsDir },
        'simpsons-loops git pull failed, using existing',
      );
    }
  } else {
    if (fs.existsSync(loopsDir)) {
      fs.rmSync(loopsDir, { recursive: true });
    }
    execSync(
      'git clone https://github.com/jnhuynh/spec-kit-simpsons-loops.git spec-kit-simpsons-loops',
      { cwd: skillsDir, stdio: 'pipe' },
    );
  }

  logger.info({ projectDir }, 'spec-kit-simpsons-loops ensured');
}

/**
 * Merge a global template file with project-specific content.
 * Everything before the delimiter is replaced with the latest global content.
 * Everything from the delimiter onwards (project-specific section) is preserved.
 */
function mergeGlobalFile(
  projectDir: string,
  relPath: string,
  globalContent: string,
): void {
  const fullPath = path.join(projectDir, relPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, globalContent);
    logger.info({ path: relPath }, 'Created global file');
    return;
  }

  const existing = fs.readFileSync(fullPath, 'utf-8');
  const delimIdx = existing.indexOf(DELIMITER);

  if (delimIdx === -1) {
    // No delimiter in existing file — treat entire content as project-specific
    // and prepend the fresh global content
    fs.writeFileSync(fullPath, globalContent + '\n\n' + existing);
    logger.info(
      { path: relPath },
      'Merged global file (no existing delimiter, prepended global)',
    );
    return;
  }

  // Keep the project-specific section (from delimiter onwards)
  const projectSection = existing.slice(delimIdx);

  // Take global content up to (but not including) the delimiter
  const globalDelimIdx = globalContent.indexOf(DELIMITER);
  const globalPart =
    globalDelimIdx !== -1
      ? globalContent.slice(0, globalDelimIdx)
      : globalContent + '\n\n';

  fs.writeFileSync(fullPath, globalPart + projectSection);
  logger.info(
    { path: relPath },
    'Merged global file (preserved project section)',
  );
}

/**
 * Ensure .specify/quality-gates.sh exists.
 * If it already exists, leave it untouched.
 * If missing, auto-generate based on project structure.
 */
function ensureQualityGates(projectDir: string): void {
  const qgPath = path.join(projectDir, '.specify', 'quality-gates.sh');

  if (fs.existsSync(qgPath)) {
    logger.info({ projectDir }, 'quality-gates.sh already exists, skipping');
    return;
  }

  fs.mkdirSync(path.join(projectDir, '.specify'), { recursive: true });

  const script = generateQualityGates(projectDir);
  fs.writeFileSync(qgPath, script, { mode: 0o755 });
  logger.info({ projectDir }, 'Generated quality-gates.sh');
}

function generateQualityGates(projectDir: string): string {
  const checks: string[] = [];

  // Node.js
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const devDeps = pkg.devDependencies || {};

      if (scripts.test) {
        checks.push('echo "Running tests..."');
        checks.push('npm test');
      }
      if (scripts.lint) {
        checks.push('echo "Running linter..."');
        checks.push('npm run lint');
      }
      if (scripts.typecheck) {
        checks.push('echo "Running type check..."');
        checks.push('npm run typecheck');
      } else if (scripts['type-check']) {
        checks.push('echo "Running type check..."');
        checks.push('npm run type-check');
      } else if (devDeps.typescript || pkg.dependencies?.typescript) {
        checks.push('echo "Running type check..."');
        checks.push('npx tsc --noEmit');
      }
    } catch {
      checks.push('echo "Warning: could not parse package.json"');
    }
  }

  // Ruby
  if (fs.existsSync(path.join(projectDir, 'Gemfile'))) {
    checks.push('echo "Running tests..."');
    checks.push('bundle exec rspec');
    if (fs.existsSync(path.join(projectDir, '.rubocop.yml'))) {
      checks.push('echo "Running linter..."');
      checks.push('bundle exec rubocop');
    }
  }

  // Python
  if (
    fs.existsSync(path.join(projectDir, 'pyproject.toml')) ||
    fs.existsSync(path.join(projectDir, 'requirements.txt'))
  ) {
    checks.push('echo "Running tests..."');
    checks.push('pytest');
    const pyprojectPath = path.join(projectDir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf-8');
        if (content.includes('ruff')) {
          checks.push('echo "Running linter..."');
          checks.push('ruff check .');
        } else if (content.includes('flake8')) {
          checks.push('echo "Running linter..."');
          checks.push('flake8 .');
        }
        if (content.includes('mypy')) {
          checks.push('echo "Running type check..."');
          checks.push('mypy .');
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Go
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) {
    checks.push('echo "Running tests..."');
    checks.push('go test ./...');
    checks.push('echo "Running vet..."');
    checks.push('go vet ./...');
  }

  // Rust
  if (fs.existsSync(path.join(projectDir, 'Cargo.toml'))) {
    checks.push('echo "Running tests..."');
    checks.push('cargo test');
    checks.push('echo "Running clippy..."');
    checks.push('cargo clippy -- -D warnings');
  }

  if (checks.length === 0) {
    checks.push(
      'echo "No quality gates configured - add checks for your project type"',
    );
    checks.push('exit 0');
  }

  return `#!/usr/bin/env bash
set -euo pipefail

# Quality gates for speckit pipeline
# Auto-generated based on project structure — edit as needed

${checks.join('\n')}

echo "All quality gates passed!"
`;
}
