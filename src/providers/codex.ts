/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Env passthrough is deliberately narrow:
 *   CODEX_MODEL — optional model override; unset lets Codex use its default.
 *
 * NOT passed through:
 *   OPENAI_API_KEY  — would override the credential-proxy `placeholder` and
 *     leak the real key into container env. The proxy substitutes the real
 *     key on every request based on the placeholder, so the container
 *     never needs to see it.
 *   OPENAI_BASE_URL — would override the proxy URL we set in
 *     container-runner.ts. Containers must route through the proxy.
 *
 * For Codex with ChatGPT subscription auth (the common path), the OAuth
 * token in `auth.json` is the credential — neither OPENAI_API_KEY nor
 * the proxy is involved on that codepath.
 *
 * Auth source is pluggable via the resolver registry below. The default
 * registration here uses the instructor's host `~/.codex/auth.json`,
 * which preserves single-user behavior with zero config. Extension
 * features (e.g. the class feature's per-student Codex auth) register
 * additional resolvers that can shadow the default.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * A resolver returns the path to an auth.json the session should use,
 * or null if it doesn't have an opinion (let the next resolver try).
 *
 * `name` is a short label used in logs to disambiguate which credential
 * is in play (handy when an instructor is debugging a class where some
 * students have authed and others haven't).
 */
export type CodexAuthResolver = (ctx: CodexAuthResolverContext) => CodexAuthResolution | null;

export interface CodexAuthResolverContext {
  agentGroupId: string;
  hostHome: string | undefined;
}

export interface CodexAuthResolution {
  name: string;
  path: string;
}

const resolvers: CodexAuthResolver[] = [];

/**
 * Prepend a resolver to the chain. Resolvers are tried in reverse
 * registration order — newest registration wins — so an extension
 * (like the class feature's per-student resolver) automatically
 * shadows the default instructor resolver, regardless of which file
 * is imported first.
 */
export function registerCodexAuthResolver(resolver: CodexAuthResolver): void {
  resolvers.unshift(resolver);
}

/**
 * Walk the resolver chain. Returns the first non-null resolution, or
 * null if no resolver had an answer (session spawns without auth.json
 * and Codex itself surfaces the auth-required error to the agent).
 *
 * Pure-ish: filesystem reads only. No mutation.
 */
export function resolveCodexAuthSource(ctx: CodexAuthResolverContext): CodexAuthResolution | null {
  for (const resolver of resolvers) {
    const result = resolver(ctx);
    if (result) return result;
  }
  return null;
}

/** Test hook — clear the resolver chain. */
export function _resetResolversForTest(): void {
  resolvers.length = 0;
}

/**
 * Default resolver: the instructor's host ~/.codex/auth.json. Registered
 * at import time so the chain is never empty in a fresh install.
 * Exported so tests can re-register against a freshly reset chain
 * without re-importing the module.
 */
export const instructorHostResolver: CodexAuthResolver = (ctx) => {
  if (!ctx.hostHome) return null;
  const candidate = path.join(ctx.hostHome, '.codex', 'auth.json');
  if (!fs.existsSync(candidate)) return null;
  return { name: 'instructor', path: candidate };
};

registerCodexAuthResolver(instructorHostResolver);

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const resolved = resolveCodexAuthSource({
    agentGroupId: ctx.agentGroupId,
    hostHome: ctx.hostEnv.HOME,
  });

  if (resolved) {
    fs.copyFileSync(resolved.path, path.join(codexDir, 'auth.json'));
    log.info('codex provider: auth source resolved', {
      agentGroupId: ctx.agentGroupId,
      source: resolved.name,
    });
  } else {
    log.warn('codex provider: no auth.json available — session will need /login', {
      agentGroupId: ctx.agentGroupId,
    });
  }

  const env: Record<string, string> = {};
  if (ctx.hostEnv.CODEX_MODEL) env.CODEX_MODEL = ctx.hostEnv.CODEX_MODEL;

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
