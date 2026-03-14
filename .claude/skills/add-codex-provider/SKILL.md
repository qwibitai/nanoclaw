---
name: add-codex-provider
description: Add OpenAI Codex as an alternative LLM provider via ChatGPT OAuth PKCE authentication
---

# Add Codex Provider

Adds OpenAI Codex as an alternative LLM provider for NanoClaw. Uses the ChatGPT Codex Responses API with OAuth PKCE authentication — lets users leverage their ChatGPT Plus/Pro subscription instead of API credits.

## Phase 1: Pre-flight

### Check if already applied

If `src/plugin-loader.ts` and `plugins/codex/host.ts` both exist, skip to Phase 3 (Setup).

### Ask the user

AskUserQuestion: Would you like to use Codex as the default provider, or keep Claude as default?
- **Claude default (Recommended)** — Keeps Claude as default, switch by editing `.env` later
- **Codex default** — Sets `AGENT_PROVIDER=codex` in `.env`

## Phase 2: Apply Code Changes

### 2a. Copy new files

Run the skill applicator to copy the new files:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-codex-provider
```

This adds:
- `packages/codex-oauth/` — OAuth PKCE authentication package (local dependency)
- `src/plugin-loader.ts` — Plugin discovery and loading
- `src/provider-plugin.ts` — ProviderPlugin interface
- `plugins/codex/host.ts` — Host-side OAuth token management (auto-opens browser)
- `plugins/codex/provider-codex.ts` — Container-side Codex API client
- `plugins/codex/types.ts` — Shared type definitions
- `plugins/codex/package.json`, `README.md`, `LICENSE` — Package metadata
- `setup/codex-auth-step.ts` — OAuth setup step

### 2b. Install codex-oauth local package

The `codex-oauth` package is included in `packages/codex-oauth/` (not published to npm). Add it as a local dependency and build it:

```bash
# Add local dependency to package.json
npm install ./packages/codex-oauth

# Build the codex-oauth package (generates dist/ with compiled JS)
cd packages/codex-oauth && npm run build && cd ../..
```

Verify that `"codex-oauth": "file:packages/codex-oauth"` appears in the root `package.json` dependencies.

### 2c. Modify existing files

The following 5 files need small edits to wire up the plugin system. Make each change carefully.

#### 1. `src/config.ts`

**Add `'AGENT_PROVIDER'` to the readEnvFile call.** Find the `readEnvFile([...])` call and add `'AGENT_PROVIDER'` to the array.

**Add provider config at the bottom of the file:**

```typescript
// LLM provider selection (global)
export type AgentProvider = string; // 'claude' | plugin names
export const AGENT_PROVIDER: AgentProvider =
  process.env.AGENT_PROVIDER ||
    envConfig.AGENT_PROVIDER ||
    'claude';
```

#### 2. `src/container-runner.ts`

**Add two imports.** Add `AGENT_PROVIDER` to the existing `./config.js` import, and add a new import:

```typescript
import { getActivePlugin } from './plugin-loader.js';
```

**Add `provider` field to `ContainerInput` interface:**

```typescript
provider?: string;
```

**In `buildVolumeMounts()`, after the agent-runner-src copy block** (after `fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, ...)`), add:

```typescript
  // Copy active plugin's container provider into the agent-runner-src directory
  const plugin = getActivePlugin();
  if (plugin) {
    const pluginProviderSrc = path.join(projectRoot, 'plugins', plugin.name, plugin.containerProvider);
    if (fs.existsSync(pluginProviderSrc) && fs.existsSync(groupAgentRunnerDir)) {
      const providerDst = path.join(groupAgentRunnerDir, plugin.containerProvider);
      fs.copyFileSync(pluginProviderSrc, providerDst);
    }
  }
```

**Change `readSecrets()` from sync to async**, and add plugin secrets:

```typescript
async function readSecrets(): Promise<Record<string, string>> {
  const secrets = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);

  const plugin = getActivePlugin();
  if (plugin) {
    const providerSecrets = await plugin.getSecrets();
    Object.assign(secrets, providerSecrets);
  }

  return secrets;
}
```

**In `runContainerAgent()`**, before the `return new Promise(...)` line, add:

```typescript
  // Read secrets before entering the Promise constructor (readSecrets is async)
  input.secrets = await readSecrets();
  input.provider = AGENT_PROVIDER;
```

And remove the old `input.secrets = readSecrets();` line from inside the Promise (it was sync before).

#### 3. `src/index.ts`

**Add import:**

```typescript
import { loadPlugins } from './plugin-loader.js';
```

**In `main()`, add `await loadPlugins();`** right before the `loadState()` call.

#### 4. `container/agent-runner/src/index.ts`

**Add `provider` field to the `ContainerInput` interface:**

```typescript
provider?: string;
```

**In `main()`, after parsing stdin input and before the Claude SDK code**, add provider routing:

```typescript
  // Provider routing: dispatch to plugin provider if configured
  if (containerInput.provider && containerInput.provider !== 'claude') {
    log(`Using ${containerInput.provider} provider`);
    const mod = await import(`./provider-${containerInput.provider}.js`);
    await mod.runProvider(containerInput);
    return;
  }
```

#### 5. `setup/index.ts`

**Add the codex-auth step to the `STEPS` object:**

```typescript
  'codex-auth': () => import('./codex-auth-step.js'),
```

#### 6. `tsconfig.json`

**Add `"plugins"` to the `include` array** so TypeScript compiles the plugin:

```json
"include": ["src", "setup", "plugins"]
```

### 2d. Validate

```bash
npm run build
```

Build must pass before proceeding. If there are type errors, check that all the edits above were applied correctly.

## Phase 3: Codex OAuth Setup

Run the Codex auth setup step:

```bash
npx tsx setup/index.ts --step codex-auth
```

The browser will **open automatically** for ChatGPT OAuth login. If it doesn't, copy the URL from the terminal.

Parse the status block:

- `AUTH_STATUS=already_authenticated` → Tokens exist, offer to keep or re-authenticate
- `AUTH_STATUS=authenticated` → Success, continue
- `AUTH_STATUS=failed` → Check port 1455 (`lsof -i :1455`), check network, retry

Tell the user:

> A browser window will open for ChatGPT OAuth login. Log in with your ChatGPT Plus/Pro account.

## Phase 4: Configure and Build

### Set provider in .env

If user chose Codex as default:

```bash
echo 'AGENT_PROVIDER=codex' >> .env
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Clear cache and rebuild

```bash
rm -rf data/sessions/*/agent-runner-src/
npm run build
```

### Restart service

macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
Linux: `systemctl --user restart nanoclaw`
Dev mode: `npm run dev`

## Phase 5: Verify

Tell the user to send a test message in their registered chat. Check logs:

```bash
tail -f logs/nanoclaw.log
```

Look for:
- `Using codex provider` — Container dispatch working
- `[codex-provider] Tool-use round 1` — API call successful

If the response comes back, Codex is working.

## Troubleshooting

### "Missing Codex credentials"

Check:
1. `AGENT_PROVIDER=codex` in `.env`
2. `.env` synced to `data/env/env`
3. `data/codex-tokens.json` exists (re-run auth if not)

### Token refresh fails

Re-authenticate:
```bash
npx tsx setup/index.ts --step codex-auth
```

### "Codex API error 400: Instructions are required"

The container provider is outdated. Clear cache:
```bash
rm -rf data/sessions/*/agent-runner-src/
```
Then restart.

### Rate limit (429)

Wait a few minutes. Rate depends on subscription tier (Plus vs Pro).

### Switch back to Claude

Set `AGENT_PROVIDER=claude` in `.env` (or remove the line), sync, restart.

### Stale agent-runner

If container behavior seems wrong:
```bash
rm -rf data/sessions/*/agent-runner-src/
```
Then restart. NanoClaw will re-copy the provider files.

## Supported Models

The default model is `gpt-5.1-codex`. To use a different model, edit `plugins/codex/provider-codex.ts` and change `DEFAULT_MODEL`.

Available models:
- `gpt-5.2-codex` — Newest (supports xhigh reasoning)
- `gpt-5.1-codex` — Standard (default)
- `gpt-5.1-codex-max` — Max reasoning (supports xhigh)
- `gpt-5.1-codex-mini` — Lightweight (medium/high only)
- `gpt-5.2` — General purpose
- `gpt-5.1` — General purpose

## Removal

1. Set `AGENT_PROVIDER=claude` in `.env` (or remove the line)
2. Remove `plugins/codex/` directory
3. Remove `setup/codex-auth-step.ts`
4. Remove `'codex-auth'` entry from `setup/index.ts` STEPS
5. Remove `src/plugin-loader.ts` and `src/provider-plugin.ts` (if no other plugins use them)
6. Revert the 5 core file edits (optional — they are harmless without plugins)
7. Optionally remove `data/codex-tokens.json`
8. Rebuild: `npm run build`
9. Restart service
