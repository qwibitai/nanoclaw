import https from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getRouterState, setRouterState } from './db.js';

const NOTION_PAGE_ID = '3366d40b-27ff-81aa-bc16-dbb3a76996ce';
const CATEGORY_HEADINGS = [
  '🔴 CRITICAL',
  '🟡 APPROVAL',
  '🔵 DELEGATE',
  '⏳ Waiting for Reply',
  '⚪ FYI',
  '✅ Done',
];
const CATEGORY_ALIASES: Record<string, string> = {
  critical: '🔴 CRITICAL',
  crit: '🔴 CRITICAL',
  approval: '🟡 APPROVAL',
  appr: '🟡 APPROVAL',
  delegate: '🔵 DELEGATE',
  del: '🔵 DELEGATE',
  waiting: '⏳ Waiting for Reply',
  wfr: '⏳ Waiting for Reply',
  fyi: '⚪ FYI',
};

interface CloseCommand {
  type: 'close';
  number: number;
  category?: string;
}
interface MuteCommand {
  type: 'mute';
  keyword: string;
  hours: number | null;
}
interface UnmuteCommand {
  type: 'unmute';
  keyword: string;
}
interface SimpleCommand {
  type: 'mutes' | 'status' | 'ack';
}

type OpsCommand = CloseCommand | MuteCommand | UnmuteCommand | SimpleCommand;

export function parseOpsCommand(text: string): OpsCommand | null {
  // Strip leading / (Telegram bot command prefix) and @botname suffix
  const t = text.trim().replace(/^\//, '').replace(/@\S+$/, '').trim();

  // close #N [in] [CATEGORY] or done #N [CATEGORY]
  const closeMatch = t.match(
    /^(?:close|done|✅)\s*#?(\d+)(?:\s+(?:in\s+)?(\w[\w\s]*))?$/i,
  );
  if (closeMatch) {
    const number = parseInt(closeMatch[1]);
    const rawCat = closeMatch[2]?.trim().toLowerCase();
    const category = rawCat ? CATEGORY_ALIASES[rawCat] : undefined;
    return { type: 'close', number, category };
  }

  // close CATEGORY #N
  const closeAltMatch = t.match(/^(?:close|done|✅)\s+(\w+)\s+#?(\d+)$/i);
  if (closeAltMatch) {
    const rawCat = closeAltMatch[1].toLowerCase();
    const category = CATEGORY_ALIASES[rawCat];
    if (category) {
      return { type: 'close', number: parseInt(closeAltMatch[2]), category };
    }
  }

  // mute <keyword> [for Xh/Xm]
  const muteMatch = t.match(/^mute\s+(.+?)(?:\s+for\s+(\d+)\s*([hm]))?$/i);
  if (muteMatch) {
    const keyword = muteMatch[1].trim();
    if (!keyword) return null;
    let hours: number | null = null;
    if (muteMatch[2]) {
      hours =
        muteMatch[3].toLowerCase() === 'm'
          ? parseInt(muteMatch[2]) / 60
          : parseInt(muteMatch[2]);
    }
    return { type: 'mute', keyword, hours };
  }

  // unmute <keyword>
  const unmuteMatch = t.match(/^unmute\s+(.+)$/i);
  if (unmuteMatch) {
    return { type: 'unmute', keyword: unmuteMatch[1].trim() };
  }

  // simple commands
  if (/^(?:mutes|list\s+mutes)$/i.test(t)) return { type: 'mutes' };
  if (/^(?:status|what'?s?\s+open|open)$/i.test(t)) return { type: 'status' };
  if (/^(?:ack|acknowledged?|got\s*it|ok)$/i.test(t)) return { type: 'ack' };

  return null;
}

export async function executeOpsCommand(cmd: OpsCommand): Promise<string> {
  switch (cmd.type) {
    case 'close':
      return executeClose(cmd);
    case 'mute':
      return executeMute(cmd);
    case 'unmute':
      return executeUnmute(cmd);
    case 'mutes':
      return listMutes();
    case 'status':
      return getOpsStatus();
    case 'ack':
      return acknowledgeAlert();
  }
}

// --- Mute system ---

interface MuteEntry {
  until: string | null;
  keyword: string;
}

function getMutes(): Record<string, MuteEntry> {
  try {
    const raw = getRouterState('ops_mutes');
    if (!raw) return {};
    const mutes = JSON.parse(raw) as Record<string, MuteEntry>;
    const now = new Date().toISOString();
    let changed = false;
    for (const [key, entry] of Object.entries(mutes)) {
      if (entry.until && entry.until < now) {
        delete mutes[key];
        changed = true;
      }
    }
    if (changed) saveMutes(mutes);
    return mutes;
  } catch {
    return {};
  }
}

function saveMutes(mutes: Record<string, MuteEntry>): void {
  setRouterState('ops_mutes', JSON.stringify(mutes));
}

export function isNotificationMuted(text: string): boolean {
  const mutes = getMutes();
  const lower = text.toLowerCase();
  for (const entry of Object.values(mutes)) {
    if (lower.includes(entry.keyword.toLowerCase())) return true;
  }
  return false;
}

function executeMute(cmd: MuteCommand): string {
  const mutes = getMutes();
  const key = cmd.keyword.toLowerCase().replace(/\s+/g, '_');
  const until = cmd.hours
    ? new Date(Date.now() + cmd.hours * 3600000).toISOString()
    : null;
  mutes[key] = { until, keyword: cmd.keyword };
  saveMutes(mutes);
  const duration = cmd.hours ? `for ${cmd.hours}h` : 'indefinitely';
  return `Muted "${cmd.keyword}" ${duration}.`;
}

function executeUnmute(cmd: UnmuteCommand): string {
  const mutes = getMutes();
  const key = cmd.keyword.toLowerCase().replace(/\s+/g, '_');
  if (mutes[key]) {
    delete mutes[key];
    saveMutes(mutes);
    return `Unmuted "${cmd.keyword}".`;
  }
  return `No active mute for "${cmd.keyword}".`;
}

function listMutes(): string {
  const mutes = getMutes();
  const entries = Object.values(mutes);
  if (!entries.length) return 'No active mutes.';
  const lines = entries.map((m) => {
    const exp = m.until
      ? `until ${new Date(m.until).toLocaleString()}`
      : 'indefinite';
    return `• "${m.keyword}" — ${exp}`;
  });
  return `Active mutes:\n${lines.join('\n')}`;
}

function acknowledgeAlert(): string {
  setRouterState('ops_last_ack', new Date().toISOString());
  return 'Acknowledged.';
}

// --- Notion close ---

function getNotionToken(): string | null {
  const env = readEnvFile(['NOTION_API_KEY']);
  return env.NOTION_API_KEY || null;
}

async function notionRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const token = getNotionToken();
  if (!token) throw new Error('No NOTION_API_KEY');
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.notion.com',
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(text));
          } else {
            reject(
              new Error(`Notion ${res.statusCode}: ${text.slice(0, 200)}`),
            );
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Notion timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function executeClose(cmd: CloseCommand): Promise<string> {
  try {
    const blocks = await notionRequest(
      'GET',
      `/v1/blocks/${NOTION_PAGE_ID}/children?page_size=100`,
    );

    let currentCategory = '';
    let itemCount = 0;
    let targetBlock: any = null;
    let targetTitle = '';

    for (const block of blocks.results || []) {
      // Detect category headings
      const headingText = getBlockText(block);
      if (
        block.type?.startsWith('heading') &&
        CATEGORY_HEADINGS.some((h) => headingText.includes(h))
      ) {
        currentCategory = headingText;
        itemCount = 0;
        continue;
      }

      // Count to-do blocks under the current category
      if (block.type === 'to_do' && !block.to_do?.checked) {
        itemCount++;
        const matchesCategory =
          !cmd.category || currentCategory.includes(cmd.category);
        if (matchesCategory && itemCount === cmd.number) {
          targetBlock = block;
          targetTitle = getBlockText(block);
          break;
        }
      }
    }

    if (!targetBlock) {
      return cmd.category
        ? `No unchecked item #${cmd.number} found in ${cmd.category}.`
        : `No unchecked item #${cmd.number} found.`;
    }

    // Check the to-do
    await notionRequest('PATCH', `/v1/blocks/${targetBlock.id}`, {
      to_do: { checked: true },
    });

    logger.info(
      {
        blockId: targetBlock.id,
        title: targetTitle,
        category: currentCategory,
      },
      'Ops bot closed Notion item',
    );

    const shortCat = currentCategory.replace(/^[^\s]+\s+/, '');
    return `✅ Closed ${shortCat} #${cmd.number}: ${targetTitle}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'Ops bot close command failed');
    return `Failed to close: ${msg}`;
  }
}

function getBlockText(block: any): string {
  const richText =
    block[block.type]?.rich_text || block[block.type]?.text || [];
  return richText.map((t: any) => t.plain_text || '').join('');
}

// --- Status ---

async function getOpsStatus(): Promise<string> {
  try {
    const blocks = await notionRequest(
      'GET',
      `/v1/blocks/${NOTION_PAGE_ID}/children?page_size=100`,
    );

    let currentCategory = '';
    const counts: Record<string, number> = {};

    for (const block of blocks.results || []) {
      const headingText = getBlockText(block);
      if (
        block.type?.startsWith('heading') &&
        CATEGORY_HEADINGS.some((h) => headingText.includes(h))
      ) {
        currentCategory = headingText;
        if (!counts[currentCategory]) counts[currentCategory] = 0;
        continue;
      }
      if (block.type === 'to_do' && !block.to_do?.checked && currentCategory) {
        counts[currentCategory] = (counts[currentCategory] || 0) + 1;
      }
    }

    const mutes = getMutes();
    const muteCount = Object.keys(mutes).length;

    const lines = CATEGORY_HEADINGS.filter((h) => h !== '✅ Done').map(
      (h) => `${h}: ${counts[h] || 0}`,
    );
    lines.push('');
    lines.push(`Active mutes: ${muteCount}`);
    return lines.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to get status: ${msg}`;
  }
}
