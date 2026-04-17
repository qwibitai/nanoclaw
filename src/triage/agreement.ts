import { getDb } from '../db.js';

export interface AgreementReport {
  overall: number;
  total: number;
  bySlice: Record<string, { rate: number; total: number }>;
}

export function computeAgreement(opts: { windowMs: number }): AgreementReport {
  const cutoff = Date.now() - opts.windowMs;
  const rows = getDb()
    .prepare(
      `SELECT kind, agent_queue FROM triage_examples WHERE created_at >= ?`,
    )
    .all(cutoff) as Array<{ kind: string; agent_queue: string }>;

  let correct = 0;
  const sliceCounts: Record<string, { correct: number; total: number }> = {};

  for (const r of rows) {
    const bucket = (sliceCounts[r.agent_queue] ??= { correct: 0, total: 0 });
    bucket.total += 1;
    if (r.kind === 'positive') {
      correct += 1;
      bucket.correct += 1;
    }
  }

  const bySlice: Record<string, { rate: number; total: number }> = {};
  for (const [slice, c] of Object.entries(sliceCounts)) {
    bySlice[slice] = {
      rate: c.total === 0 ? 1 : c.correct / c.total,
      total: c.total,
    };
  }

  return {
    overall: rows.length === 0 ? 1 : correct / rows.length,
    total: rows.length,
    bySlice,
  };
}

export async function runNightlyAgreementCheck(opts: {
  agreementFloor: number;
}): Promise<void> {
  const r = computeAgreement({ windowMs: 7 * 24 * 60 * 60 * 1000 });
  if (r.total < 20) return; // not enough data
  if (r.overall >= opts.agreementFloor) return;

  const chatId = process.env.EMAIL_INTEL_TG_CHAT_ID;
  if (!chatId) return;

  const { sendTelegramMessage } = await import('../channels/telegram.js');
  const worst = Object.entries(r.bySlice).sort(
    (a, b) => a[1].rate - b[1].rate,
  )[0];
  const msg = `⚠️ Triage calibration alert: 7d agreement = ${(r.overall * 100).toFixed(0)}% (floor ${(opts.agreementFloor * 100).toFixed(0)}%).\nWorst slice: *${worst?.[0]}* at ${((worst?.[1].rate ?? 0) * 100).toFixed(0)}% over ${worst?.[1].total ?? 0} items.`;
  await sendTelegramMessage(chatId, msg, { parse_mode: 'Markdown' });
}
