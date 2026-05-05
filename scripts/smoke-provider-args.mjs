#!/usr/bin/env node
// Smoke test for buildProviderArgs(): verifies the helper produces the
// expected env + --add-host args for each provider mode without spawning
// any container. Re-implements buildProviderArgs inline so this script can
// run against the published types without importing the .ts source.

const cases = [
  {
    name: 'default (provider undefined)',
    config: undefined,
    expectEnv: {},
    expectHosts: [],
  },
  {
    name: 'provider=anthropic explicit',
    config: { provider: 'anthropic' },
    expectEnv: {},
    expectHosts: [],
  },
  {
    name: 'provider=ollama with RunPod URL',
    config: {
      provider: 'ollama',
      ollama: {
        baseUrl: 'https://qggwu1g2nyt6dw-11434.proxy.runpod.net',
        model: 'llama3.2:latest',
      },
    },
    expectEnv: {
      ANTHROPIC_BASE_URL: 'https://qggwu1g2nyt6dw-11434.proxy.runpod.net',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      NO_PROXY: 'qggwu1g2nyt6dw-11434.proxy.runpod.net',
      no_proxy: 'qggwu1g2nyt6dw-11434.proxy.runpod.net',
    },
    expectHosts: ['api.anthropic.com'],
  },
  {
    name: 'provider=ollama + custom blockedHosts overlay',
    config: {
      provider: 'ollama',
      ollama: {
        baseUrl: 'http://host.docker.internal:11434',
        model: 'qwen2.5:32b',
      },
      blockedHosts: ['api.openai.com', 'generativelanguage.googleapis.com'],
    },
    expectEnv: {
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      NO_PROXY: 'host.docker.internal',
      no_proxy: 'host.docker.internal',
    },
    expectHosts: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'],
  },
  {
    name: 'env overlay overrides provider auto-derived',
    config: {
      provider: 'ollama',
      ollama: { baseUrl: 'http://x:11434', model: 'm', apiKey: 'foo' },
      env: { ANTHROPIC_AUTH_TOKEN: 'override' },
    },
    expectEnv: {
      ANTHROPIC_BASE_URL: 'http://x:11434',
      ANTHROPIC_AUTH_TOKEN: 'override',
      NO_PROXY: 'x',
      no_proxy: 'x',
    },
    expectHosts: ['api.anthropic.com'],
  },
];

// Inlined copy of buildProviderArgs() — keep in sync with src/container-runner.ts.
function buildProviderArgs(containerConfig) {
  const env = {};
  const blockedHosts = new Set();

  if (containerConfig?.provider === 'ollama' && containerConfig.ollama) {
    const { baseUrl, apiKey } = containerConfig.ollama;
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = apiKey ?? 'ollama';
    let host = null;
    try { host = new URL(baseUrl).hostname; } catch { /* skip */ }
    if (host) {
      env.NO_PROXY = host;
      env.no_proxy = host;
    }
    blockedHosts.add('api.anthropic.com');
  }

  if (containerConfig?.env) Object.assign(env, containerConfig.env);
  for (const h of containerConfig?.blockedHosts ?? []) blockedHosts.add(h);

  const envArgs = [];
  for (const [k, v] of Object.entries(env)) envArgs.push('-e', `${k}=${v}`);
  const addHostArgs = [];
  for (const h of blockedHosts) addHostArgs.push('--add-host', `${h}:127.0.0.1`);
  return { envArgs, addHostArgs, env, blockedHosts: [...blockedHosts] };
}

let pass = 0, fail = 0;
for (const c of cases) {
  const got = buildProviderArgs(c.config);
  const envOk = JSON.stringify(got.env) === JSON.stringify(c.expectEnv);
  const hostsOk = JSON.stringify(got.blockedHosts.sort()) === JSON.stringify([...c.expectHosts].sort());
  if (envOk && hostsOk) {
    console.log(`PASS  ${c.name}`);
    pass++;
  } else {
    console.log(`FAIL  ${c.name}`);
    if (!envOk) console.log(`  env expected: ${JSON.stringify(c.expectEnv)}\n  env got:      ${JSON.stringify(got.env)}`);
    if (!hostsOk) console.log(`  hosts expected: ${JSON.stringify(c.expectHosts)}\n  hosts got:      ${JSON.stringify(got.blockedHosts)}`);
    fail++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
