/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * The real auth token never enters the container. Setup creates an
 * OneCLI generic secret (host-pattern = base URL hostname, header-name
 * = Authorization, value-format = "Bearer {value}") so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  return { env };
});
