/**
 * POST /api/jobs/supabase-backup
 *
 * Triggers the supabase-localhost-daily-backup job on the host Mac.
 * Called by the NanoClaw scheduled task (running in a container) via
 * http://host.docker.internal:3002/api/jobs/supabase-backup
 *
 * Protected by Bearer token (BACKUP_JOB_SECRET in .env.local).
 */

// Allow up to 15 minutes for the backup to complete (3 x supabase db dump + zip + move)
export const maxDuration = 900;

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "supabase-localhost-daily-backup.sh");

function formatExecutionTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round((ms / 1000) * 10) / 10;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

async function sendSlackNotification(result: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.SLACK_SCHEDULED_JOBS_WEBHOOK_URL;
  if (!webhookUrl) return;

  const isSuccess = result.ok as boolean;
  const meta = result.metadata as Record<string, unknown> | undefined;

  const fields = isSuccess && meta ? [
    { type: "mrkdwn", text: `*Archive*\n\`${meta.archive_name ?? "unknown"}\`` },
    { type: "mrkdwn", text: `*Size*\n\`${Number(meta.archive_size_mb).toFixed(2)} MB\`` },
    { type: "mrkdwn", text: `*Saved To*\n\`${meta.backup_directory ?? "/Volumes/caponesafe"}\`` },
    { type: "mrkdwn", text: `*Execution Time*\n\`${result.execution_time}\`` },
  ] : [
    { type: "mrkdwn", text: `*Error*\n${result.message}` },
  ];

  const runAt = new Date().toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  });

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attachments: [{
        color: isSuccess ? "#2eb886" : "#e01e5a",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "🗄️  Supabase Localhost Daily Backup", emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: `${isSuccess ? "✅" : "❌"} *${isSuccess ? "Backup completed successfully" : `Backup failed (status ${result.status})`}*\n_${result.message}_` } },
          { type: "divider" },
          { type: "section", fields },
          { type: "context", elements: [{ type: "mrkdwn", text: `nanoclaw-admin  ·  cron: \`53 23 * * *\`  ·  supabase-localhost-daily-backup  ·  ${runAt}` }] },
        ],
      }],
    }),
  }).catch((e) => console.warn("Slack notification error:", e));
}

export async function POST(req: Request) {
  // Bearer token auth
  const secret = process.env.BACKUP_JOB_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!existsSync(SCRIPT_PATH)) {
    return NextResponse.json(
      { ok: false, status: 500, message: `Script not found: ${SCRIPT_PATH}` },
      { status: 500 }
    );
  }

  const start = Date.now();

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("bash", [SCRIPT_PATH], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: process.env.HOME ?? "/Users/broseph",
          PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH ?? "/usr/bin:/bin"}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error((err || out || `backup script exited with code ${code}`).trim()));
          return;
        }
        resolve(`${out}\n${err}`.trim());
      });
    });

    const archiveName      = output.match(/Backup archive created:\s*(.+)/)?.[1]?.trim() ?? null;
    const archiveSizeBytes = Number(output.match(/File size:\s*(\d+) bytes/)?.[1] ?? "0");
    const backupDirectory  = output.match(/Backup directory:\s*(.+)/)?.[1]?.trim() ?? null;
    const sizeMb           = archiveSizeBytes > 0 ? archiveSizeBytes / (1024 * 1024) : 0;
    const executionMs      = Date.now() - start;

    const result = {
      ok: true,
      status: 200,
      message: `Backup created${archiveName ? ` (${archiveName})` : ""} • ${sizeMb.toFixed(2)} MB`,
      execution_time: formatExecutionTime(executionMs),
      execution_ms: executionMs,
      metadata: {
        archive_name: archiveName,
        archive_size_bytes: archiveSizeBytes,
        archive_size_mb: Number(sizeMb.toFixed(2)),
        backup_directory: backupDirectory,
      },
    };

    await sendSlackNotification(result);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const executionMs = Date.now() - start;
    const result = {
      ok: false,
      status: 500,
      message: String(err),
      execution_time: formatExecutionTime(executionMs),
      execution_ms: executionMs,
    };
    await sendSlackNotification(result);
    return NextResponse.json(result, { status: 500 });
  }
}

// GET — quick health check
export async function GET() {
  return NextResponse.json({
    job: "supabase-localhost-daily-backup",
    script: SCRIPT_PATH,
    script_exists: existsSync(SCRIPT_PATH),
    schedule: "53 23 * * *",
  });
}
