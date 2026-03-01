// In-memory model/thinking overrides per group session.
// No DB persistence — cleared on pool eviction or explicit reset.

import { logger } from './logger.js';

const DEFAULT_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-20250115',
];

export const ALLOWED_MODELS: string[] = process.env.ALLOWED_MODELS
  ? process.env.ALLOWED_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODELS;

interface Override {
  model?: string;
  thinking?: boolean;
}

interface SetModelResult {
  success: boolean;
  error?: string;
  availableModels?: string[];
}

interface ParsedCommand {
  type: 'set_model' | 'set_thinking';
  model?: string;
  list?: boolean;
  reset?: boolean;
}

const MAX_OVERRIDES = 100;
const overrides = new Map<string, Override>();

export function setModel(groupFolder: string, modelName: string): SetModelResult {
  if (!modelName || !ALLOWED_MODELS.includes(modelName)) {
    return {
      success: false,
      error: `Invalid model. Available models: ${ALLOWED_MODELS.join(', ')}`,
      availableModels: [...ALLOWED_MODELS],
    };
  }

  // Evict oldest entry if at capacity (prevents unbounded growth)
  if (!overrides.has(groupFolder) && overrides.size >= MAX_OVERRIDES) {
    const firstKey = overrides.keys().next().value;
    if (firstKey !== undefined) overrides.delete(firstKey);
  }

  const existing = overrides.get(groupFolder) ?? {};
  overrides.set(groupFolder, { ...existing, model: modelName });
  logger.debug({ groupFolder, model: modelName }, 'Model override set');
  return { success: true };
}

export function setThinking(groupFolder: string, enabled: boolean): void {
  const existing = overrides.get(groupFolder) ?? {};
  overrides.set(groupFolder, { ...existing, thinking: enabled });
}

export function getOverride(groupFolder: string): Override {
  return overrides.get(groupFolder) ?? {};
}

export function clearOverride(groupFolder: string): void {
  overrides.delete(groupFolder);
  logger.debug({ groupFolder }, 'Model override cleared');
}

export function listModels(): string[] {
  return [...ALLOWED_MODELS];
}

export function parseModelCommand(message: string): ParsedCommand | null {
  if (!message) return null;

  // Only match commands at the start of the message
  if (message.startsWith('/thinking')) {
    return { type: 'set_thinking' };
  }

  if (!message.startsWith('/model')) {
    return null;
  }

  const trimmed = message.slice('/model'.length).trim();

  if (trimmed === '') {
    return { type: 'set_model', list: true };
  }

  if (trimmed === 'reset') {
    return { type: 'set_model', reset: true };
  }

  return { type: 'set_model', model: trimmed };
}
