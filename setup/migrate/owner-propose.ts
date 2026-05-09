/**
 * Infer the owner user_id from v1 state. The owner is the one user who
 * gets the global `owner` role in v2 and receives approval prompts.
 *
 * Inference order (highest confidence first):
 *   1. `.env` OWNER_USER_ID / OWNER_JID / OWNER_PHONE
 *   2. The single registered group row with is_main=1
 *   3. sender-allowlist.json with a single explicit allow entry
 *
 * Returns null user_id when inference fails — the caller must prompt.
 */

import { inferChannelTypeFromJid } from './jid.js';

export interface OwnerProposal {
  userId: string | null;
  source: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export interface RegisteredGroupLite {
  jid: string;
  is_main: boolean;
  inferred_channel_type: string;
}

interface AllowlistChat {
  allow: '*' | string[];
}

export interface V1Allowlist {
  default?: AllowlistChat;
  chats?: Record<string, AllowlistChat>;
}

export function proposeOwner(
  env: Record<string, string>,
  registered: RegisteredGroupLite[],
  allowlist: V1Allowlist | null,
): OwnerProposal {
  if (env.OWNER_USER_ID) {
    return { userId: env.OWNER_USER_ID, source: '.env OWNER_USER_ID', confidence: 'high' };
  }
  if (env.OWNER_JID) {
    const channel = inferChannelTypeFromJid(env.OWNER_JID).channel_type;
    return { userId: `${channel}:${env.OWNER_JID}`, source: '.env OWNER_JID', confidence: 'high' };
  }
  if (env.OWNER_PHONE) {
    const phone = env.OWNER_PHONE.startsWith('+') ? env.OWNER_PHONE : `+${env.OWNER_PHONE}`;
    return { userId: `phone:${phone}`, source: '.env OWNER_PHONE', confidence: 'high' };
  }

  const main = registered.find((r) => r.is_main);
  if (main) {
    return {
      userId: `${main.inferred_channel_type}:${main.jid}`,
      source: `is_main group (${main.jid})`,
      confidence: 'medium',
    };
  }

  if (allowlist?.chats) {
    const explicit: string[] = [];
    for (const entry of Object.values(allowlist.chats)) {
      if (entry && Array.isArray(entry.allow)) {
        for (const v of entry.allow) explicit.push(v);
      }
    }
    if (explicit.length === 1) {
      const channel = inferChannelTypeFromJid(explicit[0]).channel_type;
      return {
        userId: `${channel}:${explicit[0]}`,
        source: 'sender-allowlist.json single entry',
        confidence: 'medium',
      };
    }
  }

  return { userId: null, source: 'none', confidence: 'none' };
}
