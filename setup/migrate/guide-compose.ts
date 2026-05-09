/**
 * Compose `.nanoclaw-migrations/guide.md` from extracted v1 state.
 *
 * The guide is the durable human + Claude-readable record of the migration
 * plan. The sequencer can write this between extract and worktree so the
 * user has a checkpoint before any v2 state is touched.
 */

import fs from 'fs';
import path from 'path';

import type { V1ExtractResult } from './extract-v1.js';

export function composeGuide(ex: V1ExtractResult): string {
  const owner = ex.ownerProposal.userId ?? '(unresolved — will prompt)';
  const now = new Date().toISOString();

  const sections: string[] = [
    `# NanoClaw v1→v2 Migration Guide`,
    ``,
    `Generated: ${now}`,
    `v1 root: \`${ex.v1Root}\``,
    `v1 HEAD: \`${ex.gitHead || 'unknown'}\``,
    `Owner: \`${owner}\` (confidence: ${ex.ownerProposal.confidence}, source: ${ex.ownerProposal.source})`,
    ``,
    `---`,
    ``,
    `## Seed plan`,
    ``,
    seedPlanTables(ex),
    ``,
    `## Skills to install (in order)`,
    ``,
    skillsToInstall(ex),
    ``,
    `## Reapply-as-is`,
    ``,
    `- Non-secret \`.env\` keys (already captured in \`v1-data/env.json\`)`,
    `- \`groups/<folder>/CLAUDE.md\` → v2 \`groups/<folder>/CLAUDE.local.md\` (v2 regenerates \`CLAUDE.md\` at spawn; per-group agent memory lives in \`.local.md\`)`,
    `- User-authored skills under \`.claude/skills/\`: ${ex.userAuthoredSkillDirs.length > 0 ? ex.userAuthoredSkillDirs.map((d) => `\`${d}\``).join(', ') : '_(none)_'}`,
    ``,
    `## Translate`,
    ``,
    translatedNotes(ex),
    ``,
    `## Rebuild`,
    ``,
    rebuildSection(ex),
    ``,
    `## Deferred`,
    ``,
    deferredSection(ex),
    ``,
    `## Dropped`,
    ``,
    `Customizations targeting v1-only surfaces (IPC, credential-proxy, monolithic \`src/db.ts\`, \`task-scheduler.ts\`, pino) do not survive the migration. Review \`v1-data/git-customizations.json\` and re-express any surviving intent against v2's module system (see docs/module-contract.md).`,
    ``,
    `## Rollback`,
    ``,
    `After the swap, the pre-migration state is preserved at:`,
    ``,
    `- Git tag \`pre-v2-<hash>-<ts>\` (restore code with \`git reset --hard <tag>\`)`,
    `- \`store.v1-backup/\` (restore v1 DB with \`mv store.v1-backup store\`)`,
    `- \`data/ipc.v1-backup/\` (restore v1 IPC with \`mv data/ipc.v1-backup data/ipc\`)`,
    ``,
    `Delete \`data/v2.db\` after restoring to drop the v2 central state.`,
    ``,
  ];

  return sections.join('\n');
}

export function writeGuide(ex: V1ExtractResult): string {
  const outPath = path.join(ex.v1Root, '.nanoclaw-migrations', 'guide.md');
  fs.writeFileSync(outPath, composeGuide(ex));
  return outPath;
}

// ── section builders ──

function seedPlanTables(ex: V1ExtractResult): string {
  const rows: string[] = [];
  const folders = new Set<string>();
  for (const g of ex.registeredGroups) folders.add(g.folder);

  rows.push(`**Agent groups** (${folders.size}):`);
  rows.push('');
  for (const folder of folders) {
    const name = ex.registeredGroups.find((g) => g.folder === folder)?.name ?? folder;
    rows.push(`- \`${folder}\` — ${name}`);
  }
  rows.push('');
  rows.push(`**Messaging groups + wirings** (${ex.registeredGroups.length}):`);
  rows.push('');
  rows.push('| channel_type | platform_id | folder | engage_mode | engage_pattern |');
  rows.push('|---|---|---|---|---|');
  for (const g of ex.registeredGroups) {
    const { engage_mode, engage_pattern } = deriveEngage(g);
    rows.push(
      `| ${g.inferred_channel_type || '**UNKNOWN**'} | \`${g.jid}\` | \`${g.folder}\` | ${engage_mode} | ${engage_pattern ? `\`${engage_pattern}\`` : '—'} |`,
    );
  }

  if (ex.unknownJids.length > 0) {
    rows.push('');
    rows.push(`> ⚠ ${ex.unknownJids.length} JID(s) could not be classified — edit \`v1-data/registered-groups.json\` before seeding.`);
  }
  return rows.join('\n');
}

function skillsToInstall(ex: V1ExtractResult): string {
  if (ex.requiredChannelSkills.length === 0 && ex.appliedSkillMerges.length === 0) {
    return '_(none)_';
  }
  const lines: string[] = [];
  lines.push('**Channel skills** (required by seed — the seeder fails if missing):');
  lines.push('');
  if (ex.requiredChannelSkills.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const s of ex.requiredChannelSkills) lines.push(`- [ ] \`${s}\``);
  }

  const nonChannel = ex.appliedSkillMerges.filter(
    (m) => m.v2_install && !ex.requiredChannelSkills.includes(m.v2_install),
  );
  if (nonChannel.length > 0) {
    lines.push('');
    lines.push('**Other previously-applied skills:**');
    lines.push('');
    for (const m of nonChannel) lines.push(`- [ ] \`${m.v2_install}\` (was \`${m.branch}\`)`);
  }
  return lines.join('\n');
}

function translatedNotes(ex: V1ExtractResult): string {
  const lines: string[] = [];
  lines.push('- **Triggers** (v1 global `TRIGGER_PATTERN` → per-wiring `engage_mode` + `engage_pattern`) — seeded automatically');
  lines.push('- **Container configs** (v1 `registered_groups.container_config` column → `groups/<folder>/container.json`) — seeded automatically');
  const hasExplicitAllow = ex.senderAllowlist?.chats && Object.keys(ex.senderAllowlist.chats).length > 0;
  if (hasExplicitAllow) {
    lines.push('- **Sender allowlist explicit entries** → `users` + `agent_group_members` rows — seeded automatically');
  } else {
    lines.push('- **Sender allowlist** was wildcard (`"*"`) or absent — no member rows seeded; set `unknown_sender_policy` per messaging group to control access');
  }
  lines.push('- **Owner + admin** (`users(role=owner)` + `NANOCLAW_ADMIN_USER_IDS`) — seeded automatically from `owner.json`');
  return lines.join('\n');
}

function rebuildSection(ex: V1ExtractResult): string {
  if (ex.customizedFiles.length === 0) {
    return '_No user-authored source customizations detected._';
  }
  const lines: string[] = [
    `Files changed since the v1 merge base (${ex.customizedFiles.length}). The sequencer offers a Claude handoff at the \`rebuild\` step so you can walk these through interactively:`,
    '',
  ];
  const hot = ex.customizedFiles
    .slice()
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, 20);
  for (const f of hot) {
    lines.push(`- \`${f.path}\` (+${f.additions} / -${f.deletions})`);
  }
  if (ex.customizedFiles.length > hot.length) {
    lines.push(`- … and ${ex.customizedFiles.length - hot.length} more (see \`v1-data/git-customizations.json\`)`);
  }
  return lines.join('\n');
}

function deferredSection(ex: V1ExtractResult): string {
  const lines: string[] = [];
  if (ex.scheduledTasks.length > 0) {
    lines.push(
      `**${ex.scheduledTasks.length} scheduled task(s)** live in \`v1-data/scheduled-tasks.json\`. ` +
        `v2 stores tasks in per-session \`messages_in\` rows, not the central DB — ` +
        `they can't be seeded directly. After first DM contact with the agent, paste the list so it can call its scheduling tool.`,
    );
  }
  if (ex.chatRowCount > 0) {
    lines.push(
      `**${ex.chatRowCount} chat metadata row(s)** from v1 are not migrated — v2 doesn't keep a central \`chats\` table. ` +
        `The v1 DB is preserved at \`store.v1-backup/messages.db\` if you need to extract history separately.`,
    );
  }
  if (lines.length === 0) return '_(nothing deferred)_';
  return lines.join('\n\n');
}

function deriveEngage(g: {
  trigger_pattern: string;
  requires_trigger: number;
}): { engage_mode: string; engage_pattern: string | null } {
  if (g.trigger_pattern) return { engage_mode: 'pattern', engage_pattern: g.trigger_pattern };
  if (g.requires_trigger === 0) return { engage_mode: 'pattern', engage_pattern: '.' };
  return { engage_mode: 'mention', engage_pattern: null };
}
