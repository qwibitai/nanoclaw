/**
 * Node.js module resolution hooks for direct runner mode.
 * Intercepts imports at the module system level — ZERO source file changes.
 *
 * When NANOCLAW_DIRECT_RUNNER=1:
 *   ./container-runner.js  → ./agent-runner.js
 *   ./container-runtime.js → ./noop-container.js
 *   ./credential-proxy.js  → ./noop-container.js
 */

const ACTIVE = process.env.NANOCLAW_DIRECT_RUNNER === '1';

const REDIRECTS: Record<string, string> = {
  './container-runner.js': './agent-runner.js',
  './container-runtime.js': './noop-container.js',
  './credential-proxy.js': './noop-container.js',
};

export async function resolve(
  specifier: string,
  context: { parentURL?: string; conditions?: string[] },
  nextResolve: (specifier: string, context: object) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (!ACTIVE) return nextResolve(specifier, context);

  // Only intercept imports from our own compiled code
  const parent = context.parentURL || '';
  if (!parent.includes('/nanoclaw/') && !parent.includes('/nanoclaw-')) {
    return nextResolve(specifier, context);
  }

  const redirect = REDIRECTS[specifier];
  if (redirect) {
    return nextResolve(redirect, context);
  }

  return nextResolve(specifier, context);
}
