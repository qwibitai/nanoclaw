import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDb = { exec: vi.fn(), prepare: vi.fn() };
vi.mock('../db.js', () => ({ getDb: vi.fn(() => mockDb) }));

const mockInitRulesStore = vi.fn();
vi.mock('./rules-engine.js', () => ({
  initRulesStore: () => mockInitRulesStore(),
  queryRules: vi.fn().mockReturnValue([]),
  addRule: vi.fn().mockReturnValue('r1'),
  markMatched: vi.fn(),
  pruneStaleRules: vi.fn().mockReturnValue(0),
  decayConfidence: vi.fn().mockReturnValue(0),
}));

vi.mock('./procedure-recorder.js', () => ({
  startTrace: vi.fn(),
  addTrace: vi.fn(),
  finalizeTrace: vi.fn(),
}));

vi.mock('./outcome-enricher.js', () => ({
  buildRulesBlock: vi.fn().mockReturnValue(null),
  inferActionClasses: vi.fn().mockReturnValue([]),
}));

vi.mock('./feedback-capture.js', () => ({
  detectFeedback: vi.fn().mockReturnValue(null),
  saveFeedbackAsRule: vi.fn().mockReturnValue('r1'),
}));

vi.mock('../memory/outcome-store.js', () => ({
  queryOutcomes: vi.fn().mockReturnValue([]),
}));

import { EventBus } from '../event-bus.js';
import { initLearningSystem } from './index.js';

describe('initLearningSystem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls initRulesStore on startup', () => {
    const bus = new EventBus();
    initLearningSystem(bus, {
      getRegisteredGroups: () => ({}),
      sendMessage: vi.fn(),
      enqueueTask: vi.fn(),
    });
    expect(mockInitRulesStore).toHaveBeenCalledOnce();
  });

  it('subscribes to task.started, task.complete, and message.outbound events', () => {
    const bus = new EventBus();
    const onSpy = vi.spyOn(bus, 'on');

    initLearningSystem(bus, {
      getRegisteredGroups: () => ({}),
      sendMessage: vi.fn(),
      enqueueTask: vi.fn(),
    });

    const subscribedEvents = onSpy.mock.calls.map((c) => c[0]);
    expect(subscribedEvents).toContain('task.started');
    expect(subscribedEvents).toContain('task.complete');
    expect(subscribedEvents).toContain('message.outbound');
  });

  it('wires task.started to startTrace', async () => {
    const { startTrace } = await import('./procedure-recorder.js');
    const bus = new EventBus();

    initLearningSystem(bus, {
      getRegisteredGroups: () => ({}),
      sendMessage: vi.fn(),
      enqueueTask: vi.fn(),
    });

    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      groupId: 'g1',
      timestamp: Date.now(),
      payload: {
        taskId: 'task-1',
        groupJid: 'g1',
        containerName: 'c1',
        slotIndex: 0,
      },
    });

    expect(startTrace).toHaveBeenCalledWith('g1', 'task-1');
  });
});
