import type { NewMessage } from '../types.js';

export const ACP_NOTICE_SENDER = '__agentlite_acp__';
export const ACP_NOTICE_SENDER_NAME = 'AgentLite ACP';

export function isAcpNoticeMessage(
  message: Pick<NewMessage, 'sender'>,
): boolean {
  return message.sender === ACP_NOTICE_SENDER;
}
