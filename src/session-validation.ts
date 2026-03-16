/**
 * Session ID validation for OpenCode compatibility
 * OpenCode uses 'ses_' prefix format, Claude uses 'sess_' prefix UUID format
 */

/**
 * Validates a session ID format
 * Supports both:
 * - Claude format: sess_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (UUID)
 * - OpenCode format: ses_xxxxxxxxxxxxxxxxxxxxxxxxxx (alphanumeric)
 * - Legacy/other formats: Any non-empty string (for backward compatibility)
 *
 * @param sessionId - The session ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidSessionId(
  sessionId: string | undefined | null,
): boolean {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }

  // Reject obviously invalid values (too short, null-like strings)
  if (
    sessionId.length < 3 ||
    sessionId === 'null' ||
    sessionId === 'undefined'
  ) {
    return false;
  }

  // Accept Claude format: sess_ prefix followed by UUID
  const claudeRegex =
    /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Accept OpenCode format: ses_ prefix followed by alphanumeric
  const openCodeRegex = /^ses_[a-zA-Z0-9]+$/;

  // Accept any other non-empty string for backward compatibility
  // (allows unicode session IDs, custom formats, etc.)
  return (
    claudeRegex.test(sessionId) ||
    openCodeRegex.test(sessionId) ||
    sessionId.length >= 3
  );
}

/**
 * Sanitizes a session ID from the database
 * Returns the session ID if valid, undefined otherwise (triggers new session creation)
 *
 * @param sessionId - The session ID from database
 * @param groupFolder - For logging context
 * @returns Valid session ID or undefined
 */
export function sanitizeSessionId(
  sessionId: string | undefined | null,
  groupFolder: string,
): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  if (isValidSessionId(sessionId)) {
    return sessionId;
  }

  // Invalid session ID - will trigger new session creation
  // Caller should log this and create a new session
  return undefined;
}

/**
 * Gets a safe session ID for use with the container
 * Validates the stored session ID and returns undefined for invalid ones
 * This ensures invalid/corrupted session IDs don't crash the container
 *
 * @param sessions - The sessions record from memory
 * @param groupFolder - The group folder to get session for
 * @returns Valid session ID or undefined (to create new session)
 */
export function getSafeSessionId(
  sessions: Record<string, string>,
  groupFolder: string,
): string | undefined {
  const sessionId = sessions[groupFolder];
  return sanitizeSessionId(sessionId, groupFolder);
}
