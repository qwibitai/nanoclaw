import { logger } from './logger.js';

export interface UnverifiedClaim {
  claim: string;
  type: 'number' | 'date' | 'name';
}

export interface VerificationResult {
  verified: boolean;
  unverifiedClaims: UnverifiedClaim[];
}

// Matches dollar amounts like $1,234.56 or $100 or $1,234,567.89
const NUMBER_PATTERN =
  /\$[\d,]+(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/g;

// Matches dates like "March 20, 2026" or "January 1, 2025"
const DATE_PATTERN =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/g;

function normalizeCommas(s: string): string {
  return s.replace(/,/g, '');
}

function extractClaims(text: string): UnverifiedClaim[] {
  const claims: UnverifiedClaim[] = [];

  const numbers = text.match(NUMBER_PATTERN) ?? [];
  for (const n of numbers) {
    claims.push({ claim: n, type: 'number' });
  }

  const dates = text.match(DATE_PATTERN) ?? [];
  for (const d of dates) {
    claims.push({ claim: d, type: 'date' });
  }

  return claims;
}

function claimFoundInSources(claim: string, toolResults: string[]): boolean {
  const normalizedClaim = normalizeCommas(claim);
  return toolResults.some((result) => {
    const normalizedResult = normalizeCommas(result);
    return normalizedResult.includes(normalizedClaim);
  });
}

export function crossReferenceFactualClaims(
  agentResponse: string,
  toolResults: string[],
): VerificationResult {
  const claims = extractClaims(agentResponse);

  if (claims.length === 0) {
    return { verified: true, unverifiedClaims: [] };
  }

  const unverifiedClaims: UnverifiedClaim[] = [];

  for (const claim of claims) {
    if (!claimFoundInSources(claim.claim, toolResults)) {
      unverifiedClaims.push(claim);
    }
  }

  if (unverifiedClaims.length > 0) {
    logger.warn(
      { unverifiedClaims },
      'Agent response contains claims not found in tool results',
    );
    return { verified: false, unverifiedClaims };
  }

  return { verified: true, unverifiedClaims: [] };
}
