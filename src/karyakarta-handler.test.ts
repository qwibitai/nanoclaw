/**
 * karyakarta-handler.test.ts — TDD tests for karyakarta validation commands.
 *
 * Tests #approve, #reject, #my-complaints commands and the
 * initKaryakartaNotifications listener for new complaints.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  createTestDb,
  seedArea,
  seedUser,
  seedKaryakarta,
  seedComplaint,
} from './test-helpers.js';
import { getValidationsForComplaint } from './area-db.js';
import { eventBus } from './event-bus.js';
import {
  handleKaryakartaCommand,
  handleKaryakartaReply,
  initKaryakartaNotifications,
  type KaryakartaHandlerDeps,
} from './karyakarta-handler.js';

let db: Database.Database;
let sendMessage: ReturnType<
  typeof vi.fn<(jid: string, text: string) => Promise<void>>
>;
let deps: KaryakartaHandlerDeps;

const ADMIN_GROUP_JID = '120363000000000000@g.us';
const KARYAKARTA_PHONE = '919876543210';
const CONSTITUENT_PHONE = '918888888888';

beforeEach(() => {
  db = createTestDb();
  sendMessage = vi
    .fn<(jid: string, text: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  deps = { db, sendMessage, adminGroupJid: ADMIN_GROUP_JID };

  // Remove all event listeners between tests to avoid cross-test leaks
  eventBus.removeAllListeners();
});

afterEach(() => {
  eventBus.removeAllListeners();
});

// --- #approve tests ---

describe('#approve command', () => {
  it('changes status to validated and creates validation record', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    const cid = seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0001',
    });

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#approve RK-20260212-0001',
    );

    // Status should be updated
    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get(cid) as { status: string };
    expect(complaint.status).toBe('validated');

    // Validation record created
    const validations = getValidationsForComplaint(db, cid);
    expect(validations).toHaveLength(1);
    expect(validations[0].action).toBe('approved');
    expect(validations[0].validated_by).toBe(KARYAKARTA_PHONE);

    // Response should confirm approval
    expect(result).toContain('RK-20260212-0001');
    expect(result).toBeTruthy();
  });

  it('stores note when provided', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    const cid = seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0002',
    });

    await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#approve RK-20260212-0002: This is a valid complaint',
    );

    const validations = getValidationsForComplaint(db, cid);
    expect(validations).toHaveLength(1);
    expect(validations[0].comment).toBe('This is a valid complaint');
  });

  it('returns error when complaint is not in pending_validation status', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'registered',
      area_id: areaId,
      id: 'RK-20260212-0003',
    });

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#approve RK-20260212-0003',
    );

    expect(result).toContain('pending_validation');
    // Status should NOT have changed
    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get('RK-20260212-0003') as { status: string };
    expect(complaint.status).toBe('registered');
  });

  it('returns error when complaint is not in karyakarta area', async () => {
    const area1 = seedArea(db, { name: 'Shivaji Nagar' });
    const area2 = seedArea(db, { name: 'Kothrud' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [area1]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: area2,
      id: 'RK-20260212-0004',
    });

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#approve RK-20260212-0004',
    );

    expect(result).toContain('area');
    // Status should NOT have changed
    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get('RK-20260212-0004') as { status: string };
    expect(complaint.status).toBe('pending_validation');
  });

  it('returns error for non-existent complaint', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#approve RK-NONEXIST-0001',
    );

    expect(result).toContain('not found');
  });

  it('emits status-changed event for constituent notification', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0005',
    });

    const statusEvents: unknown[] = [];
    eventBus.on('complaint:status-changed', (event) =>
      statusEvents.push(event),
    );

    await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#approve RK-20260212-0005',
    );

    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({
      complaintId: 'RK-20260212-0005',
      phone: CONSTITUENT_PHONE,
      oldStatus: 'pending_validation',
      newStatus: 'validated',
      updatedBy: KARYAKARTA_PHONE,
    });
  });

  it('forwards complaint info to admin group on approval', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0006',
      category: 'roads',
    });

    await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#approve RK-20260212-0006',
    );

    // Should have sent a message to admin group
    const adminCalls = sendMessage.mock.calls.filter(
      ([jid]) => jid === ADMIN_GROUP_JID,
    );
    expect(adminCalls.length).toBeGreaterThanOrEqual(1);
    expect(adminCalls[0][1]).toContain('RK-20260212-0006');
    expect(adminCalls[0][1]).toContain('validated');
  });
});

// --- #reject tests ---

describe('#reject command', () => {
  it('changes status to rejected with valid reason code', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    const cid = seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0010',
    });

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#reject RK-20260212-0010 duplicate',
    );

    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get(cid) as { status: string };
    expect(complaint.status).toBe('rejected');

    const validations = getValidationsForComplaint(db, cid);
    expect(validations).toHaveLength(1);
    expect(validations[0].action).toBe('rejected');
    expect(validations[0].reason_code).toBe('duplicate');
    expect(validations[0].validated_by).toBe(KARYAKARTA_PHONE);

    expect(result).toContain('RK-20260212-0010');
  });

  it('returns error for invalid reason code', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0011',
    });

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#reject RK-20260212-0011 invalid_reason',
    );

    expect(result).toContain('duplicate');
    expect(result).toContain('fraud');
    expect(result).toContain('not_genuine');
    expect(result).toContain('out_of_area');
    expect(result).toContain('insufficient_info');
    expect(result).toContain('other');

    // Status should NOT have changed
    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get('RK-20260212-0011') as { status: string };
    expect(complaint.status).toBe('pending_validation');
  });

  it('stores note when provided', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    const cid = seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0012',
    });

    await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#reject RK-20260212-0012 fraud: Clearly a fake complaint',
    );

    const validations = getValidationsForComplaint(db, cid);
    expect(validations).toHaveLength(1);
    expect(validations[0].comment).toBe('Clearly a fake complaint');
    expect(validations[0].reason_code).toBe('fraud');
  });

  it('emits status-changed event for constituent notification', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0013',
    });

    const statusEvents: unknown[] = [];
    eventBus.on('complaint:status-changed', (event) =>
      statusEvents.push(event),
    );

    await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#reject RK-20260212-0013 not_genuine: Not a real issue',
    );

    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({
      complaintId: 'RK-20260212-0013',
      phone: CONSTITUENT_PHONE,
      oldStatus: 'pending_validation',
      newStatus: 'rejected',
      updatedBy: KARYAKARTA_PHONE,
    });
  });
});

// --- #my-complaints tests ---

describe('#my-complaints command', () => {
  it('lists pending complaints for karyakarta areas', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0020',
      category: 'roads',
    });
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0021',
      category: 'water',
    });

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#my-complaints',
    );

    expect(result).toContain('RK-20260212-0020');
    expect(result).toContain('RK-20260212-0021');
  });

  it('returns no pending message when there are none', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#my-complaints',
    );

    expect(result).toBeTruthy();
    expect(result!.toLowerCase()).toContain('no pending');
  });

  it('only lists complaints from assigned areas', async () => {
    const area1 = seedArea(db, { name: 'Shivaji Nagar' });
    const area2 = seedArea(db, { name: 'Kothrud' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [area1]); // Only assigned to area1
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: area1,
      id: 'RK-20260212-0030',
    });
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: area2,
      id: 'RK-20260212-0031',
    });

    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#my-complaints',
    );

    expect(result).toContain('RK-20260212-0030');
    expect(result).not.toContain('RK-20260212-0031');
  });
});

// --- non-command messages ---

describe('non-command messages', () => {
  it('returns null for unknown # command', async () => {
    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      '#unknown-command',
    );
    expect(result).toBeNull();
  });

  it('returns null for non-# message', async () => {
    const result = await handleKaryakartaCommand(
      deps,
      KARYAKARTA_PHONE,
      'Hello, how are you?',
    );
    expect(result).toBeNull();
  });
});

// --- initKaryakartaNotifications tests ---

describe('initKaryakartaNotifications', () => {
  it('sends DM to karyakartas for pending_validation complaint with area_id', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    const karyakarta2 = '919876543211';
    seedKaryakarta(db, karyakarta2, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);

    // Seed complaint first so handler can look it up
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0040',
      category: 'roads',
    });

    initKaryakartaNotifications(deps);

    // Emit event
    eventBus.emit('complaint:created', {
      complaintId: 'RK-20260212-0040',
      phone: CONSTITUENT_PHONE,
      category: 'roads',
      description: 'Pothole on main road',
      language: 'mr',
      status: 'pending_validation',
    });

    // Allow async handlers to complete
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    // Both karyakartas should receive DMs
    const jids = sendMessage.mock.calls.map(([jid]) => jid);
    expect(jids).toContain(`${KARYAKARTA_PHONE}@s.whatsapp.net`);
    expect(jids).toContain(`${karyakarta2}@s.whatsapp.net`);

    // Message should contain complaint details and instructions
    const msg = sendMessage.mock.calls[0][1];
    expect(msg).toContain('RK-20260212-0040');
    expect(msg).toContain('#approve');
    expect(msg).toContain('#reject');
  });

  it('does not send DM for registered status (no validation needed)', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'registered',
      area_id: areaId,
      id: 'RK-20260212-0041',
    });

    initKaryakartaNotifications(deps);

    eventBus.emit('complaint:created', {
      complaintId: 'RK-20260212-0041',
      phone: CONSTITUENT_PHONE,
      description: 'Some issue',
      language: 'mr',
      status: 'registered',
    });

    // Give async handlers a chance to run
    await new Promise((r) => setTimeout(r, 50));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send DM when no karyakartas assigned to area', async () => {
    const areaId = seedArea(db, { name: 'Empty Area' });
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0042',
    });

    initKaryakartaNotifications(deps);

    eventBus.emit('complaint:created', {
      complaintId: 'RK-20260212-0042',
      phone: CONSTITUENT_PHONE,
      description: 'Some issue',
      language: 'mr',
      status: 'pending_validation',
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// --- handleKaryakartaReply tests ---

// Mock admin-reply module
vi.mock('./admin-reply.js', () => ({
  extractComplaintId: vi.fn(),
  interpretReply: vi.fn(),
}));

import { extractComplaintId, interpretReply } from './admin-reply.js';
import type { ReplyResult } from './admin-reply.js';

const mockedExtractId = vi.mocked(extractComplaintId);
const mockedInterpret = vi.mocked(interpretReply);

describe('handleKaryakartaReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approves complaint via natural language reply', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    const cid = seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0050',
    });

    mockedExtractId.mockReturnValue('RK-20260212-0050');
    mockedInterpret.mockResolvedValue({
      action: 'approve',
      note: 'Genuine complaint',
      confidence: 0.95,
    });

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'Approved, genuine complaint',
      `New complaint pending validation\nID: RK-20260212-0050`,
    );

    expect(result).toContain('approved');

    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get(cid) as { status: string };
    expect(complaint.status).toBe('validated');
  });

  it('rejects complaint via natural language reply', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    const cid = seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0051',
    });

    mockedExtractId.mockReturnValue('RK-20260212-0051');
    mockedInterpret.mockResolvedValue({
      action: 'reject',
      rejectionReason: 'duplicate',
      note: 'Same as previous complaint',
      confidence: 0.9,
    });

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'This is duplicate',
      `ID: RK-20260212-0051`,
    );

    expect(result).toContain('rejected');

    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get(cid) as { status: string };
    expect(complaint.status).toBe('rejected');
  });

  it('adds note via natural language reply', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0052',
    });

    mockedExtractId.mockReturnValue('RK-20260212-0052');
    mockedInterpret.mockResolvedValue({
      action: 'add_note',
      note: 'Will check tomorrow',
      confidence: 0.85,
    });

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'Will check tomorrow',
      `ID: RK-20260212-0052`,
    );

    expect(result).toContain('RK-20260212-0052');
  });

  it('returns null when no complaint ID found', async () => {
    mockedExtractId.mockReturnValue(null);

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'Approved',
      'Hello there',
    );

    expect(result).toBeNull();
  });

  it('returns null when complaint not found', async () => {
    mockedExtractId.mockReturnValue('RK-99999999-9999');

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'Approved',
      'ID: RK-99999999-9999',
    );

    expect(result).toBeNull();
  });

  it('rejects when complaint is not pending_validation', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'registered',
      area_id: areaId,
      id: 'RK-20260212-0053',
    });

    mockedExtractId.mockReturnValue('RK-20260212-0053');

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'Approved',
      `ID: RK-20260212-0053`,
    );

    expect(result).toContain('pending_validation');
  });

  it('rejects when karyakarta not assigned to area', async () => {
    const area1 = seedArea(db, { name: 'Shivaji Nagar' });
    const area2 = seedArea(db, { name: 'Kothrud' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [area1]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: area2,
      id: 'RK-20260212-0054',
    });

    mockedExtractId.mockReturnValue('RK-20260212-0054');

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'Approved',
      `ID: RK-20260212-0054`,
    );

    expect(result).toContain('area');
  });

  it('returns message for unrecognized intent', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0055',
    });

    mockedExtractId.mockReturnValue('RK-20260212-0055');
    mockedInterpret.mockResolvedValue({
      action: 'unrecognized',
      confidence: 0,
    });

    const result = await handleKaryakartaReply(
      deps,
      KARYAKARTA_PHONE,
      'Good morning',
      `ID: RK-20260212-0055`,
    );

    expect(result).toContain('approve');
  });
});

// --- notification reply hints ---

describe('karyakarta notification reply hints', () => {
  it('notification includes reply hint', async () => {
    const areaId = seedArea(db, { name: 'Shivaji Nagar' });
    seedKaryakarta(db, KARYAKARTA_PHONE, [areaId]);
    seedUser(db, CONSTITUENT_PHONE);
    seedComplaint(db, {
      phone: CONSTITUENT_PHONE,
      status: 'pending_validation',
      area_id: areaId,
      id: 'RK-20260212-0060',
      category: 'roads',
    });

    initKaryakartaNotifications(deps);

    eventBus.emit('complaint:created', {
      complaintId: 'RK-20260212-0060',
      phone: CONSTITUENT_PHONE,
      category: 'roads',
      description: 'Pothole on main road',
      language: 'mr',
      status: 'pending_validation',
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    const msg = sendMessage.mock.calls[0][1];
    expect(msg).toContain('Reply to this message');
  });
});
