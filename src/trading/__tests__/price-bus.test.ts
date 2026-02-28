import { describe, it, expect, vi } from 'vitest';

import {
  PriceBus,
  type BtcPriceEvent,
  type PolyMidpointEvent,
  type KalshiBracketsEvent,
  type KalshiMarketsEvent,
  type FeedStatusEvent,
} from '../price-bus.js';

describe('PriceBus', () => {
  it('emits btc:price events', () => {
    const bus = new PriceBus();
    const received: BtcPriceEvent[] = [];
    bus.on('btc:price', (e) => received.push(e));

    const payload: BtcPriceEvent = { price: 67_500.25, ts: Date.now() };
    bus.emit('btc:price', payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it('emits poly:midpoint events', () => {
    const bus = new PriceBus();
    const received: PolyMidpointEvent[] = [];
    bus.on('poly:midpoint', (e) => received.push(e));

    const payload: PolyMidpointEvent = {
      upMid: 0.55,
      downMid: 0.45,
      marketSlug: 'btc-above-70k',
      ts: Date.now(),
    };
    bus.emit('poly:midpoint', payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it('emits kalshi:brackets events', () => {
    const bus = new PriceBus();
    const received: KalshiBracketsEvent[] = [];
    bus.on('kalshi:brackets', (e) => received.push(e));

    const payload: KalshiBracketsEvent = {
      brackets: [
        {
          ticker: 1,
          event_ticker: 100,
          title: 42,
          yes_bid: 0.35,
          yes_ask: 0.40,
          no_bid: 0.58,
          no_ask: 0.65,
          last_price: 0.37,
          close_time: '2026-03-01T00:00:00Z',
          low: 66_000,
          high: 68_000,
          inBracket: true,
          isEdge: false,
          spread: 0.05,
          mid: 0.375,
          centeredness: 0.8,
        },
      ],
      ts: Date.now(),
    };
    bus.emit('kalshi:brackets', payload);

    expect(received).toHaveLength(1);
    expect(received[0].brackets).toHaveLength(1);
    expect(received[0].brackets[0].inBracket).toBe(true);
  });

  it('emits kalshi:markets events', () => {
    const bus = new PriceBus();
    const received: KalshiMarketsEvent[] = [];
    bus.on('kalshi:markets', (e) => received.push(e));

    const payload: KalshiMarketsEvent = {
      markets: [
        {
          ticker: 'KXBTC-26MAR01-B66000',
          event_ticker: 'KXBTC-26MAR01',
          yes_bid: 0.30,
          yes_ask: 0.35,
          no_bid: 0.63,
          no_ask: 0.70,
          last_price: 0.32,
          close_time: '2026-03-01T00:00:00Z',
          status: 'open',
        },
      ],
      ts: Date.now(),
    };
    bus.emit('kalshi:markets', payload);

    expect(received).toHaveLength(1);
    expect(received[0].markets[0].ticker).toBe('KXBTC-26MAR01-B66000');
  });

  it('emits feed:status events', () => {
    const bus = new PriceBus();
    const received: FeedStatusEvent[] = [];
    bus.on('feed:status', (e) => received.push(e));

    const payload: FeedStatusEvent = {
      source: 'coinbase-ws',
      status: 'connected',
    };
    bus.emit('feed:status', payload);

    expect(received).toHaveLength(1);
    expect(received[0].source).toBe('coinbase-ws');
    expect(received[0].status).toBe('connected');
  });

  it('delivers events to multiple subscribers', () => {
    const bus = new PriceBus();
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    bus.on('btc:price', listenerA);
    bus.on('btc:price', listenerB);

    const payload: BtcPriceEvent = { price: 70_000, ts: Date.now() };
    bus.emit('btc:price', payload);

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerA).toHaveBeenCalledWith(payload);
    expect(listenerB).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledWith(payload);
  });

  it('isolates events between different event types', () => {
    const bus = new PriceBus();
    const btcListener = vi.fn();
    const polyListener = vi.fn();

    bus.on('btc:price', btcListener);
    bus.on('poly:midpoint', polyListener);

    bus.emit('btc:price', { price: 65_000, ts: Date.now() });

    expect(btcListener).toHaveBeenCalledTimes(1);
    expect(polyListener).not.toHaveBeenCalled();
  });

  it('unsubscribes a listener with off()', () => {
    const bus = new PriceBus();
    const listener = vi.fn();

    bus.on('feed:status', listener);
    bus.emit('feed:status', { source: 'test', status: 'connected' });
    expect(listener).toHaveBeenCalledTimes(1);

    bus.off('feed:status', listener);
    bus.emit('feed:status', { source: 'test', status: 'disconnected' });
    expect(listener).toHaveBeenCalledTimes(1); // still 1 — no new call
  });
});
