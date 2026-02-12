/**
 * mla-escalation.ts — MLA escalation and reply handling.
 *
 * Provides functions to escalate complaints to the MLA via WhatsApp DM
 * and to detect/forward MLA replies back to the admin group.
 */
import type Database from 'better-sqlite3';

import { transitionComplaintStatus } from './complaint-utils.js';

export interface MlaEscalationDeps {
  db: Database.Database;
  sendMessage: (jid: string, text: string) => Promise<void>;
  adminGroupJid: string;
  mlaPhone: string;
}

interface ComplaintRow {
  id: string;
  phone: string;
  category: string | null;
  description: string;
  location: string | null;
  status: string;
}

/** Format a complaint for MLA escalation. */
export function formatMlaEscalation(
  complaint: {
    id: string;
    phone: string;
    category: string | null;
    description: string;
    location: string | null;
    status: string;
  },
  reason: string,
): string {
  const lines = [
    '\u{1F534} Urgent Escalation',
    `Complaint: ${complaint.id}`,
    `From: ${complaint.phone}`,
    `Category: ${complaint.category ?? 'N/A'}`,
    `Location: ${complaint.location ?? 'N/A'}`,
    `Description: ${complaint.description}`,
    `Reason for escalation: ${reason}`,
    '',
    'Reply to this message to respond (will be forwarded to admin group).',
  ];
  return lines.join('\n');
}

/** Execute #escalate-to-mla command from admin group. */
export async function escalateToMla(
  deps: MlaEscalationDeps,
  complaintId: string,
  reason: string,
  senderPhone: string,
): Promise<string> {
  if (!deps.mlaPhone) {
    return 'MLA phone not configured. Check tenant config.';
  }

  const complaint = deps.db
    .prepare(
      'SELECT id, phone, category, description, location, status FROM complaints WHERE id = ?',
    )
    .get(complaintId) as ComplaintRow | undefined;

  if (!complaint) {
    return `Complaint '${complaintId}' not found.`;
  }

  // Transition status (handles UPDATE, audit record, and event emission)
  const note = `Escalated to MLA: ${reason}`;
  const oldStatus = transitionComplaintStatus(
    deps.db,
    complaintId,
    'escalated',
    note,
    senderPhone,
  );

  if (oldStatus === null) {
    return `Complaint '${complaintId}' not found.`;
  }

  // Format and send MLA DM
  const message = formatMlaEscalation(complaint, reason);
  await deps.sendMessage(`${deps.mlaPhone}@s.whatsapp.net`, message);

  return `Complaint ${complaintId} escalated to MLA.`;
}

/** Check if a message is from MLA and handle reply forwarding. */
export async function handleMlaReply(
  deps: MlaEscalationDeps,
  senderPhone: string,
  text: string,
): Promise<string | null> {
  if (senderPhone !== deps.mlaPhone) {
    return null;
  }

  const forwardMessage = `\u{1F4E9} MLA Reply\n${text}`;
  await deps.sendMessage(deps.adminGroupJid, forwardMessage);

  return 'Your reply has been forwarded to the admin group.';
}
