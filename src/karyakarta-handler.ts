/**
 * karyakarta-handler.ts — Karyakarta validation commands.
 *
 * Handles #approve, #reject, and #my-complaints commands from karyakartas.
 * Also listens for new complaints to notify assigned karyakartas.
 */
import type Database from 'better-sqlite3';

import { extractComplaintId, interpretReply } from './admin-reply.js';
import {
  getAreasForKaryakarta,
  getKaryakartasForArea,
  createValidation,
} from './area-db.js';
import { addComplaintNote } from './complaint-utils.js';
import { eventBus, type ComplaintEvent } from './event-bus.js';
import { logger } from './logger.js';
import type { Complaint, RejectionReason } from './types.js';
import { nowISO } from './utils.js';

export interface KaryakartaHandlerDeps {
  db: Database.Database;
  sendMessage: (jid: string, text: string) => Promise<void>;
  adminGroupJid: string;
}

const VALID_REJECTION_REASONS: RejectionReason[] = [
  'duplicate',
  'fraud',
  'not_genuine',
  'out_of_area',
  'insufficient_info',
  'other',
];

/**
 * Handle a natural language reply to a karyakarta notification message.
 * Returns response string, or null if the reply couldn't be matched to a complaint.
 */
export async function handleKaryakartaReply(
  deps: KaryakartaHandlerDeps,
  senderPhone: string,
  replyText: string,
  quotedText: string,
): Promise<string | null> {
  const complaintId = extractComplaintId(quotedText);
  if (!complaintId) return null;

  const { db } = deps;
  const complaint = db
    .prepare('SELECT * FROM complaints WHERE id = ?')
    .get(complaintId) as Complaint | undefined;
  if (!complaint) return null;

  if (complaint.status !== 'pending_validation') {
    return `Complaint ${complaintId} is in '${complaint.status}' status, not pending_validation. Only pending_validation complaints can be acted on.`;
  }

  // Verify karyakarta is assigned to complaint's area
  const areas = getAreasForKaryakarta(db, senderPhone);
  const areaIds = areas.map((a) => a.id);
  if (!complaint.area_id || !areaIds.includes(complaint.area_id)) {
    return `Complaint ${complaintId} is not in your assigned area.`;
  }

  const result = await interpretReply(
    replyText,
    complaint,
    'karyakarta',
    [],
  );

  switch (result.action) {
    case 'approve':
      return handleApprove(deps, senderPhone, `#approve ${complaintId}${result.note ? ': ' + result.note : ''}`);

    case 'reject': {
      const reason = result.rejectionReason ?? 'other';
      const note = result.note ? `: ${result.note}` : '';
      return handleReject(deps, senderPhone, `#reject ${complaintId} ${reason}${note}`);
    }

    case 'add_note': {
      addComplaintNote(db, complaintId, result.note ?? replyText, senderPhone);
      const lang = complaint.language || 'mr';
      return lang === 'hi' ? `शिकायत ${complaintId} पर नोट जोड़ी गई.`
        : lang === 'mr' ? `तक्रार ${complaintId} वर टीप जोडली.`
        : `Note added to ${complaintId}.`;
    }

    default: {
      const lang = complaint.language || 'mr';
      return lang === 'hi' ? 'आपका जवाब समझ नहीं आया. "approve" या "reject" लिखकर जवाब दें.'
        : lang === 'mr' ? 'तुमचा प्रतिसाद समजला नाही. "approve" किंवा "reject" लिहून पाठवा.'
        : 'Could not understand your reply. Reply with "approve", "reject", or a clear action.';
    }
  }
}

/**
 * Handle a karyakarta command (#approve, #reject, #my-complaints).
 * Returns response string for the karyakarta, or null if not a recognized command.
 */
export async function handleKaryakartaCommand(
  deps: KaryakartaHandlerDeps,
  senderPhone: string,
  text: string,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('#')) return null;

  if (trimmed.startsWith('#approve ')) {
    return handleApprove(deps, senderPhone, trimmed);
  }
  if (trimmed.startsWith('#reject ')) {
    return handleReject(deps, senderPhone, trimmed);
  }
  if (trimmed === '#my-complaints') {
    return handleMyComplaints(deps, senderPhone);
  }

  return null;
}

function parseCommandWithNote(rest: string): { id: string; note?: string } {
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) {
    return { id: rest.trim() };
  }
  return {
    id: rest.slice(0, colonIdx).trim(),
    note: rest.slice(colonIdx + 1).trim() || undefined,
  };
}

async function handleApprove(
  deps: KaryakartaHandlerDeps,
  senderPhone: string,
  text: string,
): Promise<string> {
  const { db, sendMessage, adminGroupJid } = deps;
  const rest = text.slice('#approve '.length);
  const { id: complaintId, note } = parseCommandWithNote(rest);

  // Look up complaint
  const complaint = db
    .prepare('SELECT * FROM complaints WHERE id = ?')
    .get(complaintId) as Complaint | undefined;
  if (!complaint) {
    return `Complaint ${complaintId} not found.`;
  }

  // Must be in pending_validation
  if (complaint.status !== 'pending_validation') {
    return `Complaint ${complaintId} is in '${complaint.status}' status, not pending_validation. Only pending_validation complaints can be approved.`;
  }

  // Karyakarta must be assigned to the complaint's area
  const areas = getAreasForKaryakarta(db, senderPhone);
  const areaIds = areas.map((a) => a.id);
  if (!complaint.area_id || !areaIds.includes(complaint.area_id)) {
    return `Complaint ${complaintId} is not in your assigned area. You can only approve complaints in your areas.`;
  }

  // Update status
  const now = nowISO();
  db.prepare(
    'UPDATE complaints SET status = ?, updated_at = ? WHERE id = ?',
  ).run('validated', now, complaintId);

  // Create validation record
  createValidation(db, {
    complaint_id: complaintId,
    validated_by: senderPhone,
    action: 'approved',
    comment: note,
  });

  // Emit status change for user notification
  eventBus.emit('complaint:status-changed', {
    complaintId,
    phone: complaint.phone,
    oldStatus: 'pending_validation',
    newStatus: 'validated',
    note,
    updatedBy: senderPhone,
  });

  // Forward to admin group
  const adminMsg = [
    'Complaint Validated',
    `ID: ${complaintId}`,
    `Category: ${complaint.category ?? 'N/A'}`,
    `Status: validated`,
    `Validated by: ${senderPhone}`,
    note ? `Note: ${note}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  sendMessage(adminGroupJid, adminMsg).catch((err) => {
    logger.error(
      { err, complaintId },
      'Failed to forward validation to admin group',
    );
  });

  return `Complaint ${complaintId} approved and forwarded to admin group.`;
}

async function handleReject(
  deps: KaryakartaHandlerDeps,
  senderPhone: string,
  text: string,
): Promise<string> {
  const { db } = deps;
  const rest = text.slice('#reject '.length);

  // Parse: #reject RK-XXXX reason_code: optional note
  // First token is complaint ID, second is reason_code (optionally followed by ": note")
  const parts = rest.split(/\s+/);
  if (parts.length < 2) {
    return `Usage: #reject <complaint_id> <reason_code>: optional note\nValid reason codes: ${VALID_REJECTION_REASONS.join(', ')}`;
  }

  const complaintId = parts[0];

  // The remainder after complaint ID might be "reason_code: note" or "reason_code"
  const afterId = rest.slice(complaintId.length).trim();
  const colonIdx = afterId.indexOf(':');
  let reasonCodeRaw: string;
  let note: string | undefined;

  if (colonIdx === -1) {
    reasonCodeRaw = afterId.trim();
  } else {
    reasonCodeRaw = afterId.slice(0, colonIdx).trim();
    note = afterId.slice(colonIdx + 1).trim() || undefined;
  }

  // Validate reason code
  if (!VALID_REJECTION_REASONS.includes(reasonCodeRaw as RejectionReason)) {
    return `Invalid reason code '${reasonCodeRaw}'. Valid codes: ${VALID_REJECTION_REASONS.join(', ')}`;
  }
  const reasonCode = reasonCodeRaw as RejectionReason;

  // Look up complaint
  const complaint = db
    .prepare('SELECT * FROM complaints WHERE id = ?')
    .get(complaintId) as Complaint | undefined;
  if (!complaint) {
    return `Complaint ${complaintId} not found.`;
  }

  // Must be in pending_validation
  if (complaint.status !== 'pending_validation') {
    return `Complaint ${complaintId} is in '${complaint.status}' status, not pending_validation. Only pending_validation complaints can be rejected.`;
  }

  // Karyakarta must be assigned to complaint's area
  const areas = getAreasForKaryakarta(db, senderPhone);
  const areaIds = areas.map((a) => a.id);
  if (!complaint.area_id || !areaIds.includes(complaint.area_id)) {
    return `Complaint ${complaintId} is not in your assigned area. You can only reject complaints in your areas.`;
  }

  // Update status
  const now = nowISO();
  db.prepare(
    'UPDATE complaints SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?',
  ).run('rejected', reasonCode, now, complaintId);

  // Create validation record
  createValidation(db, {
    complaint_id: complaintId,
    validated_by: senderPhone,
    action: 'rejected',
    reason_code: reasonCode,
    comment: note,
  });

  // Emit status change for user notification
  eventBus.emit('complaint:status-changed', {
    complaintId,
    phone: complaint.phone,
    oldStatus: 'pending_validation',
    newStatus: 'rejected',
    note: note ?? `Reason: ${reasonCode}`,
    updatedBy: senderPhone,
  });

  return `Complaint ${complaintId} rejected (${reasonCode}).`;
}

async function handleMyComplaints(
  deps: KaryakartaHandlerDeps,
  senderPhone: string,
): Promise<string> {
  const { db } = deps;

  const areas = getAreasForKaryakarta(db, senderPhone);
  if (areas.length === 0) {
    return 'You have no assigned areas. No pending complaints to show.';
  }

  const areaIds = areas.map((a) => a.id);
  const placeholders = areaIds.map(() => '?').join(', ');
  const complaints = db
    .prepare(
      `SELECT id, phone, category, description, area_id, created_at
       FROM complaints
       WHERE status = 'pending_validation' AND area_id IN (${placeholders})
       ORDER BY created_at`,
    )
    .all(...areaIds) as Array<{
    id: string;
    phone: string;
    category: string | null;
    description: string;
    area_id: string;
    created_at: string;
  }>;

  if (complaints.length === 0) {
    return 'No pending complaints in your areas.';
  }

  const lines = [`Pending complaints (${complaints.length}):\n`];
  for (const c of complaints) {
    const area = areas.find((a) => a.id === c.area_id);
    lines.push(
      `- ${c.id} | ${area?.name ?? c.area_id} | ${c.category ?? 'N/A'} | ${c.description.slice(0, 60)}`,
    );
  }

  lines.push('\nUse #approve <id> or #reject <id> <reason_code> to validate.');
  return lines.join('\n');
}

/**
 * Initialize listener that notifies karyakartas when a new complaint
 * with status pending_validation is created in their area.
 */
export function initKaryakartaNotifications(deps: KaryakartaHandlerDeps): void {
  const { db, sendMessage } = deps;

  eventBus.on('complaint:created', (event: ComplaintEvent) => {
    if (event.status !== 'pending_validation') return;

    // Look up the complaint to get area_id
    const complaint = db
      .prepare('SELECT area_id FROM complaints WHERE id = ?')
      .get(event.complaintId) as { area_id: string | null } | undefined;
    if (!complaint?.area_id) return;

    const karyakartas = getKaryakartasForArea(db, complaint.area_id);
    if (karyakartas.length === 0) return;

    const msg = [
      'New complaint pending validation',
      `ID: ${event.complaintId}`,
      `Category: ${event.category ?? 'N/A'}`,
      `Description: ${event.description.slice(0, 100)}`,
      '',
      'Reply to this message to approve or reject.',
      'Or use commands:',
      `#approve ${event.complaintId}: optional note`,
      `#reject ${event.complaintId} <reason_code>: optional note`,
    ].join('\n');

    for (const k of karyakartas) {
      const jid = `${k.phone}@s.whatsapp.net`;
      sendMessage(jid, msg).catch((err) => {
        logger.error(
          { err, phone: k.phone, complaintId: event.complaintId },
          'Failed to notify karyakarta',
        );
      });
    }
  });
}
