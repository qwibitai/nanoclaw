/**
 * validation-scheduler.test.ts — Tests for checkPendingValidations().
 *
 * TDD: all tests written first, then implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

import { checkPendingValidations } from './validation-scheduler.js';
import {
  createTestDb,
  seedArea,
  seedUser,
  seedKaryakarta,
  seedComplaint,
} from './test-helpers.js';
import { eventBus } from './event-bus.js';

/** Generate ISO timestamp N hours in the past. */
const hoursAgo = (h: number): string => {
  const d = new Date(Date.now() - h * 3600_000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

describe('checkPendingValidations', () => {
  let db: Database.Database;
  let sendMessage: ReturnType<
    typeof vi.fn<(jid: string, text: string) => Promise<void>>
  >;
  const adminGroupJid = 'admin-group@g.us';

  beforeEach(() => {
    db = createTestDb();
    sendMessage = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  function deps() {
    return { db, sendMessage, adminGroupJid };
  }

  // ---- Test 1: Complaint pending < 12h → no action ----
  it('takes no action for complaints pending less than 12h', async () => {
    const areaId = seedArea(db, { name: 'Ward 1' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000010', [areaId]);
    seedComplaint(db, {
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(6),
    });

    const result = await checkPendingValidations(deps());

    expect(result.reminders).toBe(0);
    expect(result.escalated).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ---- Test 2: Complaint pending >= 12h but < 24h → reminder sent ----
  it('sends reminder to karyakarta for complaints pending >= 12h but < 24h', async () => {
    const areaId = seedArea(db, { name: 'Ward 2' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000020', [areaId]);
    seedComplaint(db, {
      id: 'RK-REM-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(13),
    });

    const result = await checkPendingValidations(deps());

    expect(result.reminders).toBe(1);
    expect(result.escalated).toBe(0);
    // Should send DM to karyakarta (JID format)
    expect(sendMessage).toHaveBeenCalledWith(
      '919999000020@s.whatsapp.net',
      expect.stringContaining('RK-REM-01'),
    );
  });

  // ---- Test 3: Complaint pending >= 24h → auto-escalated ----
  it('auto-escalates complaints pending >= 24h', async () => {
    const areaId = seedArea(db, { name: 'Ward 3' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000030', [areaId]);
    seedComplaint(db, {
      id: 'RK-ESC-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    const result = await checkPendingValidations(deps());

    expect(result.escalated).toBe(1);
    // Complaint status should be updated
    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get('RK-ESC-01') as { status: string };
    expect(complaint.status).toBe('escalated_timeout');
  });

  // ---- Test 4: Auto-escalation creates validation record ----
  it('creates validation record with action escalated_timeout', async () => {
    const areaId = seedArea(db, { name: 'Ward 4' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000040', [areaId]);
    seedComplaint(db, {
      id: 'RK-VAL-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    await checkPendingValidations(deps());

    const validations = db
      .prepare('SELECT * FROM complaint_validations WHERE complaint_id = ?')
      .all('RK-VAL-01') as Array<{
      action: string;
      validated_by: string | null;
    }>;
    expect(validations).toHaveLength(1);
    expect(validations[0].action).toBe('escalated_timeout');
    expect(validations[0].validated_by).toBeNull();
  });

  // ---- Test 5: Auto-escalation emits complaint:status-changed event ----
  it('emits complaint:status-changed event on escalation', async () => {
    const areaId = seedArea(db, { name: 'Ward 5' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000050', [areaId]);
    seedComplaint(db, {
      id: 'RK-EVT-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    const events: unknown[] = [];
    eventBus.on('complaint:status-changed', (e) => events.push(e));

    await checkPendingValidations(deps());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      complaintId: 'RK-EVT-01',
      phone: '919999000001',
      oldStatus: 'pending_validation',
      newStatus: 'escalated_timeout',
      updatedBy: 'system',
    });
  });

  // ---- Test 6: Auto-escalation sends admin group notification ----
  it('sends admin group notification on escalation', async () => {
    const areaId = seedArea(db, { name: 'Ward 6' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000060', [areaId]);
    seedComplaint(db, {
      id: 'RK-ADM-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    await checkPendingValidations(deps());

    // Should have sent message to admin group
    expect(sendMessage).toHaveBeenCalledWith(
      adminGroupJid,
      expect.stringContaining('RK-ADM-01'),
    );
  });

  // ---- Test 7: Already approved complaint → skip ----
  it('skips complaints that are already validated (approved)', async () => {
    const areaId = seedArea(db, { name: 'Ward 7' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000070', [areaId]);
    seedComplaint(db, {
      phone: '919999000001',
      status: 'validated',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    const result = await checkPendingValidations(deps());

    expect(result.reminders).toBe(0);
    expect(result.escalated).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ---- Test 8: Already rejected complaint → skip ----
  it('skips complaints that are already rejected', async () => {
    const areaId = seedArea(db, { name: 'Ward 8' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000080', [areaId]);
    seedComplaint(db, {
      phone: '919999000001',
      status: 'rejected',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    const result = await checkPendingValidations(deps());

    expect(result.reminders).toBe(0);
    expect(result.escalated).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ---- Test 9: Configurable timeout from tenant_config ----
  it('respects custom timeout values from tenant_config', async () => {
    const areaId = seedArea(db, { name: 'Ward 9' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000090', [areaId]);

    // Set custom thresholds: reminder at 6h, escalation at 10h
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_reminder_hours', '6')",
    ).run();
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_response_timeout_hours', '10')",
    ).run();

    // Complaint at 7h — should get reminder (>= 6) but not escalation (< 10)
    seedComplaint(db, {
      id: 'RK-CFG-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(7),
    });

    const result = await checkPendingValidations(deps());

    expect(result.reminders).toBe(1);
    expect(result.escalated).toBe(0);
  });

  // ---- Test 10: Multiple karyakartas in same area all get reminder ----
  it('sends reminders to all karyakartas in the complaint area', async () => {
    const areaId = seedArea(db, { name: 'Ward 10' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000101', [areaId]);
    seedKaryakarta(db, '919999000102', [areaId]);
    seedKaryakarta(db, '919999000103', [areaId]);
    seedComplaint(db, {
      id: 'RK-MULTI-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(13),
    });

    const result = await checkPendingValidations(deps());

    expect(result.reminders).toBe(1);
    // All three karyakartas should receive a DM (JID format)
    expect(sendMessage).toHaveBeenCalledWith(
      '919999000101@s.whatsapp.net',
      expect.stringContaining('RK-MULTI-01'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      '919999000102@s.whatsapp.net',
      expect.stringContaining('RK-MULTI-01'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      '919999000103@s.whatsapp.net',
      expect.stringContaining('RK-MULTI-01'),
    );
  });

  // ---- Test 11: Reminder sent only once ----
  it('does not re-send reminder if already sent', async () => {
    const areaId = seedArea(db, { name: 'Ward 11' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000110', [areaId]);
    seedComplaint(db, {
      id: 'RK-ONCE-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(13),
    });

    // First run — should send reminder
    const result1 = await checkPendingValidations(deps());
    expect(result1.reminders).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    sendMessage.mockClear();

    // Second run — reminder already tracked, should not re-send
    const result2 = await checkPendingValidations(deps());
    expect(result2.reminders).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // ---- Test 12: Multiple pending complaints all processed ----
  it('processes multiple pending complaints correctly', async () => {
    const areaId = seedArea(db, { name: 'Ward 12' });
    seedUser(db, '919999000001');
    seedUser(db, '919999000002');
    seedKaryakarta(db, '919999000120', [areaId]);

    // Complaint A: 13h old → reminder
    seedComplaint(db, {
      id: 'RK-BATCH-A',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(13),
    });

    // Complaint B: 25h old → escalate
    seedComplaint(db, {
      id: 'RK-BATCH-B',
      phone: '919999000002',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    const result = await checkPendingValidations(deps());

    expect(result.reminders).toBe(1);
    expect(result.escalated).toBe(1);

    // Verify statuses
    const complaintA = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get('RK-BATCH-A') as { status: string };
    expect(complaintA.status).toBe('pending_validation'); // Unchanged — only reminded

    const complaintB = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get('RK-BATCH-B') as { status: string };
    expect(complaintB.status).toBe('escalated_timeout');
  });

  // ---- Test 13: Escalation also notifies constituent ----
  it('sends notification to constituent on escalation', async () => {
    const areaId = seedArea(db, { name: 'Ward 13' });
    seedUser(db, '919999000001');
    seedKaryakarta(db, '919999000130', [areaId]);
    seedComplaint(db, {
      id: 'RK-CONST-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: areaId,
      created_at: hoursAgo(25),
    });

    await checkPendingValidations(deps());

    // Should notify the constituent (JID format)
    expect(sendMessage).toHaveBeenCalledWith(
      '919999000001@s.whatsapp.net',
      expect.stringContaining('RK-CONST-01'),
    );
  });

  // ---- Test 14: Complaint with no area_id is still processed ----
  it('handles complaint with no area_id (no karyakartas to remind)', async () => {
    seedUser(db, '919999000001');
    seedComplaint(db, {
      id: 'RK-NOAREA-01',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: undefined,
      created_at: hoursAgo(13),
    });

    // Should not crash, but no reminder possible without area
    const result = await checkPendingValidations(deps());
    expect(result.reminders).toBe(0);
    expect(result.escalated).toBe(0);
  });

  // ---- Test 15: Complaint with no area_id at 24h still escalates ----
  it('escalates complaint with no area_id at timeout', async () => {
    seedUser(db, '919999000001');
    seedComplaint(db, {
      id: 'RK-NOAREA-02',
      phone: '919999000001',
      status: 'pending_validation',
      area_id: undefined,
      created_at: hoursAgo(25),
    });

    const result = await checkPendingValidations(deps());
    expect(result.escalated).toBe(1);

    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get('RK-NOAREA-02') as { status: string };
    expect(complaint.status).toBe('escalated_timeout');
  });
});
