import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface ModelProvider {
  name: string;
  url: string;
  auth: string;
  models: string[];
}

export interface ResolvedModelConfig {
  provider: ModelProvider;
  model: string;
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/**
 * Read all provider configurations from .env file.
 * Supports dynamic provider sections with URL, AUTH, and MODELS.
 */
export function readAllProviders(): ModelProvider[] {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return [];
  }

  const providers: Map<string, ModelProvider> = new Map();
  const modelToProvider: Map<string, string> = new Map();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim().toUpperCase();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    // Check for provider URL (e.g., OLLAMA_URL, OPENROUTER_URL)
    if (key.endsWith('_URL')) {
      const name = key.slice(0, -4).toLowerCase();
      const existing = providers.get(name) || {
        name,
        url: '',
        auth: '',
        models: [],
      };
      existing.url = value;
      providers.set(name, existing);
    }
    // Check for provider auth (e.g., OLLAMA_AUTH, OPENROUTER_AUTH)
    else if (key.endsWith('_AUTH')) {
      const name = key.slice(0, -5).toLowerCase();
      const existing = providers.get(name) || {
        name,
        url: '',
        auth: '',
        models: [],
      };
      existing.auth = value;
      providers.set(name, existing);
    }
    // Check for provider models (e.g., OLLAMA_MODELS, OPENROUTER_MODELS)
    else if (key.endsWith('_MODELS')) {
      const name = key.slice(0, -7).toLowerCase();
      const existing = providers.get(name) || {
        name,
        url: '',
        auth: '',
        models: [],
      };
      existing.models = value
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      // Build reverse lookup (case insensitive)
      for (const model of existing.models) {
        modelToProvider.set(model.toLowerCase(), name);
      }
      providers.set(name, existing);
    }
  }

  // Add Anthropic as a provider if ANTHROPIC_BASE_URL is set
  const anthropicModels = readEnvFile(['ANTHROPIC_MODELS']).ANTHROPIC_MODELS;
  const anthropicModel = readEnvFile(['ANTHROPIC_MODEL']).ANTHROPIC_MODEL;
  const anthropicBaseUrl = readEnvFile([
    'ANTHROPIC_BASE_URL',
  ]).ANTHROPIC_BASE_URL;
  const anthropicAuth = readEnvFile([
    'ANTHROPIC_AUTH_TOKEN',
  ]).ANTHROPIC_AUTH_TOKEN;

  if (anthropicBaseUrl) {
    const models: string[] = [];
    if (anthropicModels) {
      models.push(
        ...anthropicModels
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
      );
    }
    if (anthropicModel && !models.includes(anthropicModel)) {
      models.push(anthropicModel);
    }
    const existing = providers.get('anthropic') || {
      name: 'anthropic',
      url: '',
      auth: '',
      models: [],
    };
    for (const m of models) {
      modelToProvider.set(m.toLowerCase(), 'anthropic');
    }
    existing.models = [...new Set([...existing.models, ...models])];
    existing.url = anthropicBaseUrl;
    if (anthropicAuth) existing.auth = anthropicAuth;
    providers.set('anthropic', existing);
  }

  // Store reverse lookup on each provider
  for (const provider of providers.values()) {
    (provider as any).modelToProvider = modelToProvider;
  }

  return Array.from(providers.values()).filter(
    (p) => p.url && p.models.length > 0,
  );
}

/**
 * Resolve a model name to its provider configuration.
 * Returns the provider and the model to use.
 * Returns null if model is not found in any provider.
 */
export function resolveModelConfig(
  modelName: string,
): ResolvedModelConfig | null {
  const providers = readAllProviders();
  const normalizedModel = modelName.toLowerCase();

  // Check if model exists in any provider's list (case insensitive)
  for (const provider of providers) {
    if (provider.models.map((m) => m.toLowerCase()).includes(normalizedModel)) {
      return { provider, model: modelName };
    }
  }

  return null;
}

/**
 * Get all available models across all providers.
 */
export function getAllAvailableModels(): string[] {
  const providers = readAllProviders();
  const models = new Set<string>();

  for (const provider of providers) {
    for (const model of provider.models) {
      models.add(model);
    }
  }

  return Array.from(models).sort();
}

/**
 * Get models grouped by provider name.
 */
export function getModelsByProvider(): Map<string, string[]> {
  const providers = readAllProviders();
  const byProvider = new Map<string, string[]>();

  for (const provider of providers) {
    byProvider.set(provider.name, [...provider.models].sort());
  }

  return byProvider;
}
