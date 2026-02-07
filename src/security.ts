/**
 * Security Module for NanoClaw
 *
 * Centralized security controls for the NanoClaw system:
 * - Input sanitization and validation
 * - Shell command deny patterns (for agent containers)
 * - Secret detection to prevent accidental exposure
 * - Rate limiting for channels
 * - Docker security configuration
 *
 * Design: Defense-in-depth approach. Even if one layer fails,
 * container isolation provides the ultimate boundary.
 */
import { logger } from './logger.js';

/**
 * Patterns that should NEVER appear in shell commands executed by agents.
 * These are checked inside agent containers as an additional safety layer.
 */
export const SHELL_DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\s+\//,           // rm -rf /
  /\b(format|mkfs|diskpart)\b/i,       // Disk formatting
  /\bdd\s+if=/,                        // Raw disk write
  /:\(\)\s*\{.*\};\s*:/,               // Fork bomb
  /\b(shutdown|reboot|poweroff)\b/i,   // System power
  /\bchmod\s+777\s+\//,               // Dangerous chmod on root
  /\bcurl\b.*\|\s*\bbash\b/,          // Pipe curl to bash
  /\bwget\b.*\|\s*\bbash\b/,          // Pipe wget to bash
  />(\/dev\/sd|\/dev\/nvme)/,          // Write to raw devices
  /\biptables\s+-F/,                    // Flush firewall rules
  /\bpasswd\b/,                         // Password changes
  /\buseradd\b/,                        // User creation
  /\bchown\s+-R\s+.*\//,              // Recursive chown on root
];

/**
 * Check if a command matches any deny pattern.
 * Returns the matched pattern description or null if safe.
 */
export function checkShellCommand(command: string): string | null {
  for (const pattern of SHELL_DENY_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked by security pattern: ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Unified secret patterns with descriptions.
 * Each entry pairs a detection regex with a human-readable description.
 */
const SECRET_ENTRIES: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/, description: 'API key' },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36})\b/, description: 'GitHub personal access token' },
  { pattern: /\b(gho_[a-zA-Z0-9]{36})\b/, description: 'GitHub OAuth token' },
  { pattern: /\b(xox[bprs]-[a-zA-Z0-9-]{10,})\b/, description: 'Slack token' },
  { pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/, description: 'Google API key' },
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/, description: 'AWS access key' },
  { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/, description: 'Private key' },
  { pattern: /-----BEGIN CERTIFICATE-----/, description: 'Certificate' },
];

/**
 * Scan text for potential secrets.
 * Returns list of detected secret types.
 */
export function detectSecrets(text: string): string[] {
  return SECRET_ENTRIES
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => entry.description);
}

/**
 * Redact secrets from text for safe logging.
 */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const entry of SECRET_ENTRIES) {
    redacted = redacted.replace(entry.pattern, '[REDACTED]');
  }
  return redacted;
}

/**
 * Sanitize a container name to prevent command injection.
 * Only allows alphanumeric characters and hyphens.
 * Throws if the result would be empty.
 */
export function sanitizeContainerName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9-]/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid container name: sanitization of '${name.slice(0, 50)}' produced empty string`);
  }
  return sanitized;
}

/**
 * Validate environment variables before passing to containers.
 * Only allows explicitly listed variable names.
 */
export const ALLOWED_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NODE_ENV',
  'TZ',
]);

export function filterEnvVars(
  env: Record<string, string>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWED_ENV_VARS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Simple rate limiter for channel messages.
 * Prevents abuse from external channels.
 * Auto-cleans expired windows to prevent memory leaks.
 */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private maxRequests: number;
  private windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxRequests: number = 30, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
  }

  /** Check if a request should be allowed. Returns true if allowed. */
  check(key: string): boolean {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window || now >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (window.count >= this.maxRequests) {
      logger.warn({ key, count: window.count }, 'Rate limit exceeded');
      return false;
    }

    window.count++;
    return true;
  }

  /** Clean up expired windows */
  cleanup(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) {
        this.windows.delete(key);
      }
    }
  }

  /** Stop the auto-cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * Docker security flags for agent containers.
 * Constant array to avoid re-allocation on each call.
 */
export const DOCKER_SECURITY_ARGS: readonly string[] = Object.freeze([
  '--network=none',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges:true',
  '--read-only',
  '--memory=1g',
  '--memory-swap=1g',
  '--cpus=1.0',
  '--pids-limit=256',
  '--tmpfs=/tmp:rw,noexec,nosuid,size=256m',
]);

/** @deprecated Use DOCKER_SECURITY_ARGS constant instead */
export function getDockerSecurityArgs(): string[] {
  return [...DOCKER_SECURITY_ARGS];
}

/**
 * Escape LIKE wildcards in SQL parameters to prevent pattern injection.
 */
export function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Validate a URL to prevent SSRF attacks.
 * Only allows http:// and https:// schemes.
 */
export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Sanitize user input to prevent injection in XML-formatted prompts.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
