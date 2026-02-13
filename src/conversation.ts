export type ConversationKind = 'group' | 'direct' | 'unknown';

export interface ConversationRef {
  platform: string;
  externalId: string;
  canonicalId: string;
  kind: ConversationKind;
}

const CANONICAL_ID_PATTERN = /^([a-z0-9_-]+):\/\/(.+)$/i;

function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

export function inferConversationKind(
  platform: string,
  externalId: string,
): ConversationKind {
  const normalizedPlatform = normalizePlatform(platform);

  if (normalizedPlatform === 'whatsapp') {
    if (externalId.endsWith('@g.us')) return 'group';
    if (externalId.endsWith('@s.whatsapp.net')) return 'direct';
  }

  return 'unknown';
}

export function toCanonicalConversationId(
  platform: string,
  externalId: string,
): string {
  const normalizedPlatform = normalizePlatform(platform);
  if (normalizedPlatform === 'whatsapp') {
    // Keep existing WhatsApp IDs stable for backwards compatibility.
    return externalId;
  }
  return `${normalizedPlatform}://${externalId}`;
}

export function isCanonicalConversationId(value: string): boolean {
  return CANONICAL_ID_PATTERN.test(value);
}

export function toConversationRef(
  platform: string,
  externalId: string,
  kind?: ConversationKind,
): ConversationRef {
  const normalizedPlatform = normalizePlatform(platform);
  return {
    platform: normalizedPlatform,
    externalId,
    canonicalId: toCanonicalConversationId(normalizedPlatform, externalId),
    kind: kind || inferConversationKind(normalizedPlatform, externalId),
  };
}

export function fromCanonicalConversationId(
  canonicalId: string,
  fallbackPlatform = 'whatsapp',
): ConversationRef {
  const match = canonicalId.match(CANONICAL_ID_PATTERN);
  if (match) {
    const platform = normalizePlatform(match[1]);
    const externalId = match[2];
    return toConversationRef(platform, externalId);
  }

  // Legacy IDs (existing WhatsApp data) or unprefixed provider IDs
  return toConversationRef(fallbackPlatform, canonicalId);
}

export function isGroupConversation(ref: ConversationRef): boolean {
  return ref.kind === 'group';
}
