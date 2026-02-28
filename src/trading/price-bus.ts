import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Event payload interfaces
// ---------------------------------------------------------------------------

export interface BtcPriceEvent {
  readonly price: number;
  readonly ts: number;
}

export interface PolyMidpointEvent {
  readonly upMid: number;
  readonly downMid: number;
  readonly marketSlug: string;
  readonly ts: number;
}

export interface KxbtcBracketData {
  readonly ticker: string;
  readonly event_ticker: string;
  readonly title: string;
  readonly yes_bid: number;
  readonly yes_ask: number;
  readonly no_bid: number;
  readonly no_ask: number;
  readonly last_price: number;
  readonly close_time: string;
  readonly low: number;
  readonly high: number;
  readonly inBracket: boolean;
  readonly isEdge: boolean;
  readonly spread: number;
  readonly mid: number;
  readonly centeredness: number;
}

export interface KalshiBracketsEvent {
  readonly brackets: readonly KxbtcBracketData[];
  readonly ts: number;
}

export interface KxbtcMarketData {
  readonly ticker: string;
  readonly event_ticker: string;
  readonly yes_bid: number;
  readonly yes_ask: number;
  readonly no_bid: number;
  readonly no_ask: number;
  readonly last_price: number;
  readonly close_time: string;
  readonly status: string;
}

export interface KalshiMarketsEvent {
  readonly markets: readonly KxbtcMarketData[];
  readonly ts: number;
}

export interface FeedStatusEvent {
  readonly source: string;
  readonly status: 'connected' | 'disconnected' | 'error';
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Event map: event name -> payload type
// ---------------------------------------------------------------------------

export interface PriceBusEvents {
  'btc:price': BtcPriceEvent;
  'poly:midpoint': PolyMidpointEvent;
  'kalshi:brackets': KalshiBracketsEvent;
  'kalshi:markets': KalshiMarketsEvent;
  'feed:status': FeedStatusEvent;
}

// ---------------------------------------------------------------------------
// PriceBus — typed wrapper around Node EventEmitter
// ---------------------------------------------------------------------------

export class PriceBus {
  private readonly emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(20);
  }

  on<K extends keyof PriceBusEvents>(
    event: K,
    listener: (payload: PriceBusEvents[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof PriceBusEvents>(
    event: K,
    listener: (payload: PriceBusEvents[K]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof PriceBusEvents>(
    event: K,
    payload: PriceBusEvents[K],
  ): boolean {
    return this.emitter.emit(event, payload);
  }

  removeAllListeners<K extends keyof PriceBusEvents>(event?: K): this {
    if (event !== undefined) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }
}
