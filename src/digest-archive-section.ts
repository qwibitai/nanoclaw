import type { ArchiveTracker } from './archive-tracker.js';

/**
 * Generate the inbox cleanup section for the morning digest.
 * Lists emails that were acted on but not yet archived.
 * Returns empty string if no unarchived emails exist.
 */
export function generateArchiveDigestSection(tracker: ArchiveTracker): string {
  const unarchived = tracker.getUnarchived();
  if (unarchived.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push(`<b>━━ INBOX CLEANUP (${unarchived.length}) ━━</b>`);
  lines.push('Emails acted on but still in your inbox:');

  for (const email of unarchived) {
    lines.push(
      `  📬 [${email.account}] ${email.action_taken} — thread ${email.thread_id.slice(0, 8)}…`,
    );
  }

  lines.push('');
  lines.push('Reply "archive all" to batch-archive these threads.');

  return lines.join('\n');
}
