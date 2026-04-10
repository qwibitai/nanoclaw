#!/usr/bin/env node

/**
 * Weekly prompt & repo health review.
 *
 * Checks:
 * 1. Token budgets on all prompt files (CLAUDE.md + SKILL.md)
 * 2. Reference file integrity — /workspace/ pointers resolve to real files
 * 3. Upstream commits pending merge
 *
 * Exit 0 always (report, don't fail). Output is markdown suitable for
 * sending to a channel or DM.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { encodingForModel } from 'js-tiktoken';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const GROUPS_DIR = join(ROOT, 'groups');
const CONTAINER_SKILLS = join(ROOT, 'container', 'skills');
const DB_PATH = join(ROOT, 'store', 'messages.db');

const BUDGETS = {
  globalClaudeMd: 750,
  groupClaudeMd: 1_000,
  containerSkill: 800,
};

const enc = encodingForModel('gpt-4o');
const tokenCount = (p) => enc.encode(readFileSync(p, 'utf8')).length;

const issues = [];
const stats = { filesChecked: 0, refsChecked: 0 };

// ── 1. Token budgets ───────────────────────────────────────────────

function checkBudgets() {
  // Global CLAUDE.md
  const globalMd = join(GROUPS_DIR, 'global', 'CLAUDE.md');
  if (existsSync(globalMd)) {
    stats.filesChecked++;
    const t = tokenCount(globalMd);
    if (t > BUDGETS.globalClaudeMd)
      issues.push(`**Over budget:** global/CLAUDE.md — ${t}/${BUDGETS.globalClaudeMd} tokens`);
  }

  // Per-group CLAUDE.md
  for (const dir of readdirSync(GROUPS_DIR)) {
    if (dir === 'global') continue;
    const claudeMd = join(GROUPS_DIR, dir, 'CLAUDE.md');
    if (!existsSync(claudeMd)) continue;
    stats.filesChecked++;
    const t = tokenCount(claudeMd);
    if (t > BUDGETS.groupClaudeMd)
      issues.push(`**Over budget:** ${dir}/CLAUDE.md — ${t}/${BUDGETS.groupClaudeMd} tokens`);
  }

  // Container skills
  if (existsSync(CONTAINER_SKILLS)) {
    for (const dir of readdirSync(CONTAINER_SKILLS)) {
      const skillMd = join(CONTAINER_SKILLS, dir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      stats.filesChecked++;
      const t = tokenCount(skillMd);
      if (t > BUDGETS.containerSkill)
        issues.push(`**Over budget:** ${dir}/SKILL.md — ${t}/${BUDGETS.containerSkill} tokens`);
    }
  }
}

// ── 2. Reference file integrity ────────────────────────────────────

function checkRefs() {
  const workspacePattern = /\/workspace\/(group|global)\/([^\s)"`]+)/g;

  const checkFile = (filePath, groupDir) => {
    const content = readFileSync(filePath, 'utf8');
    let match;
    while ((match = workspacePattern.exec(content)) !== null) {
      stats.refsChecked++;
      const scope = match[1]; // 'group' or 'global'
      const relPath = match[2];

      // /workspace/group/ → the group's own directory
      // /workspace/global/ → groups/global/
      const resolvedDir =
        scope === 'global' ? join(GROUPS_DIR, 'global') : groupDir;
      const resolved = join(resolvedDir, relPath);

      if (!existsSync(resolved)) {
        const short = filePath.replace(ROOT + '/', '');
        issues.push(`**Broken ref:** ${short} → /workspace/${scope}/${relPath} (file missing)`);
      }
    }
  };

  // Check all CLAUDE.md files
  for (const dir of readdirSync(GROUPS_DIR)) {
    const claudeMd = join(GROUPS_DIR, dir, 'CLAUDE.md');
    if (!existsSync(claudeMd)) continue;
    checkFile(claudeMd, join(GROUPS_DIR, dir));
  }

  // Container skill /workspace/ paths only resolve inside containers — skip ref checks
}

// ── 3. Upstream sync ───────────────────────────────────────────────

function checkUpstream() {
  try {
    execSync('git fetch upstream --quiet 2>/dev/null', { cwd: ROOT });
    const log = execSync(
      'git log HEAD..upstream/main --oneline --no-decorate 2>/dev/null',
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();

    if (log) {
      const commits = log.split('\n');
      const preview = commits.slice(0, 10).join('\n');
      const more = commits.length > 10 ? `\n… and ${commits.length - 10} more` : '';
      issues.push(
        `**Upstream behind:** ${commits.length} commit(s) pending merge from upstream/main:\n\`\`\`\n${preview}${more}\n\`\`\``
      );
    }
  } catch {
    issues.push('**Upstream check failed** — could not fetch upstream remote');
  }
}

// ── 4. Token usage ─────────────────────────────────────────────────

let usageReport = '';

function checkTokenUsage() {
  if (!existsSync(DB_PATH)) return;

  try {
    const db = new Database(DB_PATH, { readonly: true });

    // Check if table exists
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'")
      .get();
    if (!tableExists) {
      db.close();
      return;
    }

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT group_folder,
                SUM(input_tokens) as total_input,
                SUM(output_tokens) as total_output,
                SUM(cache_read_input_tokens) as total_cache_read,
                SUM(cost_usd) as total_cost,
                COUNT(*) as runs
         FROM token_usage
         WHERE timestamp >= ?
         GROUP BY group_folder
         ORDER BY total_cost DESC`,
      )
      .all(weekAgo);

    if (rows.length === 0) {
      db.close();
      return;
    }

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalRuns = 0;

    const lines = rows.map((r) => {
      totalCost += r.total_cost;
      totalInput += r.total_input;
      totalOutput += r.total_output;
      totalRuns += r.runs;
      const name = r.group_folder.replace(/^discord_/, '');
      return `  ${name}: ${r.runs} runs · ${fmt(r.total_input)}in/${fmt(r.total_output)}out · $${r.total_cost.toFixed(2)}`;
    });

    usageReport = `\n**Token usage (7d):** ${totalRuns} runs · ${fmt(totalInput)}in/${fmt(totalOutput)}out · **$${totalCost.toFixed(2)}**\n${lines.join('\n')}`;
    db.close();
  } catch {
    // DB not available or schema mismatch — skip silently
  }
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── 5. Task health ────────────────────────────────────────────────

let taskReport = '';

function checkTaskHealth() {
  if (!existsSync(DB_PATH)) return;

  try {
    const db = new Database(DB_PATH, { readonly: true });

    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'")
      .get();
    if (!tableExists) {
      db.close();
      return;
    }

    const active = db
      .prepare("SELECT id, schedule_type, schedule_value, script, group_folder, last_result FROM scheduled_tasks WHERE status = 'active'")
      .all();

    if (active.length === 0) {
      db.close();
      return;
    }

    let gated = 0;
    let ungated = 0;
    let subDailyUngated = [];
    let errored = [];

    for (const t of active) {
      const hasScript = !!(t.script && t.script.trim());
      if (hasScript) {
        gated++;
      } else {
        ungated++;
      }

      // Flag sub-daily tasks without gates (shouldn't exist after enforcement,
      // but catches manually-inserted or legacy tasks)
      if (!hasScript && t.schedule_type !== 'once') {
        const isSubDaily = t.schedule_type === 'interval' ||
          (t.schedule_type === 'cron' && /\*\/\d|,/.test(t.schedule_value));
        if (isSubDaily) {
          subDailyUngated.push(`${t.id} (${t.schedule_value})`);
        }
      }

      // Flag tasks with recent errors
      if (t.last_result && t.last_result.startsWith('Error:')) {
        const name = t.group_folder.replace(/^discord_/, '');
        errored.push(`${name}/${t.id}: ${t.last_result.slice(0, 80)}`);
      }
    }

    const lines = [`\n**Task health:** ${active.length} active (${gated} gated, ${ungated} ungated)`];

    if (subDailyUngated.length > 0) {
      issues.push(`**Ungated sub-daily tasks:** ${subDailyUngated.join(', ')}`);
    }

    if (errored.length > 0) {
      lines.push(`⚠️ Tasks with errors:\n${errored.map(e => `  ${e}`).join('\n')}`);
    }

    // Gate script failures from run logs (last 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const gateRunsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_run_logs'")
      .get();
    if (gateRunsTable) {
      const gateFailRows = db
        .prepare(
          `SELECT trl.task_id, st.group_folder, COUNT(*) as fail_count
           FROM task_run_logs trl
           JOIN scheduled_tasks st ON st.id = trl.task_id
           WHERE trl.run_at >= ?
             AND st.script IS NOT NULL AND st.script != ''
             AND trl.error IS NOT NULL
           GROUP BY trl.task_id
           ORDER BY fail_count DESC`,
        )
        .all(weekAgo);

      if (gateFailRows.length > 0) {
        const gateLines = gateFailRows.map((r) => {
          const name = r.group_folder.replace(/^discord_/, '');
          return `  ${name}/${r.task_id}: ${r.fail_count} failures`;
        });
        issues.push(
          `**Gate script failures (7d):**\n${gateLines.join('\n')}`,
        );
      }

      // Also flag gated tasks where every recent run was "Gate: script error"
      const allGateSkipped = db
        .prepare(
          `SELECT id, group_folder, last_result FROM scheduled_tasks
           WHERE status = 'active'
             AND script IS NOT NULL AND script != ''
             AND last_result LIKE 'Gate: script error%'`,
        )
        .all();
      if (allGateSkipped.length > 0) {
        for (const t of allGateSkipped) {
          const name = t.group_folder.replace(/^discord_/, '');
          issues.push(`**Gate stuck:** ${name}/${t.id} — last result: ${t.last_result}`);
        }
      }
    }

    // Schedule summary by group
    const byGroup = {};
    for (const t of active) {
      const name = t.group_folder.replace(/^discord_/, '');
      if (!byGroup[name]) byGroup[name] = [];
      const gate = t.script ? '🔒' : '  ';
      byGroup[name].push(`${gate} ${t.schedule_type}(${t.schedule_value})`);
    }
    lines.push('Schedule summary:');
    for (const [group, schedules] of Object.entries(byGroup).sort()) {
      lines.push(`  ${group}: ${schedules.join(', ')}`);
    }

    taskReport = lines.join('\n');
    db.close();
  } catch {
    // DB not available or schema mismatch — skip silently
  }
}

// ── Run ────────────────────────────────────────────────────────────

checkBudgets();
checkRefs();
checkUpstream();
checkTokenUsage();
checkTaskHealth();

const now = new Date().toLocaleDateString('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

if (issues.length === 0) {
  console.log(
    `**Weekly Review — ${now}**\n✅ All clear. ${stats.filesChecked} files checked, ${stats.refsChecked} refs validated, upstream in sync.${usageReport}${taskReport}`,
  );
} else {
  console.log(
    `**Weekly Review — ${now}**\n${stats.filesChecked} files checked, ${stats.refsChecked} refs validated.\n\n${issues.map((i) => `- ${i}`).join('\n')}${usageReport}${taskReport}`,
  );
}
