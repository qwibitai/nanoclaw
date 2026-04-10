/**
 * Stdio MCP Server for LiteLLM Model Discovery & Sync
 *
 * Provides a unified view of all models available across:
 *   Layer 1 — NanoClaw direct credentials (env-based detection)
 *   Layer 2 — LiteLLM gateway models (API query)
 *   Layer 3 — Ollama local models (API query, optional)
 *
 * Also syncs Ollama models → LiteLLM (Ollama is source of truth).
 *
 * Activation:
 *   LITELLM_URL must be set. If absent, exits cleanly.
 *
 * Config:
 *   LITELLM_URL=http://litellm:4000
 *   LITELLM_MASTER_KEY=sk-...         (required for model management)
 *   OLLAMA_URL=http://ollama:11434     (optional, enables sync)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LITELLM_URL = (process.env.LITELLM_URL ?? '').replace(/\/$/, '');
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? '';
const OLLAMA_URL = (process.env.OLLAMA_URL ?? '').replace(/\/$/, '');

// Credential detection env vars (read but never logged)
const CREDENTIAL_KEYS = [
  { key: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { key: 'CLAUDE_CODE_OAUTH_TOKEN', provider: 'anthropic' },
  { key: 'OPENAI_API_KEY', provider: 'openai' },
  { key: 'GOOGLE_API_KEY', provider: 'google' },
  { key: 'MISTRAL_API_KEY', provider: 'mistral' },
  { key: 'COHERE_API_KEY', provider: 'cohere' },
  { key: 'GROQ_API_KEY', provider: 'groq' },
] as const;

function log(msg: string): void {
  process.stderr.write(`[litellm-mcp] ${msg}\n`);
}

// --- Activation gate ---

if (!LITELLM_URL) {
  log('LiteLLM URL not configured, skill disabled');
  process.exit(0);
}

// --- HTTP helpers ---

function litellmHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (LITELLM_MASTER_KEY) {
    headers['Authorization'] = `Bearer ${LITELLM_MASTER_KEY}`;
  }
  return headers;
}

async function litellmGet(path: string): Promise<unknown> {
  const res = await fetch(`${LITELLM_URL}${path}`, { headers: litellmHeaders() });
  if (!res.ok) throw new Error(`LiteLLM ${res.status}: ${await res.text()}`);
  return res.json();
}

async function litellmPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${LITELLM_URL}${path}`, {
    method: 'POST',
    headers: litellmHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LiteLLM ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ollamaGet(path: string): Promise<unknown> {
  const res = await fetch(`${OLLAMA_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return res.json();
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true as const,
  };
}

// --- Layer 1: Direct credential detection ---

interface DetectedProvider {
  provider: string;
  source: string;
}

function detectDirectCredentials(): DetectedProvider[] {
  const seen = new Set<string>();
  const result: DetectedProvider[] = [];
  for (const { key, provider } of CREDENTIAL_KEYS) {
    if (process.env[key] && !seen.has(provider)) {
      seen.add(provider);
      result.push({ provider, source: key });
    }
  }
  return result;
}

// --- Layer 2: LiteLLM model query ---

interface LiteLLMModel {
  model_name: string;
  litellm_params?: {
    model?: string;
    custom_llm_provider?: string;
    api_base?: string;
  };
  model_info?: Record<string, unknown>;
}

async function getLiteLLMModels(): Promise<LiteLLMModel[]> {
  const resp = await litellmGet('/model/info');
  const data = resp as { data?: LiteLLMModel[] };
  return data.data ?? [];
}

// --- Layer 3: Ollama model query ---

interface OllamaModel {
  name: string;
  size?: number;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
  modified_at?: string;
}

async function getOllamaModels(): Promise<OllamaModel[]> {
  if (!OLLAMA_URL) return [];
  const resp = await ollamaGet('/api/tags');
  const data = resp as { models?: OllamaModel[] };
  return data.models ?? [];
}

// --- Ollama → LiteLLM sync ---

export interface SyncResult {
  added: string[];
  removed: string[];
  unchanged: string[];
  errors: string[];
}

/**
 * Sync Ollama models to LiteLLM. Ollama is always the source of truth.
 * - Models in Ollama but not in LiteLLM are added.
 * - Models in LiteLLM (ollama provider) but not in Ollama are removed.
 *
 * Self-contained: accepts all config as parameters, no module-level state.
 */
export async function syncOllamaToLiteLLM(
  ollamaUrl: string,
  litellmUrl: string,
  litellmMasterKey: string,
): Promise<SyncResult> {
  const result: SyncResult = { added: [], removed: [], unchanged: [], errors: [] };

  if (!litellmMasterKey) {
    result.errors.push('LITELLM_MASTER_KEY not set — cannot manage models');
    return result;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${litellmMasterKey}`,
  };

  // Fetch Ollama models
  const ollamaRes = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!ollamaRes.ok) throw new Error(`Ollama unreachable: ${ollamaRes.status}`);
  const ollamaData = (await ollamaRes.json()) as { models?: OllamaModel[] };
  const ollamaModels = new Set((ollamaData.models ?? []).map((m) => m.name));

  // Fetch LiteLLM models, filter to ollama provider
  const litellmRes = await fetch(`${litellmUrl.replace(/\/$/, '')}/model/info`, { headers });
  if (!litellmRes.ok) throw new Error(`LiteLLM unreachable: ${litellmRes.status}`);
  const litellmData = (await litellmRes.json()) as { data?: LiteLLMModel[] };
  const litellmModels = (litellmData.data ?? []).filter(
    (m) =>
      m.litellm_params?.custom_llm_provider === 'ollama' ||
      m.litellm_params?.model?.startsWith('ollama/'),
  );
  const litellmOllamaNames = new Map<string, string>();
  for (const m of litellmModels) {
    // Extract the Ollama model name from the LiteLLM model string
    const ollamaName = (m.litellm_params?.model ?? '').replace(/^ollama\//, '');
    if (ollamaName) litellmOllamaNames.set(ollamaName, m.model_name);
  }

  // Add models present in Ollama but missing from LiteLLM
  for (const modelName of ollamaModels) {
    if (litellmOllamaNames.has(modelName)) {
      result.unchanged.push(modelName);
      continue;
    }
    try {
      await fetch(`${litellmUrl.replace(/\/$/, '')}/model/new`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model_name: `ollama/${modelName}`,
          litellm_params: {
            model: `ollama/${modelName}`,
            custom_llm_provider: 'ollama',
            api_base: ollamaUrl,
          },
        }),
      });
      result.added.push(modelName);
    } catch (e) {
      result.errors.push(`Failed to add ${modelName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Remove models in LiteLLM (ollama provider) that no longer exist in Ollama
  for (const [ollamaName, litellmName] of litellmOllamaNames) {
    if (ollamaModels.has(ollamaName)) continue;
    try {
      await fetch(`${litellmUrl.replace(/\/$/, '')}/model/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: litellmName }),
      });
      result.removed.push(ollamaName);
    } catch (e) {
      result.errors.push(`Failed to remove ${ollamaName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

// --- Startup: probe services and optionally sync ---

async function startup(): Promise<void> {
  // Probe LiteLLM health
  try {
    await fetch(`${LITELLM_URL}/health`, { signal: AbortSignal.timeout(5000) });
    log('LiteLLM reachable');
  } catch {
    log('WARNING: LiteLLM not reachable — model queries will fail');
  }

  // Detect direct credentials
  const directCreds = detectDirectCredentials();
  if (directCreds.length > 0) {
    log(`Direct credentials detected: ${directCreds.map((c) => c.provider).join(', ')}`);
  }

  // Probe Ollama and sync if available
  if (OLLAMA_URL) {
    try {
      await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      log('Ollama reachable — running sync');
      const syncResult = await syncOllamaToLiteLLM(OLLAMA_URL, LITELLM_URL, LITELLM_MASTER_KEY);
      log(
        `Sync complete: ${syncResult.added.length} added, ${syncResult.removed.length} removed, ` +
          `${syncResult.unchanged.length} unchanged` +
          (syncResult.errors.length > 0 ? `, ${syncResult.errors.length} errors` : ''),
      );
    } catch (e) {
      log(`Ollama sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Summary
  try {
    const litellmModels = await getLiteLLMModels();
    log(`Startup summary: ${directCreds.length} direct providers, ${litellmModels.length} LiteLLM models`);
  } catch {
    log('Startup summary: LiteLLM model count unavailable');
  }
}

// --- MCP Server ---

const mcpServer = new McpServer({ name: 'litellm', version: '1.0.0' });

mcpServer.tool(
  'list_models',
  'List all available models across three layers: NanoClaw direct credentials (env detection), LiteLLM gateway models, and Ollama local models. Returns a structured inventory with source attribution and deduplication.',
  {},
  async () => {
    try {
      // Layer 1: Direct credentials
      const directProviders = detectDirectCredentials();

      // Layer 2: LiteLLM models
      let litellmModels: LiteLLMModel[] = [];
      try {
        litellmModels = await getLiteLLMModels();
      } catch (e) {
        log(`LiteLLM query failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Layer 3: Ollama models
      let ollamaModels: OllamaModel[] = [];
      try {
        ollamaModels = await getOllamaModels();
      } catch (e) {
        log(`Ollama query failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Deduplicate: track providers seen in LiteLLM to flag direct-credential overlap
      const litellmProviders = new Set(
        litellmModels.map((m) => m.litellm_params?.custom_llm_provider ?? 'unknown'),
      );
      const ollamaNamesInLiteLLM = new Set(
        litellmModels
          .filter(
            (m) =>
              m.litellm_params?.custom_llm_provider === 'ollama' ||
              m.litellm_params?.model?.startsWith('ollama/'),
          )
          .map((m) => (m.litellm_params?.model ?? '').replace(/^ollama\//, '')),
      );

      return ok({
        layer_1_direct_credentials: directProviders.map((p) => ({
          provider: p.provider,
          source: p.source,
          also_in_litellm: litellmProviders.has(p.provider),
        })),
        layer_2_litellm_gateway: litellmModels.map((m) => ({
          model_name: m.model_name,
          provider: m.litellm_params?.custom_llm_provider ?? 'unknown',
          litellm_model: m.litellm_params?.model,
          api_base: m.litellm_params?.api_base,
        })),
        layer_3_ollama_local: ollamaModels.map((m) => ({
          name: m.name,
          size_bytes: m.size,
          parameter_size: m.details?.parameter_size,
          quantization: m.details?.quantization_level,
          family: m.details?.family,
          synced_to_litellm: ollamaNamesInLiteLLM.has(m.name),
        })),
        summary: {
          direct_providers: directProviders.length,
          litellm_models: litellmModels.length,
          ollama_models: ollamaModels.length,
        },
      });
    } catch (e) {
      return err(e);
    }
  },
);

mcpServer.tool(
  'sync_ollama_models',
  'Sync Ollama models to LiteLLM. Ollama is the source of truth: models present in Ollama but missing from LiteLLM are added, models in LiteLLM (ollama provider) that no longer exist in Ollama are removed. Requires both OLLAMA_URL and LITELLM_URL to be configured.',
  {},
  async () => {
    if (!OLLAMA_URL) {
      return err('OLLAMA_URL not configured — sync unavailable');
    }
    if (!LITELLM_MASTER_KEY) {
      return err('LITELLM_MASTER_KEY not set — cannot manage LiteLLM models');
    }
    try {
      const result = await syncOllamaToLiteLLM(OLLAMA_URL, LITELLM_URL, LITELLM_MASTER_KEY);
      return ok(result);
    } catch (e) {
      return err(e);
    }
  },
);

mcpServer.tool(
  'get_model_info',
  'Get detailed information about a specific model by name. Searches across all three layers: direct credentials, LiteLLM gateway, and Ollama local models.',
  {
    model: z.string().describe('Model name to look up, e.g. "claude-sonnet-4-20250514", "ollama/llama3.2", "gpt-4o"'),
  },
  async (args) => {
    try {
      const modelName = args.model;
      const results: Record<string, unknown> = { model: modelName, found_in: [] as string[] };

      // Search Layer 2: LiteLLM
      try {
        const litellmModels = await getLiteLLMModels();
        const match = litellmModels.find(
          (m) =>
            m.model_name === modelName ||
            m.litellm_params?.model === modelName ||
            m.model_name.includes(modelName),
        );
        if (match) {
          (results.found_in as string[]).push('litellm');
          results.litellm = {
            model_name: match.model_name,
            provider: match.litellm_params?.custom_llm_provider,
            litellm_model: match.litellm_params?.model,
            api_base: match.litellm_params?.api_base,
            model_info: match.model_info,
          };
        }
      } catch (e) {
        results.litellm_error = e instanceof Error ? e.message : String(e);
      }

      // Search Layer 3: Ollama
      if (OLLAMA_URL) {
        try {
          const ollamaModels = await getOllamaModels();
          const searchName = modelName.replace(/^ollama\//, '');
          const match = ollamaModels.find(
            (m) => m.name === searchName || m.name === modelName,
          );
          if (match) {
            (results.found_in as string[]).push('ollama');
            results.ollama = {
              name: match.name,
              size_bytes: match.size,
              details: match.details,
              modified_at: match.modified_at,
            };
          }
        } catch (e) {
          results.ollama_error = e instanceof Error ? e.message : String(e);
        }
      }

      // Search Layer 1: Direct credentials (provider-level, not model-level)
      const directCreds = detectDirectCredentials();
      const providerFromModel = modelName.includes('claude') || modelName.includes('anthropic')
        ? 'anthropic'
        : modelName.includes('gpt') || modelName.includes('openai')
          ? 'openai'
          : modelName.includes('gemini') || modelName.includes('google')
            ? 'google'
            : null;
      if (providerFromModel) {
        const directMatch = directCreds.find((c) => c.provider === providerFromModel);
        if (directMatch) {
          (results.found_in as string[]).push('direct_credentials');
          results.direct_credentials = {
            provider: directMatch.provider,
            note: 'Direct API access available via NanoClaw credential proxy',
          };
        }
      }

      if ((results.found_in as string[]).length === 0) {
        results.message = 'Model not found in any layer';
      }

      return ok(results);
    } catch (e) {
      return err(e);
    }
  },
);

// --- Start ---

await startup();
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
