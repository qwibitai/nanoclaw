import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

import { PriceBus, type BtcPriceEvent, type FeedStatusEvent } from '../price-bus.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  readonly url: string;

  constructor(url: string) {
    super();
    mockInstances.push(this);
    this.url = url;
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  /** Simulate the server opening the connection */
  simulateOpen(): void {
    this.emit('open');
  }

  /** Simulate an incoming trade message */
  simulateMessage(data: string): void {
    this.emit('message', data);
  }

  /** Simulate a connection error */
  simulateError(message: string): void {
    this.emit('error', new Error(message));
  }

  /** Simulate the connection closing */
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }
}

let mockInstances: MockWebSocket[] = [];

vi.mock('ws', () => ({
  default: MockWebSocket,
}));

// Dynamic import AFTER mock is installed
const { startBinanceFeed } = await import('../feeds/binance-ws.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrade(price: string, tradeTime: number): string {
  return JSON.stringify({
    e: 'trade',
    s: 'BTCUSDT',
    p: price,
    T: tradeTime,
  });
}

function latestWs(): MockWebSocket {
  const ws = mockInstances.at(-1);
  if (!ws) throw new Error('No MockWebSocket instance created');
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startBinanceFeed', () => {
  let bus: PriceBus;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInstances = [];
    bus = new PriceBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Connection lifecycle ----

  it('connects to the Binance WebSocket URL', () => {
    const handle = startBinanceFeed(bus);
    expect(mockInstances).toHaveLength(1);
    expect(latestWs().url).toBe('wss://stream.binance.com:9443/ws/btcusdt@trade');
    handle.stop();
  });

  it('emits feed:status connected on open', () => {
    const statuses: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({ source: 'binance-ws', status: 'connected' });
    handle.stop();
  });

  it('emits feed:status disconnected on close', () => {
    const statuses: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();
    latestWs().simulateClose();

    expect(statuses).toHaveLength(2);
    expect(statuses[1]).toEqual({ source: 'binance-ws', status: 'disconnected' });
    handle.stop();
  });

  it('emits feed:status error on WebSocket error', () => {
    const statuses: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();
    latestWs().simulateError('connection reset');

    const errorEvent = statuses.find((s) => s.status === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.source).toBe('binance-ws');
    expect(errorEvent!.message).toBe('connection reset');
    handle.stop();
  });

  // ---- Price emission ----

  it('emits btc:price on valid trade message', () => {
    const prices: BtcPriceEvent[] = [];
    bus.on('btc:price', (e) => prices.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();
    latestWs().simulateMessage(makeTrade('84500.50', 1709161200000));

    expect(prices).toHaveLength(1);
    expect(prices[0]).toEqual({ price: 84500.5, ts: 1709161200000 });
    handle.stop();
  });

  it('ignores non-trade event types', () => {
    const prices: BtcPriceEvent[] = [];
    bus.on('btc:price', (e) => prices.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();
    latestWs().simulateMessage(JSON.stringify({ e: 'aggTrade', s: 'BTCUSDT', p: '84500', T: 1 }));

    expect(prices).toHaveLength(0);
    handle.stop();
  });

  it('ignores malformed JSON', () => {
    const prices: BtcPriceEvent[] = [];
    bus.on('btc:price', (e) => prices.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();
    latestWs().simulateMessage('not json {{{');

    expect(prices).toHaveLength(0);
    handle.stop();
  });

  it('ignores messages with invalid price', () => {
    const prices: BtcPriceEvent[] = [];
    bus.on('btc:price', (e) => prices.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();
    latestWs().simulateMessage(makeTrade('NaN', 1709161200000));
    latestWs().simulateMessage(makeTrade('-100', 1709161200000));
    latestWs().simulateMessage(makeTrade('', 1709161200000));

    expect(prices).toHaveLength(0);
    handle.stop();
  });

  // ---- Throttling ----

  it('throttles to at most 1 emit per second', () => {
    const prices: BtcPriceEvent[] = [];
    bus.on('btc:price', (e) => prices.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();

    // First message goes through immediately
    latestWs().simulateMessage(makeTrade('84000', 1000));
    expect(prices).toHaveLength(1);

    // Messages within the same second are dropped
    vi.advanceTimersByTime(200);
    latestWs().simulateMessage(makeTrade('84100', 1200));
    expect(prices).toHaveLength(1);

    vi.advanceTimersByTime(300);
    latestWs().simulateMessage(makeTrade('84200', 1500));
    expect(prices).toHaveLength(1);

    // After 1 second from first emit, next message goes through
    vi.advanceTimersByTime(500); // total 1000ms elapsed
    latestWs().simulateMessage(makeTrade('84300', 2000));
    expect(prices).toHaveLength(2);
    expect(prices[1].price).toBe(84300);

    handle.stop();
  });

  it('resets throttle window after each emit', () => {
    const prices: BtcPriceEvent[] = [];
    bus.on('btc:price', (e) => prices.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();

    latestWs().simulateMessage(makeTrade('84000', 1000));
    expect(prices).toHaveLength(1);

    // Advance past throttle window
    vi.advanceTimersByTime(1000);
    latestWs().simulateMessage(makeTrade('84100', 2000));
    expect(prices).toHaveLength(2);

    // Second emit starts a new throttle window
    vi.advanceTimersByTime(500);
    latestWs().simulateMessage(makeTrade('84200', 2500));
    expect(prices).toHaveLength(2); // still throttled from second emit

    vi.advanceTimersByTime(500);
    latestWs().simulateMessage(makeTrade('84300', 3000));
    expect(prices).toHaveLength(3);

    handle.stop();
  });

  // ---- Reconnection ----

  it('reconnects with exponential backoff after disconnect', () => {
    const handle = startBinanceFeed(bus);
    const initialWs = latestWs();
    initialWs.simulateOpen();

    // First disconnect -> 1s backoff
    initialWs.simulateClose();
    expect(mockInstances).toHaveLength(1); // not reconnected yet

    vi.advanceTimersByTime(1000);
    expect(mockInstances).toHaveLength(2); // reconnected after 1s

    // Second disconnect -> 2s backoff
    latestWs().simulateClose();
    vi.advanceTimersByTime(1000);
    expect(mockInstances).toHaveLength(2); // not yet
    vi.advanceTimersByTime(1000);
    expect(mockInstances).toHaveLength(3); // reconnected after 2s

    // Third disconnect -> 4s backoff
    latestWs().simulateClose();
    vi.advanceTimersByTime(3000);
    expect(mockInstances).toHaveLength(3); // not yet
    vi.advanceTimersByTime(1000);
    expect(mockInstances).toHaveLength(4); // reconnected after 4s

    handle.stop();
  });

  it('resets backoff after successful connection', () => {
    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();

    // Disconnect and reconnect to increase backoff
    latestWs().simulateClose();
    vi.advanceTimersByTime(1000);
    expect(mockInstances).toHaveLength(2);

    latestWs().simulateClose();
    vi.advanceTimersByTime(2000);
    expect(mockInstances).toHaveLength(3);

    // Now simulate successful open — backoff should reset
    latestWs().simulateOpen();

    // Next disconnect should use initial 1s backoff again
    latestWs().simulateClose();
    vi.advanceTimersByTime(1000);
    expect(mockInstances).toHaveLength(4); // 1s, not 4s
    handle.stop();
  });

  it('caps backoff at 30 seconds', () => {
    const handle = startBinanceFeed(bus);

    // Disconnect repeatedly without ever opening to let backoff grow:
    // 1s, 2s, 4s, 8s, 16s, 32s -> capped at 30s
    for (let i = 0; i < 5; i++) {
      latestWs().simulateClose();
      vi.advanceTimersByTime(30_000);
    }
    const countBefore = mockInstances.length;

    // Next disconnect — backoff should be capped at 30s
    latestWs().simulateClose();
    vi.advanceTimersByTime(29_999);
    expect(mockInstances).toHaveLength(countBefore); // not yet
    vi.advanceTimersByTime(1);
    expect(mockInstances).toHaveLength(countBefore + 1); // at exactly 30s

    handle.stop();
  });

  // ---- Stop / Cleanup ----

  it('stop() closes the WebSocket and prevents reconnection', () => {
    const handle = startBinanceFeed(bus);
    const ws = latestWs();
    ws.simulateOpen();

    handle.stop();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    // No reconnection should occur
    vi.advanceTimersByTime(60_000);
    expect(mockInstances).toHaveLength(1);
  });

  it('stop() cancels pending reconnect timer', () => {
    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();
    latestWs().simulateClose();

    // Reconnect is scheduled for 1s, but we stop before it fires
    vi.advanceTimersByTime(500);
    handle.stop();

    vi.advanceTimersByTime(5_000);
    expect(mockInstances).toHaveLength(1); // no new connection
  });

  it('stop() is idempotent', () => {
    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();

    handle.stop();
    handle.stop(); // should not throw
    handle.stop();

    expect(mockInstances).toHaveLength(1);
  });

  it('does not emit events after stop()', () => {
    const prices: BtcPriceEvent[] = [];
    const statuses: FeedStatusEvent[] = [];
    bus.on('btc:price', (e) => prices.push(e));
    bus.on('feed:status', (e) => statuses.push(e));

    const handle = startBinanceFeed(bus);
    latestWs().simulateOpen();

    const pricesBefore = prices.length;
    const statusesBefore = statuses.length;

    handle.stop();

    // The WS listeners were removed, so these should not propagate
    // (listeners were removed before close in stop())
    expect(prices).toHaveLength(pricesBefore);
    // stop() removes listeners then closes, so no new status events
    expect(statuses).toHaveLength(statusesBefore);
  });
});
