/**
 * Auth guard — thin integration layer for index.ts.
 * Encapsulates credential checking, stream auth error detection, and reauth triggering.
 */
import type { RegisteredGroup } from '../types.js';
import type { ChatIO } from './types.js';
import { isAuthError } from './providers/claude.js';
import { resolveSecrets } from './provision.js';
import { runReauth } from './reauth.js';
import { logger } from '../logger.js';

export function createAuthGuard(
  group: RegisteredGroup,
  createChat: () => ChatIO,
  closeStdin: () => void,
) {
  let streamedAuthError: string | null = null;

  return {
    /** Check credentials before agent run. Returns false if reauth failed. */
    async preCheck(): Promise<boolean> {
      const secrets = resolveSecrets(group);
      if (Object.keys(secrets).length === 0) {
        logger.warn({ group: group.name }, 'No credentials available, starting reauth');
        return runReauth(group.folder, createChat(), 'No credentials configured');
      }
      return true;
    },

    /** Call from streaming callback. Detects auth errors and kills container. */
    onStreamResult(result: { status: string; result?: string | null; error?: string }): void {
      if (typeof result.error === 'string' && isAuthError(result.error)) {
        streamedAuthError = result.error;
      } else if (typeof result.result === 'string' && isAuthError(result.result)) {
        // Claude doesn't always mark errors in stream
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
      logger.warn({ group: group.name }, 'Auth error detected, starting reauth');
      const ok = await runReauth(group.folder, createChat(), `Agent failed: ${reason}`);
      return ok ? 'reauth-ok' : 'reauth-failed';
    },
  };
}
