import type { NewMessage } from './types.js';
import { logger } from './logger.js';

export type SessionCommand =
  | { kind: 'compact'; raw: '/compact' }
  | { kind: 'new'; raw: '/new' }
  | { kind: 'model_show'; raw: '/model' }
  | { kind: 'model_set'; raw: string; value: string }
  | { kind: 'model_default'; raw: '/model default' };

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the parsed command or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): SessionCommand | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  if (text === '/compact') return { kind: 'compact', raw: '/compact' };
  if (text === '/new') return { kind: 'new', raw: '/new' };
  if (text === '/model') return { kind: 'model_show', raw: '/model' };

  const modelMatch = text.match(/^\/model\s+(\S+)$/);
  if (modelMatch) {
    const value = modelMatch[1];
    if (value === 'default') {
      return { kind: 'model_default', raw: '/model default' };
    }
    return {
      kind: 'model_set',
      raw: `/model ${value}`,
      value,
    };
  }

  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
    options?: { timeoutMs?: number },
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  getDefaultModel: () => string | undefined;
  getGroupModelOverride: () => string | undefined;
  setGroupModelOverride: (value: string | undefined) => void;
  archiveCurrentSession: () => Promise<void>;
  clearCurrentSession: () => void;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
}

const MODEL_VALIDATION_TIMEOUT_MS = 90_000;
const MAX_MODEL_ERROR_MESSAGE_CHARS = 240;

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function sanitizeErrorText(text: string): string {
  const noAnsi = text.replace(/\u001b\[[0-9;]*m/g, '');
  const normalized = noAnsi.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_MODEL_ERROR_MESSAGE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_MODEL_ERROR_MESSAGE_CHARS - 1)}…`;
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (!isSessionCommandAllowed(isMainGroup, cmdMsg.is_from_me === true)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-command messages first, then run the command
  logger.info({ group: groupName, command: command.raw }, 'Session command');

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCommandMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-command messages to the agent so they're in the session context.
  if (preCommandMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCommandMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-command processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command.raw}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-command messages, leave command pending.
        deps.advanceCursor(preCommandMsgs[preCommandMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  if (command.kind === 'new') {
    try {
      await deps.archiveCurrentSession();
    } catch (err) {
      logger.warn(
        { group: groupName, err },
        'Session archive failed during /new; continuing with reset',
      );
    }

    try {
      deps.clearCurrentSession();
    } catch (err) {
      logger.error({ group: groupName, err }, 'Failed to reset session for /new');
      await deps.sendMessage('/new failed. The session is unchanged.');
      return { handled: true, success: false };
    }

    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage('Started a fresh session.');
    return { handled: true, success: true };
  }

  const defaultModel = deps.getDefaultModel();
  const groupOverrideModel = deps.getGroupModelOverride();

  if (command.kind === 'model_show') {
    let message: string;
    if (groupOverrideModel) {
      message = `Current model: ${groupOverrideModel} (group override).`;
    } else if (defaultModel) {
      message = `Current model: ${defaultModel} (default).`;
    } else {
      message = 'Current model: CLI default (no explicit override).';
    }
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage(message);
    return { handled: true, success: true };
  }

  if (command.kind === 'model_set') {
    let modelValidationFailed = false;
    let modelValidationError: string | null = null;
    const validateResult = await deps.runAgent(
      command.raw,
      async (result) => {
        if (result.status === 'error') {
          modelValidationFailed = true;
        }
        const text = sanitizeErrorText(resultToText(result.result));
        if (text && modelValidationError === null) {
          modelValidationError = text;
        }
      },
      { timeoutMs: MODEL_VALIDATION_TIMEOUT_MS },
    );

    if (validateResult === 'error' || modelValidationFailed) {
      deps.advanceCursor(cmdMsg.timestamp);
      await deps.sendMessage(
        modelValidationError
          ? `Failed to set model: ${modelValidationError}`
          : `Failed to set model to ${command.value}. Override unchanged.`,
      );
      return { handled: true, success: true };
    }

    deps.advanceCursor(cmdMsg.timestamp);
    deps.setGroupModelOverride(command.value);
    await deps.sendMessage(`Model set to ${command.value} for this group.`);
    return { handled: true, success: true };
  }

  if (command.kind === 'model_default') {
    deps.setGroupModelOverride(undefined);
    deps.advanceCursor(cmdMsg.timestamp);
    if (defaultModel) {
      await deps.sendMessage(
        `Model override cleared. Using default model: ${defaultModel}.`,
      );
    } else {
      await deps.sendMessage(
        'Model override cleared. Using CLI default model selection.',
      );
    }
    return { handled: true, success: true };
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command.raw, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command.raw} failed. The session is unchanged.`);
    return { handled: true, success: true };
  }

  return { handled: true, success: true };
}
