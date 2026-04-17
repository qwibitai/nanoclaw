import { z } from 'zod';

import type { ToolContext } from '../context.js';

import { textResponse, type ToolDefinition } from './types.js';

// --- register_group ----------------------------------------------------

interface RegisterGroupArgs {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger?: boolean;
}

const REGISTER_GROUP_DESCRIPTION = `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`;

export function buildRegisterGroupTool(
  ctx: ToolContext,
): ToolDefinition<RegisterGroupArgs, ReturnType<typeof textResponse>> {
  return {
    name: 'register_group',
    description: REGISTER_GROUP_DESCRIPTION,
    schema: {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
        ),
      name: z.string().describe('Display name for the group'),
      folder: z
        .string()
        .describe(
          'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
        ),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
      requiresTrigger: z
        .boolean()
        .optional()
        .describe(
          'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
        ),
    },
    handler: async (args) => {
      if (!ctx.isMain) {
        return textResponse(
          'Only the main group can register new groups.',
          true,
        );
      }

      ctx.writeIpcFile(ctx.tasksDir, {
        type: 'register_group',
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        requiresTrigger: args.requiresTrigger ?? false,
        timestamp: new Date().toISOString(),
      });

      return textResponse(
        `Group "${args.name}" registered. It will start receiving messages immediately.`,
      );
    },
  };
}

// --- switch_model ------------------------------------------------------

interface SwitchModelArgs {
  model: string;
  effort?: string;
  thinking_budget?: string;
}

const SWITCH_MODEL_DESCRIPTION = `Switch the model, effort level, or thinking budget for your conversation. Changes take effect from the next conversation turn. Model overrides automatically revert after 20 minutes.

Use model aliases (e.g., "opus", "sonnet", "haiku") or full model IDs. Use "reset" to clear overrides.

Parameters:
• model: Model alias or full ID. Use "reset" to clear.
• effort (optional): "low", "medium", "high", "max", or "reset"
• thinking_budget (optional): "low" (42k), "medium" (85k), "high" (128k), "adaptive", or "reset"`;

export function buildSwitchModelTool(
  ctx: ToolContext,
): ToolDefinition<SwitchModelArgs, ReturnType<typeof textResponse>> {
  return {
    name: 'switch_model',
    description: SWITCH_MODEL_DESCRIPTION,
    schema: {
      model: z
        .string()
        .describe(
          'Model alias or full model ID (e.g., "opus", "haiku", "claude-opus-4-20250514"). Use "reset" to clear the override.',
        ),
      effort: z
        .string()
        .optional()
        .describe(
          'Effort level: "low", "medium", "high", "max", or "reset" to clear.',
        ),
      thinking_budget: z
        .string()
        .optional()
        .describe(
          'Thinking budget preset: "low" (42k tokens), "medium" (85k), "high" (128k), "adaptive", or "reset" to clear.',
        ),
    },
    handler: async (args) => {
      ctx.writeIpcFile(ctx.tasksDir, {
        type: 'switch_model',
        model: args.model,
        effort: args.effort,
        thinking_budget: args.thinking_budget,
        chatJid: ctx.chatJid,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      });

      const parts: string[] = [];
      const isReset = args.model === 'reset';
      if (isReset) {
        parts.push(
          'Model override cleared. The group/default model will be used from the next turn.',
        );
      } else {
        parts.push(
          `Model switch to "${args.model}" requested. It will take effect from the next conversation turn and revert automatically after 20 minutes.`,
        );
      }
      if (args.effort) {
        parts.push(
          args.effort === 'reset'
            ? 'Effort reset to default.'
            : `Effort set to "${args.effort}".`,
        );
      }
      if (args.thinking_budget) {
        parts.push(
          args.thinking_budget === 'reset'
            ? 'Thinking budget reset to default.'
            : `Thinking budget set to "${args.thinking_budget}".`,
        );
      }

      return textResponse(parts.join(' '));
    },
  };
}
