/**
 * Event Router for NanoClaw Phase 2
 *
 * Classifies incoming email and calendar events via Ollama, applies trust
 * matrix rules to determine routing (notify / autonomous / escalate), then
 * publishes the result to the message bus.
 *
 * Architecture:
 *   RawEvent → classify (Ollama) → applyTrustRules → publish → (onEscalate?)
 */

import { logger } from './logger.js';
import {
  getEmailClassificationPrompt,
  getCalendarClassificationPrompt,
  type EmailPayload,
  type CalendarPayload,
} from './classification-prompts.js';

// ─── Public Interfaces ────────────────────────────────────────────────────────

export interface RawEvent {
  type: 'email' | 'calendar';
  id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface Classification {
  importance: number;
  urgency: number;
  topic: string;
  summary: string;
  suggestedRouting: 'notify' | 'autonomous' | 'escalate';
  requiresClaude: boolean;
  confidence: number;
}

export interface ClassifiedEvent {
  event: RawEvent;
  classification: Classification;
  routing: 'notify' | 'autonomous' | 'escalate';
  classifiedAt: string;
  latencyMs: number;
}

export interface TrustRuleConditions {
  importance_lt?: number;
  importance_gte?: number;
  change_type?: string;
  sender_domain?: string[];
}

export interface TrustRule {
  event_type?: 'email' | 'calendar';
  conditions?: TrustRuleConditions;
  routing: 'notify' | 'autonomous' | 'escalate';
  action?: string;
}

export interface TrustConfig {
  default_routing: 'notify' | 'autonomous' | 'escalate';
  rules: TrustRule[];
}

export interface MessageBusLike {
  publish: (data: Record<string, unknown>) => unknown;
}

export interface HealthMonitorLike {
  recordOllamaLatency: (ms: number) => void;
  isOllamaDegraded: () => boolean;
}

export interface EventRouterConfig {
  ollamaHost: string;
  ollamaModel: string;
  trustRules: TrustRule[];
  defaultRouting?: 'notify' | 'autonomous' | 'escalate';
  messageBus: MessageBusLike;
  healthMonitor: HealthMonitorLike;
  onEscalate?: (event: ClassifiedEvent) => void;
  ollamaTimeoutMs?: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CLASSIFICATION: Classification = {
  importance: 0.5,
  urgency: 0.5,
  topic: 'unknown',
  summary: 'Classification unavailable',
  suggestedRouting: 'notify',
  requiresClaude: false,
  confidence: 0,
};

const DEFAULT_OLLAMA_TIMEOUT_MS = 15_000;

// ─── EventRouter ──────────────────────────────────────────────────────────────

export class EventRouter {
  private config: EventRouterConfig;
  private processed = 0;
  private latencies: number[] = [];
  private routingCounts: Record<string, number> = {
    notify: 0,
    autonomous: 0,
    escalate: 0,
  };

  constructor(config: EventRouterConfig) {
    this.config = config;
  }

  async route(event: RawEvent): Promise<ClassifiedEvent> {
    const start = Date.now();

    let classification: Classification;
    if (this.config.healthMonitor.isOllamaDegraded()) {
      logger.warn(
        { eventId: event.id },
        'Ollama degraded — using fallback classification',
      );
      classification = { ...DEFAULT_CLASSIFICATION };
    } else {
      classification = await this.classify(event);
    }

    const latencyMs = Date.now() - start;
    const routing = this.applyTrustRules(event, classification);

    const classified: ClassifiedEvent = {
      event,
      classification,
      routing,
      classifiedAt: new Date().toISOString(),
      latencyMs,
    };

    this.config.messageBus.publish({
      from: 'event-router',
      topic: 'classified_event',
      eventId: event.id,
      eventType: event.type,
      routing,
      classification,
      classifiedAt: classified.classifiedAt,
    });

    if (routing === 'escalate' && this.config.onEscalate) {
      this.config.onEscalate(classified);
    }

    this.processed++;
    this.latencies.push(latencyMs);
    this.routingCounts[routing] = (this.routingCounts[routing] ?? 0) + 1;

    logger.info(
      { eventId: event.id, eventType: event.type, routing, latencyMs },
      'Event classified and routed',
    );

    return classified;
  }

  getStats(): {
    processed: number;
    byRouting: Record<string, number>;
    avgLatencyMs: number;
  } {
    const avg =
      this.latencies.length > 0
        ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
        : 0;
    return {
      processed: this.processed,
      byRouting: { ...this.routingCounts },
      avgLatencyMs: avg,
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private async classify(event: RawEvent): Promise<Classification> {
    const timeoutMs = this.config.ollamaTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    const { system, prompt } = this.buildPrompt(event);

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${this.config.ollamaHost}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.config.ollamaModel,
            prompt,
            system,
            stream: false,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Date.now() - start;
      this.config.healthMonitor.recordOllamaLatency(latencyMs);

      if (!response.ok) {
        logger.warn(
          { status: response.status, eventId: event.id },
          'Ollama returned non-OK status — using fallback',
        );
        return { ...DEFAULT_CLASSIFICATION };
      }

      const body = (await response.json()) as { response?: string };
      return this.parseClassification(body.response ?? '');
    } catch (err) {
      const latencyMs = Date.now() - start;
      this.config.healthMonitor.recordOllamaLatency(latencyMs);
      logger.warn(
        { err, eventId: event.id },
        'Ollama classification failed — using fallback',
      );
      return { ...DEFAULT_CLASSIFICATION };
    }
  }

  private buildPrompt(event: RawEvent): { system: string; prompt: string } {
    if (event.type === 'email') {
      return getEmailClassificationPrompt(
        event.payload as unknown as EmailPayload,
      );
    } else {
      return getCalendarClassificationPrompt(
        event.payload as unknown as CalendarPayload,
      );
    }
  }

  private parseClassification(raw: string): Classification {
    try {
      // Extract JSON from response (may be wrapped in markdown code fences)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(
          { raw },
          'No JSON found in Ollama response — using fallback',
        );
        return { ...DEFAULT_CLASSIFICATION };
      }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<Classification>;

      return {
        importance:
          typeof parsed.importance === 'number' ? parsed.importance : 0.5,
        urgency: typeof parsed.urgency === 'number' ? parsed.urgency : 0.5,
        topic: typeof parsed.topic === 'string' ? parsed.topic : 'unknown',
        summary:
          typeof parsed.summary === 'string' ? parsed.summary : 'No summary',
        suggestedRouting: this.isValidRouting(parsed.suggestedRouting)
          ? parsed.suggestedRouting
          : 'notify',
        requiresClaude:
          typeof parsed.requiresClaude === 'boolean'
            ? parsed.requiresClaude
            : false,
        confidence:
          typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      };
    } catch (err) {
      logger.warn(
        { err, raw },
        'Failed to parse Ollama classification JSON — using fallback',
      );
      return { ...DEFAULT_CLASSIFICATION };
    }
  }

  private isValidRouting(
    value: unknown,
  ): value is 'notify' | 'autonomous' | 'escalate' {
    return value === 'notify' || value === 'autonomous' || value === 'escalate';
  }

  private applyTrustRules(
    event: RawEvent,
    classification: Classification,
  ): 'notify' | 'autonomous' | 'escalate' {
    for (const rule of this.config.trustRules) {
      if (!this.ruleMatchesEvent(rule, event, classification)) continue;
      return rule.routing;
    }

    // No rule matched — use default
    return this.config.defaultRouting ?? 'notify';
  }

  private ruleMatchesEvent(
    rule: TrustRule,
    event: RawEvent,
    classification: Classification,
  ): boolean {
    // Check event_type filter
    if (rule.event_type && rule.event_type !== event.type) return false;

    const conditions = rule.conditions;
    if (!conditions) return true; // rule has no conditions → always matches for this event_type

    // importance_lt
    if (conditions.importance_lt !== undefined) {
      if (classification.importance >= conditions.importance_lt) return false;
    }

    // importance_gte
    if (conditions.importance_gte !== undefined) {
      if (classification.importance < conditions.importance_gte) return false;
    }

    // change_type — checked against payload field
    if (conditions.change_type !== undefined) {
      const changeType =
        (event.payload['change_type'] as string | undefined) ??
        (event.payload['changeType'] as string | undefined);
      if (changeType !== conditions.change_type) return false;
    }

    // sender_domain — checked against payload.from
    if (conditions.sender_domain !== undefined) {
      const from = event.payload['from'] as string | undefined;
      if (!from) return false;
      const domain = from.includes('@') ? from.split('@')[1] : '';
      if (!conditions.sender_domain.includes(domain)) return false;
    }

    return true;
  }
}
