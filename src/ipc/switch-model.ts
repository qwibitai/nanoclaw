import { DEFAULT_MODEL, resolveModelAlias } from '../config.js';
import { setGroupEffort, setGroupThinkingBudget } from '../db.js';
import { logger } from '../logger.js';

import type { IpcDeps, IpcTaskPayload } from './types.js';

/**
 * Handle the `switch_model` IPC: an agent-initiated model / effort /
 * thinking-budget override for its OWN group. Authorization: only the
 * group that owns the target chatJid may request a switch.
 */
export function handleSwitchModel(
  data: IpcTaskPayload,
  sourceGroup: string,
  deps: IpcDeps,
): void {
  if (!data.chatJid) {
    logger.warn({ sourceGroup }, 'switch_model missing chatJid');
    return;
  }
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  if (!targetGroup) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'switch_model: target group not registered',
    );
    return;
  }
  if (targetGroup.folder !== sourceGroup) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized switch_model attempt blocked',
    );
    return;
  }

  if (data.model === 'reset' || data.model === '') {
    const previousOverride = targetGroup.agentModelOverride;
    targetGroup.agentModelOverride = undefined;
    targetGroup.agentModelOverrideSetAt = undefined;
    if (previousOverride) {
      const effectiveModel = targetGroup.model || DEFAULT_MODEL;
      targetGroup.pendingModelNotice = `[model override cleared — reverted to ${effectiveModel}]`;
      deps
        .sendMessage(
          data.chatJid,
          `Model override cleared — reverted to ${effectiveModel}`,
        )
        .catch((err) =>
          logger.error({ err }, 'Failed to send model reset notification'),
        );
    }
    logger.info(
      { chatJid: data.chatJid, sourceGroup },
      'Agent model override cleared via IPC',
    );
  } else if (data.model) {
    const resolved = resolveModelAlias(data.model);
    const previousEffective =
      targetGroup.agentModelOverride || targetGroup.model || DEFAULT_MODEL;
    targetGroup.agentModelOverride = resolved;
    targetGroup.agentModelOverrideSetAt = Date.now();
    if (previousEffective !== resolved) {
      targetGroup.pendingModelNotice = `[model has switched to ${resolved} (agent-initiated, auto-reverts in 20 min)]`;
    }
    deps
      .sendMessage(
        data.chatJid,
        `Model switched to ${resolved} (agent-initiated, auto-reverts in 20 min)`,
      )
      .catch((err) =>
        logger.error({ err }, 'Failed to send model switch notification'),
      );
    logger.info(
      { chatJid: data.chatJid, sourceGroup, model: resolved },
      'Agent model override set via IPC',
    );
  }

  if (data.effort) {
    const effortValue = data.effort === 'reset' ? null : data.effort;
    setGroupEffort(data.chatJid, effortValue);
    targetGroup.effort = effortValue || undefined;
    logger.info(
      { chatJid: data.chatJid, effort: effortValue },
      'Effort set via switch_model IPC',
    );
  }

  if (data.thinking_budget) {
    const tbValue =
      data.thinking_budget === 'reset' ? null : data.thinking_budget;
    setGroupThinkingBudget(data.chatJid, tbValue);
    targetGroup.thinking_budget = tbValue || undefined;
    logger.info(
      { chatJid: data.chatJid, thinking_budget: tbValue },
      'Thinking budget set via switch_model IPC',
    );
  }
}
