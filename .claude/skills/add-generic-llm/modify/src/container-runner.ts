/**
 * Intent: Extend readSecrets() to pass generic LLM credentials to container
 * Changes:
 * - Include LLM_API_KEY, LLM_API_BASE, LLM_MODEL, LLM_PROVIDER in the allowlist
 * Invariants:
 * - Keep existing CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY
 */
import { readEnvFile } from './env.js';

function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'LLM_API_KEY',
    'LLM_API_BASE',
    'LLM_MODEL',
    'LLM_PROVIDER',
  ]);
}
