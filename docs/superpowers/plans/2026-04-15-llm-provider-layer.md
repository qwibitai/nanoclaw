# LLM Provider Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable NanoClaw agent containers to run on any LLM provider (OpenAI, Google, Ollama, Groq, Together) via Vercel AI SDK, while preserving claude-agent-sdk for Claude models.

**Architecture:** Dual-runtime agent runner — the host resolves provider/model per group, passes it to the container. Inside the container, `provider === 'anthropic'` routes to existing `query()`, everything else routes to Vercel AI SDK `generateText()` with tool bridging. Host-side utility LLM service handles classification, short generation, and embeddings.

**Tech Stack:** `ai` (Vercel AI SDK), `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, `zod`, existing `@anthropic-ai/claude-agent-sdk`

**Spec:** `docs/superpowers/specs/2026-04-15-llm-provider-layer-design.md`

---

## File Structure

### New files

| File | Purpose |
|------|---------|
| `src/llm/provider.ts` | `resolveModel()` — resolves provider/model from group config + overrides |
| `src/llm/escalation.ts` | `scoreComplexity()` — keyword heuristics for auto-escalation |
| `src/llm/utility.ts` | `classify()`, `generateShort()`, `embedText()` — in-process utility LLM |
| `src/llm/provider.test.ts` | Tests for provider resolution |
| `src/llm/escalation.test.ts` | Tests for complexity scoring |
| `src/llm/utility.test.ts` | Tests for utility LLM functions |
| `container/agent-runner/src/vercel-runner.ts` | Vercel AI SDK agent loop with `generateText()` |
| `container/agent-runner/src/tool-bridge.ts` | IPC tools as Zod-schema `tool()` definitions |
| `container/agent-runner/src/session-store.ts` | `CoreMessage[]` JSON session persistence |

### Modified files

| File | Changes |
|------|---------|
| `src/container-runner.ts:49-59` | Add `provider`, `model`, `providerBaseUrl` to `ContainerInput` |
| `src/container-runner.ts:518-684` | Pass provider env vars in `buildContainerArgs()` |
| `src/index.ts:584-601` | Call `resolveModel()` + `scoreComplexity()`, pass provider/model to container |
| `src/types.ts:30-33` | Add `llm?` field to `ContainerConfig` |
| `container/agent-runner/src/index.ts:623-773` | Branch on provider: Claude path stays, non-Claude calls `runVercelQuery()` |
| `container/agent-runner/package.json` | Add `ai`, `@ai-sdk/openai`, `@ai-sdk/google` |
| `package.json` | Add `ai`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic` |

---

### Task 1: Host-Side Provider Resolution

**Files:**
- Create: `src/llm/provider.ts`
- Create: `src/llm/provider.test.ts`
- Modify: `src/types.ts:30-33`

- [ ] **Step 1: Write the failing test for `resolveModel`**

```typescript
// src/llm/provider.test.ts
import { describe, it, expect } from 'vitest';
import { resolveModel, LlmConfig } from './provider.js';

describe('resolveModel', () => {
  it('defaults to anthropic with null model when no config', () => {
    const result = resolveModel({});
    expect(result).toEqual({
      provider: 'anthropic',
      model: null,
      providerBaseUrl: null,
    });
  });

  it('uses group config when provided', () => {
    const llm: LlmConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    const result = resolveModel({ llm });
    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      providerBaseUrl: null,
    });
  });

  it('override takes precedence over group config', () => {
    const llm: LlmConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    const result = resolveModel({ llm }, { provider: 'google', model: 'gemini-2.0-flash' });
    expect(result).toEqual({
      provider: 'google',
      model: 'gemini-2.0-flash',
      providerBaseUrl: null,
    });
  });

  it('preserves providerBaseUrl from group config', () => {
    const llm: LlmConfig = {
      provider: 'ollama',
      model: 'llama3:70b',
      providerBaseUrl: 'http://localhost:11434/v1',
    };
    const result = resolveModel({ llm });
    expect(result).toEqual({
      provider: 'ollama',
      model: 'llama3:70b',
      providerBaseUrl: 'http://localhost:11434/v1',
    });
  });

  it('partial override merges with group config', () => {
    const llm: LlmConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    const result = resolveModel({ llm }, { model: 'gpt-4o' });
    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      providerBaseUrl: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/provider.test.ts`
Expected: FAIL — module `./provider.js` does not exist

- [ ] **Step 3: Add `LlmConfig` to `ContainerConfig` in `src/types.ts`**

Add after line 33 (after `ContainerConfig` closing brace), and modify `ContainerConfig`:

```typescript
// Add to src/types.ts — insert before the ContainerConfig interface

export interface LlmConfig {
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'groq' | 'together';
  model?: string;
  escalationModel?: string;
  providerBaseUrl?: string;
}
```

Then add `llm?: LlmConfig;` inside `ContainerConfig`:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  llm?: LlmConfig;
}
```

- [ ] **Step 4: Implement `resolveModel`**

```typescript
// src/llm/provider.ts
import type { LlmConfig } from '../types.js';

export type { LlmConfig };

export interface ResolvedModel {
  provider: string;
  model: string | null;
  providerBaseUrl: string | null;
}

export function resolveModel(
  config: { llm?: LlmConfig },
  override?: { provider?: string; model?: string },
): ResolvedModel {
  const llm = config.llm ?? {};
  return {
    provider: override?.provider ?? llm.provider ?? 'anthropic',
    model: override?.model ?? llm.model ?? null,
    providerBaseUrl: llm.providerBaseUrl ?? null,
  };
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
};

const ESCALATION_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.5-pro',
};

export function getDefaultModel(provider: string): string | null {
  return DEFAULT_MODELS[provider] ?? null;
}

export function getEscalationModel(provider: string): string | null {
  return ESCALATION_MODELS[provider] ?? null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/llm/provider.test.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/llm/provider.ts src/llm/provider.test.ts src/types.ts
git commit -m "feat(llm): add provider resolution with LlmConfig type"
```

---

### Task 2: Auto-Escalation Scoring

**Files:**
- Create: `src/llm/escalation.ts`
- Create: `src/llm/escalation.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/llm/escalation.test.ts
import { describe, it, expect } from 'vitest';
import { scoreComplexity } from './escalation.js';

describe('scoreComplexity', () => {
  it('returns low score for simple messages', () => {
    const result = scoreComplexity('hello');
    expect(result.shouldEscalate).toBe(false);
    expect(result.score).toBeLessThan(5);
  });

  it('returns low score for short questions', () => {
    const result = scoreComplexity('what time is it?');
    expect(result.shouldEscalate).toBe(false);
  });

  it('escalates messages with code blocks and technical keywords', () => {
    const msg = `Can you debug this function?
\`\`\`typescript
function broken() {
  return undefined;
}
\`\`\`
It should return a string but it returns undefined. Fix the security vulnerability too.`;
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(5);
    expect(result.reason).toBeDefined();
  });

  it('escalates very long messages', () => {
    const msg = 'a'.repeat(2100);
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
  });

  it('escalates multi-question messages', () => {
    const msg = 'What is X? How does Y work? Can you explain Z? What about W?';
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
  });

  it('does not escalate single code block without other signals', () => {
    const msg = '```\nconst x = 1;\n```';
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(false);
    expect(result.score).toBe(3);
  });

  it('escalates messages with multiple file references and code keywords', () => {
    const msg = 'Refactor src/index.ts, src/config.ts, src/types.ts to use the new import pattern';
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
  });

  it('includes reasons when escalating', () => {
    const msg = `\`\`\`typescript
function debug() {}
\`\`\`
Can you debug this? And fix the security issue? Also analyze the trade-off?`;
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('code block');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/escalation.test.ts`
Expected: FAIL — module `./escalation.js` does not exist

- [ ] **Step 3: Implement `scoreComplexity`**

```typescript
// src/llm/escalation.ts
export interface EscalationResult {
  shouldEscalate: boolean;
  reason?: string;
  score: number;
}

export function scoreComplexity(message: string): EscalationResult {
  let score = 0;
  const reasons: string[] = [];

  if (message.length > 500) {
    score += 2;
    reasons.push('long message');
  }
  if (message.length > 2000) {
    score += 3;
    reasons.push('very long message');
  }

  if (/```/.test(message)) {
    score += 3;
    reasons.push('code block');
  }
  if (/\b(function|class|import|export|const|let|var)\b/.test(message)) {
    score += 2;
    reasons.push('code keywords');
  }

  if (
    /\b(debug|fix|refactor|architect|design|security|vulnerability)\b/i.test(
      message,
    )
  ) {
    score += 2;
    reasons.push('technical keywords');
  }
  if (/\b(analyze|compare|evaluate|trade-?off)\b/i.test(message)) {
    score += 2;
    reasons.push('analysis keywords');
  }

  const questionMarks = (message.match(/\?/g) || []).length;
  if (questionMarks >= 3) {
    score += 2;
    reasons.push('multi-question');
  }

  const fileRefs = (message.match(/\b[\w/-]+\.\w{1,5}\b/g) || []).length;
  if (fileRefs >= 3) {
    score += 2;
    reasons.push('multi-file reference');
  }

  const shouldEscalate = score >= 5;
  return {
    shouldEscalate,
    reason: shouldEscalate ? reasons.join(', ') : undefined,
    score,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/llm/escalation.test.ts`
Expected: PASS — all 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/llm/escalation.ts src/llm/escalation.test.ts
git commit -m "feat(llm): add auto-escalation complexity scoring"
```

---

### Task 3: Session Store for Vercel AI SDK Path

**Files:**
- Create: `container/agent-runner/src/session-store.ts`
- Create: `container/agent-runner/src/session-store.test.ts`

Note: The agent runner uses plain TypeScript (no vitest — it has no test runner configured). Tests for this module should be added to the host's vitest suite by mocking `fs`. However, since the container's `package.json` has no test runner, we'll write these tests in the host test suite at `src/llm/session-store.test.ts` using the same code but importing via path alias. **Actually**, the simplest approach: write the session-store as a standalone module with no external dependencies beyond `fs`, `path`, and `crypto`, and test it in the host vitest suite with fs mocking.

- [ ] **Step 1: Write the failing tests in the host test suite**

```typescript
// src/llm/session-store.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('session-store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saveSession creates session file and returns sessionId', async () => {
    // Dynamically import to avoid module resolution issues
    const { saveSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const sessionId = saveSession(tempDir, null, messages);
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const filePath = path.join(tempDir, `${sessionId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(saved).toHaveLength(2);
    expect(saved[0].role).toBe('user');
  });

  it('loadSession returns empty array for missing session', async () => {
    const { loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const messages = loadSession(tempDir, 'nonexistent-id');
    expect(messages).toEqual([]);
  });

  it('loadSession returns saved messages', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const original = [
      { role: 'user', content: 'test message' },
      { role: 'assistant', content: 'test response' },
    ];
    const sessionId = saveSession(tempDir, null, original);
    const loaded = loadSession(tempDir, sessionId);
    expect(loaded).toEqual(original);
  });

  it('saveSession trims to last 100 messages', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const messages = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));
    const sessionId = saveSession(tempDir, null, messages);
    const loaded = loadSession(tempDir, sessionId);
    expect(loaded).toHaveLength(100);
    expect(loaded[0].content).toBe('message 20');
  });

  it('saveSession reuses existing sessionId', async () => {
    const { saveSession, loadSession } = await import(
      '../../container/agent-runner/src/session-store.js'
    );
    const id = saveSession(tempDir, null, [{ role: 'user', content: 'first' }]);
    saveSession(tempDir, id, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
    const loaded = loadSession(tempDir, id);
    expect(loaded).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/session-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement session store**

```typescript
// container/agent-runner/src/session-store.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface SessionMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

const MAX_SESSION_MESSAGES = 100;

export function loadSession(
  sessionDir: string,
  sessionId: string | null | undefined,
): SessionMessage[] {
  if (!sessionId) return [];
  const filePath = path.join(sessionDir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveSession(
  sessionDir: string,
  sessionId: string | null | undefined,
  messages: SessionMessage[],
): string {
  fs.mkdirSync(sessionDir, { recursive: true });
  const id = sessionId ?? crypto.randomUUID();
  const filePath = path.join(sessionDir, `${id}.json`);
  const trimmed = messages.slice(-MAX_SESSION_MESSAGES);
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/llm/session-store.test.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/session-store.ts src/llm/session-store.test.ts
git commit -m "feat(llm): add Vercel AI SDK session store"
```

---

### Task 4: IPC Tool Bridge for Vercel AI SDK

**Files:**
- Create: `container/agent-runner/src/tool-bridge.ts`
- Create: `src/llm/tool-bridge.test.ts`

The agent runner writes IPC messages as JSON files to `/workspace/ipc/messages/` (for send_message) and `/workspace/ipc/tasks/` (for schedule). The host polls these directories. For the Vercel path, we define tools using Zod schemas that write the same JSON files.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/llm/tool-bridge.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('tool-bridge', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tools-test-'));
    fs.mkdirSync(path.join(tempDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'tasks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('buildIpcTools returns tool definitions with correct names', async () => {
    const { buildIpcTools } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );
    const tools = buildIpcTools(tempDir, 'test-jid', 'test-group');
    expect(Object.keys(tools)).toContain('send_message');
    expect(Object.keys(tools)).toContain('schedule');
    expect(Object.keys(tools)).toContain('relay_message');
    expect(Object.keys(tools)).toContain('learn_feedback');
  });

  it('send_message tool writes JSON file to messages dir', async () => {
    const { buildIpcTools } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );
    const tools = buildIpcTools(tempDir, 'chat@jid', 'test-group');
    const result = await tools.send_message.execute(
      { text: 'hello world' },
      { toolCallId: 'tc1', messages: [], abortSignal: undefined as any },
    );
    expect(result).toEqual({ success: true });

    const files = fs.readdirSync(path.join(tempDir, 'messages'));
    expect(files).toHaveLength(1);
    const data = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'messages', files[0]), 'utf-8'),
    );
    expect(data.type).toBe('message');
    expect(data.text).toBe('hello world');
    expect(data.chatJid).toBe('chat@jid');
  });

  it('schedule tool writes JSON file to tasks dir', async () => {
    const { buildIpcTools } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );
    const tools = buildIpcTools(tempDir, 'chat@jid', 'test-group');
    const result = await tools.schedule.execute(
      { when: '0 8 * * *', prompt: 'daily check', label: 'Morning check' },
      { toolCallId: 'tc2', messages: [], abortSignal: undefined as any },
    );
    expect(result).toEqual({ success: true });

    const files = fs.readdirSync(path.join(tempDir, 'tasks'));
    expect(files).toHaveLength(1);
    const data = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'tasks', files[0]), 'utf-8'),
    );
    expect(data.type).toBe('schedule');
    expect(data.prompt).toBe('daily check');
  });

  it('learn_feedback tool writes to messages dir', async () => {
    const { buildIpcTools } = await import(
      '../../container/agent-runner/src/tool-bridge.js'
    );
    const tools = buildIpcTools(tempDir, 'chat@jid', 'test-group');
    const result = await tools.learn_feedback.execute(
      { rule: 'Always check auth first', source: 'user_feedback' },
      { toolCallId: 'tc3', messages: [], abortSignal: undefined as any },
    );
    expect(result).toEqual({ success: true });

    const files = fs.readdirSync(path.join(tempDir, 'messages'));
    expect(files).toHaveLength(1);
    const data = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'messages', files[0]), 'utf-8'),
    );
    expect(data.type).toBe('learn_feedback');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/tool-bridge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement tool bridge**

```typescript
// container/agent-runner/src/tool-bridge.ts
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

interface ToolDefinition {
  description: string;
  parameters: z.ZodType<any>;
  execute: (args: any, context: any) => Promise<{ success: boolean }>;
}

function writeIpcFile(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `vercel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

export function buildIpcTools(
  ipcDir: string,
  chatJid: string,
  groupFolder: string,
): Record<string, ToolDefinition> {
  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');

  return {
    send_message: {
      description: 'Send a message to the chat',
      parameters: z.object({
        text: z.string().describe('Message text to send'),
      }),
      execute: async ({ text }: { text: string }) => {
        writeIpcFile(messagesDir, {
          type: 'message',
          chatJid,
          text,
          groupFolder,
        });
        return { success: true };
      },
    },

    schedule: {
      description: 'Schedule a task for later execution',
      parameters: z.object({
        when: z
          .string()
          .describe('When to run (cron expression or relative time)'),
        prompt: z.string().describe('Task prompt'),
        label: z.string().optional().describe('Human-readable label'),
      }),
      execute: async ({
        when,
        prompt,
        label,
      }: {
        when: string;
        prompt: string;
        label?: string;
      }) => {
        writeIpcFile(tasksDir, {
          type: 'schedule',
          chatJid,
          groupFolder,
          when,
          prompt,
          label,
        });
        return { success: true };
      },
    },

    relay_message: {
      description: 'Relay a message to the main group channel',
      parameters: z.object({
        text: z.string().describe('Message to relay'),
      }),
      execute: async ({ text }: { text: string }) => {
        writeIpcFile(messagesDir, {
          type: 'relay_message',
          chatJid,
          text,
          groupFolder,
        });
        return { success: true };
      },
    },

    learn_feedback: {
      description: 'Record a learned rule from this interaction',
      parameters: z.object({
        rule: z.string().describe('The rule or pattern learned'),
        source: z.enum([
          'user_feedback',
          'outcome_pattern',
          'agent_reported',
        ]),
      }),
      execute: async ({
        rule,
        source,
      }: {
        rule: string;
        source: string;
      }) => {
        writeIpcFile(messagesDir, {
          type: 'learn_feedback',
          chatJid,
          groupFolder,
          rule,
          source,
        });
        return { success: true };
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/llm/tool-bridge.test.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/tool-bridge.ts src/llm/tool-bridge.test.ts
git commit -m "feat(llm): add IPC tool bridge for Vercel AI SDK path"
```

---

### Task 5: Vercel AI SDK Agent Runner

**Files:**
- Create: `container/agent-runner/src/vercel-runner.ts`
- Modify: `container/agent-runner/package.json`

- [ ] **Step 1: Add Vercel AI SDK dependencies to agent-runner**

Update `container/agent-runner/package.json` dependencies:

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.76",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "ai": "^4.3.0",
    "@ai-sdk/openai": "^1.3.0",
    "@ai-sdk/google": "^1.2.0",
    "cron-parser": "^5.0.0",
    "zod": "^4.0.0"
  }
}
```

Run: `cd container/agent-runner && npm install`

- [ ] **Step 2: Implement the Vercel runner**

```typescript
// container/agent-runner/src/vercel-runner.ts
import fs from 'fs';
import path from 'path';
import { generateText, type CoreMessage, type CoreTool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { buildIpcTools } from './tool-bridge.js';
import { loadSession, saveSession } from './session-store.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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
  provider?: string;
  model?: string;
  providerBaseUrl?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  numTurns?: number;
  progressLabel?: string;
}

function log(message: string): void {
  console.error(`[vercel-runner] ${message}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function createProviderFactory(provider: string, baseUrl?: string | null) {
  switch (provider) {
    case 'openai':
      return createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: baseUrl ?? undefined,
      });
    case 'groq':
      return createOpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: baseUrl ?? 'https://api.groq.com/openai/v1',
      });
    case 'together':
      return createOpenAI({
        apiKey: process.env.TOGETHER_AI_API_KEY,
        baseURL: baseUrl ?? 'https://api.together.xyz/v1',
      });
    case 'ollama':
      return createOpenAI({
        apiKey: 'ollama',
        baseURL: baseUrl ?? 'http://host.docker.internal:11434/v1',
      });
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  parts.push(
    `You are ${input.assistantName ?? 'an AI assistant'}. You help with tasks by using the available tools.`,
  );

  // Load group CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Load global CLAUDE.md
  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMd)) {
    parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
  }

  // Load container skills
  const skillsDir = '/workspace/skills';
  if (fs.existsSync(skillsDir)) {
    for (const skill of fs.readdirSync(skillsDir)) {
      const skillMd = path.join(skillsDir, skill, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        parts.push(fs.readFileSync(skillMd, 'utf-8'));
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

function formatToolLabel(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  if (toolName === 'send_message') return 'Sending message';
  if (toolName === 'schedule') return 'Scheduling task';
  if (toolName === 'relay_message') return 'Relaying message';
  if (toolName === 'learn_feedback') return 'Recording lesson';
  const words = toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export async function runVercelQuery(
  prompt: string,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const provider = input.provider ?? 'openai';
  const modelId = input.model ?? 'gpt-4o-mini';

  log(`Provider: ${provider}, Model: ${modelId}`);

  try {
    const factory = createProviderFactory(provider, input.providerBaseUrl);
    const model = factory(modelId);

    const ipcTools = buildIpcTools(
      '/workspace/ipc',
      input.chatJid,
      input.groupFolder,
    );

    // Convert IPC tools to CoreTool format
    const tools: Record<string, CoreTool> = {};
    for (const [name, def] of Object.entries(ipcTools)) {
      tools[name] = {
        description: def.description,
        parameters: def.parameters,
        execute: def.execute,
      };
    }

    const sessionDir = '/workspace/group/sessions/vercel';
    const sessionMessages = loadSession(sessionDir, input.sessionId);

    const messages: CoreMessage[] = [
      ...sessionMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: String(m.content),
      })),
      { role: 'user' as const, content: prompt },
    ];

    const systemPrompt = buildSystemPrompt(input);

    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools,
      maxSteps: 50,
      onStepFinish: ({ toolCalls }) => {
        for (const tc of toolCalls ?? []) {
          const label = formatToolLabel(
            tc.toolName,
            tc.args as Record<string, unknown>,
          );
          writeOutput({
            status: 'success',
            result: null,
            progressLabel: label,
          });
        }
      },
    });

    const allMessages = [
      ...messages,
      ...result.response.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content),
      })),
    ];
    const newSessionId = saveSession(sessionDir, input.sessionId, allMessages);

    return {
      status: 'success',
      result: result.text,
      newSessionId,
      usage: {
        input_tokens: result.usage?.promptTokens,
        output_tokens: result.usage?.completionTokens,
      },
      numTurns: result.steps.length,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Error: ${errorMsg}`);
    return {
      status: 'error',
      result: null,
      error: errorMsg,
    };
  }
}
```

- [ ] **Step 3: Verify agent-runner compiles**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors (may need to add `"moduleResolution": "node16"` to tsconfig if not already present)

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/vercel-runner.ts container/agent-runner/package.json container/agent-runner/package-lock.json
git commit -m "feat(llm): add Vercel AI SDK agent runner with tool bridge"
```

---

### Task 6: Wire Dual-Runtime Into Agent Runner Entry Point

**Files:**
- Modify: `container/agent-runner/src/index.ts:67-77` (ContainerInput)
- Modify: `container/agent-runner/src/index.ts:623-773` (main query dispatch)

- [ ] **Step 1: Add provider fields to ContainerInput**

In `container/agent-runner/src/index.ts`, add three fields to the `ContainerInput` interface (after line 58, before the closing brace):

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
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'groq' | 'together';
  model?: string;
  providerBaseUrl?: string;
}
```

- [ ] **Step 2: Add the dual-runtime branch in main()**

Find the `main()` function. After stdin is read and `containerInput` is parsed, but before the existing `runQuery()` call, add the provider branch. Locate the section where `runQuery` is called (around line 623) and wrap it:

```typescript
// Add import at top of file
import { runVercelQuery } from './vercel-runner.js';

// In main(), after containerInput is parsed, before the query loop:
const provider = containerInput.provider ?? 'anthropic';

if (provider !== 'anthropic') {
  // Non-Claude path: use Vercel AI SDK
  log(`Using Vercel AI SDK (provider: ${provider}, model: ${containerInput.model ?? 'default'})`);
  const result = await runVercelQuery(containerInput.prompt, containerInput);
  writeOutput(result);
  process.exit(0);
}

// Existing Claude path continues below unchanged...
```

- [ ] **Step 3: Verify agent-runner compiles**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(llm): wire dual-runtime dispatch in agent runner"
```

---

### Task 7: Pass Provider Config From Host to Container

**Files:**
- Modify: `src/container-runner.ts:49-59` (ContainerInput)
- Modify: `src/container-runner.ts:518-684` (buildContainerArgs)
- Modify: `src/index.ts:584-601` (runAgent call site)

- [ ] **Step 1: Add provider fields to host-side ContainerInput**

In `src/container-runner.ts`, add three fields to the `ContainerInput` interface (after `verbose?: boolean;`):

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  verbose?: boolean;
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'groq' | 'together';
  model?: string;
  providerBaseUrl?: string;
}
```

- [ ] **Step 2: Pass provider env vars in `buildContainerArgs`**

In `src/container-runner.ts`, inside `buildContainerArgs()`, after the existing env var block (after the `NOTION_TOKEN` block around line 578), add:

```typescript
  // Non-Anthropic LLM provider keys — only passed when using non-Claude providers
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    args.push('-e', `OPENAI_API_KEY=${openaiKey}`);
  }
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (googleKey) {
    args.push('-e', `GOOGLE_GENERATIVE_AI_API_KEY=${googleKey}`);
  }
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    args.push('-e', `GROQ_API_KEY=${groqKey}`);
  }
  const togetherKey = process.env.TOGETHER_AI_API_KEY;
  if (togetherKey) {
    args.push('-e', `TOGETHER_AI_API_KEY=${togetherKey}`);
  }
```

Also add these keys to the `SECRET_KEY_PREFIXES` array (around line 641):

```typescript
const SECRET_KEY_PREFIXES = [
  'DISCORD_BOT_TOKEN=',
  'NANOCLAW_SERVICE_TOKEN=',
  'GH_TOKEN=',
  'NOTION_TOKEN=',
  'CLAUDE_CODE_OAUTH_TOKEN=',
  'HTTPS_PROXY=',
  'HTTP_PROXY=',
  'https_proxy=',
  'http_proxy=',
  'ANTHROPIC_API_KEY=',
  'OPENAI_API_KEY=',
  'GOOGLE_GENERATIVE_AI_API_KEY=',
  'GROQ_API_KEY=',
  'TOGETHER_AI_API_KEY=',
];
```

- [ ] **Step 3: Call `resolveModel` and `scoreComplexity` in `runAgent`**

In `src/index.ts`, add imports at the top:

```typescript
import { resolveModel } from './llm/provider.js';
import { scoreComplexity } from './llm/escalation.js';
```

Then modify the `runContainerAgent` call site (around line 587-601). Before the call, add provider resolution:

```typescript
    // Resolve LLM provider/model for this group
    const resolved = resolveModel(
      { llm: group.containerConfig?.llm },
    );

    // Auto-escalate if message is complex and escalation model is configured
    let finalModel = resolved.model;
    if (resolved.provider !== 'anthropic') {
      const complexity = scoreComplexity(prompt);
      if (complexity.shouldEscalate) {
        const llmConfig = group.containerConfig?.llm;
        const escalationModel = llmConfig?.escalationModel;
        if (escalationModel) {
          finalModel = escalationModel;
          logger.info(
            { group: group.name, score: complexity.score, reason: complexity.reason, model: escalationModel },
            'Auto-escalated model',
          );
        }
      }
    }

    const output = await runContainerAgent(
      group,
      {
        prompt: enrichedPrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        verbose: group.verbose,
        provider: resolved.provider as any,
        model: finalModel ?? undefined,
        providerBaseUrl: resolved.providerBaseUrl ?? undefined,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );
```

- [ ] **Step 4: Update existing container-runner tests**

In `src/container-runner.test.ts`, if there are tests that construct `ContainerInput`, they should still pass since the new fields are optional. Verify:

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS — all existing tests still pass

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new)

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/index.ts
git commit -m "feat(llm): wire provider resolution and auto-escalation into host"
```

---

### Task 8: Add Vercel AI SDK Dependencies to Root

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install host-side Vercel AI SDK packages**

```bash
npm install ai @ai-sdk/openai @ai-sdk/google @ai-sdk/anthropic
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Clean compile, no errors

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(llm): add Vercel AI SDK dependencies to host"
```

---

### Task 9: Utility LLM Service

**Files:**
- Create: `src/llm/utility.ts`
- Create: `src/llm/utility.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/llm/utility.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => 'mock-model')),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
}));

import { generateText, embed } from 'ai';
import { resolveUtilityModel, classify, generateShort } from './utility.js';

describe('resolveUtilityModel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns explicit model when provided', () => {
    const result = resolveUtilityModel('openai:gpt-4o-mini');
    expect(result).toBeDefined();
  });

  it('falls back to env var UTILITY_LLM_MODEL', () => {
    const original = process.env.UTILITY_LLM_MODEL;
    process.env.UTILITY_LLM_MODEL = 'google:gemini-2.0-flash';
    try {
      const result = resolveUtilityModel();
      expect(result).toBeDefined();
    } finally {
      if (original !== undefined) {
        process.env.UTILITY_LLM_MODEL = original;
      } else {
        delete process.env.UTILITY_LLM_MODEL;
      }
    }
  });
});

describe('classify', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns one of the provided categories', async () => {
    const mockGenerateText = vi.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: 'urgent',
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const result = await classify('fire alarm going off', [
      'urgent',
      'normal',
      'low',
    ]);
    expect(result).toBe('urgent');
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it('returns first category if LLM output doesnt match', async () => {
    const mockGenerateText = vi.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: 'unknown-category',
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const result = await classify('test', ['cat_a', 'cat_b']);
    expect(result).toBe('cat_a');
  });
});

describe('generateShort', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns text from generateText', async () => {
    const mockGenerateText = vi.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: 'A brief summary.',
      usage: { promptTokens: 10, completionTokens: 5 },
    } as any);

    const result = await generateShort('Summarize this in one line');
    expect(result).toBe('A brief summary.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/utility.test.ts`
Expected: FAIL — module `./utility.js` does not exist

- [ ] **Step 3: Implement utility LLM service**

```typescript
// src/llm/utility.ts
import { generateText, embed } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';

type ProviderFactory = ReturnType<
  typeof createOpenAI | typeof createGoogleGenerativeAI | typeof createAnthropic
>;

export function resolveUtilityModel(explicit?: string) {
  const spec = explicit ?? process.env.UTILITY_LLM_MODEL;
  if (spec) {
    const [providerName, ...modelParts] = spec.split(':');
    const modelId = modelParts.join(':');
    const factory = getFactory(providerName);
    return factory(modelId);
  }

  if (process.env.OPENAI_API_KEY) {
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-4o-mini');
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    })('gemini-2.0-flash');
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(
      'claude-haiku-4-5-20251001',
    );
  }

  throw new Error(
    'No utility LLM configured. Set UTILITY_LLM_MODEL or provide an API key (OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or ANTHROPIC_API_KEY).',
  );
}

function getFactory(providerName: string): ProviderFactory {
  switch (providerName) {
    case 'openai':
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
    case 'anthropic':
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    default:
      throw new Error(`Unknown utility provider: ${providerName}`);
  }
}

export async function classify(
  text: string,
  categories: string[],
  options?: { model?: string },
): Promise<string> {
  const model = resolveUtilityModel(options?.model);

  const result = await generateText({
    model,
    system: `You are a classifier. Respond with exactly one of these categories: ${categories.join(', ')}. No explanation, just the category.`,
    messages: [{ role: 'user', content: text }],
    maxTokens: 50,
  });

  const output = result.text.trim().toLowerCase();
  const match = categories.find((c) => c.toLowerCase() === output);
  return match ?? categories[0];
}

export async function generateShort(
  prompt: string,
  options?: { model?: string; maxTokens?: number },
): Promise<string> {
  const model = resolveUtilityModel(options?.model);

  const result = await generateText({
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: options?.maxTokens ?? 200,
  });

  return result.text;
}

export async function embedText(
  text: string,
  options?: { model?: string },
): Promise<number[]> {
  const spec = options?.model ?? 'openai:text-embedding-3-small';
  const [providerName, ...modelParts] = spec.split(':');
  const modelId = modelParts.join(':');
  const factory = getFactory(providerName);
  const embeddingModel = factory.embedding(modelId);

  const result = await embed({
    model: embeddingModel,
    value: text,
  });

  return result.embedding;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/llm/utility.test.ts`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/llm/utility.ts src/llm/utility.test.ts
git commit -m "feat(llm): add utility LLM service (classify, generateShort, embedText)"
```

---

### Task 10: Update Existing Test Mocks and Run Full Suite

**Files:**
- Modify: `src/index.test.ts` (add mocks for new imports)
- Modify: `src/container-runner.test.ts` (if needed)

- [ ] **Step 1: Add mocks for new imports in `src/index.test.ts`**

Add mocks for the new LLM modules before the existing imports:

```typescript
vi.mock('./llm/provider.js', () => ({
  resolveModel: vi.fn().mockReturnValue({
    provider: 'anthropic',
    model: null,
    providerBaseUrl: null,
  }),
}));

vi.mock('./llm/escalation.js', () => ({
  scoreComplexity: vi.fn().mockReturnValue({
    shouldEscalate: false,
    score: 0,
  }),
}));
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (741+ existing tests + new tests)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/index.test.ts
git commit -m "test: add mocks for LLM provider imports in index test"
```

---

### Task 11: Rebuild Container Image

**Files:**
- No new files (uses existing `container/build.sh`)

- [ ] **Step 1: Rebuild container**

```bash
./container/build.sh
```

Expected: Build succeeds with new Vercel AI SDK dependencies included

- [ ] **Step 2: Verify container starts with Anthropic provider (existing behavior)**

Test that existing Claude path still works by sending a test message to an active group. The `provider` field will be undefined (defaulting to `anthropic`), which routes to the existing `query()` path. No behavior change expected.

- [ ] **Step 3: Commit any container build changes**

If `container/build.sh` or `Dockerfile` needed changes:

```bash
git add container/
git commit -m "build: rebuild container with Vercel AI SDK support"
```

---

## Deferred Items (v2)

- **MCP tool bridging for Vercel path**: The spec describes connecting MCP servers (Gmail, Notion, SuperPilot) via `experimental_createMCPClient()`. For v1, the Vercel path only has IPC tools (send_message, schedule, relay_message, learn_feedback). MCP tools require the `nanoclaw` MCP server and Gmail/Notion MCP servers — adding these increases complexity significantly. Deferred to a follow-up.
- **Trust gateway check in Vercel runner**: For v1, trust is handled by the host-side IPC authorization (ipc.ts:109-126). External write tools (email, git) aren't available in the Vercel path without MCP bridging. When MCP bridging is added, trust gateway integration must be added too.
- **`switch_model` IPC message type**: Per-task model override via IPC. Lower priority — groups can set their default, and auto-escalation handles most cases. Deferred.

## Post-Implementation Verification

After all tasks complete:

1. **Type safety**: `npm run typecheck` passes
2. **Tests**: `npx vitest run` — all pass
3. **Build**: `npm run build` — clean compile
4. **Container**: `./container/build.sh` — builds successfully
5. **Backward compat**: Groups with no `llm` config default to `anthropic` — no behavior change
6. **Manual test** (optional): Add `"llm": {"provider": "openai", "model": "gpt-4o-mini"}` to a test group's `config.json`, send a message, verify response comes from OpenAI
