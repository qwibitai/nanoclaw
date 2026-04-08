/**
 * supabase-localhost-daily-backup
 *
 * Spawns supabase-localhost-daily-backup.sh to dump the local Supabase project
 * and archive it to /Volumes/caponesafe/longbow-backups.
 *
 * Run via:  pnpm job:supabase-backup
 * Schedule: 53 23 * * * (daily at 11:53 PM — before price-drops at 11:57)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatExecutionTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round((ms / 1000) * 10) / 10;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
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

type BackupResult = {
  ok: boolean;
  status: number;
  message: string;
  execution_time: string;
  execution_ms: number;
  metadata?: {
    archive_name: string | null;
    archive_size_bytes: number;
    archive_size_mb: number;
    backup_directory: string | null;
  };
};

async function sendSlackNotification(result: BackupResult): Promise<void> {
  const webhookUrl = process.env.SLACK_SCHEDULED_JOBS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("⚠️  SLACK_SCHEDULED_JOBS_WEBHOOK_URL not set — skipping Slack notification.");
    return;
  }

  const isSuccess = result.ok;
  const color = isSuccess ? "#2eb886" : "#e01e5a";
  const statusIcon = isSuccess ? "✅" : "❌";
  const statusLabel = isSuccess ? "Backup completed successfully" : `Backup failed (status ${result.status})`;
  const meta = result.metadata;

  const fields = isSuccess && meta ? [
    { type: "mrkdwn", text: `*Archive*\n\`${meta.archive_name ?? "unknown"}\`` },
    { type: "mrkdwn", text: `*Size*\n\`${meta.archive_size_mb.toFixed(2)} MB\`` },
    { type: "mrkdwn", text: `*Saved To*\n\`${meta.backup_directory ?? "/Volumes/caponesafe"}\`` },
    { type: "mrkdwn", text: `*Execution Time*\n\`${result.execution_time}\`` },
  ] : [
    { type: "mrkdwn", text: `*Error*\n${result.message}` },
    { type: "mrkdwn", text: `*Completed At*\n\`${formatRunAt()}\`` },
  ];

  const payload = {
    attachments: [
      {
        color,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "🗄️  Supabase Localhost Daily Backup", emoji: true },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${statusIcon} *${statusLabel}*\n_${result.message}_`,
            },
          },
          { type: "divider" },
          { type: "section", fields },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `nanoclaw-admin  ·  cron: \`53 23 * * *\`  ·  supabase-localhost-daily-backup  ·  ${formatRunAt()}`,
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
    if (!res.ok) console.warn(`⚠️  Slack notification failed: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`⚠️  Slack notification error: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Backup runner
// ---------------------------------------------------------------------------

const SCRIPT_PATH = path.join(import.meta.dirname, "supabase-localhost-daily-backup.sh");
const SCRIPT_CWD  = path.join(import.meta.dirname, "..");

async function run(): Promise<BackupResult> {
  const start = Date.now();

  if (!existsSync(SCRIPT_PATH)) {
    return {
      ok: false, status: 500,
      message: `Backup script not found: ${SCRIPT_PATH}`,
      execution_time: "0ms", execution_ms: 0,
    };
  }

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("bash", [SCRIPT_PATH], {
      cwd: SCRIPT_CWD,
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/Users/broseph",
        // Ensure supabase CLI (installed via homebrew) is on PATH
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

  return {
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
    const result: BackupResult = {
      ok: false, status: 500,
      message: String(err),
      execution_time: "unknown", execution_ms: 0,
    };
    console.error(JSON.stringify(result, null, 2));
    await sendSlackNotification(result);
    process.exit(1);
  });
