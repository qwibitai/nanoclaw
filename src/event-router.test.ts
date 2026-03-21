import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventRouter,
  type RawEvent,
  type TrustRule,
  type EventRouterConfig,
  type ClassifiedEvent,
} from './event-router.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockBus = { publish: vi.fn() };
const mockHealthMonitor = {
  recordOllamaLatency: vi.fn(),
  isOllamaDegraded: vi.fn(() => false),
};

const baseTrustRules: TrustRule[] = [
  {
    event_type: 'email',
    conditions: { importance_lt: 0.3 },
    routing: 'autonomous',
  },
  {
    event_type: 'calendar',
    conditions: { change_type: 'conflict' },
    routing: 'escalate',
  },
];

function makeConfig(
  overrides: Partial<EventRouterConfig> = {},
): EventRouterConfig {
  return {
    ollamaHost: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    trustRules: baseTrustRules,
    messageBus: mockBus as EventRouterConfig['messageBus'],
    healthMonitor: mockHealthMonitor as EventRouterConfig['healthMonitor'],
    onEscalate: vi.fn() as unknown as (event: ClassifiedEvent) => void,
    ...overrides,
  };
}

const sampleEmailEvent: RawEvent = {
  type: 'email',
  id: 'msg-001',
  timestamp: '2026-03-21T09:00:00Z',
  payload: {
    messageId: 'msg-001',
    threadId: 'thread-001',
    from: 'alice@example.com',
    to: ['bob@lab.edu'],
    cc: [],
    subject: 'Test email',
    snippet: 'Hello world',
    date: '2026-03-21T09:00:00Z',
    labels: ['INBOX'],
    hasAttachments: false,
  },
};

const sampleCalendarEvent: RawEvent = {
  type: 'calendar',
  id: 'cal-001',
  timestamp: '2026-03-21T09:00:00Z',
  payload: {
    changeType: 'created',
    event: {
      title: 'Team standup',
      start: '2026-03-22T10:00:00Z',
      end: '2026-03-22T10:30:00Z',
    },
  },
};

const conflictCalendarEvent: RawEvent = {
  type: 'calendar',
  id: 'cal-conflict-001',
  timestamp: '2026-03-21T09:00:00Z',
  payload: {
    changeType: 'created',
    change_type: 'conflict',
    event: {
      title: 'Conflicting meeting',
      start: '2026-03-22T10:00:00Z',
      end: '2026-03-22T11:00:00Z',
    },
  },
};

describe('EventRouter', () => {
  let router: EventRouter;
  let onEscalate: (event: ClassifiedEvent) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockHealthMonitor.isOllamaDegraded.mockReturnValue(false);
    onEscalate = vi.fn() as unknown as (event: ClassifiedEvent) => void;
    router = new EventRouter(makeConfig({ onEscalate }));
  });

  it('classifies event via Ollama and publishes to bus', async () => {
    const ollamaResponse = {
      response: JSON.stringify({
        importance: 0.7,
        urgency: 0.5,
        topic: 'test',
        summary: 'A test email',
        suggestedRouting: 'notify',
        requiresClaude: false,
        confidence: 0.9,
      }),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ollamaResponse,
      }),
    );

    const result = await router.route(sampleEmailEvent);

    expect(result.classification.importance).toBe(0.7);
    expect(result.routing).toBe('notify');
    expect(mockBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'classified_event' }),
    );
    expect(mockHealthMonitor.recordOllamaLatency).toHaveBeenCalled();
  });

  it('falls back to notify when Ollama times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch timeout')),
    );

    const result = await router.route(sampleEmailEvent);

    expect(result.routing).toBe('notify');
    expect(result.classification.confidence).toBe(0);
    expect(mockBus.publish).toHaveBeenCalled();
  });

  it('skips Ollama when degraded and uses fallback classification', async () => {
    mockHealthMonitor.isOllamaDegraded.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await router.route(sampleEmailEvent);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.routing).toBe('notify');
    expect(mockBus.publish).toHaveBeenCalled();
  });

  it('applies trust rules for routing (importance_lt condition)', async () => {
    const ollamaResponse = {
      response: JSON.stringify({
        importance: 0.1, // below 0.3 threshold → autonomous
        urgency: 0.1,
        topic: 'spam',
        summary: 'Low priority email',
        suggestedRouting: 'notify',
        requiresClaude: false,
        confidence: 0.8,
      }),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ollamaResponse,
      }),
    );

    const result = await router.route(sampleEmailEvent);

    expect(result.routing).toBe('autonomous');
  });

  it('escalates critical events (change_type: conflict)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('not needed')));

    const result = await router.route(conflictCalendarEvent);

    expect(result.routing).toBe('escalate');
    expect(onEscalate).toHaveBeenCalledWith(
      expect.objectContaining({ routing: 'escalate' }),
    );
  });

  it('returns stats', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    await router.route(sampleEmailEvent);
    await router.route(sampleCalendarEvent);

    const stats = router.getStats();
    expect(stats.processed).toBe(2);
    expect(typeof stats.avgLatencyMs).toBe('number');
    expect(stats.byRouting).toBeDefined();
  });
});
