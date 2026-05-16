/**
 * Fetches the latest owl-radar digest and posts a summary to Discord.
 * Tracks the last posted date in .owl-radar-state.json to avoid duplicates.
 *
 * Usage: pnpm exec tsx scripts/owl-radar-discord.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "../src/env.js";

const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/alexli-77/owl-radar/master/manifest.json";
const DEFAULT_PAGES_URL = "https://alexli-77.github.io/owl-radar";
const STATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".owl-radar-state.json",
);

const REPORT_LABELS: Record<string, string> = {
  "ai-cli": "AI CLI Tools",
  "ai-agents": "AI Agents",
  "ai-web": "Anthropic & OpenAI",
  "ai-trending": "GitHub Trending",
  "ai-hn": "Hacker News",
  "ai-ph": "Product Hunt",
  "ai-arxiv": "arXiv Papers",
  "ai-hf": "Hugging Face",
  "ai-community": "Community",
  "ai-weekly": "Weekly Rollup",
  "ai-monthly": "Monthly Rollup",
};

interface DateEntry {
  date: string;
  reports: string[];
}

interface Manifest {
  dates: DateEntry[];
}

interface State {
  lastPostedDate: string;
}

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as State;
  } catch {
    return { lastPostedDate: "" };
  }
}

function saveState(state: State): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function buildDiscordMessage(date: string, reports: string[], PAGES_URL: string): string {
  const baseReports = reports.filter((r) => !r.endsWith("-en"));
  const isWeekly = baseReports.includes("ai-weekly");
  const isMonthly = baseReports.includes("ai-monthly");

  const icon = isMonthly ? "📆" : isWeekly ? "📅" : "📡";
  const suffix = isMonthly ? " Monthly" : isWeekly ? " Weekly" : " Daily";
  const lines: string[] = [`${icon} **owl-radar${suffix} · ${date}**`, ""];

  const ordered = [
    ...baseReports.filter((r) => !r.includes("weekly") && !r.includes("monthly")),
    ...baseReports.filter((r) => r.includes("weekly") || r.includes("monthly")),
  ];

  for (const r of ordered) {
    const label = REPORT_LABELS[r] ?? r;
    const zhUrl = `${PAGES_URL}/#${date}/${r}`;
    const enKey = `${r}-en`;
    if (reports.includes(enKey)) {
      const enUrl = `${PAGES_URL}/#${date}/${enKey}`;
      lines.push(`• [${label}](${zhUrl})  ·  [EN](${enUrl})`);
    } else {
      lines.push(`• [${label}](${zhUrl})`);
    }
  }

  lines.push("", `[🌐 Web UI](${PAGES_URL})  ·  [⊕ RSS](${PAGES_URL}/feed.xml)`);
  return lines.join("\n");
}

async function postToDiscord(token: string, channelId: string, content: string): Promise<void> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord API ${res.status}: ${body}`);
  }
}

async function main(): Promise<void> {
  const env = readEnvFile(["DISCORD_BOT_TOKEN", "OWL_RADAR_CHANNEL_ID", "OWL_RADAR_MANIFEST_URL", "OWL_RADAR_PAGES_URL"]);
  if (!env.DISCORD_BOT_TOKEN) {
    console.error("[owl-radar] DISCORD_BOT_TOKEN not set in .env — aborting.");
    process.exit(1);
  }
  if (!env.OWL_RADAR_CHANNEL_ID) {
    console.error("[owl-radar] OWL_RADAR_CHANNEL_ID not set in .env — aborting.");
    process.exit(1);
  }

  const MANIFEST_URL = env.OWL_RADAR_MANIFEST_URL || DEFAULT_MANIFEST_URL;
  const PAGES_URL = env.OWL_RADAR_PAGES_URL || DEFAULT_PAGES_URL;
  const CHANNEL_ID = env.OWL_RADAR_CHANNEL_ID;

  console.log("[owl-radar] Fetching manifest…");
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
  const manifest = (await res.json()) as Manifest;

  const latest = manifest.dates?.[0];
  if (!latest) {
    console.log("[owl-radar] Manifest is empty — nothing to post.");
    return;
  }

  const state = loadState();
  if (latest.date === state.lastPostedDate) {
    console.log(`[owl-radar] Already posted for ${latest.date} — skipping.`);
    return;
  }

  const message = buildDiscordMessage(latest.date, latest.reports, PAGES_URL);
  console.log(`[owl-radar] Posting digest for ${latest.date} to Discord…`);
  await postToDiscord(env.DISCORD_BOT_TOKEN, CHANNEL_ID, message);

  saveState({ lastPostedDate: latest.date });
  console.log("[owl-radar] Done!");
}

main().catch((e: unknown) => {
  console.error("[owl-radar]", e instanceof Error ? e.message : e);
  process.exit(1);
});
