/**
 * validation-scheduler.ts — Check pending validations and send reminders or auto-escalate.
 *
 * Designed to be called hourly by the task scheduler.
 */
import type Database from 'better-sqlite3';

import { getKaryakartasForArea, createValidation } from './area-db.js';
import { eventBus } from './event-bus.js';
import { nowISO } from './utils.js';

export interface ValidationSchedulerDeps {
  db: Database.Database;
  sendMessage: (jid: string, text: string) => Promise<void>;
  adminGroupJid: string;
}

/** Check all pending_validation complaints and send reminders or auto-escalate. */
export async function checkPendingValidations(
  deps: ValidationSchedulerDeps,
): Promise<{
  reminders: number;
  escalated: number;
}> {
  const { db, sendMessage, adminGroupJid } = deps;

  // Read configurable thresholds from tenant_config (defaults: 12h reminder, 24h escalation)
  const reminderHours = readConfigNumber(db, 'karyakarta_reminder_hours', 12);
  const timeoutHours = readConfigNumber(
    db,
    'karyakarta_response_timeout_hours',
    24,
  );

  // Fetch all complaints still awaiting validation
  const pending = db
    .prepare(
      "SELECT id, phone, area_id, created_at FROM complaints WHERE status = 'pending_validation'",
    )
    .all() as Array<{
    id: string;
    phone: string;
    area_id: string | null;
    created_at: string;
  }>;

  let reminders = 0;
  let escalated = 0;

  for (const c of pending) {
    const hoursSinceCreated =
      (Date.now() - new Date(c.created_at).getTime()) / 3_600_000;

    if (hoursSinceCreated >= timeoutHours) {
      // --- Auto-escalate ---
      const now = nowISO();

      db.prepare(
        "UPDATE complaints SET status = 'escalated_timeout', updated_at = ? WHERE id = ?",
      ).run(now, c.id);

      createValidation(db, {
        complaint_id: c.id,
        action: 'escalated_timeout',
      });

      db.prepare(
        `INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at)
         VALUES (?, 'pending_validation', 'escalated_timeout', ?, 'system', ?)`,
      ).run(c.id, 'Auto-escalated: karyakarta response timed out', now);

      eventBus.emit('complaint:status-changed', {
        complaintId: c.id,
        phone: c.phone,
        oldStatus: 'pending_validation',
        newStatus: 'escalated_timeout',
        note: 'Auto-escalated: karyakarta response timed out',
        updatedBy: 'system',
      });

      await sendMessage(
        adminGroupJid,
        `Complaint ${c.id} auto-escalated — karyakarta did not respond within ${timeoutHours}h.`,
      );

      await sendMessage(
        `${c.phone}@s.whatsapp.net`,
        `Your complaint ${c.id} has been escalated for faster attention. We apologize for the delay.`,
      );

      escalated++;
    } else if (hoursSinceCreated >= reminderHours) {
      // --- Send reminder (only if not already sent) ---
      if (!c.area_id) continue; // No area → cannot identify karyakartas

      const alreadyReminded = db
        .prepare(
          "SELECT 1 FROM complaint_updates WHERE complaint_id = ? AND note LIKE '%Karyakarta reminder sent%'",
        )
        .get(c.id);

      if (alreadyReminded) continue;

      const karyakartas = getKaryakartasForArea(db, c.area_id);
      if (karyakartas.length === 0) continue;

      for (const k of karyakartas) {
        await sendMessage(
          `${k.phone}@s.whatsapp.net`,
          `Reminder: Complaint ${c.id} is awaiting your validation. Please review it at your earliest convenience.`,
        );
      }

      const now = nowISO();
      db.prepare(
        `INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at)
         VALUES (?, 'pending_validation', 'pending_validation', 'Karyakarta reminder sent', 'system', ?)`,
      ).run(c.id, now);

      reminders++;
    }
  }

  return { reminders, escalated };
}

function readConfigNumber(
  db: Database.Database,
  key: string,
  defaultValue: number,
): number {
  const row = db
    .prepare('SELECT value FROM tenant_config WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
