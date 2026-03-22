/**
 * Auth guard — thin integration layer for index.ts.
 * Encapsulates credential checking, stream auth error detection, and reauth triggering.
 */
import type { RegisteredGroup } from '../types.js';
import type { ChatIO, CredentialProvider } from './types.js';
import { isAuthError } from './providers/claude.js';
import { resolveScope } from './provision.js';
import { runReauth } from './reauth.js';
import { logger } from '../logger.js';

/**
 * Try to refresh the given provider's credentials for this group.
 * Returns true if credentials are now available.
 */
async function tryRefreshProvider(
  group: RegisteredGroup,
  provider: CredentialProvider,
  scope: string,
  force?: boolean,
): Promise<boolean> {
  if (!provider.refresh) return false;

  logger.info({ group: group.name, provider: provider.service, scope, force }, 'Attempting credential refresh');
  try {
    return await provider.refresh(scope, force);
  } catch (err) {
    logger.warn({ group: group.name, provider: provider.service, scope, err }, 'Credential refresh threw');
  }
  return false;
}

const MAX_REASON_LEN = 200;

/** Strip formatting, control chars, and truncate to make agent error text safe for chat display. */
function sanitizeReason(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')            // HTML tags
    .replace(/[*_`~[\]]/g, '')          // markdown formatting
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{S}]/gu, '') // keep only letters, numbers, punctuation, spaces, symbols
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .slice(0, MAX_REASON_LEN) + (raw.length > MAX_REASON_LEN ? '…' : '');
}

export function createAuthGuard(
  group: RegisteredGroup,
  createChat: () => ChatIO,
  closeStdin: () => void,
  /** The provider whose credentials power the session. */
  provider: CredentialProvider,
) {
  let streamedAuthError: string | null = null;

  return {
    /** Check credentials before agent run. Returns false if reauth failed. */
    async preCheck(): Promise<boolean> {
      const scope = resolveScope(group);

      // Check if provider can serve usable credentials
      if (Object.keys(provider.provision(scope).env).length > 0) return true;

      // Credentials missing or expired — try refresh
      if (await tryRefreshProvider(group, provider, scope)) return true;

      logger.warn({ group: group.name }, 'No credentials available, starting reauth');
      return runReauth(group.folder, createChat(), 'No credentials configured', provider.displayName);
    },

    /** Call from streaming callback. Detects auth errors and kills container. */
    onStreamResult(result: { status: string; result?: string | null; error?: string }): void {
      if (typeof result.error === 'string' && isAuthError(result.error)) {
        streamedAuthError = result.error;
      } else if (typeof result.result === 'string' && isAuthError(result.result)) {
        streamedAuthError = result.result;
      }
      if (streamedAuthError) {
        closeStdin();
      }
    },

    /**
     * Handle auth errors after agent run.
     * Returns 'not-auth' if not an auth error, 'reauth-ok' or 'reauth-failed' otherwise.
     */
    async handleAuthError(agentError?: string): Promise<'not-auth' | 'reauth-ok' | 'reauth-failed'> {
      if (agentError && isAuthError(agentError)) {
        streamedAuthError = agentError;
      }
      if (!streamedAuthError) return 'not-auth';

      const reason = streamedAuthError;
      streamedAuthError = null;

      if (await tryRefreshProvider(group, provider, resolveScope(group), true)) {
        logger.info({ group: group.name }, 'Credential refresh succeeded, skipping reauth');
        return 'reauth-ok';
      }

      logger.warn({ group: group.name, reason }, 'Auth error detected, starting reauth');
      const ok = await runReauth(group.folder, createChat(), `Agent failed: ${sanitizeReason(reason)}`, provider.displayName);
      return ok ? 'reauth-ok' : 'reauth-failed';
    },
  };
}
