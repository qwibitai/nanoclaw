/**
 * Inbound pipeline — runs all inbound stages in order.
 * If any stage rejects, processing stops and the message is dropped.
 */
import { logger } from '../logger.js';
import { InboundStage, InboundMessage, StageVerdict } from './types.js';

export class InboundPipeline {
  private stages: InboundStage[] = [];

  add(stage: InboundStage): this {
    this.stages.push(stage);
    return this;
  }

  process(msg: InboundMessage): StageVerdict {
    for (const stage of this.stages) {
      const verdict = stage.process(msg);
      if (verdict.action === 'reject') {
        const meta = { stage: stage.name, msgId: msg.id, reason: verdict.reason };
        if (stage.name === 'DedupStage') {
          logger.debug(meta, 'Inbound message rejected by pipeline');
        } else {
          logger.info(meta, 'Inbound message rejected by pipeline');
        }
        return verdict;
      }
    }
    return { action: 'pass' };
  }
}
