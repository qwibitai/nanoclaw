/**
 * Zod schemas for runtime validation of all JSON config/state parsing.
 *
 * Every JSON.parse() boundary in production code should use one of these
 * schemas instead of a bare `as T` cast. TypeScript types are erased at
 * runtime — these schemas are the only real guarantee that parsed data
 * matches expected shapes.
 */
import { z } from 'zod';

// --- Mount security ---

export const AllowedRootSchema = z.object({
  path: z.string(),
  allowReadWrite: z.boolean(),
  description: z.string().optional(),
});

export const MountAllowlistSchema = z.object({
  allowedRoots: z.array(AllowedRootSchema),
  blockedPatterns: z.array(z.string()),
  nonMainReadOnly: z.boolean(),
});

// --- Sender allowlist ---

export const ChatAllowlistEntrySchema = z.object({
  allow: z.union([z.literal('*'), z.array(z.string())]),
  mode: z.enum(['trigger', 'drop']),
});

export const SenderAllowlistConfigSchema = z.object({
  default: ChatAllowlistEntrySchema,
  chats: z.record(z.string(), ChatAllowlistEntrySchema).optional().default({}),
  logDenied: z.boolean().optional().default(true),
  autoTriggerSenders: z.array(z.string()).optional().default([]),
});

// --- Container config (stored in DB as JSON) ---

export const AdditionalMountSchema = z.object({
  hostPath: z.string(),
  containerPath: z.string().optional(),
  readonly: z.boolean().optional(),
});

export const ContainerConfigSchema = z.object({
  additionalMounts: z.array(AdditionalMountSchema).optional(),
  timeout: z.number().optional(),
});

// --- Container output ---

export const UsageDataSchema = z.object({
  totalCostUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreateTokens: z.number(),
  durationMs: z.number().optional(),
  durationApiMs: z.number().optional(),
  numTurns: z.number().optional(),
  modelUsage: z.record(
    z.string(),
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadInputTokens: z.number(),
      cacheCreationInputTokens: z.number(),
    }),
  ),
});

export const ContainerOutputSchema = z.object({
  status: z.enum(['success', 'error']),
  result: z.string().nullable(),
  newSessionId: z.string().optional(),
  error: z.string().optional(),
  usage: UsageDataSchema.optional(),
});

// --- Worktree lock ---

export const WorktreeLockSchema = z.object({
  case_id: z.string(),
  case_name: z.string(),
  started_at: z.string(),
  heartbeat: z.string(),
  pid: z.number(),
});

// --- Remote control session ---

export const RemoteControlSessionSchema = z.object({
  pid: z.number(),
  url: z.string(),
  startedBy: z.string(),
  startedInChat: z.string(),
  startedAt: z.string(),
});

// --- IPC messages ---

export const IpcMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    chatJid: z.string(),
    text: z.string(),
    signals: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('image'),
    chatJid: z.string(),
    imagePath: z.string(),
    caption: z.string().optional(),
  }),
  z.object({
    type: z.literal('document'),
    chatJid: z.string(),
    documentPath: z.string(),
    filename: z.string().optional(),
    caption: z.string().optional(),
  }),
]);
