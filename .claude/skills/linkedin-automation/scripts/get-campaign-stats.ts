/**
 * LinkedIn Automation — Get Campaign Stats from Notion
 *
 * No browser needed — just Notion API.
 * Input: { campaign?: string }
 * Output: { success: boolean, message: string, data: Record<LeadStatus, number> }
 */

import { readInput, writeResult } from '../lib/browser.js';
import { getCampaignStats } from '../lib/notion.js';

async function main() {
  const { campaign } = await readInput<{ campaign?: string }>();
  try {
    const stats = await getCampaignStats(campaign);
    const lines = Object.entries(stats).map(([s, c]) => `${s}: ${c}`).join('\n');
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    writeResult({
      success: true,
      message: `LinkedIn Lead Stats${campaign ? ` (${campaign})` : ''}:\n${lines}\n\nTotal: ${total} leads`,
      data: stats,
    });
  } catch (err) {
    writeResult({ success: false, message: `Notion error: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }
}

main();
