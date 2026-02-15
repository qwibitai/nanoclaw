/**
 * External Access Broker — Provider abstraction
 *
 * Providers register actions with access levels (L1-L3).
 * Host-side only — never runs in containers.
 */
import { z } from 'zod';

export interface ExtActionResult {
  ok: boolean;
  data: unknown;       // returned to container (sanitized)
  summary: string;     // logged in ext_calls.result_summary
}

export interface ExtAction {
  level: 1 | 2 | 3;
  description: string;
  params: z.ZodType<unknown>;
  execute: (params: unknown, secrets: ProviderSecrets) => Promise<ExtActionResult>;
  summarize: (params: unknown) => string;
  idempotent: boolean;
}

export interface ExtProvider {
  name: string;
  requiredSecrets: string[];
  actions: Record<string, ExtAction>;
}

export type ProviderSecrets = Record<string, string>;

// --- Provider registry ---

const providers = new Map<string, ExtProvider>();

export function registerProvider(provider: ExtProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): ExtProvider | undefined {
  return providers.get(name);
}

export function getAllProviderNames(): string[] {
  return Array.from(providers.keys());
}

export function getProviderActionCatalog(
  providerName: string,
): Record<string, { level: number; description: string; idempotent: boolean }> | undefined {
  const provider = providers.get(providerName);
  if (!provider) return undefined;

  const catalog: Record<string, { level: number; description: string; idempotent: boolean }> = {};
  for (const [name, action] of Object.entries(provider.actions)) {
    catalog[name] = {
      level: action.level,
      description: action.description,
      idempotent: action.idempotent,
    };
  }
  return catalog;
}

/**
 * Check if a provider has all required secrets available.
 * Returns missing secret names (empty array = all good).
 */
export function checkProviderSecrets(
  providerName: string,
  secrets: ProviderSecrets,
): string[] {
  const provider = providers.get(providerName);
  if (!provider) return [];

  return provider.requiredSecrets.filter((s) => !secrets[s]);
}
