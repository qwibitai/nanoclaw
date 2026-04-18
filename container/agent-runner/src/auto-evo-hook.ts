import fs from 'fs';
import type { HookCallback, SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';

/** Default path inside the agent container; override for tests via NANOCLAW_AUTO_EVO_PATH. */
export function getAutoEvoFilePath(): string {
  const p = process.env.NANOCLAW_AUTO_EVO_PATH?.trim();
  return p || '/workspace/group/AUTO_EVO.md';
}

/** Keep hook payload reasonable for SessionStart. */
const MAX_INJECT_CHARS = 14_000;

/**
 * Injects per-group auto-evo memory before each session segment (startup / resume / compact).
 * Skips subagent threads (agent_id set) to avoid duplicating large context.
 */
export function createAutoEvoSessionStartHook(
  log: (message: string) => void,
): HookCallback {
  return async (input, _toolUseId, _context) => {
    if (process.env.NANOCLAW_AUTO_EVO_DISABLE === '1') {
      return {};
    }

    const hi = input as SessionStartHookInput;
    if (hi.hook_event_name !== 'SessionStart') {
      return {};
    }

    // Subagent workers get agent_id; main thread does not.
    if (hi.agent_id) {
      return {};
    }

    const autoEvoPath = getAutoEvoFilePath();
    if (!fs.existsSync(autoEvoPath)) {
      log(`auto-evo: no ${autoEvoPath} (optional)`);
      return {};
    }

    let body = fs.readFileSync(autoEvoPath, 'utf-8').trim();
    if (!body) {
      return {};
    }

    if (body.length > MAX_INJECT_CHARS) {
      body =
        body.slice(0, MAX_INJECT_CHARS) +
        '\n\n…[truncated by NanoClaw auto-evo; shorten AUTO_EVO.md]';
    }

    log(
      `auto-evo: injecting AUTO_EVO.md (session source=${hi.source}, chars=${body.length})`,
    );

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: [
          '### Auto-evo memory (`AUTO_EVO.md`)',
          'Durable strategy for **this group** only. Read before large tasks. After substantive work, update this file with new lessons (run Skill `auto-evo` for the protocol).',
          '',
          body,
        ].join('\n'),
      },
    };
  };
}
