/**
 * Promotion Analyzer for NanoClaw Phase 3a
 *
 * Analyzes approval stats from the trust tracker and proposes automatic
 * promotion of routing rules toward more autonomous operation, subject to
 * safety floors defined in the trust YAML.
 *
 * Promotion order (most restrictive → least restrictive):
 *   escalate → draft → notify → autonomous
 */

import fs from 'fs';
import YAML from 'yaml';
import { logger } from './logger.js';
import type { ApprovalStat } from './approval-tracker.js';
import type { RoutingLevel, TrustRule, TrustConfig } from './event-router.js';

// Re-export RoutingLevel for consumers
export type { RoutingLevel };

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROMOTION_ORDER: RoutingLevel[] = [
  'escalate',
  'draft',
  'notify',
  'autonomous',
];

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface PromotionProposal {
  ruleId: string;
  currentRouting: RoutingLevel;
  proposedRouting: RoutingLevel;
  evidence: { total: number; approved: number; rate: number };
  maxPromotion?: RoutingLevel;
  blocked: boolean;
}

// ─── Tracker interface (minimal shape used by PromotionAnalyzer) ──────────────

interface TrackerLike {
  getApprovalStats: (windowDays: number) => ApprovalStat[];
  recordDecision: (decision: {
    eventType: string;
    eventSource: string;
    routing: string;
    trustRuleId: string | null;
    classificationSummary: string;
    classificationImportance: number;
    classificationUrgency: string;
  }) => number;
  setTelegramMsgId: (id: number, msgId: string) => void;
}

// ─── EventRouter interface (minimal shape used by PromotionAnalyzer) ──────────

interface EventRouterLike {
  reloadFromPath: (yamlPath: string) => void;
}

// ─── PromotionAnalyzer ────────────────────────────────────────────────────────

export class PromotionAnalyzer {
  private readonly tracker: TrackerLike;
  private readonly trustMatrixPath: string;
  private readonly eventRouter: EventRouterLike;
  private readonly sendToMainGroup: (
    text: string,
  ) => Promise<string | undefined>;
  private readonly minDecisions: number;
  private readonly promotionThreshold: number;

  constructor(
    tracker: TrackerLike,
    trustMatrixPath: string,
    eventRouter: EventRouterLike,
    sendToMainGroup: (text: string) => Promise<string | undefined>,
    minDecisions: number = 30,
    promotionThreshold: number = 0.95,
  ) {
    this.tracker = tracker;
    this.trustMatrixPath = trustMatrixPath;
    this.eventRouter = eventRouter;
    this.sendToMainGroup = sendToMainGroup;
    this.minDecisions = minDecisions;
    this.promotionThreshold = promotionThreshold;
  }

  /**
   * Read approval stats, cross-reference trust YAML rules, and produce
   * PromotionProposal objects for eligible rules.
   *
   * Unblocked proposals are sent to Telegram and recorded as pending draft
   * decisions in the approval tracker so they can be approved/rejected
   * through the normal response flow.
   */
  async analyze(windowDays = 30): Promise<PromotionProposal[]> {
    const stats = this.tracker.getApprovalStats(windowDays);
    const config = this.loadConfig();

    const proposals: PromotionProposal[] = [];

    for (const stat of stats) {
      // Skip rules with insufficient data
      if (stat.total < this.minDecisions) continue;

      // Skip rules below the approval threshold
      if (stat.rate < this.promotionThreshold) continue;

      // Find the matching rule by ID
      const rule = config.rules.find((r) => r.id === stat.trustRuleId);
      if (!rule || !rule.id) {
        logger.debug(
          { ruleId: stat.trustRuleId },
          'No matching rule found for stat — skipping',
        );
        continue;
      }

      const currentRouting = rule.routing as RoutingLevel;
      const proposedRouting = this.nextPromotion(currentRouting);

      if (!proposedRouting) {
        // Already at maximum (autonomous) — nothing to promote
        logger.debug(
          { ruleId: rule.id },
          'Rule already at autonomous — skipping',
        );
        continue;
      }

      // Check max_promotion safety floor
      const maxPromotion = rule.max_promotion as RoutingLevel | undefined;
      const blocked =
        maxPromotion !== undefined
          ? !this.isAtOrBelowMax(proposedRouting, maxPromotion)
          : false;

      const proposal: PromotionProposal = {
        ruleId: rule.id,
        currentRouting,
        proposedRouting,
        evidence: {
          total: stat.total,
          approved: stat.approved,
          rate: stat.rate,
        },
        maxPromotion,
        blocked,
      };

      proposals.push(proposal);

      if (!blocked) {
        await this.sendProposal(proposal);
      }
    }

    return proposals;
  }

  /**
   * Apply a promotion proposal atomically:
   *  1. Read the trust YAML
   *  2. Update the rule's routing field
   *  3. Write to a temp file
   *  4. Rename temp → original (atomic on POSIX)
   *  5. Reload the event router
   */
  applyPromotion(proposal: PromotionProposal): void {
    const config = this.loadConfig();

    const rule = config.rules.find((r) => r.id === proposal.ruleId);
    if (!rule) {
      logger.warn(
        { ruleId: proposal.ruleId },
        'Rule not found for applyPromotion — skipping',
      );
      return;
    }

    rule.routing = proposal.proposedRouting;

    const updated = YAML.stringify(config);
    const tmpPath = `${this.trustMatrixPath}.tmp`;

    fs.writeFileSync(tmpPath, updated, 'utf-8');
    fs.renameSync(tmpPath, this.trustMatrixPath);

    logger.info(
      {
        ruleId: proposal.ruleId,
        from: proposal.currentRouting,
        to: proposal.proposedRouting,
      },
      'Trust rule promoted',
    );

    this.eventRouter.reloadFromPath(this.trustMatrixPath);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private loadConfig(): TrustConfig {
    const raw = fs.readFileSync(this.trustMatrixPath, 'utf-8');
    return YAML.parse(raw) as TrustConfig;
  }

  /**
   * Return the next routing level toward autonomous, or null if already at max.
   */
  private nextPromotion(current: RoutingLevel): RoutingLevel | null {
    const idx = PROMOTION_ORDER.indexOf(current);
    if (idx === -1 || idx === PROMOTION_ORDER.length - 1) return null;
    return PROMOTION_ORDER[idx + 1];
  }

  /**
   * Return true if the proposed routing is at or below (more restrictive than
   * or equal to) the max_promotion floor.
   *
   * e.g. proposedRouting='notify', maxPromotion='notify' → true (allowed)
   *      proposedRouting='autonomous', maxPromotion='notify' → false (blocked)
   */
  private isAtOrBelowMax(proposed: RoutingLevel, max: RoutingLevel): boolean {
    const proposedIdx = PROMOTION_ORDER.indexOf(proposed);
    const maxIdx = PROMOTION_ORDER.indexOf(max);
    return proposedIdx <= maxIdx;
  }

  /**
   * Format and send a proposal to the main Telegram group, then record it
   * as a draft decision in the approval tracker.
   */
  private async sendProposal(proposal: PromotionProposal): Promise<void> {
    const { ruleId, currentRouting, proposedRouting, evidence } = proposal;
    const pct = (evidence.rate * 100).toFixed(1);

    const text =
      `[Promotion Proposal] Rule: ${ruleId}\n` +
      `Current routing: ${currentRouting} → Proposed: ${proposedRouting}\n` +
      `Evidence: ${evidence.approved}/${evidence.total} approved (${pct}%)\n\n` +
      `Reply to approve or reject this promotion.`;

    const decisionId = this.tracker.recordDecision({
      eventType: 'promotion',
      eventSource: ruleId,
      routing: 'draft',
      trustRuleId: ruleId,
      classificationSummary: `Promotion: ${currentRouting} → ${proposedRouting}`,
      classificationImportance: evidence.rate,
      classificationUrgency: 'low',
    });

    const msgId = await this.sendToMainGroup(text);
    if (msgId) {
      this.tracker.setTelegramMsgId(decisionId, msgId);
    }
  }
}
