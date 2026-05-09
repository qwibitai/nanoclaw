/**
 * Regression: getMessageIdBySeq must NOT return the
 * `<platform-id>:<agentGroupId>` composite for inbound rows.
 *
 * Background: the host's router writes `messages_in.id` as
 *   `<rawPlatformMessageId>:<agentGroupId>`
 * (see src/router.ts messageIdForAgent — the suffix is needed because
 * messages_in.id is PRIMARY KEY and the same inbound message can fan
 * out to multiple per-agent session DBs). When the agent calls
 * mcp__nanoclaw__add_reaction or edit_message, those tools resolve a
 * seq → platform message id via getMessageIdBySeq and put the result in
 * `content.messageId` on the outbound row. The host delivery then hands
 * `content.messageId` to the channel adapter (Discord etc.). Discord
 * rejected this with `NUMBER_TYPE_COERCE: not a snowflake` because the
 * id had `:ag-...` appended.
 *
 * Fix: strip the agent-group suffix at the lookup boundary so all
 * MCP-tool callers downstream see the clean platform id.
 */
import { describe, expect, it } from 'bun:test';

import { stripAgentGroupSuffix } from './messages-out.js';

describe('stripAgentGroupSuffix', () => {
  it('strips the trailing :ag-<id> from a Discord snowflake', () => {
    expect(stripAgentGroupSuffix('1502487856978067566:ag-1778068450126-025c')).toBe('1502487856978067566');
  });

  it("preserves Telegram's chatId:messageId composite (only strips the agent suffix)", () => {
    expect(stripAgentGroupSuffix('6037840640:42:ag-1778068450126-025c')).toBe('6037840640:42');
  });

  it('preserves a plain platform id with no agent suffix', () => {
    expect(stripAgentGroupSuffix('1502487856978067566')).toBe('1502487856978067566');
    expect(stripAgentGroupSuffix('6037840640:42')).toBe('6037840640:42');
  });

  it('does not strip a non-suffix `ag-` substring (only the trailing one)', () => {
    expect(stripAgentGroupSuffix('msg-ag-archive-12')).toBe('msg-ag-archive-12');
  });

  it('handles all observed agent-group ID shapes', () => {
    expect(stripAgentGroupSuffix('x:ag-1778051330215-np1wol')).toBe('x');
    expect(stripAgentGroupSuffix('x:ag-1778053157724-drungy')).toBe('x');
    expect(stripAgentGroupSuffix('x:ag-1778068450082-025c')).toBe('x');
  });

  it('passes empty / null-ish through', () => {
    expect(stripAgentGroupSuffix('')).toBe('');
  });
});
