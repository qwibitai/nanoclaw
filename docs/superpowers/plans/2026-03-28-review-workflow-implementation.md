# Review Workflow Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw-extraction review pipeline with an agent-processed, chat-assisted review experience featuring a three-panel dashboard UI.

**Architecture:** The ingestion pipeline drops docling as a mandatory step. Uploaded files go directly to a fresh agent container that reads the document multimodally and generates structured study notes. A new "web" channel enables the dashboard to communicate with NanoClaw for per-draft chat. The dashboard is rebuilt with a three-panel review detail view (source, draft, chat) and an overview page with batch operations.

**Tech Stack:** Node.js/TypeScript (NanoClaw), Next.js 16 / React 19 / Tailwind 4 (dashboard), SQLite (coordination), SSE (streaming), Claude Agent SDK (containers)

**Important:** The dashboard uses Next.js 16.2.1 which has breaking changes from older versions. Before writing any dashboard code, read the relevant guide in `dashboard/node_modules/next/dist/docs/` to verify APIs and conventions.

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/channels/web.ts` | Web channel: HTTP server for dashboard ↔ NanoClaw communication. Accepts messages, routes to review agent group, streams responses via SSE. |
| `src/channels/web.test.ts` | Tests for web channel |
| `src/ingestion/agent-processor.ts` | Spawns a fresh agent container per uploaded document with the original file mounted. Replaces the docling-first pipeline step. |
| `src/ingestion/agent-processor.test.ts` | Tests for agent processor |
| `groups/review_agent/CLAUDE.md` | Instructions for the review agent: vault structure, metadata schema, note generation rules, figure handling. |
| `dashboard/src/app/review/page.tsx` | Redesigned overview: drafts grouped by course, batch actions, checkboxes. Replaces current. |
| `dashboard/src/app/review/[id]/page.tsx` | Three-panel detail view: source viewer, draft editor, chat panel. Replaces current. |
| `dashboard/src/app/api/chat/route.ts` | POST endpoint: sends user message to NanoClaw web channel for a specific draft. |
| `dashboard/src/app/api/chat/[draftId]/stream/route.ts` | GET endpoint: SSE stream of agent responses for a specific draft. |
| `dashboard/src/app/api/review/[id]/route.ts` | GET endpoint: fetch single draft with full content (not just excerpt). |
| `dashboard/src/app/api/attachments/[...path]/route.ts` | GET endpoint: serve attachment files (PDFs, figures) from vault for the source viewer. |

### Modified files

| File | Change |
|------|--------|
| `src/channels/index.ts` | Add `import './web.js'` |
| `src/ingestion/index.ts` | Replace docling extraction + raw draft creation with call to `AgentProcessor`. Keep file watcher, path parsing, and file copy logic. |
| `src/index.ts` | Register review_agent group on startup if not already registered. Add web channel config to `channelOpts`. |
| `src/config.ts` | Add `WEB_CHANNEL_PORT` config |
| `dashboard/src/app/api/review/route.ts` | Fix approve to use `_targetPath` instead of moving to vault root. Add `reviewed` date to frontmatter on approve. |

### Unchanged files

| File | Note |
|------|------|
| `src/ingestion/docling-client.ts` | Stays as-is. Available as a tool inside agent containers but no longer called by the pipeline. |
| `src/ingestion/file-watcher.ts` | Already fixed (ignores `.processed/`). |
| `src/ingestion/review-queue.ts` | Used by the agent processor to write drafts. No changes needed. |
| `src/ingestion/path-parser.ts` | Used by the pipeline for metadata inference. No changes. |

---

## Task 1: Web Channel

The HTTP server that lets the dashboard talk to NanoClaw. Handles inbound messages and streams agent responses.

**Files:**
- Create: `src/channels/web.ts`
- Create: `src/channels/web.test.ts`
- Modify: `src/channels/index.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add config**

Add `WEB_CHANNEL_PORT` to `src/config.ts`:

```typescript
export const WEB_CHANNEL_PORT = parseInt(
  process.env.WEB_CHANNEL_PORT || '3200',
  10,
);
```

- [ ] **Step 2: Write the failing test**

Create `src/channels/web.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

function postJSON(port: number, path: string, body: object): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('WebChannel', () => {
  let mod: typeof import('./web.js');
  let channel: import('../types.js').Channel;
  const TEST_PORT = 3299;
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('WEB_CHANNEL_PORT', String(TEST_PORT));
    vi.resetModules();
    mod = await import('./web.js');
    channel = mod.createWebChannel({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({}),
    })!;
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
    vi.unstubAllEnvs();
  });

  it('accepts POST /message and calls onMessage', async () => {
    const res = await postJSON(TEST_PORT, '/message', {
      draftId: 'abc-123',
      text: 'Fix the metadata',
    });
    expect(res.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(
      'web:review:abc-123',
      expect.objectContaining({
        content: 'Fix the metadata',
        chat_jid: 'web:review:abc-123',
      }),
    );
  });

  it('rejects missing draftId', async () => {
    const res = await postJSON(TEST_PORT, '/message', { text: 'hello' });
    expect(res.status).toBe(400);
  });

  it('ownsJid returns true for web: prefixed JIDs', () => {
    expect(channel.ownsJid('web:review:abc-123')).toBe(true);
    expect(channel.ownsJid('tg:12345')).toBe(false);
  });

  it('buffers sendMessage output for SSE retrieval', async () => {
    await channel.sendMessage('web:review:abc-123', 'Agent response text');
    const pending = mod.getPendingResponses('abc-123');
    expect(pending).toContain('Agent response text');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/channels/web.test.ts`
Expected: FAIL — module `./web.js` does not exist

- [ ] **Step 4: Implement web channel**

Create `src/channels/web.ts`:

```typescript
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { WEB_CHANNEL_PORT } from '../config.js';
import { logger } from '../logger.js';

const JID_PREFIX = 'web:review:';

// Buffer agent responses per draft for SSE consumers
const responseBuffers = new Map<string, string[]>();

export function getPendingResponses(draftId: string): string[] {
  const buf = responseBuffers.get(draftId) || [];
  responseBuffers.set(draftId, []);
  return buf;
}

// SSE subscribers per draft
const sseClients = new Map<string, Set<http.ServerResponse>>();

export function createWebChannel(opts: ChannelOpts): Channel {
  let server: http.Server | null = null;

  function handleMessage(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { draftId?: string; text?: string };
        if (!parsed.draftId || !parsed.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing draftId or text' }));
          return;
        }

        const chatJid = `${JID_PREFIX}${parsed.draftId}`;
        const msg = {
          id: randomUUID(),
          chat_jid: chatJid,
          sender: 'web-user',
          sender_name: 'Web User',
          content: parsed.text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        };

        opts.onMessage(chatJid, msg);
        opts.onChatMetadata(chatJid, msg.timestamp, `Review: ${parsed.draftId}`, 'web', false);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messageId: msg.id }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  function handleSSE(req: http.IncomingMessage, res: http.ServerResponse, draftId: string) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':\n\n'); // SSE comment to establish connection

    if (!sseClients.has(draftId)) sseClients.set(draftId, new Set());
    sseClients.get(draftId)!.add(res);

    // Send any buffered responses
    const pending = getPendingResponses(draftId);
    for (const text of pending) {
      res.write(`data: ${JSON.stringify({ type: 'message', text })}\n\n`);
    }

    req.on('close', () => {
      sseClients.get(draftId)?.delete(res);
    });
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = new URL(req.url || '/', `http://localhost`);

    if (req.method === 'POST' && url.pathname === '/message') {
      handleMessage(req, res);
      return;
    }

    // GET /stream/:draftId
    const streamMatch = url.pathname.match(/^\/stream\/(.+)$/);
    if (req.method === 'GET' && streamMatch) {
      handleSSE(req, res, streamMatch[1]);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  const channel: Channel = {
    name: 'web',

    async connect() {
      server = http.createServer(handleRequest);
      await new Promise<void>((resolve) => {
        server!.listen(WEB_CHANNEL_PORT, '127.0.0.1', () => {
          logger.info({ port: WEB_CHANNEL_PORT }, 'Web channel listening');
          resolve();
        });
      });
    },

    async sendMessage(jid: string, text: string) {
      const draftId = jid.replace(JID_PREFIX, '');

      // Push to SSE clients
      const clients = sseClients.get(draftId);
      if (clients && clients.size > 0) {
        const data = `data: ${JSON.stringify({ type: 'message', text })}\n\n`;
        for (const client of clients) {
          client.write(data);
        }
      }

      // Also buffer for clients that connect later
      if (!responseBuffers.has(draftId)) responseBuffers.set(draftId, []);
      responseBuffers.get(draftId)!.push(text);
    },

    isConnected() {
      return server?.listening === true;
    },

    ownsJid(jid: string) {
      return jid.startsWith(JID_PREFIX);
    },

    async disconnect() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },
  };

  return channel;
}

// Self-register
registerChannel('web', (opts) => {
  return createWebChannel(opts);
});
```

- [ ] **Step 5: Register the channel**

Add to `src/channels/index.ts`:

```typescript
import './web.js';
```

- [ ] **Step 6: Run tests**

Run: `npm test -- src/channels/web.test.ts`
Expected: All 4 tests pass

- [ ] **Step 7: Commit**

```bash
git add src/channels/web.ts src/channels/web.test.ts src/channels/index.ts src/config.ts
git commit -m "feat: add web channel for dashboard-agent communication"
```

---

## Task 2: Review Agent Group

Create the review agent's group folder and CLAUDE.md with instructions for processing documents and handling review chat.

**Files:**
- Create: `groups/review_agent/CLAUDE.md`
- Modify: `src/index.ts`

- [ ] **Step 1: Create review agent CLAUDE.md**

Create `groups/review_agent/CLAUDE.md`:

```markdown
# Review Agent

You are a teaching assistant that processes academic documents and generates structured study notes for an Obsidian vault.

## Your Role

You process uploaded course materials (PDFs, slides, documents) and generate well-structured study notes. You also refine drafts based on user feedback via the review chat.

## Document Processing

When processing a new document:

1. Read the original source file. You can view PDFs and images multimodally.
2. Generate structured study notes in markdown with:
   - A clear, descriptive title (not the filename)
   - Logical section headings
   - Key concepts highlighted
   - Important definitions and terminology
   - Summaries of complex topics
3. Fill in all metadata fields based on what you observe in the document and any context provided.
4. If the document contains important diagrams or figures, use the docling extraction tool to extract them as separate image files. Reference them with `![[filename.png]]` syntax and write descriptive captions.
5. Write the draft to the specified output path.

## Metadata Schema

Every note must have this YAML frontmatter:

```yaml
title: "Descriptive title"
type: lecture | reading | assignment | exam-prep | lab | project | reference
course: "XX-NNNN"           # Course code (e.g., IS-1500)
course_name: "Full Name"     # Full course name
semester: N                  # Semester number (1-6)
year: N                      # Study year (1-3)
language: "no" | "en"        # Document language
status: draft
tags: [topic1, topic2]       # Relevant topic tags
source: "[[original-file.pdf]]"
created: YYYY-MM-DD
figures: [fig1.png, fig2.png] # Extracted figure filenames
```

## Review Chat

When the user sends messages about a draft:

- Read the current draft file to see its current state.
- Make the requested changes directly to the draft file.
- Infer additional metadata from what the user says — if they mention a course, exam relevance, connections to other topics, update tags and metadata accordingly.
- Never approve or reject drafts — that's the user's action.
- Never move files in the vault — that happens on approve.

## Language

The user is Norwegian. Course materials may be in Norwegian or English. Write notes in the same language as the source material. Respond to chat messages in the language the user writes in.

## Vault Structure

Notes are organized as:
- `courses/{course-code}/{type}/` — e.g., `courses/IS-1500/lectures/`
- `attachments/{course-code}/` — original source files
- `attachments/{course-code}/figures/` — extracted figures
- `drafts/` — pending review items (your workspace)
```

- [ ] **Step 2: Register review agent group on startup**

Add to `src/index.ts`, inside `main()` after `loadState()`:

```typescript
// Ensure review agent group exists
const REVIEW_AGENT_JID = 'web:review:__agent__';
if (!registeredGroups[REVIEW_AGENT_JID]) {
  registerGroup(REVIEW_AGENT_JID, {
    name: 'Review Agent',
    folder: 'review_agent',
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
    containerConfig: {
      additionalMounts: [
        { hostPath: join(process.cwd(), 'vault'), containerPath: '/workspace/extra/vault', readonly: false },
        { hostPath: join(process.cwd(), 'upload'), containerPath: '/workspace/extra/upload', readonly: true },
      ],
    },
  });
}
```

- [ ] **Step 3: Run build to verify no errors**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add groups/review_agent/CLAUDE.md src/index.ts
git commit -m "feat: add review agent group with CLAUDE.md instructions"
```

---

## Task 3: Agent Processor

Replaces the docling-first pipeline step. Spawns a fresh agent container per document that reads the original file multimodally and generates structured notes.

**Files:**
- Create: `src/ingestion/agent-processor.ts`
- Create: `src/ingestion/agent-processor.test.ts`
- Modify: `src/ingestion/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/ingestion/agent-processor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentProcessor, AgentProcessorOpts } from './agent-processor.js';

// Mock the container runner
vi.mock('../container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('../db.js', () => ({
  getAllRegisteredGroups: vi.fn(() => ({})),
  setRegisteredGroup: vi.fn(),
}));

describe('AgentProcessor', () => {
  let processor: AgentProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new AgentProcessor({
      vaultDir: '/tmp/test-vault',
      uploadDir: '/tmp/test-upload',
    });
  });

  it('builds a prompt with file path and metadata context', () => {
    const prompt = processor.buildPrompt(
      '/tmp/test-upload/03_TCP.pdf',
      '03_TCP.pdf',
      { courseCode: 'IS-1500', courseName: 'Digital Samhandling', semester: 3, year: 2, type: 'lecture', fileName: '03_TCP.pdf' },
      'draft-id-123',
    );

    expect(prompt).toContain('03_TCP.pdf');
    expect(prompt).toContain('IS-1500');
    expect(prompt).toContain('Digital Samhandling');
    expect(prompt).toContain('draft-id-123');
    expect(prompt).toContain('/workspace/extra/upload/03_TCP.pdf');
  });

  it('builds prompt with null metadata gracefully', () => {
    const prompt = processor.buildPrompt(
      '/tmp/test-upload/random.pdf',
      'random.pdf',
      { courseCode: null, courseName: null, semester: null, year: null, type: null, fileName: 'random.pdf' },
      'draft-id-456',
    );

    expect(prompt).toContain('random.pdf');
    expect(prompt).toContain('draft-id-456');
    expect(prompt).not.toContain('IS-1500');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/ingestion/agent-processor.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement agent processor**

Create `src/ingestion/agent-processor.ts`:

```typescript
import { join, basename, relative } from 'node:path';
import { readdir } from 'node:fs/promises';
import { runContainerAgent, ContainerOutput } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { PathContext } from './path-parser.js';

export interface AgentProcessorOpts {
  vaultDir: string;
  uploadDir: string;
}

export class AgentProcessor {
  private vaultDir: string;
  private uploadDir: string;

  constructor(opts: AgentProcessorOpts) {
    this.vaultDir = opts.vaultDir;
    this.uploadDir = opts.uploadDir;
  }

  buildPrompt(
    filePath: string,
    fileName: string,
    context: PathContext,
    draftId: string,
  ): string {
    // The file is mounted at /workspace/extra/upload/ inside the container
    const relativePath = relative(this.uploadDir, filePath);
    const containerFilePath = `/workspace/extra/upload/${relativePath}`;
    const vaultDraftPath = `/workspace/extra/vault/drafts/${draftId}.md`;

    const metadataLines: string[] = [];
    if (context.courseCode) metadataLines.push(`- Course code: ${context.courseCode}`);
    if (context.courseName) metadataLines.push(`- Course name: ${context.courseName}`);
    if (context.semester) metadataLines.push(`- Semester: ${context.semester}`);
    if (context.year) metadataLines.push(`- Year: ${context.year}`);
    if (context.type) metadataLines.push(`- Material type: ${context.type}`);

    const metadataSection = metadataLines.length > 0
      ? `The folder structure suggests:\n${metadataLines.join('\n')}\n\nUse this as a starting point but verify against the document content.`
      : 'No metadata was inferred from the folder structure. Determine all metadata from the document content.';

    return `Process this document and generate study notes.

## Source File

Read this file: ${containerFilePath}
Original filename: ${fileName}

## Inferred Metadata

${metadataSection}

## Output

Write the generated note (with YAML frontmatter) to: ${vaultDraftPath}

The _targetPath in frontmatter should be: courses/${context.courseCode || '_unsorted'}/${context.type || 'unsorted'}/${fileName.replace(/\.[^.]+$/, '.md')}

Follow the instructions in your CLAUDE.md for note format and metadata schema.`;
  }

  async process(
    filePath: string,
    fileName: string,
    context: PathContext,
    draftId: string,
    reviewAgentGroup: RegisteredGroup,
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
    const prompt = this.buildPrompt(filePath, fileName, context, draftId);

    logger.info({ fileName, draftId }, 'Starting agent processing');

    try {
      const output = await runContainerAgent(
        reviewAgentGroup,
        {
          prompt,
          groupFolder: reviewAgentGroup.folder,
          chatJid: `web:review:${draftId}`,
          isMain: false,
        },
        (_proc, _containerName) => {
          // No queue registration needed for ingestion containers
        },
      );

      if (output.status === 'error') {
        logger.error({ fileName, draftId, error: output.error }, 'Agent processing failed');
        return { status: 'error', error: output.error };
      }

      logger.info({ fileName, draftId }, 'Agent processing completed');
      return { status: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ fileName, draftId, err }, 'Agent processing error');
      return { status: 'error', error: message };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/ingestion/agent-processor.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/agent-processor.ts src/ingestion/agent-processor.test.ts
git commit -m "feat: add agent processor for document ingestion"
```

---

## Task 4: Rewire Ingestion Pipeline

Replace the docling-first flow in `IngestionPipeline.processFile()` with the agent processor. Keep file watching, path parsing, attachment copying, and DB logging.

**Files:**
- Modify: `src/ingestion/index.ts`

- [ ] **Step 1: Rewrite processFile**

Replace the contents of `src/ingestion/index.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { parseUploadPath } from './path-parser.js';
import { TypeMappings } from './type-mappings.js';
import { AgentProcessor } from './agent-processor.js';
import {
  createIngestionJob,
  updateIngestionJobStatus,
  createReviewItem,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  typeMappingsPath: string;
  getReviewAgentGroup: () => RegisteredGroup | undefined;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private agentProcessor: AgentProcessor;
  private typeMappings: TypeMappings;
  private uploadDir: string;
  private vaultDir: string;
  private getReviewAgentGroup: () => RegisteredGroup | undefined;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vaultDir = opts.vaultDir;
    this.getReviewAgentGroup = opts.getReviewAgentGroup;
    this.agentProcessor = new AgentProcessor({
      vaultDir: opts.vaultDir,
      uploadDir: opts.uploadDir,
    });
    this.typeMappings = new TypeMappings(opts.typeMappingsPath);
    this.watcher = new FileWatcher(opts.uploadDir, (filePath) => {
      this.processFile(filePath).catch((err) => {
        logger.error({ err }, `Error processing ${filePath}: ${err.message}`);
      });
    });
  }

  async start(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
    await this.watcher.start();
    logger.info(`Watching ${this.uploadDir} for new files`);
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
  }

  async processFile(filePath: string): Promise<void> {
    const jobId = randomUUID();
    const draftId = randomUUID();
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    logger.info(`ingestion: Processing: ${relativePath}`);

    const context = parseUploadPath(relativePath, this.typeMappings);

    createIngestionJob(
      jobId,
      filePath,
      fileName,
      context.courseCode,
      context.courseName,
      context.semester,
      context.year,
      context.type,
    );

    try {
      // Copy original to vault attachments
      const courseDir = context.courseCode || '_unsorted';
      const attachmentDir = join('attachments', courseDir);
      await mkdir(join(this.vaultDir, attachmentDir), { recursive: true });
      await copyFile(filePath, join(this.vaultDir, attachmentDir, fileName));

      // Ensure drafts directory exists
      await mkdir(join(this.vaultDir, 'drafts'), { recursive: true });

      // Get the review agent group
      const reviewAgentGroup = this.getReviewAgentGroup();
      if (!reviewAgentGroup) {
        throw new Error('Review agent group not registered');
      }

      // Process with agent
      updateIngestionJobStatus(jobId, 'generating');
      const result = await this.agentProcessor.process(
        filePath,
        fileName,
        context,
        draftId,
        reviewAgentGroup,
      );

      if (result.status === 'error') {
        throw new Error(result.error || 'Agent processing failed');
      }

      // Create review item in DB
      createReviewItem(
        draftId,
        jobId,
        `drafts/${draftId}.md`,
        fileName,
        context.type,
        context.courseCode,
        [],
      );

      // Move original out of upload folder
      const processedDir = join(this.uploadDir, '.processed');
      await mkdir(processedDir, { recursive: true });
      await rename(filePath, join(processedDir, `${jobId}-${fileName}`));

      updateIngestionJobStatus(jobId, 'completed');
      logger.info(`ingestion: Completed: ${relativePath} → draft ${draftId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      updateIngestionJobStatus(jobId, 'failed', message);
      logger.error(`ingestion: Failed: ${relativePath} — ${message}`);
    }
  }
}
```

- [ ] **Step 2: Update pipeline construction in src/index.ts**

In `src/index.ts`, update the pipeline construction in `main()`:

```typescript
const REVIEW_AGENT_JID = 'web:review:__agent__';

const pipeline = new IngestionPipeline({
  uploadDir: UPLOAD_DIR,
  vaultDir: VAULT_DIR,
  typeMappingsPath: TYPE_MAPPINGS_PATH,
  getReviewAgentGroup: () => registeredGroups[REVIEW_AGENT_JID],
});
await pipeline.start();
```

Remove the old imports that are no longer needed (`DoclingClient`, `ReviewQueue`, `VaultUtility` if they were imported in index.ts for pipeline use).

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 4: Run existing tests**

Run: `npm test`
Expected: All tests pass (some ingestion tests may need adjustment if they test the old pipeline directly)

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/index.ts src/index.ts
git commit -m "feat: rewire ingestion pipeline to use agent processor instead of docling"
```

---

## Task 5: Fix Review API — Approve with Target Path

The current approve endpoint moves drafts to the vault root instead of using `_targetPath`. Fix this and add the `reviewed` date.

**Files:**
- Modify: `dashboard/src/app/api/review/route.ts`
- Create: `dashboard/src/app/api/review/[id]/route.ts`

- [ ] **Step 1: Fix approve action**

Rewrite `dashboard/src/app/api/review/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { join, dirname } from 'path';
import { readdir, readFile, rename, unlink, mkdir, writeFile } from 'fs/promises';
import matter from 'gray-matter';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');
const DRAFTS_DIR = join(VAULT_DIR, 'drafts');

export async function GET() {
  try {
    let files: string[];
    try {
      files = await readdir(DRAFTS_DIR);
    } catch {
      return NextResponse.json([]);
    }

    const mdFiles = files.filter((f) => f.endsWith('.md'));

    const drafts = await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = join(DRAFTS_DIR, filename);
        const raw = await readFile(filePath, 'utf-8');
        const { data, content } = matter(raw);
        return {
          id: filename.replace(/\.md$/, ''),
          filename,
          frontmatter: data,
          content,
          excerpt: content.slice(0, 200),
        };
      })
    );

    return NextResponse.json(drafts);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, action } = body as { id: string; action: 'approve' | 'reject' };

    if (!id || !action) {
      return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
    }

    const srcPath = join(DRAFTS_DIR, `${id}.md`);

    if (action === 'approve') {
      const raw = await readFile(srcPath, 'utf-8');
      const { data, content } = matter(raw);

      const targetPath = (data._targetPath as string) || `${id}.md`;
      const destPath = join(VAULT_DIR, targetPath);

      // Remove internal fields, set final status
      const { _targetPath: _, ...cleanData } = data;
      cleanData.status = 'approved';
      cleanData.reviewed = new Date().toISOString().split('T')[0];

      await mkdir(dirname(destPath), { recursive: true });
      const finalContent = matter.stringify(content, cleanData);
      await writeFile(destPath, finalContent, 'utf-8');
      await unlink(srcPath);

      return NextResponse.json({ ok: true, message: `Approved → ${targetPath}` });
    } else if (action === 'reject') {
      await unlink(srcPath);
      return NextResponse.json({ ok: true, message: 'Rejected and deleted' });
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Add single draft GET endpoint**

Create `dashboard/src/app/api/review/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { readFile } from 'fs/promises';
import matter from 'gray-matter';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');
const DRAFTS_DIR = join(VAULT_DIR, 'drafts');

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const filePath = join(DRAFTS_DIR, `${id}.md`);

  try {
    const raw = await readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);
    return NextResponse.json({
      id,
      frontmatter: data,
      content,
      source: data.source || null,
    });
  } catch {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }
}
```

- [ ] **Step 3: Run dashboard build**

Run: `cd dashboard && npm run build`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/api/review/route.ts dashboard/src/app/api/review/[id]/route.ts
git commit -m "fix: approve uses _targetPath, add single-draft GET endpoint"
```

---

## Task 6: Attachments API

Serve vault attachment files (PDFs, figures) to the dashboard for the source viewer and inline figure display.

**Files:**
- Create: `dashboard/src/app/api/attachments/[...path]/route.ts`

- [ ] **Step 1: Create attachments route**

Create `dashboard/src/app/api/attachments/[...path]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { join, extname, resolve } from 'path';
import { readFile, stat } from 'fs/promises';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const relativePath = segments.join('/');

  // Path traversal protection
  const fullPath = resolve(join(VAULT_DIR, 'attachments', relativePath));
  if (!fullPath.startsWith(resolve(join(VAULT_DIR, 'attachments')))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
  }

  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 404 });
    }

    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await readFile(fullPath);

    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
```

- [ ] **Step 2: Run dashboard build**

Run: `cd dashboard && npm run build`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/api/attachments/\[...path\]/route.ts
git commit -m "feat: add attachments API for serving vault files to dashboard"
```

---

## Task 7: Chat API Endpoints

Dashboard endpoints that forward messages to the NanoClaw web channel and stream responses via SSE.

**Files:**
- Create: `dashboard/src/app/api/chat/route.ts`
- Create: `dashboard/src/app/api/chat/[draftId]/stream/route.ts`

- [ ] **Step 1: Create chat POST endpoint**

Create `dashboard/src/app/api/chat/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';

const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://127.0.0.1:3200';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { draftId, text } = body as { draftId?: string; text?: string };

    if (!draftId || !text) {
      return NextResponse.json({ error: 'Missing draftId or text' }, { status: 400 });
    }

    const res = await fetch(`${WEB_CHANNEL_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId, text }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: data.error || 'Failed to send message' }, { status: res.status });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: `Web channel unreachable: ${err}` }, { status: 502 });
  }
}
```

- [ ] **Step 2: Create SSE stream endpoint**

Create `dashboard/src/app/api/chat/[draftId]/stream/route.ts`:

```typescript
import { NextRequest } from 'next/server';

const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://127.0.0.1:3200';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const { draftId } = await params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const res = await fetch(`${WEB_CHANNEL_URL}/stream/${draftId}`);

        if (!res.ok || !res.body) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', text: 'Failed to connect to web channel' })}\n\n`));
          controller.close();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(encoder.encode(decoder.decode(value)));
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', text: String(err) })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 3: Run dashboard build**

Run: `cd dashboard && npm run build`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/api/chat/route.ts dashboard/src/app/api/chat/\[draftId\]/stream/route.ts
git commit -m "feat: add chat API endpoints for dashboard-agent communication"
```

---

## Task 8: Review Overview Page (Redesigned)

Replace the current flat list with a grouped, batch-actionable overview.

**Files:**
- Modify: `dashboard/src/app/review/page.tsx`

- [ ] **Step 1: Rewrite the review overview page**

Replace `dashboard/src/app/review/page.tsx`:

```tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface Draft {
  id: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  content: string;
  excerpt: string;
}

interface GroupedDrafts {
  [course: string]: Draft[];
}

function groupByCourse(drafts: Draft[]): GroupedDrafts {
  const groups: GroupedDrafts = {};
  for (const draft of drafts) {
    const course = (draft.frontmatter.course as string) || 'Unsorted';
    if (!groups[course]) groups[course] = [];
    groups[course].push(draft);
  }
  return groups;
}

export default function ReviewPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Batch edit state
  const [batchField, setBatchField] = useState<string | null>(null);
  const [batchValue, setBatchValue] = useState('');

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/review');
    const data = await res.json();
    setDrafts(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === drafts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(drafts.map((d) => d.id)));
    }
  }

  async function handleBatchAction(action: 'approve' | 'reject') {
    if (selected.size === 0) return;
    setBusy(true);
    setMessage(null);
    let successCount = 0;
    for (const id of selected) {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (res.ok) successCount++;
    }
    setMessage(`${action === 'approve' ? 'Approved' : 'Rejected'} ${successCount}/${selected.size} drafts`);
    setSelected(new Set());
    setBusy(false);
    await loadDrafts();
  }

  async function applyBatchMetadata() {
    if (!batchField || !batchValue || selected.size === 0) return;
    setBusy(true);
    setMessage(null);
    let successCount = 0;
    for (const id of selected) {
      const res = await fetch(`/api/review/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [batchField]: batchValue }),
      });
      if (res.ok) successCount++;
    }
    setMessage(`Updated ${batchField} on ${successCount}/${selected.size} drafts`);
    setBatchField(null);
    setBatchValue('');
    setBusy(false);
    await loadDrafts();
  }

  if (loading) return <p className="text-gray-400">Loading drafts...</p>;

  const grouped = groupByCourse(drafts);
  const courseNames = Object.keys(grouped).sort((a, b) =>
    a === 'Unsorted' ? 1 : b === 'Unsorted' ? -1 : a.localeCompare(b)
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Review Queue ({drafts.length})</h2>
        {drafts.length > 0 && (
          <button onClick={toggleSelectAll} className="text-sm text-gray-400 hover:text-gray-200">
            {selected.size === drafts.length ? 'Deselect all' : 'Select all'}
          </button>
        )}
      </div>

      {message && (
        <div className="mb-4 px-4 py-3 rounded bg-gray-800 text-gray-200 text-sm">{message}</div>
      )}

      {/* Batch actions bar */}
      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded bg-gray-800 border border-gray-700">
          <span className="text-sm text-gray-300">{selected.size} selected</span>
          <button
            onClick={() => handleBatchAction('approve')}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-green-800 hover:bg-green-700 text-green-100 disabled:opacity-50"
          >
            Approve all
          </button>
          <button
            onClick={() => handleBatchAction('reject')}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-red-900 hover:bg-red-800 text-red-100 disabled:opacity-50"
          >
            Reject all
          </button>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={batchField || ''}
              onChange={(e) => setBatchField(e.target.value || null)}
              className="text-sm bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-gray-200"
            >
              <option value="">Set field...</option>
              <option value="course">Course</option>
              <option value="semester">Semester</option>
              <option value="type">Type</option>
            </select>
            {batchField && (
              <>
                <input
                  type="text"
                  value={batchValue}
                  onChange={(e) => setBatchValue(e.target.value)}
                  placeholder={`Enter ${batchField}...`}
                  className="text-sm bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-gray-200 w-40"
                />
                <button
                  onClick={applyBatchMetadata}
                  disabled={busy || !batchValue}
                  className="px-3 py-1.5 text-sm rounded bg-blue-800 hover:bg-blue-700 text-blue-100 disabled:opacity-50"
                >
                  Apply
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {drafts.length === 0 ? (
        <p className="text-gray-500">No drafts awaiting review.</p>
      ) : (
        <div className="space-y-8">
          {courseNames.map((course) => (
            <div key={course}>
              <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
                {course} ({grouped[course].length})
              </h3>
              <div className="space-y-2">
                {grouped[course].map((draft) => (
                  <div
                    key={draft.id}
                    className={`flex items-center gap-4 bg-gray-900 border rounded-lg px-4 py-3 ${
                      selected.has(draft.id) ? 'border-blue-600' : 'border-gray-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(draft.id)}
                      onChange={() => toggleSelect(draft.id)}
                      className="shrink-0"
                    />
                    <Link href={`/review/${draft.id}`} className="flex-1 min-w-0 group">
                      <h4 className="font-medium text-gray-100 truncate group-hover:text-blue-400">
                        {String(draft.frontmatter.title || draft.id)}
                      </h4>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        {draft.frontmatter.type && <span>{String(draft.frontmatter.type)}</span>}
                        {draft.frontmatter.source && <span>{String(draft.frontmatter.source)}</span>}
                        {Array.isArray(draft.frontmatter.figures) && draft.frontmatter.figures.length > 0 && (
                          <span>{draft.frontmatter.figures.length} figures</span>
                        )}
                        {draft.frontmatter.created && <span>{String(draft.frontmatter.created)}</span>}
                      </div>
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add PATCH endpoint for batch metadata updates**

Add PATCH handler to `dashboard/src/app/api/review/[id]/route.ts`:

```typescript
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const filePath = join(DRAFTS_DIR, `${id}.md`);

  try {
    const updates = await req.json();
    const raw = await readFile(filePath, 'utf-8');
    const { data, content } = matter(raw);

    const merged = { ...data, ...updates };
    const updated = matter.stringify(content, merged);
    await writeFile(filePath, updated, 'utf-8');

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }
}
```

Add the missing imports at the top of that file: `writeFile` from `fs/promises`.

- [ ] **Step 3: Run dashboard build**

Run: `cd dashboard && npm run build`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/review/page.tsx dashboard/src/app/api/review/\[id\]/route.ts
git commit -m "feat: redesign review overview with course grouping and batch actions"
```

---

## Task 9: Review Detail Page (Three-Panel)

The core UI: source viewer, draft editor with rendered markdown and editable metadata, and chat panel.

**Files:**
- Modify: `dashboard/src/app/review/[id]/page.tsx`

- [ ] **Step 1: Install react-markdown for rendered content**

```bash
cd dashboard && npm install react-markdown
```

- [ ] **Step 2: Rewrite the detail page**

Replace `dashboard/src/app/review/[id]/page.tsx`:

```tsx
'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';

interface DraftDetail {
  id: string;
  frontmatter: Record<string, unknown>;
  content: string;
  source: string | null;
}

interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
}

export default function ReviewDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Editable metadata
  const [editTitle, setEditTitle] = useState('');
  const [editCourse, setEditCourse] = useState('');
  const [editSemester, setEditSemester] = useState('');
  const [editType, setEditType] = useState('');
  const [editTags, setEditTags] = useState('');

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Source panel
  const [sourceCollapsed, setSourceCollapsed] = useState(false);

  const loadDraft = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/review/${id}`);
    if (!res.ok) {
      setDraft(null);
      setLoading(false);
      return;
    }
    const data: DraftDetail = await res.json();
    setDraft(data);
    setEditTitle(String(data.frontmatter.title || ''));
    setEditCourse(String(data.frontmatter.course || ''));
    setEditSemester(String(data.frontmatter.semester || ''));
    setEditType(String(data.frontmatter.type || ''));
    setEditTags(Array.isArray(data.frontmatter.tags) ? data.frontmatter.tags.join(', ') : '');
    setLoading(false);
  }, [id]);

  useEffect(() => { loadDraft(); }, [loadDraft]);

  // SSE connection for agent responses
  useEffect(() => {
    const es = new EventSource(`/api/chat/${id}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message' && data.text) {
          setChatMessages((prev) => [
            ...prev,
            { role: 'agent', text: data.text, timestamp: new Date().toISOString() },
          ]);
          // Refresh draft when agent updates it
          loadDraft();
        }
      } catch {
        // Ignore parse errors from SSE comments
      }
    };

    return () => { es.close(); };
  }, [id, loadDraft]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  async function handleAction(action: 'approve' | 'reject') {
    setBusy(true);
    setMessage(null);
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    const data = await res.json();
    setMessage(data.message || data.error);
    setBusy(false);
    if (res.ok) {
      // Auto-advance: navigate to review queue (which will show next draft)
      setTimeout(() => router.push('/review'), 500);
    }
  }

  async function saveMetadata() {
    setBusy(true);
    const updates: Record<string, unknown> = {
      title: editTitle,
      course: editCourse || null,
      semester: editSemester ? parseInt(editSemester, 10) : null,
      type: editType || null,
      tags: editTags ? editTags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    };
    await fetch(`/api/review/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    setBusy(false);
    await loadDraft();
    setMessage('Metadata saved');
  }

  async function sendChatMessage() {
    if (!chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput('');
    setChatBusy(true);
    setChatMessages((prev) => [
      ...prev,
      { role: 'user', text, timestamp: new Date().toISOString() },
    ]);

    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: id, text }),
      });
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'agent', text: `Error: ${err}`, timestamp: new Date().toISOString() },
      ]);
    }
    setChatBusy(false);
  }

  async function removeFigure(figure: string) {
    setBusy(true);
    await fetch(`/api/review/${id}/figures`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figure }),
    });
    setBusy(false);
    await loadDraft();
  }

  if (loading) return <p className="text-gray-400">Loading...</p>;
  if (!draft) return <p className="text-gray-400">Draft not found.</p>;

  const figures = Array.isArray(draft.frontmatter.figures)
    ? (draft.frontmatter.figures as string[])
    : [];
  const sourceFile = draft.frontmatter.source
    ? String(draft.frontmatter.source).replace(/^\[\[/, '').replace(/\]\]$/, '')
    : null;
  const courseDir = draft.frontmatter.course || '_unsorted';

  return (
    <div className="h-[calc(100vh-5rem)]">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <button onClick={() => router.push('/review')} className="text-sm text-gray-400 hover:text-gray-200">
          &larr; Back to queue
        </button>
        <h2 className="text-lg font-semibold truncate">{String(draft.frontmatter.title || id)}</h2>
        {message && <span className="text-sm text-gray-400 ml-auto">{message}</span>}
      </div>

      {/* Three-panel layout */}
      <div className="flex gap-4 h-[calc(100%-3rem)]">

        {/* Left: Source viewer */}
        {!sourceCollapsed && sourceFile && (
          <div className="w-1/3 flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden shrink-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
              <span className="text-xs text-gray-400 truncate">{sourceFile}</span>
              <button onClick={() => setSourceCollapsed(true)} className="text-xs text-gray-500 hover:text-gray-300">
                Collapse
              </button>
            </div>
            <iframe
              src={`/api/attachments/${courseDir}/${encodeURIComponent(sourceFile)}`}
              className="flex-1 w-full bg-white"
              title="Source document"
            />
          </div>
        )}

        {sourceCollapsed && (
          <button
            onClick={() => setSourceCollapsed(false)}
            className="w-8 flex items-center justify-center bg-gray-900 border border-gray-800 rounded-lg text-gray-500 hover:text-gray-300 shrink-0"
            title="Expand source"
          >
            &raquo;
          </button>
        )}

        {/* Center: Draft */}
        <div className="flex-1 flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden min-w-0">
          <div className="flex-1 overflow-y-auto p-4">
            {/* Metadata form */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-xs text-gray-500">Title</label>
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="w-full text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
              </div>
              <div>
                <label className="text-xs text-gray-500">Course</label>
                <input value={editCourse} onChange={(e) => setEditCourse(e.target.value)} placeholder="e.g. IS-1500" className="w-full text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
              </div>
              <div>
                <label className="text-xs text-gray-500">Semester</label>
                <input value={editSemester} onChange={(e) => setEditSemester(e.target.value)} type="number" className="w-full text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
              </div>
              <div>
                <label className="text-xs text-gray-500">Type</label>
                <select value={editType} onChange={(e) => setEditType(e.target.value)} className="w-full text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200">
                  <option value="">—</option>
                  <option value="lecture">Lecture</option>
                  <option value="reading">Reading</option>
                  <option value="assignment">Assignment</option>
                  <option value="exam-prep">Exam Prep</option>
                  <option value="lab">Lab</option>
                  <option value="project">Project</option>
                  <option value="reference">Reference</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-xs text-gray-500">Tags (comma-separated)</label>
                <input value={editTags} onChange={(e) => setEditTags(e.target.value)} className="w-full text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
              </div>
            </div>
            <button onClick={saveMetadata} disabled={busy} className="text-sm px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50 mb-6">
              Save metadata
            </button>

            {/* Rendered content */}
            <div className="prose prose-invert prose-sm max-w-none mb-6">
              <ReactMarkdown
                components={{
                  img: ({ src, alt }) => {
                    // Resolve Obsidian ![[image]] embeds
                    const figureSrc = src?.startsWith('http') ? src : `/api/attachments/${courseDir}/figures/${src}`;
                    return <img src={figureSrc} alt={alt || ''} className="max-w-full rounded" />;
                  },
                }}
              >
                {draft.content}
              </ReactMarkdown>
            </div>

            {/* Figures */}
            {figures.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-400 mb-3">Figures</h3>
                <div className="grid grid-cols-2 gap-3">
                  {figures.map((fig) => (
                    <div key={fig} className="relative group">
                      <img
                        src={`/api/attachments/${courseDir}/figures/${draft.frontmatter.source ? String(draft.frontmatter.source).replace(/^\[\[/, '').replace(/\]\]$/, '').replace(/\.[^.]+$/, '') : '_unsorted'}/${fig}`}
                        alt={fig}
                        className="w-full rounded border border-gray-700"
                      />
                      <button
                        onClick={() => removeFigure(fig)}
                        disabled={busy}
                        className="absolute top-1 right-1 px-2 py-0.5 text-xs rounded bg-red-900/80 text-red-100 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Remove
                      </button>
                      <span className="text-xs text-gray-500 mt-1 block">{fig}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Actions bar */}
          <div className="flex gap-3 px-4 py-3 border-t border-gray-800">
            <button
              onClick={() => handleAction('approve')}
              disabled={busy}
              className="px-4 py-2 rounded bg-green-800 hover:bg-green-700 text-green-100 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => handleAction('reject')}
              disabled={busy}
              className="px-4 py-2 rounded bg-red-900 hover:bg-red-800 text-red-100 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>

        {/* Right: Chat */}
        <div className="w-80 flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden shrink-0">
          <div className="px-3 py-2 border-b border-gray-800">
            <span className="text-xs text-gray-400">Chat with Review Agent</span>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {chatMessages.length === 0 && (
              <p className="text-xs text-gray-600 italic">Send a message to refine this draft...</p>
            )}
            {chatMessages.map((msg, i) => (
              <div
                key={i}
                className={`text-sm rounded-lg px-3 py-2 ${
                  msg.role === 'user'
                    ? 'bg-blue-900/30 text-blue-100 ml-8'
                    : 'bg-gray-800 text-gray-200 mr-8'
                }`}
              >
                {msg.text}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="px-3 py-2 border-t border-gray-800">
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendChatMessage()}
                placeholder="Ask the agent..."
                disabled={chatBusy}
                className="flex-1 text-sm bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 disabled:opacity-50"
              />
              <button
                onClick={sendChatMessage}
                disabled={chatBusy || !chatInput.trim()}
                className="px-3 py-1.5 text-sm rounded bg-blue-800 hover:bg-blue-700 text-blue-100 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run dashboard build**

Run: `cd dashboard && npm run build`
Expected: Clean compilation

- [ ] **Step 4: Test manually**

Start the dashboard with `cd dashboard && npm run dev` and navigate to `/review/{id}` for an existing draft. Verify:
- Three-panel layout renders
- Source PDF loads in iframe (if available)
- Metadata form is populated and editable
- Save metadata works
- Chat input is visible (agent won't respond yet until NanoClaw is running with web channel)

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/review/\[id\]/page.tsx dashboard/package.json dashboard/package-lock.json
git commit -m "feat: three-panel review detail page with source viewer, metadata editor, and chat"
```

---

## Task 10: Integration Wiring and End-to-End Test

Connect all the pieces: ensure the web channel is imported, the review agent group registers on startup, and the pipeline triggers agent processing.

**Files:**
- Modify: `src/index.ts` (final wiring)

- [ ] **Step 1: Verify all imports and startup sequence**

Ensure `src/index.ts` has:

1. `import './channels/index.js'` (which now includes `import './web.js'`)
2. Review agent group registration (from Task 2)
3. Pipeline construction with `getReviewAgentGroup` (from Task 4)

Review the file to confirm all three are present and in the correct order.

- [ ] **Step 2: Build and test**

Run: `npm run build && npm test`
Expected: Clean build, all tests pass

- [ ] **Step 3: End-to-end manual test**

1. Start NanoClaw: `npm run dev`
2. Start dashboard: `cd dashboard && npm run dev`
3. Drop a PDF into `upload/`
4. Watch NanoClaw logs — should see agent container spawning for the document
5. After processing, check `/review` in dashboard — should show the draft with agent-generated notes
6. Open the draft — three-panel view should show source, draft content, and chat
7. Send a chat message — should reach the web channel and spawn an agent container
8. Verify agent response appears in chat panel

- [ ] **Step 4: Commit any fixes from integration testing**

```bash
git add -A
git commit -m "fix: integration wiring for review workflow"
```

---

## Summary

| Task | What it builds | Key files |
|------|---------------|-----------|
| 1 | Web channel (HTTP + SSE) | `src/channels/web.ts` |
| 2 | Review agent group + instructions | `groups/review_agent/CLAUDE.md` |
| 3 | Agent processor (container per doc) | `src/ingestion/agent-processor.ts` |
| 4 | Rewired ingestion pipeline | `src/ingestion/index.ts` |
| 5 | Fixed approve API + single draft GET | `dashboard/src/app/api/review/` |
| 6 | Attachments serving API | `dashboard/src/app/api/attachments/` |
| 7 | Chat API (forward + SSE proxy) | `dashboard/src/app/api/chat/` |
| 8 | Redesigned overview page | `dashboard/src/app/review/page.tsx` |
| 9 | Three-panel detail page | `dashboard/src/app/review/[id]/page.tsx` |
| 10 | Integration wiring + E2E test | `src/index.ts` |
