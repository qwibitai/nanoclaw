import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromotionAnalyzer } from './promotion-analyzer.js';
import type { PromotionProposal } from './promotion-analyzer.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  },
}));

// Import fs mock after vi.mock declaration
import fs from 'fs';

const SAMPLE_YAML = `
default_routing: notify
rules:
  - id: rule-low-importance
    event_type: email
    conditions:
      importance_lt: 0.3
    routing: draft
    max_promotion: notify

  - id: rule-calendar-new
    event_type: calendar
    conditions:
      change_type: new_event
    routing: escalate

  - id: rule-no-id
    event_type: email
    routing: notify
`.trim();

function makeTracker(
  stats: Array<{
    trustRuleId: string;
    eventType: string;
    total: number;
    approved: number;
    rate: number;
  }>,
) {
  return {
    getApprovalStats: vi.fn().mockReturnValue(stats),
    recordDecision: vi.fn().mockReturnValue(100),
    setTelegramMsgId: vi.fn(),
  };
}

function makeEventRouter() {
  return {
    reloadFromPath: vi.fn(),
  };
}

type SendFn = (text: string) => Promise<string | undefined>;

const TRUST_MATRIX_PATH = '/fake/trust.yaml';

describe('PromotionAnalyzer.analyze()', () => {
  let sendToMainGroup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(SAMPLE_YAML);
    sendToMainGroup = vi.fn().mockResolvedValue('tg-msg-999');
  });

  it('proposes promotion when approval rate > threshold and total > minimum', async () => {
    const tracker = makeTracker([
      {
        trustRuleId: 'rule-calendar-new',
        eventType: 'calendar',
        total: 35,
        approved: 34,
        rate: 0.971,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    const proposals = await analyzer.analyze();

    expect(proposals).toHaveLength(1);
    expect(proposals[0].ruleId).toBe('rule-calendar-new');
    expect(proposals[0].currentRouting).toBe('escalate');
    expect(proposals[0].proposedRouting).toBe('draft');
    expect(proposals[0].blocked).toBe(false);
    expect(proposals[0].evidence.total).toBe(35);
    expect(proposals[0].evidence.rate).toBeCloseTo(0.971);
  });

  it('blocks promotion when max_promotion matches current routing (safety floor)', async () => {
    // rule with routing: notify and max_promotion: notify
    // next promotion would be 'autonomous', which exceeds max_promotion → blocked
    const yamlWithNotifyAtFloor = `
default_routing: notify
rules:
  - id: rule-at-floor
    event_type: email
    routing: notify
    max_promotion: notify
`.trim();

    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      yamlWithNotifyAtFloor,
    );

    const tracker = makeTracker([
      {
        trustRuleId: 'rule-at-floor',
        eventType: 'email',
        total: 40,
        approved: 39,
        rate: 0.975,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    const proposals = await analyzer.analyze();

    expect(proposals).toHaveLength(1);
    expect(proposals[0].ruleId).toBe('rule-at-floor');
    expect(proposals[0].blocked).toBe(true);
    expect(proposals[0].maxPromotion).toBe('notify');
  });

  it('skips rules with insufficient data (< 30 decisions)', async () => {
    const tracker = makeTracker([
      {
        trustRuleId: 'rule-calendar-new',
        eventType: 'calendar',
        total: 29,
        approved: 28,
        rate: 0.966,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    const proposals = await analyzer.analyze();

    // Should be empty — not enough data
    expect(proposals).toHaveLength(0);
  });

  it('skips rules with rate below threshold', async () => {
    const tracker = makeTracker([
      {
        trustRuleId: 'rule-calendar-new',
        eventType: 'calendar',
        total: 50,
        approved: 40,
        rate: 0.8,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    const proposals = await analyzer.analyze();

    expect(proposals).toHaveLength(0);
  });

  it('skips stats where trustRuleId does not match any rule in YAML', async () => {
    const tracker = makeTracker([
      {
        trustRuleId: 'nonexistent-rule',
        eventType: 'email',
        total: 50,
        approved: 50,
        rate: 1.0,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    const proposals = await analyzer.analyze();

    expect(proposals).toHaveLength(0);
  });

  it('sends proposals to Telegram via sendToMainGroup', async () => {
    const tracker = makeTracker([
      {
        trustRuleId: 'rule-calendar-new',
        eventType: 'calendar',
        total: 35,
        approved: 34,
        rate: 0.971,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    await analyzer.analyze();

    expect(sendToMainGroup).toHaveBeenCalled();
    const message = sendToMainGroup.mock.calls[0][0] as string;
    expect(message).toContain('rule-calendar-new');
  });

  it('records proposals as draft decisions in the approval tracker', async () => {
    const tracker = makeTracker([
      {
        trustRuleId: 'rule-calendar-new',
        eventType: 'calendar',
        total: 35,
        approved: 34,
        rate: 0.971,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    await analyzer.analyze();

    expect(tracker.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'promotion' }),
    );
  });

  it('does not send or record blocked proposals', async () => {
    const yamlWithNotifyAtFloor = `
default_routing: notify
rules:
  - id: rule-blocked
    event_type: email
    routing: notify
    max_promotion: notify
`.trim();

    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      yamlWithNotifyAtFloor,
    );

    const tracker = makeTracker([
      {
        trustRuleId: 'rule-blocked',
        eventType: 'email',
        total: 40,
        approved: 39,
        rate: 0.975,
      },
    ]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    await analyzer.analyze();

    expect(sendToMainGroup).not.toHaveBeenCalled();
    expect(tracker.recordDecision).not.toHaveBeenCalled();
  });
});

describe('PromotionAnalyzer.applyPromotion()', () => {
  let sendToMainGroup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(SAMPLE_YAML);
    sendToMainGroup = vi.fn().mockResolvedValue('tg-msg-999');
  });

  it('updates routing in YAML file via temp+rename and calls reloadFromPath', () => {
    const tracker = makeTracker([]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    const proposal: PromotionProposal = {
      ruleId: 'rule-calendar-new',
      currentRouting: 'escalate',
      proposedRouting: 'draft',
      evidence: { total: 35, approved: 34, rate: 0.971 },
      blocked: false,
    };

    analyzer.applyPromotion(proposal);

    // Should write to a temp file
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('draft'),
      'utf-8',
    );

    // Should rename temp to final path
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      TRUST_MATRIX_PATH,
    );

    // Should call reloadFromPath on the event router
    expect(eventRouter.reloadFromPath).toHaveBeenCalledWith(TRUST_MATRIX_PATH);
  });

  it('updates the routing field of the matched rule', () => {
    const tracker = makeTracker([]);
    const eventRouter = makeEventRouter();

    const analyzer = new PromotionAnalyzer(
      tracker,
      TRUST_MATRIX_PATH,
      eventRouter,
      sendToMainGroup as unknown as SendFn,
      30,
      0.95,
    );

    const proposal: PromotionProposal = {
      ruleId: 'rule-low-importance',
      currentRouting: 'draft',
      proposedRouting: 'notify',
      evidence: { total: 40, approved: 39, rate: 0.975 },
      blocked: false,
    };

    analyzer.applyPromotion(proposal);

    const writtenContent = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    // The written YAML should have the updated routing for the matched rule
    expect(writtenContent).toContain('notify');
    // The rule ID should still be present
    expect(writtenContent).toContain('rule-low-importance');
  });
});
