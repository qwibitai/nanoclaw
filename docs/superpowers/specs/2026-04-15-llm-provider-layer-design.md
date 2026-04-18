# LLM Provider Layer — Design Spec

> Sub-project 1 of NanoClaw scope expansion. Adds multi-LLM support via a dual-runtime agent architecture: claude-agent-sdk for Claude models, Vercel AI SDK for everything else.

## Goal

Enable NanoClaw agent containers to run on any LLM provider — not just Claude — while preserving the full claude-agent-sdk feature set (session resumption, hooks, agent teams) when using Anthropic models. Cheaper/faster models handle routine tasks; Claude handles complex ones.

## Architecture

Dual-runtime approach inside `container/agent-runner/`. The host orchestrator (`src/index.ts`) resolves which provider and model to use, then passes that to the container. Inside the container, the runner branches:

- **Claude path** → existing `query()` from `@anthropic-ai/claude-agent-sdk` (unchanged)
- **Non-Claude path** → `generateText()` from Vercel AI SDK with tool bridging, session persistence, and agentic loop

Provider configuration lives in per-group settings. Auto-escalation upgrades cheap models to stronger ones based on message complexity.

## Tech Stack

- `ai` (Vercel AI SDK core) — provider-agnostic `generateText`, tool definitions
- `@ai-sdk/anthropic` — Anthropic provider (for utility LLM, not agent runtime)
- `@ai-sdk/openai` — OpenAI + compatible providers (Ollama, Groq, Together)
- `@ai-sdk/google` — Google Gemini
- `zod` — tool parameter schemas

---

## Section 1: Agent Runner Dual-Runtime

### Decision

Keep `@anthropic-ai/claude-agent-sdk` for Claude models. Use Vercel AI SDK `generateText()` for all other providers. The runner branches based on the `provider` field in ContainerInput.

### Why dual-runtime instead of all-Vercel

Claude Agent SDK provides session resumption (`.jsonl` transcript files), pre-compact hooks (conversation archival), agent teams (subagent dispatch), and MCP server auto-discovery — none of which exist in Vercel AI SDK. Rewriting these would be months of work with no benefit. For non-Claude models, Vercel AI SDK's `generateText()` with `maxSteps` provides a clean agentic loop with native tool calling.

### ContainerInput changes

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  verbose?: boolean;
  // New fields
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'groq' | 'together';
  model?: string;           // e.g. 'gpt-4o', 'gemini-2.0-flash', 'llama3:70b'
  providerBaseUrl?: string;  // For OpenAI-compatible endpoints
}
```

### Branching logic

```typescript
// In container/agent-runner/src/index.ts main()
const provider = containerInput.provider ?? 'anthropic';

if (provider === 'anthropic') {
  // Existing claude-agent-sdk path — unchanged
  await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv);
} else {
  // Vercel AI SDK path
  const result = await runVercelQuery(prompt, containerInput);
  writeOutput(result);
}
```

### What each runtime handles

| Feature | Claude (claude-agent-sdk) | Non-Claude (Vercel AI SDK) |
|---------|--------------------------|----------------------------|
| Agent loop | `query()` with `MessageStream` | `generateText()` with `maxSteps: 50` |
| Session files | `.jsonl` transcript + session resumption | `CoreMessage[]` JSON files |
| Hooks | `preCompact`, `preToolUse` | Custom pre-tool-use check |
| Tools | MCP auto-discovery + IPC | Zod-schema tool definitions + IPC bridge |
| Subagents | Agent teams (built-in) | Not supported (escalate to Claude instead) |
| Model escalation | In-SDK (Sonnet → Opus via Agent tool) | Host-side auto-escalation only |

---

## Section 2: Provider Configuration

### Per-group settings

Groups configure their default provider and model in `groups/{name}/config.json`:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "escalationModel": "gpt-4o",
    "providerBaseUrl": null
  }
}
```

All fields are optional. Defaults:
- `provider`: `"anthropic"`
- `model`: `null` (uses provider default — Sonnet for Claude, gpt-4o-mini for OpenAI)
- `escalationModel`: `null` (uses provider's strongest — Opus for Claude, gpt-4o for OpenAI)
- `providerBaseUrl`: `null` (uses official API endpoint)

### Per-task override

Scheduled tasks and IPC can override the model:

```json
{
  "type": "switch_model",
  "provider": "google",
  "model": "gemini-2.0-flash"
}
```

This is a new IPC message type. The host reads it and passes provider/model to the next container spawn for that group.

### API key routing via OneCLI

API keys are injected by OneCLI at container spawn time. The host resolves which env var name to pass based on the provider:

| Provider | Env Var | OneCLI Key |
|----------|---------|------------|
| `anthropic` | `ANTHROPIC_API_KEY` | Existing (already injected) |
| `openai` | `OPENAI_API_KEY` | `OPENAI_API_KEY` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `GOOGLE_AI_KEY` |
| `groq` | `GROQ_API_KEY` | `GROQ_API_KEY` |
| `together` | `TOGETHER_AI_API_KEY` | `TOGETHER_API_KEY` |
| `ollama` | (none — local) | N/A |

For Ollama, `providerBaseUrl` defaults to `http://host.docker.internal:11434/v1`.

### Host-side resolution

```typescript
// In src/llm/provider.ts
export function resolveModel(
  group: RegisteredGroup,
  override?: { provider?: string; model?: string },
): { provider: string; model: string | null; providerBaseUrl: string | null } {
  const groupConfig = group.config?.llm ?? {};
  return {
    provider: override?.provider ?? groupConfig.provider ?? 'anthropic',
    model: override?.model ?? groupConfig.model ?? null,
    providerBaseUrl: groupConfig.providerBaseUrl ?? null,
  };
}
```

---

## Section 3: Utility LLM Service

In-process utility functions for non-agent LLM tasks. These run in the host process (`src/llm/utility.ts`), not in containers.

### Functions

```typescript
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

export async function classify(
  text: string,
  categories: string[],
  options?: { model?: string },
): Promise<string> {
  // Uses cheapest available model (gpt-4o-mini or gemini-2.0-flash)
  // Returns one of the category strings
}

export async function generateShort(
  prompt: string,
  options?: { model?: string; maxTokens?: number },
): Promise<string> {
  // Short text generation for summaries, labels, etc.
  // Default maxTokens: 200
}

export async function embedText(
  text: string,
  options?: { model?: string },
): Promise<number[]> {
  // Text embedding via OpenAI text-embedding-3-small or similar
  // Returns float vector
}
```

### Use cases

- **Stagehand element resolution**: `classify()` to pick UI elements when browser sidecar needs LLM assist
- **Email triage classification**: `classify()` for urgency/category in email intelligence pipeline
- **Rule summarization**: `generateShort()` for learning system rule descriptions
- **Future semantic search**: `embedText()` for Mem0/Qdrant (Sub-project 3)

### Provider selection

Utility functions default to the cheapest fast model available. Resolution order:
1. Explicit `model` option
2. `UTILITY_LLM_MODEL` env var (e.g. `openai:gpt-4o-mini`)
3. OpenAI `gpt-4o-mini` if `OPENAI_API_KEY` is set
4. Google `gemini-2.0-flash` if `GOOGLE_AI_KEY` is set
5. Error if no provider configured

---

## Section 4: Agent Runner Implementation (Vercel AI SDK Path)

### File: `container/agent-runner/src/vercel-runner.ts`

The non-Claude agent loop. Handles tool calling, IPC bridging, session persistence, and output formatting.

### Provider factory

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

function createProviderFactory(
  provider: string,
  baseUrl?: string | null,
) {
  switch (provider) {
    case 'openai':
    case 'groq':
    case 'together':
    case 'ollama':
      return createOpenAI({
        apiKey: process.env.OPENAI_API_KEY
          ?? process.env.GROQ_API_KEY
          ?? process.env.TOGETHER_AI_API_KEY
          ?? 'ollama',
        baseURL: baseUrl ?? undefined,
      });
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
```

### Agent loop

```typescript
export async function runVercelQuery(
  prompt: string,
  containerInput: ContainerInput,
): Promise<ContainerOutput> {
  const provider = createProvider(
    containerInput.provider!,
    containerInput.providerBaseUrl,
  );
  const model = provider(containerInput.model ?? 'gpt-4o-mini');
  const tools = buildToolSet(containerInput);
  const sessionMessages = loadSession(containerInput);

  const messages: CoreMessage[] = [
    ...sessionMessages,
    { role: 'user', content: prompt },
  ];

  const systemPrompt = buildSystemPrompt(containerInput);

  const result = await generateText({
    model,
    system: systemPrompt,
    messages,
    tools,
    maxSteps: 50,
    onStepFinish: ({ toolCalls }) => {
      for (const tc of toolCalls ?? []) {
        const label = formatToolLabel(tc.toolName, tc.args);
        writeOutput({
          status: 'success',
          result: null,
          progressLabel: label,
        });
      }
    },
  });

  const allMessages = [...messages, ...result.response.messages];
  saveSession(containerInput, allMessages);

  return {
    status: 'success',
    result: result.text,
    usage: {
      input_tokens: result.usage?.promptTokens,
      output_tokens: result.usage?.completionTokens,
    },
    numTurns: result.steps.length,
  };
}
```

### MCP tool bridging

Existing MCP servers are mounted into the container and discovered by claude-agent-sdk. For the Vercel path, MCP tools are connected via `experimental_createMCPClient()`:

```typescript
import { experimental_createMCPClient as createMCPClient } from 'ai';

async function connectMcpTools(
  mcpServerPath: string,
): Promise<Record<string, CoreTool>> {
  const mcpConfig = JSON.parse(
    fs.readFileSync(mcpServerPath, 'utf-8'),
  );

  const allTools: Record<string, CoreTool> = {};

  for (const [name, config] of Object.entries(mcpConfig.mcpServers)) {
    const client = await createMCPClient({
      transport: inferTransport(config),
    });
    const tools = await client.tools();
    Object.assign(allTools, tools);
  }

  return allTools;
}
```

### IPC tool bridging

IPC tools (send_message, schedule, relay_message, browser actions, learn_feedback) are registered as Vercel AI SDK `tool()` definitions:

```typescript
import { tool } from 'ai';
import { z } from 'zod';

function buildIpcTools(): Record<string, CoreTool> {
  return {
    send_message: tool({
      description: 'Send a message to the chat',
      parameters: z.object({
        text: z.string().describe('Message text to send'),
      }),
      execute: async ({ text }) => {
        writeIpcOutput({ type: 'send_message', text });
        return { success: true };
      },
    }),

    schedule: tool({
      description: 'Schedule a task for later execution',
      parameters: z.object({
        when: z.string().describe('When to run (cron expression or relative time)'),
        prompt: z.string().describe('Task prompt'),
        label: z.string().optional().describe('Human-readable label'),
      }),
      execute: async ({ when, prompt, label }) => {
        writeIpcOutput({ type: 'schedule', when, prompt, label });
        return { success: true };
      },
    }),

    relay_message: tool({
      description: 'Relay a message to the main group channel',
      parameters: z.object({
        text: z.string().describe('Message to relay'),
      }),
      execute: async ({ text }) => {
        writeIpcOutput({ type: 'relay_message', text });
        return { success: true };
      },
    }),

    learn_feedback: tool({
      description: 'Record a learned rule from this interaction',
      parameters: z.object({
        rule: z.string().describe('The rule or pattern learned'),
        source: z.enum(['user_feedback', 'outcome_pattern', 'agent_reported']),
      }),
      execute: async ({ rule, source }) => {
        writeIpcOutput({ type: 'learn_feedback', rule, source });
        return { success: true };
      },
    }),
  };
}
```

### Pre-tool-use trust check

Before executing tools that modify external state, the Vercel runner checks with the trust gateway (same as claude-agent-sdk's `preToolUse` hook):

```typescript
async function checkTrust(
  toolName: string,
  toolInput: Record<string, unknown>,
  chatJid: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const trustUrl = process.env.TRUST_GATEWAY_URL ?? 'http://host.docker.internal:10255';
  const resp = await fetch(`${trustUrl}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: toolName, input: toolInput, chatJid }),
  });
  return resp.json();
}
```

This is wired into each tool's `execute` function for write-class tools. Read-only tools skip the check.

### Session persistence

```typescript
// File: container/agent-runner/src/session-store.ts

const SESSION_DIR = '/workspace/group/sessions/vercel';

export function loadSession(input: ContainerInput): CoreMessage[] {
  if (!input.sessionId) return [];
  const filePath = path.join(SESSION_DIR, `${input.sessionId}.json`);
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function saveSession(
  input: ContainerInput,
  messages: CoreMessage[],
): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const sessionId = input.sessionId ?? crypto.randomUUID();
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);

  // Trim to last 100 messages to bound file size
  const trimmed = messages.slice(-100);
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));

  return sessionId;
}
```

Claude's `.jsonl` session files are managed by the SDK. Vercel sessions use a simpler JSON array of `CoreMessage[]`.

### System prompt construction

The Vercel runner builds a system prompt from:
1. Group's `CLAUDE.md` (instructions, personality)
2. Global `CLAUDE.md` (shared rules)
3. Learning system rules block (injected by host via enriched prompt)
4. Container skill instructions (`container/skills/*/SKILL.md`)

This mirrors what claude-agent-sdk does automatically via its CLAUDE.md discovery.

### Output format

Both runtimes produce identical `ContainerOutput` JSON. The host doesn't know or care which runtime ran — it parses the same `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` framing.

---

## Section 5: Auto-Escalation

### Purpose

Automatically upgrade a cheap default model to a stronger one when the message appears complex. Prevents users from manually switching models for every hard question.

### Complexity scoring

```typescript
// File: src/llm/escalation.ts

interface EscalationResult {
  shouldEscalate: boolean;
  reason?: string;
  score: number;
}

export function scoreComplexity(message: string): EscalationResult {
  let score = 0;
  const reasons: string[] = [];

  // Length signals
  if (message.length > 500) { score += 2; reasons.push('long message'); }
  if (message.length > 2000) { score += 3; reasons.push('very long message'); }

  // Code signals
  if (/```/.test(message)) { score += 3; reasons.push('code block'); }
  if (/\b(function|class|import|export|const|let|var)\b/.test(message)) {
    score += 2; reasons.push('code keywords');
  }

  // Technical depth signals
  if (/\b(debug|fix|refactor|architect|design|security|vulnerability)\b/i.test(message)) {
    score += 2; reasons.push('technical keywords');
  }
  if (/\b(analyze|compare|evaluate|trade-?off)\b/i.test(message)) {
    score += 2; reasons.push('analysis keywords');
  }

  // Multi-part signals
  const questionMarks = (message.match(/\?/g) || []).length;
  if (questionMarks >= 3) { score += 2; reasons.push('multi-question'); }

  // File references
  const fileRefs = (message.match(/\b[\w/-]+\.\w{1,5}\b/g) || []).length;
  if (fileRefs >= 3) { score += 2; reasons.push('multi-file reference'); }

  const shouldEscalate = score >= 5;
  return {
    shouldEscalate,
    reason: shouldEscalate ? reasons.join(', ') : undefined,
    score,
  };
}
```

### Escalation flow

1. Host receives message, resolves group's default provider/model
2. `scoreComplexity(message)` runs
3. If `shouldEscalate` and group has `escalationModel` configured:
   - Override model to `escalationModel` for this task only
   - Log the escalation reason
4. Pass resolved provider/model to container

### Configuration

Each group can set `escalationModel` in config. If not set, the provider's strongest model is used:

| Provider | Default Model | Escalation Model |
|----------|--------------|-----------------|
| `anthropic` | `claude-sonnet-4-6` | `claude-opus-4-6` |
| `openai` | `gpt-4o-mini` | `gpt-4o` |
| `google` | `gemini-2.0-flash` | `gemini-2.5-pro` |
| `ollama` | (user-configured) | (user-configured) |

### Threshold

The score threshold of 5 means a message needs at least 2-3 complexity signals to trigger escalation. Single signals (one code block, or just being long) don't escalate. This prevents unnecessary cost increases for simple messages that happen to contain code.

---

## Section 6: Package Changes and Container Build

### New dependencies in `container/agent-runner/package.json`

```json
{
  "ai": "^4.3",
  "@ai-sdk/openai": "^1.3",
  "@ai-sdk/google": "^1.2",
  "zod": "^3.24"
}
```

The container only needs OpenAI and Google providers (plus `ai` core). `@ai-sdk/anthropic` is host-side only (utility LLM service) since the container uses claude-agent-sdk directly for Claude models.

### New dependencies in root `package.json`

```json
{
  "ai": "^4.3",
  "@ai-sdk/openai": "^1.3",
  "@ai-sdk/google": "^1.2",
  "@ai-sdk/anthropic": "^1.2",
  "zod": "^3.24"
}
```

Root needs these for the utility LLM service (`src/llm/utility.ts`) and provider resolution (`src/llm/provider.ts`).

### Environment variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENAI_API_KEY` | OpenAI/compatible providers | If using OpenAI/Groq/Together |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini | If using Google |
| `GROQ_API_KEY` | Groq (overrides OPENAI_API_KEY for Groq) | If using Groq |
| `TOGETHER_AI_API_KEY` | Together AI | If using Together |
| `UTILITY_LLM_MODEL` | Default model for utility functions | No (auto-detected) |

All keys are managed by OneCLI and injected at runtime. No keys are stored in `.env` or committed.

### Container build changes

The `container/Dockerfile` needs no structural changes — `npm install` already picks up `package.json` dependencies. The only change is ensuring env vars are passed through in `container-runner.ts`:

```typescript
// In src/container-runner.ts, add to env block:
...(containerInput.provider !== 'anthropic' ? {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TOGETHER_AI_API_KEY: process.env.TOGETHER_AI_API_KEY,
} : {}),
```

### New file structure

```
src/
  llm/
    provider.ts          # resolveModel(), provider defaults
    utility.ts           # embedText(), classify(), generateShort()
    escalation.ts        # scoreComplexity(), threshold logic
    provider.test.ts
    utility.test.ts
    escalation.test.ts
container/agent-runner/src/
    vercel-runner.ts     # Vercel AI SDK agent loop
    tool-bridge.ts       # IPC tools as Zod-schema tool() defs
    session-store.ts     # CoreMessage[] JSON persistence
    vercel-runner.test.ts
    tool-bridge.test.ts
    session-store.test.ts
```

### Testing strategy

- Unit tests for `resolveModel()`, `scoreComplexity()`, `loadSession()`/`saveSession()`, tool bridge definitions
- Integration test: mock Vercel AI SDK's `generateText()` to verify the agent loop produces correct `ContainerOutput`
- Manual test: configure a test group with `openai/gpt-4o-mini`, send messages, verify responses route correctly
- Existing claude-agent-sdk tests remain unchanged — the Claude path is not modified

---

## Scope Boundaries

### In scope
- Dual-runtime agent runner (claude-agent-sdk + Vercel AI SDK)
- Per-group provider/model configuration
- IPC and MCP tool bridging for Vercel path
- Session persistence for Vercel path
- Auto-escalation heuristics
- Utility LLM service (host-side)
- Trust gateway integration for Vercel path

### Out of scope (future sub-projects)
- Browser Act integration (Sub-project 2)
- Mem0 + Qdrant semantic memory (Sub-project 3)
- Model routing intelligence / cost optimization (Sub-project 4)
- Streaming responses (batch-only for v1)
- Agent teams / subagent support in Vercel path
- Vision / multimodal input
- Fine-tuned model support
