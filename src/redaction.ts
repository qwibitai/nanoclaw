/**
 * Shared credential scrubbing across host modules.
 *
 * Keep this list centralized so redaction coverage stays consistent
 * across logs, prompts, and persisted memory artifacts.
 */
const REDACTION_RULES: Array<[RegExp, string]> = [
  [/\bghp_[a-zA-Z0-9]+/g, 'ghp_***REDACTED***'],
  [/\bAKIA[0-9A-Z]{16}/g, 'AKIA***REDACTED***'],
  [/\bxoxb-[a-zA-Z0-9_-]+/g, 'xoxb-***REDACTED***'],
  [/\bya29\.[a-zA-Z0-9_-]+/g, 'ya29.***REDACTED***'],
  [/\bsk-ant-api\d{2}-[a-zA-Z0-9_-]+/g, 'sk-ant-***REDACTED***'],
  [/\b(or-|ant-)[a-zA-Z0-9_-]{10,}/g, '$1***REDACTED***'],
  [/\bsk-[a-zA-Z0-9_-]{10,}/g, 'sk-***REDACTED***'],
  [/\bpk-[a-zA-Z0-9_-]{10,}/g, 'pk-***REDACTED***'],
  [/\b(xai|gsk|eyJ)[a-zA-Z0-9_-]{20,}/g, '$1***REDACTED***'],
  [/(Bearer\s+)[a-zA-Z0-9._-]{20,}/gi, '$1***REDACTED***'],
  [
    /[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
    '***DISCORD_TOKEN_REDACTED***',
  ],
  [/\b0x[a-fA-F0-9]{64}\b/g, '0x***PRIVATE_KEY_REDACTED***'],
  [/\b[a-fA-F0-9]{40,}\b/g, '***HEX_REDACTED***'],
  [
    /(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi,
    '$1=***REDACTED***',
  ],
];

export function scrubCredentials(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/**
 * Same scrubbing, but normalizes all redaction markers to a single token.
 * Useful for user-facing output or generic JSON logs.
 */
export function scrubCredentialsGeneric(text: string): string {
  return scrubCredentials(text)
    .replace(/[A-Za-z0-9._-]*\*\*\*REDACTED\*\*\*/g, '[REDACTED]')
    .replace(/\*\*\*DISCORD_TOKEN_REDACTED\*\*\*/g, '[REDACTED]')
    .replace(/0x\*\*\*PRIVATE_KEY_REDACTED\*\*\*/g, '[REDACTED]')
    .replace(/\*\*\*HEX_REDACTED\*\*\*/g, '[REDACTED]');
}
