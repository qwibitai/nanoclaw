/**
 * redact.ts — Detect and mask sensitive data in message content.
 * Applied before storage so secrets never persist in the database.
 */

interface RedactPattern {
  /** Regex to match the sensitive value */
  pattern: RegExp;
  /** Label shown in the masked output */
  label: string;
  /** How many chars to keep as prefix/suffix for identification */
  keep?: { prefix?: number; suffix?: number };
}

const PATTERNS: RedactPattern[] = [
  // Anthropic API keys
  {
    pattern: /sk-ant-api03-[A-Za-z0-9_-]{80,}/g,
    label: 'ANTHROPIC_KEY',
    keep: { prefix: 14, suffix: 4 },
  },
  // Anthropic OAuth tokens
  {
    pattern: /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g,
    label: 'ANTHROPIC_TOKEN',
    keep: { prefix: 14, suffix: 4 },
  },
  // Generic sk- keys (Stripe, OpenAI, etc.)
  {
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    label: 'API_KEY',
    keep: { prefix: 3, suffix: 4 },
  },
  // GitHub tokens
  {
    pattern: /gh[ps]_[A-Za-z0-9_]{30,}/g,
    label: 'GITHUB_TOKEN',
    keep: { prefix: 4, suffix: 4 },
  },
  {
    pattern: /github_pat_[A-Za-z0-9_]{20,}/g,
    label: 'GITHUB_PAT',
    keep: { prefix: 11, suffix: 4 },
  },
  // AWS access keys
  {
    pattern: /AKIA[A-Z0-9]{12,}/g,
    label: 'AWS_KEY',
    keep: { prefix: 4, suffix: 4 },
  },
  // Slack tokens
  {
    pattern: /xox[bpras]-[A-Za-z0-9-]{10,}/g,
    label: 'SLACK_TOKEN',
    keep: { prefix: 5, suffix: 4 },
  },
  // Discord bot tokens
  {
    pattern: /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
    label: 'DISCORD_TOKEN',
    keep: { prefix: 5, suffix: 4 },
  },
  // Azure / Entra client secrets (tilde is a strong signal — normal strings rarely contain ~)
  {
    pattern: /[A-Za-z0-9_-]{8,}~[A-Za-z0-9~._-]{20,}/g,
    label: 'CLIENT_SECRET',
    keep: { prefix: 4, suffix: 4 },
  },
  // PEM private keys
  {
    pattern:
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    label: 'PRIVATE_KEY',
  },
  // Connection strings with passwords
  {
    pattern: /:\/\/[^:\s]+:([^@\s]{8,})@/g,
    label: 'CONN_PASSWORD',
    keep: { prefix: 0, suffix: 0 },
  },
  // Env-style secrets: KEY=value where value looks secret
  {
    pattern:
      /(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_KEY)\s*=\s*['"]?([^\s'"`,;]{8,})['"]?/gi,
    label: 'ENV_SECRET',
  },
  // Conversational credentials: "pass: value", "password is value", "pwd: value", etc.
  {
    pattern:
      /(?:pass(?:word)?|pwd|passcode|pin)\s*(?::|is|=)\s*['"]?(\S{4,})['"]?/gi,
    label: 'PASSWORD',
  },
  // Conversational secrets/tokens: "secret: value", "token: value", "key: value"
  {
    pattern:
      /(?:secret|token|api[_-]?key|auth[_-]?key|access[_-]?key)\s*(?::|is|=)\s*['"]?(\S{6,})['"]?/gi,
    label: 'SECRET',
  },
];

function maskValue(
  value: string,
  label: string,
  keep?: { prefix?: number; suffix?: number },
): string {
  const prefix = keep?.prefix ?? 0;
  const suffix = keep?.suffix ?? 0;

  if (prefix + suffix >= value.length) {
    return `[${label}:****]`;
  }

  const head = prefix > 0 ? value.slice(0, prefix) : '';
  const tail = suffix > 0 ? value.slice(-suffix) : '';
  return `[${label}:${head}****${tail}]`;
}

/**
 * Scan text for sensitive patterns and replace them with masked versions.
 * Returns the original text if nothing sensitive is found.
 */
export function redactSensitiveData(text: string): string {
  let result = text;

  for (const { pattern, label, keep } of PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      // Special handling for connection string passwords — only mask the password part
      if (label === 'CONN_PASSWORD') {
        const colonAt = match.indexOf(':', 3); // skip ://
        const atSign = match.lastIndexOf('@');
        if (colonAt >= 0 && atSign > colonAt) {
          const password = match.slice(colonAt + 1, atSign);
          return (
            match.slice(0, colonAt + 1) +
            maskValue(password, label, keep) +
            match.slice(atSign)
          );
        }
      }
      // Special handling for env-style secrets — only mask the value
      if (label === 'ENV_SECRET') {
        const eqIdx = match.indexOf('=');
        if (eqIdx >= 0) {
          const key = match.slice(0, eqIdx + 1);
          const val = match.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '');
          return key + maskValue(val, label, { prefix: 0, suffix: 0 });
        }
      }
      // Special handling for conversational credentials — keep the label, mask the value
      if (label === 'PASSWORD' || label === 'SECRET') {
        const sepMatch = match.match(/^(.+?(?::|is|=)\s*['"]?)(.+?)(['"]?)$/i);
        if (sepMatch) {
          return (
            sepMatch[1] +
            maskValue(sepMatch[2], label, { prefix: 0, suffix: 0 }) +
            sepMatch[3]
          );
        }
      }
      return maskValue(match, label, keep);
    });
  }

  return result;
}
