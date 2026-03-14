/**
 * Outbound pipeline — runs all outbound stages in order.
 * Stages can reject (suppress send) or transform (modify text).
 */
import { logger } from '../logger.js';
import { OutboundStage, OutboundMessage, OutboundVerdict } from './types.js';

export class OutboundPipeline {
  private stages: OutboundStage[] = [];

  add(stage: OutboundStage): this {
    this.stages.push(stage);
    return this;
  }

  /** Returns the final text to send, or null if suppressed. */
  process(msg: OutboundMessage): string | null {
    let text = msg.text;

    for (const stage of this.stages) {
      const verdict = stage.process({ ...msg, text });
      if (verdict.action === 'reject') {
        logger.debug(
          { stage: stage.name, jid: msg.chatJid, reason: verdict.reason },
          'Outbound message rejected by pipeline',
        );
        return null;
      }
      if (verdict.action === 'transform') {
        text = verdict.text;
      }
    }

    return text;
  }
}
