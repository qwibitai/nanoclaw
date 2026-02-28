/**
 * Self-Knowledge: structured capability descriptions with progressive disclosure.
 *
 * Pure functions for testing. Container-side uses inline copies
 * (container can't import from src/).
 */

import { z } from 'zod';

// ── Schema ──────────────────────────────────────────────────────────

const CapabilityItemSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const CapabilitySectionSchema = z.object({
  title: z.string(),
  summary: z.string(),
  items: z.array(CapabilityItemSchema).default([]),
});

export const CapabilitiesDocSchema = z.object({
  version: z.number().default(1),
  agent_name: z.string().default('Agent'),
  summary: z.string(),
  sections: z.record(z.string(), CapabilitySectionSchema),
});

export type CapabilityItem = z.infer<typeof CapabilityItemSchema>;
export type CapabilitySection = z.infer<typeof CapabilitySectionSchema>;
export type CapabilitiesDoc = z.infer<typeof CapabilitiesDocSchema>;

// ── Parse ───────────────────────────────────────────────────────────

export function parseCapabilities(raw: unknown): CapabilitiesDoc {
  return CapabilitiesDocSchema.parse(raw);
}

// ── Format ──────────────────────────────────────────────────────────

/**
 * Top-level overview: agent name, summary, list of available sections.
 * Used when user asks "what can you do?" with no specific section.
 */
export function formatOverview(doc: CapabilitiesDoc): string {
  const lines: string[] = [];
  lines.push(`# ${doc.agent_name}`);
  lines.push('');
  lines.push(doc.summary);
  lines.push('');
  lines.push('## Available sections');
  lines.push('');

  for (const [key, section] of Object.entries(doc.sections)) {
    lines.push(`- **${key}** — ${section.summary}`);
  }

  lines.push('');
  lines.push('_Ask about a specific section for details (e.g. "tell me about your tools")._');

  return lines.join('\n');
}

/**
 * Detailed view of a single section with all items.
 */
export function formatSection(doc: CapabilitiesDoc, sectionName: string): string | null {
  const section = doc.sections[sectionName];
  if (!section) return null;

  const lines: string[] = [];
  lines.push(`# ${section.title}`);
  lines.push('');
  lines.push(section.summary);

  if (section.items.length > 0) {
    lines.push('');
    for (const item of section.items) {
      lines.push(`- **${item.name}** — ${item.description}`);
    }
  }

  return lines.join('\n');
}

/**
 * List available section keys.
 */
export function listSections(doc: CapabilitiesDoc): string[] {
  return Object.keys(doc.sections);
}

/**
 * Fuzzy match a user query to a section name.
 * Returns the best match or null.
 */
export function matchSection(doc: CapabilitiesDoc, query: string): string | null {
  const q = query.toLowerCase().trim();
  const keys = Object.keys(doc.sections);

  // Exact match
  if (keys.includes(q)) return q;

  // Partial match on key
  const keyMatch = keys.find(k => k.includes(q) || q.includes(k));
  if (keyMatch) return keyMatch;

  // Partial match on title
  const titleMatch = keys.find(k =>
    doc.sections[k].title.toLowerCase().includes(q) ||
    q.includes(doc.sections[k].title.toLowerCase()),
  );
  if (titleMatch) return titleMatch;

  return null;
}
