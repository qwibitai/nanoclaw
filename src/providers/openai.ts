/**
 * Host-side container config for the `openai` provider.
 *
 * Minimal: just forward API key, model, and optional base URL from .env
 * into the container environment. No mounts needed — the OpenAI provider
 * talks to the API directly via fetch().
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('openai', (ctx) => {
  const dotenv = readEnvFile(['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL']);
  const env: Record<string, string> = {};
  for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL'] as const) {
    const value = ctx.hostEnv[key] || dotenv[key];
    if (value) env[key] = value;
  }

  return { env };
});
