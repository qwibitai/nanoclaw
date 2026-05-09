/**
 * v1 JID → v2 channel_type inference.
 *
 * v1 rolled all platforms into one `registered_groups.jid` column using
 * platform-specific prefixes/suffixes. v2 splits `channel_type` + `platform_id`
 * as separate columns, so we have to parse the v1 JID back out.
 *
 * Returns `channel_type: 'unknown'` for unrecognized formats — the caller
 * (extractor, seeder) must fail loudly rather than guess.
 */

export interface ChannelInference {
  channel_type: string;
  is_group: number; // 0 | 1 — best effort from the JID alone
}

export function inferChannelTypeFromJid(jid: string): ChannelInference {
  if (jid.endsWith('@s.whatsapp.net')) return { channel_type: 'whatsapp', is_group: 0 };
  if (jid.endsWith('@g.us')) return { channel_type: 'whatsapp', is_group: 1 };
  // Telegram group IDs are negative; individual chat IDs are positive. v1
  // encoded them as `tg:<id>`.
  if (jid.startsWith('tg:')) return { channel_type: 'telegram', is_group: jid.slice(3).startsWith('-') ? 1 : 0 };
  if (jid.startsWith('dc:')) return { channel_type: 'discord', is_group: 1 };
  if (jid.startsWith('slack:')) return { channel_type: 'slack', is_group: 1 };
  if (jid.startsWith('imsg:') || jid.startsWith('imessage:')) return { channel_type: 'imessage', is_group: 0 };
  if (jid.startsWith('email:')) return { channel_type: 'resend', is_group: 0 };
  if (jid.startsWith('matrix:')) return { channel_type: 'matrix', is_group: 1 };
  if (jid.startsWith('linear:')) return { channel_type: 'linear', is_group: 1 };
  if (jid.startsWith('github:')) return { channel_type: 'github', is_group: 1 };
  if (jid.startsWith('webex:')) return { channel_type: 'webex', is_group: 1 };
  if (jid.startsWith('gchat:')) return { channel_type: 'gchat', is_group: 1 };
  if (jid.startsWith('wechat:')) return { channel_type: 'wechat', is_group: 0 };
  if (jid.startsWith('teams:')) return { channel_type: 'teams', is_group: 1 };
  return { channel_type: 'unknown', is_group: 0 };
}

/** `channel_type` → the `/add-<name>` skill that installs its adapter. */
export const CHANNEL_INSTALL_SKILL: Record<string, string> = {
  whatsapp: '/add-whatsapp',
  telegram: '/add-telegram',
  discord: '/add-discord',
  slack: '/add-slack',
  imessage: '/add-imessage',
  resend: '/add-resend',
  matrix: '/add-matrix',
  linear: '/add-linear',
  github: '/add-github',
  webex: '/add-webex',
  gchat: '/add-gchat',
  wechat: '/add-wechat',
  teams: '/add-teams',
};

/** Convert an allowlist JID into a v2 user_id. Best-effort, never throws. */
export function userIdFromJid(jid: string): string {
  if (jid.endsWith('@s.whatsapp.net')) {
    const phone = jid.split('@')[0];
    const normalised = phone.startsWith('+') ? phone : `+${phone}`;
    return `phone:${normalised}`;
  }
  if (jid.endsWith('@g.us')) return `whatsapp:${jid}`; // groups in allowlists are unusual but keep them routable
  if (jid.startsWith('tg:')) return `telegram:${jid.slice(3)}`;
  if (jid.startsWith('dc:')) return `discord:${jid.slice(3)}`;
  if (jid.startsWith('slack:')) return jid;
  if (jid.startsWith('imsg:') || jid.startsWith('imessage:')) return `imessage:${jid.split(':').slice(1).join(':')}`;
  if (jid.startsWith('email:')) return jid;
  if (jid.startsWith('matrix:') || jid.startsWith('linear:') || jid.startsWith('github:') || jid.startsWith('webex:') || jid.startsWith('gchat:') || jid.startsWith('wechat:') || jid.startsWith('teams:')) return jid;
  if (jid.includes('@')) return `phone:+${jid.split('@')[0]}`;
  return `unknown:${jid}`;
}

export function splitUserId(userId: string): { kind: string; handle: string } {
  const idx = userId.indexOf(':');
  if (idx === -1) return { kind: 'unknown', handle: userId };
  return { kind: userId.slice(0, idx), handle: userId.slice(idx + 1) };
}
