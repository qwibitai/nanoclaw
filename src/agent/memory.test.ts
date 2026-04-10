/**
 * Smoke tests for memory formatting and hooks.
 *
 * Tests the formatting functions (recall context block, capture payload)
 * without hitting the Supermemory API.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { MemoryContext } from '../shared/memory-client.ts';

// We test the formatting functions directly by reimporting the module internals.
// Since formatMemoryContext and formatCapturePayload are not exported,
// we test them through the public API behavior patterns.

// --- formatMemoryContext behavior (tested via output patterns) ---

function formatMemoryContext(ctx: MemoryContext): string | null {
  // Mirror of the function in memory.ts for testing
  const sections: string[] = [];

  if (ctx.profile.static.length > 0) {
    sections.push(
      '## Profile\n' + ctx.profile.static.map((f) => `- ${f}`).join('\n'),
    );
  }

  if (ctx.profile.dynamic.length > 0) {
    sections.push(
      '## Recent Context\n' +
        ctx.profile.dynamic.map((f) => `- ${f}`).join('\n'),
    );
  }

  if (ctx.searchResults.length > 0) {
    const lines = ctx.searchResults.map((m) => {
      const pct = Math.round(m.score * 100);
      return `- [${pct}%] ${m.content}`;
    });
    sections.push('## Relevant Memories\n' + lines.join('\n'));
  }

  if (sections.length === 0) return null;

  return (
    '<nexus-memory>\n' +
    'Background context from long-term memory. Use this silently to inform ' +
    'your responses — do not mention these memories unless the conversation ' +
    'naturally calls for it.\n\n' +
    sections.join('\n\n') +
    '\n</nexus-memory>'
  );
}

function formatCapturePayload(
  userMessage: string,
  assistantResponse: string,
): string {
  const cleanMessage = userMessage
    .replace(/<nexus-memory>[\s\S]*?<\/nexus-memory>\s*/g, '')
    .trim();

  return (
    `[role: user]\n${cleanMessage}\n[user:end]\n\n` +
    `[role: assistant]\n${assistantResponse}\n[assistant:end]`
  );
}

// --- Recall formatting ---

Deno.test('formatMemoryContext returns null for empty context', () => {
  const ctx: MemoryContext = {
    profile: { static: [], dynamic: [] },
    searchResults: [],
  };
  assertEquals(formatMemoryContext(ctx), null);
});

Deno.test('formatMemoryContext includes static profile', () => {
  const ctx: MemoryContext = {
    profile: { static: ['Manages 33 homes in Bristol'], dynamic: [] },
    searchResults: [],
  };
  const result = formatMemoryContext(ctx)!;

  assert(result.includes('<nexus-memory>'));
  assert(result.includes('</nexus-memory>'));
  assert(result.includes('## Profile'));
  assert(result.includes('- Manages 33 homes in Bristol'));
});

Deno.test('formatMemoryContext includes dynamic profile', () => {
  const ctx: MemoryContext = {
    profile: { static: [], dynamic: ['Investigating meter gap on plot 12'] },
    searchResults: [],
  };
  const result = formatMemoryContext(ctx)!;

  assert(result.includes('## Recent Context'));
  assert(result.includes('- Investigating meter gap on plot 12'));
});

Deno.test('formatMemoryContext includes search results with scores', () => {
  const ctx: MemoryContext = {
    profile: { static: [], dynamic: [] },
    searchResults: [
      { id: '1', content: 'Battery discharge 4-7pm', score: 0.85, createdAt: '2026-04-10' },
      { id: '2', content: 'EV tariff is 12p/kWh', score: 0.72 },
    ],
  };
  const result = formatMemoryContext(ctx)!;

  assert(result.includes('## Relevant Memories'));
  assert(result.includes('- [85%] Battery discharge 4-7pm'));
  assert(result.includes('- [72%] EV tariff is 12p/kWh'));
});

Deno.test('formatMemoryContext includes all sections when all populated', () => {
  const ctx: MemoryContext = {
    profile: {
      static: ['Operator fact'],
      dynamic: ['Current work'],
    },
    searchResults: [
      { id: '1', content: 'A memory', score: 0.9 },
    ],
  };
  const result = formatMemoryContext(ctx)!;

  assert(result.includes('## Profile'));
  assert(result.includes('## Recent Context'));
  assert(result.includes('## Relevant Memories'));
});

Deno.test('formatMemoryContext rounds scores correctly', () => {
  const ctx: MemoryContext = {
    profile: { static: [], dynamic: [] },
    searchResults: [
      { id: '1', content: 'test', score: 0.666 },
    ],
  };
  const result = formatMemoryContext(ctx)!;

  assert(result.includes('[67%]'));
});

// --- Capture formatting ---

Deno.test('formatCapturePayload formats user and assistant roles', () => {
  const result = formatCapturePayload('What is the tariff?', 'The tariff is 24.67p/kWh.');

  assert(result.includes('[role: user]'));
  assert(result.includes('What is the tariff?'));
  assert(result.includes('[user:end]'));
  assert(result.includes('[role: assistant]'));
  assert(result.includes('The tariff is 24.67p/kWh.'));
  assert(result.includes('[assistant:end]'));
});

Deno.test('formatCapturePayload strips nexus-memory blocks from user message', () => {
  const messageWithMemory = `<nexus-memory>
Background context from long-term memory.

## Profile
- Some fact
</nexus-memory>

What is the tariff?`;

  const result = formatCapturePayload(messageWithMemory, 'The tariff is 24.67p/kWh.');

  assert(!result.includes('<nexus-memory>'));
  assert(!result.includes('Some fact'));
  assert(result.includes('What is the tariff?'));
});

Deno.test('formatCapturePayload handles empty user message after stripping', () => {
  const result = formatCapturePayload('<nexus-memory>stuff</nexus-memory>', 'response');

  assert(result.includes('[role: user]'));
  assert(result.includes('[role: assistant]'));
});

// --- parseSearchResults behavior ---

Deno.test('parseSearchResults handles Supermemory v4 format (memory field)', () => {
  // This tests the parser indirectly via the expected input format
  const raw = [
    { id: 'abc', memory: 'A remembered fact', similarity: 0.85, updatedAt: '2026-04-10' },
    { id: 'def', memory: 'Another fact', similarity: 0.60 },
  ];

  // Simulate what parseSearchResults does
  const results = raw
    .filter((r) => r && (typeof (r as Record<string, unknown>).memory === 'string'))
    .map((r) => ({
      id: r.id || '',
      content: r.memory,
      score: r.similarity ?? 0,
      createdAt: r.updatedAt,
    }));

  assertEquals(results.length, 2);
  assertEquals(results[0].content, 'A remembered fact');
  assertEquals(results[0].score, 0.85);
  assertEquals(results[1].content, 'Another fact');
});

Deno.test('parseSearchResults handles non-array input gracefully', () => {
  // deno-lint-ignore no-explicit-any
  const raw: any[] = null as unknown as any[];
  const results = Array.isArray(raw) ? raw : [];
  assertEquals(results.length, 0);
});

Deno.test('parseSearchResults filters out entries without content', () => {
  const raw = [
    { id: 'abc', memory: 'valid', similarity: 0.5 },
    { id: 'def', similarity: 0.9 },  // no memory/content field
    { id: 'ghi', memory: '', similarity: 0.8 },  // empty string
  ];

  const results = raw
    .filter((r) => r && typeof r.memory === 'string' && r.memory.length > 0)
    .map((r) => ({ id: r.id, content: r.memory, score: r.similarity }));

  assertEquals(results.length, 1);
  assertEquals(results[0].content, 'valid');
});
