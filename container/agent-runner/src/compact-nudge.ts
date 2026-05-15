// Early-compaction nudge: when effective context crosses a configurable ratio
// of the SDK auto-compact ceiling, schedule a one-shot <system-reminder> to
// prepend to the *next* user prompt. The reminder asks the agent to consider
// running /compact at a natural pause point — never mid-task.
//
// Why a separate state machine: PR #2327 tried injecting a reminder into the
// live query post-compact via `query.push()`. The SDK treated it as a synthetic
// user turn and the agent replied to it. The fix is to attach the reminder as
// context on the *next user prompt*, before the next `provider.query()` call —
// not pushed into an active stream.
//
// One-shot per compact cycle: latch on usage, clear on observed compact_boundary
// so a session that grows past the ratio again gets re-nudged.

export interface NudgeConfig {
  enabled: boolean;
  ceiling: number;
  threshold: number;
  ratio: number;
}

const DEFAULT_RATIO = 0.75;
const DEFAULT_CEILING = 165_000;

export function readNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  const ratio = parseRatio(env.COMPACT_NUDGE_RATIO);
  const ceiling = parseCeiling(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const enabled = ratio > 0 && ratio < 1 && ceiling > 0;
  return { enabled, ratio, ceiling, threshold: Math.floor(ceiling * ratio) };
}

function parseRatio(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RATIO;
  const v = Number(raw);
  return Number.isFinite(v) ? v : 0;
}

function parseCeiling(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CEILING;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CEILING;
}

export interface UsageSample {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function effectiveContext(u: UsageSample): number {
  return (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
}

/**
 * The reminder text. Framed as plain context for the next turn — never as a
 * synthetic user message. The agent should ignore it if mid-task; act on it
 * at a natural pause point.
 */
export function buildNudgeReminder(used: number, ceiling: number): string {
  return [
    '<system-reminder>',
    `Context usage is at ~${used.toLocaleString()} tokens of ~${ceiling.toLocaleString()} before auto-compaction. `,
    'If you are at a natural pause point, consider running /compact to summarize history before the SDK auto-compacts at an arbitrary point. ',
    'If you are mid-task, ignore this — it will not be repeated until the next compaction cycle.',
    '</system-reminder>',
  ].join('');
}

export interface NudgeTracker {
  onUsage(sample: UsageSample): void;
  onCompactBoundary(): void;
  /** Returns reminder text if one is pending, then clears the pending flag. */
  consumePending(): string | null;
  /** Test/inspection accessor. */
  state(): { lastEffective: number; pending: boolean; sent: boolean };
}

export function createNudgeTracker(config: NudgeConfig = readNudgeConfig()): NudgeTracker {
  let lastEffective = 0;
  let pending = false;
  let sent = false;

  return {
    onUsage(sample) {
      if (!config.enabled) return;
      const used = effectiveContext(sample);
      if (used > lastEffective) lastEffective = used;
      if (!sent && used >= config.threshold) {
        pending = true;
        sent = true;
      }
    },
    onCompactBoundary() {
      sent = false;
      pending = false;
      lastEffective = 0;
    },
    consumePending() {
      if (!pending) return null;
      pending = false;
      return buildNudgeReminder(lastEffective, config.ceiling);
    },
    state() {
      return { lastEffective, pending, sent };
    },
  };
}
