/**
 * OpenAI-compatible JSON completion client for LLM-powered extraction.
 * Config via EXTRACTION_PROVIDER/EXTRACTION_MODEL/EXTRACTION_API_KEY/EXTRACTION_BASE_URL.
 * Default: gemini-2.0-flash via Google's OpenAI-compatible endpoint.
 * Returns null on failure (graceful degradation).
 */

// ============================================================================
// Configuration
// ============================================================================

interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseURL: string;
}

interface ProviderDefaults {
  baseURL: string;
  model: string;
  apiKeyEnv?: string;
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.0-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5-20250514',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    model: 'llama3.2',
  },
  custom: {
    baseURL: '',
    model: '',
  },
};

function resolveConfig(): LLMConfig | null {
  const provider = (process.env.EXTRACTION_PROVIDER || '').toLowerCase();
  if (!provider) return null;

  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;

  const apiKey = process.env.EXTRACTION_API_KEY
    || (defaults.apiKeyEnv ? (process.env[defaults.apiKeyEnv] || '') : '')
    || '';

  const baseURL = process.env.EXTRACTION_BASE_URL || defaults.baseURL;
  const model = process.env.EXTRACTION_MODEL || defaults.model;

  if (!baseURL || !model) {
    console.warn(`[llm-client] Extraction provider "${provider}" configured but missing baseURL or model`);
    return null;
  }

  if (!apiKey && provider !== 'ollama') {
    console.warn(`[llm-client] Extraction provider "${provider}" configured but missing API key`);
    return null;
  }

  return { provider, apiKey, model, baseURL };
}

// ============================================================================
// Client
// ============================================================================

let _config: LLMConfig | null | undefined; // undefined = not yet resolved

function getConfig(): LLMConfig | null {
  if (_config === undefined) {
    _config = resolveConfig();
    if (_config) {
      console.log(`[llm-client] Extraction configured: provider=${_config.provider}, model=${_config.model}`);
    }
  }
  return _config;
}

/**
 * Check if LLM extraction is available (provider configured).
 */
export function isExtractionAvailable(): boolean {
  return getConfig() !== null;
}

/**
 * Send a prompt to the LLM and get a JSON response.
 * Returns null on any failure (graceful degradation).
 */
export async function llmJsonCompletion<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  },
): Promise<T | null> {
  const config = getConfig();
  if (!config) return null;

  const { apiKey, model, baseURL } = config;
  const temperature = options?.temperature ?? 0.1;
  const maxTokens = options?.maxTokens ?? 4096;
  const timeoutMs = options?.timeoutMs ?? 30000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const endpoint = baseURL.endsWith('/') ? `${baseURL}chat/completions` : `${baseURL}/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`[llm-client] API error ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn('[llm-client] Empty response from LLM');
      return null;
    }

    // Parse JSON from response, handling markdown code blocks
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    return JSON.parse(jsonStr) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`[llm-client] Request timed out (${timeoutMs}ms)`);
    } else {
      console.warn(`[llm-client] Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}
