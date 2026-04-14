import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  setTrustAutoExecute,
} from '../db.js';
import {
  classifyTool,
  parseActionClass,
  calculateConfidence,
  evaluateTrust,
  recordTrustDecision,
} from '../trust-engine.js';
import { eventBus } from '../event-bus.js';

beforeEach(() => _initTestDatabase());
afterEach(() => {
  eventBus.removeAllListeners();
  _closeDatabase();
});

describe('classifyTool', () => {
  it('maps known tools', () => {
    expect(classifyTool('send_message')).toBe('comms.write');
    expect(classifyTool('web_search')).toBe('info.read');
    expect(classifyTool('transfer_funds')).toBe('finance.transact');
  });

  it('uses self-reported class for unknown tools', () => {
    expect(classifyTool('my_custom_tool', 'health.write')).toBe('health.write');
  });

  it('defaults to services.transact for unknown tools', () => {
    expect(classifyTool('totally_unknown_tool')).toBe('services.transact');
  });

  it('rejects invalid self-reported class', () => {
    expect(classifyTool('my_tool', 'invalid.class')).toBe('services.transact');
    expect(classifyTool('my_tool', 'health.hack')).toBe('services.transact');
  });
});

describe('parseActionClass', () => {
  it('parses domain and operation', () => {
    const result = parseActionClass('health.write');
    expect(result.domain).toBe('health');
    expect(result.operation).toBe('write');
  });

  it('parses services.transact', () => {
    const result = parseActionClass('services.transact');
    expect(result.domain).toBe('services');
    expect(result.operation).toBe('transact');
  });
});

describe('calculateConfidence', () => {
  it('returns 0 for zero approvals', () => {
    const now = new Date().toISOString();
    expect(calculateConfidence(0, 0, now)).toBe(0);
  });

  it('formula: 3 approvals 0 denials = 0.75', () => {
    const now = new Date().toISOString();
    // 3/(3+0+1) = 0.75
    expect(calculateConfidence(3, 0, now)).toBeCloseTo(0.75);
  });

  it('denials lower confidence', () => {
    const now = new Date().toISOString();
    // 5/(5+5+1) = 0.4545
    expect(calculateConfidence(5, 5, now)).toBeCloseTo(0.4545, 3);
  });

  it('applies time decay', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    // 5/(5+0+1) = 0.833 - 0.01*10 = 0.733
    const conf = calculateConfidence(5, 0, tenDaysAgo);
    expect(conf).toBeCloseTo(0.733, 2);
  });

  it('never goes below 0', () => {
    const veryOld = new Date(Date.now() - 1000 * 86400000).toISOString();
    expect(calculateConfidence(5, 0, veryOld)).toBe(0);
  });
});

describe('evaluateTrust', () => {
  it('cold start → needs_approval', () => {
    const result = evaluateTrust('send_message', 'group1');
    expect(result.decision).toBe('needs_approval');
    expect(result.reason).toMatch(/cold start/);
  });

  it('sufficient approvals → approved', () => {
    // Record enough approvals to cross write threshold (0.8)
    // Need 5 approvals: 5/(5+0+1) = 0.833 > 0.8
    for (let i = 0; i < 5; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    const result = evaluateTrust('send_message', 'group1');
    expect(result.decision).toBe('approved');
  });

  it('denial lowers confidence below threshold', () => {
    for (let i = 0; i < 5; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    recordTrustDecision('send_message', 'group1', 'denied');
    recordTrustDecision('send_message', 'group1', 'denied');
    const result = evaluateTrust('send_message', 'group1');
    // 5/(5+2+1) = 0.625 < 0.8
    expect(result.decision).toBe('needs_approval');
  });

  it('auto_execute=false always requires approval even with high confidence', () => {
    setTrustAutoExecute('comms.write', 'group1', false, 1.0);
    for (let i = 0; i < 20; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    const result = evaluateTrust('send_message', 'group1');
    expect(result.decision).toBe('needs_approval');
    expect(result.reason).toMatch(/manually configured/);
  });

  it('handles cold start with correct default threshold per operation', () => {
    const readResult = evaluateTrust('web_search', 'group1');
    expect(readResult.threshold).toBe(0.7);

    const writeResult = evaluateTrust('send_message', 'group1');
    expect(writeResult.threshold).toBe(0.8);

    const transactResult = evaluateTrust('transfer_funds', 'group1');
    expect(transactResult.threshold).toBe(0.95);
  });
});

describe('recordTrustDecision', () => {
  it('graduation: emits trust.graduated when threshold crossed', () => {
    let graduated = false;
    eventBus.on('trust.graduated', () => {
      graduated = true;
    });
    // write threshold = 0.8
    // 3 approvals: 3/(3+0+1) = 0.75 < 0.8 → not graduated
    // 4 approvals: 4/(4+0+1) = 0.80 >= 0.8 → graduated
    for (let i = 0; i < 3; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    expect(graduated).toBe(false);
    recordTrustDecision('send_message', 'group1', 'approved');
    expect(graduated).toBe(true);
  });

  it('does not emit graduation on subsequent approvals after already graduated', () => {
    let graduationCount = 0;
    eventBus.on('trust.graduated', () => {
      graduationCount++;
    });
    // Cross threshold at 5 approvals
    for (let i = 0; i < 6; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    // Should only graduate once (at approval #5)
    expect(graduationCount).toBe(1);
  });

  it('denial decreases confidence', () => {
    for (let i = 0; i < 3; i++) {
      recordTrustDecision('send_message', 'group1', 'approved');
    }
    const beforeDenial = evaluateTrust('send_message', 'group1');
    recordTrustDecision('send_message', 'group1', 'denied');
    const afterDenial = evaluateTrust('send_message', 'group1');
    expect(afterDenial.confidence).toBeLessThan(beforeDenial.confidence);
  });
});
