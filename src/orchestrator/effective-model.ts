import { AGENT_MODEL_TIMEOUT_MS, DEFAULT_MODEL } from '../config.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

export interface EffectiveModelResult {
  model: string;
  reverted?: boolean;
  revertedFrom?: string;
}

/**
 * Resolve the model to use for the agent right now. Precedence:
 *   1. An agent-initiated override ({@link RegisteredGroup.agentModelOverride})
 *      still inside its {@link AGENT_MODEL_TIMEOUT_MS} window.
 *   2. The group's configured `model`.
 *   3. {@link DEFAULT_MODEL}.
 *
 * Mutates `group` to clear an expired override and surface a pending
 * revert notice for the next outbound prompt. Return value tells the
 * caller whether a revert happened so they can notify the user.
 */
export function getEffectiveModel(
  group: RegisteredGroup,
): EffectiveModelResult {
  if (group.agentModelOverride && group.agentModelOverrideSetAt) {
    const elapsed = Date.now() - group.agentModelOverrideSetAt;
    if (elapsed < AGENT_MODEL_TIMEOUT_MS) {
      return { model: group.agentModelOverride };
    }
    // Override expired — clear and set revert notice
    const expiredModel = group.agentModelOverride;
    group.agentModelOverride = undefined;
    group.agentModelOverrideSetAt = undefined;
    const revertedTo = group.model || DEFAULT_MODEL;
    group.pendingModelNotice = `[model override expired — reverted from ${expiredModel} to ${revertedTo}]`;
    logger.info(
      { folder: group.folder, expiredModel, revertedTo },
      'Agent model override expired',
    );
    return { model: revertedTo, reverted: true, revertedFrom: expiredModel };
  }
  return { model: group.model || DEFAULT_MODEL };
}
