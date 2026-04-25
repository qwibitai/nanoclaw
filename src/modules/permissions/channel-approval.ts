/**
 * Unknown-channel registration flow.
 *
 * When the router hits an unwired messaging group AND the message was
 * addressed to the bot (SDK-confirmed mention or DM), it calls
 * `requestChannelApproval` instead of silently dropping. The flow:
 *
 *   1. Pick the target agent group we'd wire to (MVP: first by name).
 *      Multi-agent picker is a follow-up — see ACTION-ITEMS.
 *   2. Pick an eligible approver (owner / admin) and a reachable DM for
 *      them, reusing the same primitives the sender-approval flow uses.
 *   3. Deliver an Approve / Ignore card that names the target agent
 *      explicitly so the owner knows what they're wiring to.
 *   4. Record a `pending_channel_approvals` row holding the original event
 *      so it can be re-routed on approve.
 *
 * On approve (handler in index.ts):
 *   - Create `messaging_group_agents` with MVP defaults
 *     (mention-sticky for groups / pattern='.' for DMs,
 *      sender_scope='known', ignored_message_policy='accumulate')
 *   - Add the triggering sender to `agent_group_members` so sender_scope
 *     doesn't bounce the replayed message into a sender-approval cascade
 *   - Delete the pending row, replay the original event
 *
 * On ignore:
 *   - Set `messaging_groups.denied_at = now()` so the router stops
 *     escalating on this channel until an admin explicitly re-wires
 *   - Delete the pending row
 *
 * Dedup: `pending_channel_approvals` PK on messaging_group_id. Second
 * mention while pending silently dropped.
 *
 * Failure modes (log + no row, so a future attempt can try again):
 *   - No agent groups exist (install never set up a first agent).
 *   - No eligible approver in user_roles (no owner yet).
 *   - Approver has no reachable DM.
 *   - Delivery adapter missing.
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { createPendingChannelApproval, hasInFlightChannelApproval } from './db/pending-channel-approvals.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Wired', value: 'approve' },
  { label: 'Ignore', selectedLabel: '🙅 Ignored', value: 'reject' },
];

export interface RequestChannelApprovalInput {
  messagingGroupId: string;
  event: InboundEvent;
}

export async function requestChannelApproval(input: RequestChannelApprovalInput): Promise<void> {
  const { messagingGroupId, event } = input;

  // In-flight dedup: don't spam the owner if the same unwired channel
  // gets more mentions / DMs while a card is already pending.
  if (hasInFlightChannelApproval(messagingGroupId)) {
    log.debug('Channel registration already in flight — dropping retry', {
      messagingGroupId,
    });
    return;
  }

  // MVP: pick the first agent group by name. Multi-agent systems will get
  // a richer card later (user picks the target from a list).
  const agentGroups = getAllAgentGroups();
  if (agentGroups.length === 0) {
    log.warn('Channel registration skipped — no agent groups configured. Run /init-first-agent.', {
      messagingGroupId,
    });
    return;
  }
  const target = agentGroups[0];

  // pickApprover takes the target agent group's id — gets scoped admins +
  // global admins + owners. For fresh installs with only an owner, the
  // owner is returned.
  const approvers = pickApprover(target.id);
  if (approvers.length === 0) {
    log.warn('Channel registration skipped — no owner or admin configured', {
      messagingGroupId,
      targetAgentGroupId: target.id,
    });
    return;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';
  const delivery = await pickApprovalDelivery(approvers, originChannelType);
  if (!delivery) {
    log.warn('Channel registration skipped — no DM channel for any approver', {
      messagingGroupId,
      targetAgentGroupId: target.id,
    });
    return;
  }

  const isGroup = event.message?.isGroup ?? originMg?.is_group === 1;

  // Extract sender name from the event content for a human-readable card.
  let senderName: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    senderName = (parsed.senderName ?? parsed.sender) as string | undefined;
  } catch {
    // non-critical — fall through to generic wording
  }

  const title = isGroup ? '📣 Bot mentioned in new chat' : '💬 New direct message';
  const question = isGroup
    ? senderName
      ? `${senderName} mentioned your agent in a ${originChannelType} channel. Wire it to ${target.name} and let it engage?`
      : `Your agent was mentioned in a ${originChannelType} channel. Wire it to ${target.name} and let it engage?`
    : senderName
      ? `${senderName} DM'd your agent on ${originChannelType}. Wire it to ${target.name} and let it respond?`
      : `Someone DM'd your agent on ${originChannelType}. Wire it to ${target.name} and let it respond?`;
  const options = normalizeOptions(APPROVAL_OPTIONS);

  createPendingChannelApproval({
    messaging_group_id: messagingGroupId,
    agent_group_id: target.id,
    original_message: JSON.stringify(event),
    approver_user_id: delivery.userId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Channel registration row created but no delivery adapter is wired', {
      messagingGroupId,
    });
    return;
  }

  try {
    await adapter.deliver(
      delivery.messagingGroup.channel_type,
      delivery.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        // Use messaging_group_id as the questionId — it's unique per card
        // (PK on pending table dedups) and lets the response handler look
        // up the pending row directly without another index.
        questionId: messagingGroupId,
        title,
        question,
        options,
      }),
    );
    log.info('Channel registration card delivered', {
      messagingGroupId,
      targetAgentGroupId: target.id,
      approver: delivery.userId,
    });
  } catch (err) {
    log.error('Channel registration card delivery failed', {
      messagingGroupId,
      err,
    });
  }
}

export const APPROVE_VALUE = 'approve';
export const REJECT_VALUE = 'reject';
