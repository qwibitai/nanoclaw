// Minimal synthesizer used for swarm aggregation.
// Keeps implementation local and deterministic so it works without external APIs.

export async function synthesizeMessages(messages: string[]): Promise<string> {
  if (messages.length === 0) return '';

  // Normalize and dedupe short lines
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const m of messages) {
    const trimmed = m.trim();
    if (!trimmed) continue;
    // Deduplicate identical messages
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);

    // If message is long, truncate to reasonable size to keep result compact
    const MAX_PER_MESSAGE = 1500;
    if (trimmed.length > MAX_PER_MESSAGE) parts.push(trimmed.slice(0, MAX_PER_MESSAGE) + '…');
    else parts.push(trimmed);
  }

  // Very simple compression: if there are short messages (<=140 chars), join with bullets;
  // otherwise join with separators and return.
  const short = parts.filter((p) => p.length <= 140);
  if (short.length === parts.length && parts.length <= 6) {
    // Join as bulleted list
    return parts.map((p) => `• ${p}`).join('\n');
  }

  // Otherwise return a synthesized header + concatenation.
  const header = `Synthesized (${parts.length}):`;
  return `${header}\n\n${parts.join('\n\n---\n\n')}`;
}
