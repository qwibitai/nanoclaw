/**
 * Run the full harvest pipeline with run-lock protection.
 *
 * Stages: ingest-reddit → extract-insights → refresh-opportunities
 *
 * Used by scheduled tasks to run the pipeline safely without overlap.
 * Skips stages that fail and reports results.
 *
 * Usage: tsx run-pipeline.ts
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";
import { acquireRunLock, releaseRunLock, getCounts } from "./lib/queries.ts";

const SCRIPTS_DIR = resolve(import.meta.dirname ?? ".");

interface StageResult {
  stage: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

function runStage(name: string, script: string): StageResult {
  const start = Date.now();
  try {
    const output = execSync(`cd "${SCRIPTS_DIR}" && tsx ${script}`, {
      encoding: "utf-8",
      timeout: 5 * 60 * 1000, // 5 min per stage
      env: process.env,
    });
    return { stage: name, ok: true, output: output.trim(), durationMs: Date.now() - start };
  } catch (err: any) {
    const output = err.stdout?.toString() ?? err.message;
    return { stage: name, ok: false, output: output.trim(), durationMs: Date.now() - start };
  }
}

function main() {
  const db = getDb();
  initSchema(db);

  if (!acquireRunLock("pipeline")) {
    console.log("Pipeline already running (lock held). Skipping.");
    closeDb();
    return;
  }

  console.log("Pipeline started.");
  const results: StageResult[] = [];

  try {
    // Ingestion
    results.push(runStage("ingest-reddit", "ingest-reddit.ts"));

    // Analysis
    results.push(runStage("extract-insights", "extract-insights.ts"));
    results.push(runStage("refresh-opportunities", "refresh-opportunities.ts"));
  } finally {
    releaseRunLock("pipeline");
  }

  // Report
  const counts = getCounts();
  console.log("\n--- Pipeline Results ---");
  for (const r of results) {
    const status = r.ok ? "OK" : "FAILED";
    const lastLine = r.output.split("\n").pop() ?? "";
    console.log(`  ${r.stage}: ${status} (${r.durationMs}ms) — ${lastLine}`);
  }
  console.log(`\nTotals: ${counts.source_items} sources, ${counts.insights} insights, ${counts.opportunities} opportunities, ${counts.runs_pending} pending runs`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length} stage(s) failed: ${failed.map((r) => r.stage).join(", ")}`);
  }

  closeDb();
}

main();
