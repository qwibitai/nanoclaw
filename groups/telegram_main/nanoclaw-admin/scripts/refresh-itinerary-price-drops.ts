/**
 * refresh-itinerary-price-drops
 *
 * Calls the refresh_itinerary_price_drops RPC on the source Supabase instance,
 * then syncs the results into the target instance using an atomic swap pattern.
 *
 * Run via:  npm run job:price-drops
 * Schedule: daily at 23:57 (NanoClaw task)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Supabase clients
// ---------------------------------------------------------------------------

/**
 * When the job runs inside a NanoClaw container, `127.0.0.1` / `localhost`
 * refers to the container itself — not the Mac host. Swap to
 * `host.docker.internal` so local Supabase instances are reachable.
 *
 * When running directly on the Mac (e.g. `pnpm job:price-drops`), skip the
 * substitution — `host.docker.internal` resolves to the Docker VM IP
 * (192.168.65.x), NOT to 127.0.0.1, which would break local connectivity.
 */
import { existsSync } from "fs";
const IN_CONTAINER = existsSync("/.dockerenv");

function resolveContainerUrl(url: string): string {
  if (!IN_CONTAINER) return url;
  return url.replace(/\b(localhost|127\.0\.0\.1)\b/g, "host.docker.internal");
}

function getClient(url: string, key: string, label: string): SupabaseClient {
  if (!url || !key) {
    throw new Error(`Missing Supabase credentials for ${label} (url=${!!url}, key=${!!key})`);
  }
  return createClient(resolveContainerUrl(url), key);
}

const getSupabaseSource = (): SupabaseClient =>
  getClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL_SOURCE ?? "",
    process.env.SUPABASE_SERVICE_KEY_SOURCE ?? "",
    "source"
  );

const getSupabaseTarget = (): SupabaseClient =>
  getClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL_TARGET ?? "",
    process.env.SUPABASE_SERVICE_KEY_TARGET ?? "",
    "target"
  );

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PriceDrop = {
  itinerary_id: string;
  cabin_type: string;
  average_price: number;
  price_drop_percentage: number;
  price_created_at: string;
  cruiseline_id: string;
  ship_id: string;
  latest_price: number;
  latest_price_per_night: number;
  check_prices_url: string;
  is_current: boolean;
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatExecutionTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function prettifyNum(n: number): string {
  return n.toLocaleString("en-US");
}

function splitIntoChunks<T>(arr: T[], size = 500): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatRunAt(): string {
  return new Date().toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

// ---------------------------------------------------------------------------
// Slack reporting
// ---------------------------------------------------------------------------

type JobResult = {
  ok: boolean;
  status: number;
  message: string;
  execution_time: string;
  execution_ms: number;
  inserted_count?: number;
  skipped_missing_parents?: number;
};

async function sendSlackNotification(result: JobResult): Promise<void> {
  const webhookUrl = process.env.SLACK_SCHEDULED_JOBS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("⚠️  SLACK_SCHEDULED_JOBS_WEBHOOK_URL not set — skipping Slack notification.");
    return;
  }

  const isSuccess = result.ok;
  const color = isSuccess ? "#2eb886" : "#e01e5a";
  const statusIcon = isSuccess ? "✅" : "❌";
  const statusLabel = isSuccess ? "Completed successfully" : `Failed with status ${result.status}`;
  const runAt = formatRunAt();

  const payload = {
    attachments: [
      {
        color,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "🔄  Refresh Itinerary Price Drops",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${statusIcon} *${statusLabel}*\n_${result.message}_`,
            },
          },
          { type: "divider" },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*Records Inserted*\n\`${prettifyNum(result.inserted_count ?? 0)}\``,
              },
              {
                type: "mrkdwn",
                text: `*Records Skipped*\n\`${prettifyNum(result.skipped_missing_parents ?? 0)}\``,
              },
              {
                type: "mrkdwn",
                text: `*Execution Time*\n\`${result.execution_time}\``,
              },
              {
                type: "mrkdwn",
                text: `*Completed At*\n\`${runAt}\``,
              },
            ],
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "nanoclaw-admin  ·  cron: `57 23 * * *`  ·  refresh-itinerary-price-drops",
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`⚠️  Slack notification failed: HTTP ${res.status}`);
    }
  } catch (err: unknown) {
    console.warn(`⚠️  Slack notification error: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// FK precheck
// ---------------------------------------------------------------------------

async function getExistingItineraryIds(ids: string[]): Promise<Set<string>> {
  const target = getSupabaseTarget();
  const out = new Set<string>();
  const chunks = splitIntoChunks(ids, 100);

  for (const chunk of chunks) {
    const { data, error } = await target
      .from("itineraries")
      .select("id")
      .in("id", chunk);
    if (error) throw new Error(`Failed itinerary FK precheck: ${error.message}`);
    for (const row of data ?? []) {
      if (row?.id) out.add(String(row.id));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main job
// ---------------------------------------------------------------------------

async function run() {
  const startTime = Date.now();

  const fail = (status: number, message: string) => ({
    ok: false,
    status,
    message,
    execution_time: formatExecutionTime(Date.now() - startTime),
    execution_ms: Date.now() - startTime,
  });

  // 1. Fetch fresh price drops from source via RPC
  const { data, error: rpcError } = await getSupabaseSource().rpc(
    "refresh_itinerary_price_drops"
  );
  if (rpcError) return fail(500, rpcError.message);

  const rows = (data ?? []) as PriceDrop[];
  if (!Array.isArray(rows) || rows.length === 0)
    return fail(400, "No price drops returned from source RPC.");

  // 2. Round numeric fields
  const rounded = rows.map((drop) => ({
    ...drop,
    average_price: round2(drop.average_price),
    price_drop_percentage: round2(drop.price_drop_percentage),
    latest_price: round2(drop.latest_price),
    latest_price_per_night: round2(drop.latest_price_per_night),
  }));

  // 3. FK-safe filter — only insert drops whose itinerary_id exists in target
  const uniqueIds = Array.from(
    new Set(rounded.map((r) => r.itinerary_id).filter(Boolean))
  );

  let existingIds: Set<string>;
  try {
    existingIds = await getExistingItineraryIds(uniqueIds);
  } catch (err: unknown) {
    return fail(500, (err as Error)?.message ?? "FK precheck failed");
  }

  const drops = rounded.filter((r) => existingIds.has(r.itinerary_id));
  const skippedMissingParents = rounded.length - drops.length;

  if (drops.length === 0) {
    return {
      ok: true,
      status: 200,
      message: `No eligible drops to insert (all ${prettifyNum(skippedMissingParents)} rows skipped — missing target itinerary FK).`,
      execution_time: formatExecutionTime(Date.now() - startTime),
      execution_ms: Date.now() - startTime,
      inserted_count: 0,
      skipped_missing_parents: skippedMissingParents,
    };
  }

  // 4. Atomic swap:
  //    a) Purge stale non-current leftovers from any prior failed/partial run
  const { error: purgeError } = await getSupabaseTarget()
    .from("itinerary_price_drops")
    .delete()
    .eq("is_current", false);
  if (purgeError) return fail(500, purgeError.message);

  //    b) Insert new drops (is_current = false staging area)
  for (const chunk of splitIntoChunks(drops)) {
    const { error: insertError } = await getSupabaseTarget()
      .from("itinerary_price_drops")
      .insert(chunk);
    if (insertError) return fail(500, insertError.message);
  }

  //    c) Delete the previous live set
  const { error: deleteError } = await getSupabaseTarget()
    .from("itinerary_price_drops")
    .delete()
    .eq("is_current", true);
  if (deleteError) return fail(500, deleteError.message);

  //    d) Promote staged records to live
  const { error: updateError } = await getSupabaseTarget()
    .from("itinerary_price_drops")
    .update({ is_current: true })
    .eq("is_current", false);
  if (updateError) return fail(500, updateError.message);

  const inserted = drops.length;
  const executionTime = formatExecutionTime(Date.now() - startTime);
  const message =
    skippedMissingParents > 0
      ? `Inserted ${prettifyNum(inserted)} itinerary price drops (skipped ${prettifyNum(skippedMissingParents)} missing parent itineraries).`
      : `Successfully inserted ${prettifyNum(inserted)} itinerary price drop records.`;

  return {
    ok: true,
    status: 200,
    message,
    execution_time: executionTime,
    execution_ms: Date.now() - startTime,
    inserted_count: inserted,
    skipped_missing_parents: skippedMissingParents,
  };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

run()
  .then(async (result) => {
    console.log(JSON.stringify(result, null, 2));
    await sendSlackNotification(result);
    if (!result.ok) process.exit(1);
  })
  .catch(async (err: unknown) => {
    const result: JobResult = {
      ok: false,
      status: 500,
      message: String(err),
      execution_time: "unknown",
      execution_ms: 0,
    };
    console.error(JSON.stringify(result, null, 2));
    await sendSlackNotification(result);
    process.exit(1);
  });
