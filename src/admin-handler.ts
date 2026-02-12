/**
 * admin-handler.ts — Admin group notification and command handling.
 *
 * Listens on the event bus for complaint lifecycle events and posts
 * formatted notifications to the WhatsApp admin group. Also parses
 * # commands from admin group messages.
 */
import type Database from 'better-sqlite3';

import { executeAdminCommand, isKaryakartaCommand } from './admin-commands.js';
import { eventBus } from './event-bus.js';
import type { ComplaintEvent, StatusChangeEvent } from './event-bus.js';
import { logger } from './logger.js';
import { escalateToMla } from './mla-escalation.js';
import { getUserRole, setUserRole } from './roles.js';
import type { UserRole } from './types.js';
import { nowISO } from './utils.js';

/** Format a status string for display (e.g. "in_progress" -> "In Progress"). */
function formatStatus(status: string): string {
  return status
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Normalize a phone string by stripping leading + and spaces. */
function normalizePhone(raw: string): string {
  return raw.replace(/[+\s-]/g, '');
}

export interface AdminServiceDeps {
  db: Database.Database;
  sendMessage: (jid: string, text: string) => Promise<void>;
  adminGroupJid: string;
  adminPhones: string[];
  mlaPhone: string;
}

const VALID_STATUSES = [
  'registered',
  'acknowledged',
  'in_progress',
  'action_taken',
  'resolved',
  'on_hold',
  'escalated',
];

const VALID_ROLES = ['user', 'karyakarta', 'admin', 'superadmin'];

const USAGE_TEXT = `Usage:
#update <ID> <status>: <note>
#resolve <ID>: <note>
#escalate <ID>: <note>
#hold <ID>: <note>
#status <ID>
#unblock <phone>
#block <phone>: <reason>
#role <phone> <role>
#add-karyakarta <phone> <area-slug>
#remove-karyakarta <phone>
#assign-area <phone> <area-slug>
#unassign-area <phone> <area-slug>
#add-area <Name> | <मराठी> | <हिंदी>
#rename-area <old-slug> <New Name>
#remove-area <area-slug>
#list-karyakartas
#list-areas
#override-reject <ID>: <reason>
#escalate-to-mla <ID>: <reason>`;

export class AdminService {
  constructor(private deps: AdminServiceDeps) {}

  /** Subscribe to event bus events. */
  init(): void {
    eventBus.on('complaint:created', (event) => {
      this.notifyNewComplaint(event).catch((err) =>
        logger.error({ err }, 'Failed to send new-complaint notification'),
      );
    });

    eventBus.on('complaint:status-changed', (event) => {
      this.notifyStatusChange(event).catch((err) =>
        logger.error({ err }, 'Failed to send status-change notification'),
      );
    });
  }

  /** Notify admin group of a new complaint. */
  async notifyNewComplaint(event: ComplaintEvent): Promise<void> {
    if (!this.deps.adminGroupJid) return;
    const lines = [
      '\u{1F195} New Complaint',
      `ID: ${event.complaintId}`,
      `From: ${event.phone}`,
    ];

    if (event.category) {
      lines.push(`Category: ${event.category}`);
    }
    if (event.location) {
      lines.push(`Location: ${event.location}`);
    }

    lines.push(`Description: ${event.description}`);
    lines.push(`Status: ${formatStatus(event.status)}`);

    await this.deps.sendMessage(this.deps.adminGroupJid, lines.join('\n'));
  }

  /** Notify admin group of a status change. */
  async notifyStatusChange(event: StatusChangeEvent): Promise<void> {
    if (!this.deps.adminGroupJid) return;
    const lines = [
      '\u{1F4CB} Status Updated',
      `ID: ${event.complaintId}`,
      `Status: ${formatStatus(event.oldStatus)} \u{2192} ${formatStatus(event.newStatus)}`,
      `By: ${event.updatedBy}`,
    ];

    if (event.note) {
      lines.push(`Note: ${event.note}`);
    }

    await this.deps.sendMessage(this.deps.adminGroupJid, lines.join('\n'));
  }

  /**
   * Handle an admin command from a group message.
   * Returns a response string, or null if the message is not a command.
   */
  async handleCommand(
    senderPhone: string,
    text: string,
  ): Promise<string | null> {
    const trimmed = text.trim();

    // Not a command
    if (!trimmed.startsWith('#')) return null;

    // Parse: #command rest
    const match = trimmed.match(/^#([\w-]+)\s*(.*)$/s);
    if (!match) return USAGE_TEXT;

    const command = match[1].toLowerCase();
    const rest = match[2].trim();

    // Auth: messages only reach here from the admin group JID (enforced by
    // onMessage routing in index.ts), so group membership IS the authorization.

    switch (command) {
      case 'update':
        return this.handleUpdate(senderPhone, rest);
      case 'resolve':
        return this.handleStatusShorthand(senderPhone, rest, 'resolved');
      case 'escalate':
        return this.handleStatusShorthand(senderPhone, rest, 'escalated');
      case 'hold':
        return this.handleStatusShorthand(senderPhone, rest, 'on_hold');
      case 'status':
        return this.handleStatus(rest);
      case 'unblock':
        return this.handleUnblock(rest);
      case 'block':
        return this.handleBlock(rest);
      case 'role':
        return this.handleRole(senderPhone, rest);
      case 'escalate-to-mla':
        return this.handleEscalateToMla(senderPhone, rest);
      default:
        if (isKaryakartaCommand(command)) {
          return executeAdminCommand(this.deps.db, command, rest, senderPhone)
            .response;
        }
        return `Unknown command: #${command}\n\n${USAGE_TEXT}`;
    }
  }

  // --- Command handlers ---

  private handleUpdate(senderPhone: string, rest: string): string {
    // Format: <ID> <status>: <note>  OR  <ID> <status>
    const match = rest.match(/^(\S+)\s+(\S+)(?:\s*:\s*(.+))?$/s);
    if (!match) return `Invalid format.\nUsage: #update <ID> <status>: <note>`;

    const [, id, status, note] = match;
    return this.updateComplaintStatus(senderPhone, id, status, note?.trim());
  }

  private handleStatusShorthand(
    senderPhone: string,
    rest: string,
    targetStatus: string,
  ): string {
    // Format: <ID>: <note>  OR  <ID>
    const match = rest.match(/^(\S+)(?:\s*:\s*(.+))?$/s);
    if (!match)
      return `Invalid format.\nUsage: #${targetStatus === 'resolved' ? 'resolve' : targetStatus === 'escalated' ? 'escalate' : 'hold'} <ID>: <note>`;

    const [, id, note] = match;
    return this.updateComplaintStatus(
      senderPhone,
      id,
      targetStatus,
      note?.trim(),
    );
  }

  private updateComplaintStatus(
    updatedBy: string,
    id: string,
    status: string,
    note?: string,
  ): string {
    if (!VALID_STATUSES.includes(status)) {
      return `Invalid status '${status}'. Valid: ${VALID_STATUSES.join(', ')}`;
    }

    const current = this.deps.db
      .prepare('SELECT status, phone FROM complaints WHERE id = ?')
      .get(id) as { status: string; phone: string } | undefined;

    if (!current) {
      return `Complaint '${id}' not found.`;
    }

    const now = nowISO();

    this.deps.db
      .prepare(
        `UPDATE complaints SET status = ?, updated_at = ?,
         resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END
       WHERE id = ?`,
      )
      .run(status, now, status, now, id);

    this.deps.db
      .prepare(
        `INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, current.status, status, note ?? null, updatedBy, now);

    // Emit status change event
    eventBus.emit('complaint:status-changed', {
      complaintId: id,
      phone: current.phone,
      oldStatus: current.status,
      newStatus: status,
      note,
      updatedBy,
    });

    return `Complaint ${id} updated to ${status}.`;
  }

  private handleStatus(rest: string): string {
    const id = rest.trim();
    if (!id) return 'Usage: #status <ID>';

    const complaint = this.deps.db
      .prepare('SELECT * FROM complaints WHERE id = ?')
      .get(id) as
      | {
          id: string;
          phone: string;
          category: string | null;
          description: string;
          location: string | null;
          status: string;
          priority: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!complaint) {
      return `Complaint '${id}' not found.`;
    }

    const lines = [
      `Complaint ${complaint.id}`,
      `Phone: ${complaint.phone}`,
      `Category: ${complaint.category ?? 'N/A'}`,
      `Description: ${complaint.description}`,
      `Location: ${complaint.location ?? 'N/A'}`,
      `Status: ${complaint.status}`,
      `Priority: ${complaint.priority}`,
      `Created: ${complaint.created_at}`,
      `Updated: ${complaint.updated_at}`,
    ];

    return lines.join('\n');
  }

  private handleUnblock(rest: string): string {
    const phone = normalizePhone(rest.trim());
    if (!phone) return 'Usage: #unblock <phone>';

    const user = this.deps.db
      .prepare('SELECT phone FROM users WHERE phone = ?')
      .get(phone) as { phone: string } | undefined;

    if (!user) {
      return `User ${phone} not found.`;
    }

    this.deps.db
      .prepare(
        'UPDATE users SET is_blocked = 0, blocked_until = NULL, block_reason = NULL WHERE phone = ?',
      )
      .run(phone);

    return `User ${phone} unblocked.`;
  }

  private handleBlock(rest: string): string {
    // Format: <phone>: <reason>  OR  <phone>
    const match = rest.match(/^(\S+)(?:\s*:\s*(.+))?$/s);
    if (!match) return 'Usage: #block <phone>: <reason>';

    const phone = normalizePhone(match[1]);
    const reason = match[2]?.trim() ?? 'Blocked by admin';

    if (!phone) return 'Usage: #block <phone>: <reason>';

    const user = this.deps.db
      .prepare('SELECT phone FROM users WHERE phone = ?')
      .get(phone) as { phone: string } | undefined;

    if (!user) {
      return `User ${phone} not found.`;
    }

    this.deps.db
      .prepare(
        'UPDATE users SET is_blocked = 1, block_reason = ? WHERE phone = ?',
      )
      .run(reason, phone);

    return `User ${phone} blocked. Reason: ${reason}`;
  }

  private handleRole(senderPhone: string, rest: string): string {
    // Format: <phone> <role>
    const match = rest.match(/^(\S+)\s+(\S+)$/);
    if (!match) return 'Usage: #role <phone> <role>';

    const phone = normalizePhone(match[1]);
    const role = match[2].toLowerCase();

    if (!VALID_ROLES.includes(role)) {
      return `Invalid role '${role}'. Valid: ${VALID_ROLES.join(', ')}`;
    }

    const user = this.deps.db
      .prepare('SELECT phone FROM users WHERE phone = ?')
      .get(phone) as { phone: string } | undefined;

    if (!user) {
      return `User ${phone} not found.`;
    }

    const callerRole = getUserRole(this.deps.db, senderPhone);
    const result = setUserRole(
      this.deps.db,
      phone,
      role as UserRole,
      callerRole,
    );

    if (result !== 'OK') {
      return result;
    }

    return `User ${phone} role set to ${role}.`;
  }

  private async handleEscalateToMla(
    senderPhone: string,
    rest: string,
  ): Promise<string> {
    const match = rest.match(/^(\S+)(?:\s*:\s*(.+))?$/s);
    if (!match)
      return 'Invalid format.\nUsage: #escalate-to-mla <ID>: <reason>';

    const [, id, reason] = match;
    return escalateToMla(
      {
        db: this.deps.db,
        sendMessage: this.deps.sendMessage,
        adminGroupJid: this.deps.adminGroupJid,
        mlaPhone: this.deps.mlaPhone,
      },
      id,
      reason?.trim() ?? 'Escalated by admin',
      senderPhone,
    );
  }
}
