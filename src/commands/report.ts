/**
 * /report command handler
 *
 * Schedules recurring research briefings posted to a Discord channel.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ChannelType,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';

import { RESEARCH_SYSTEM_PROMPT } from '../agents/research-prompt.js';
import { TIMEZONE } from '../config.js';
import { createTask } from '../db.js';
import { logger } from '../logger.js';
import { computeNextRun } from '../task-scheduler.js';
import { RegisteredGroup } from '../types.js';

// Map schedule + time choices to cron expressions (uses TIMEZONE via scheduler)
function buildCron(schedule: string, hour: number): string {
  switch (schedule) {
    case 'daily':
      return `0 ${hour} * * *`;
    case 'weekdays':
      return `0 ${hour} * * 1-5`;
    case 'weekly-mon':
      return `0 ${hour} * * 1`;
    case 'weekly-fri':
      return `0 ${hour} * * 5`;
    case 'twice-daily':
      return `0 ${hour},${hour + 12 > 23 ? hour : hour + 12} * * *`;
    default:
      return `0 ${hour} * * *`;
  }
}

export const reportCommand = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Schedule a recurring research briefing to a channel')
    .addStringOption((o) =>
      o
        .setName('topic')
        .setDescription(
          'What to research and report on (e.g. "LLM development updates")',
        )
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName('schedule')
        .setDescription('How often to run')
        .setRequired(true)
        .addChoices(
          { name: 'Daily', value: 'daily' },
          { name: 'Weekdays (Mon–Fri)', value: 'weekdays' },
          { name: 'Weekly on Monday', value: 'weekly-mon' },
          { name: 'Weekly on Friday', value: 'weekly-fri' },
          { name: 'Twice daily', value: 'twice-daily' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('time')
        .setDescription('Time to deliver the report')
        .setRequired(true)
        .addChoices(
          { name: '6 AM', value: '6' },
          { name: '7 AM', value: '7' },
          { name: '8 AM', value: '8' },
          { name: '9 AM', value: '9' },
          { name: '10 AM', value: '10' },
          { name: '12 PM', value: '12' },
          { name: '3 PM', value: '15' },
          { name: '6 PM', value: '18' },
        ),
    )
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription(
          'Channel to post reports in (defaults to current channel)',
        )
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    ),

  async execute(
    interaction: ChatInputCommandInteraction,
    onRegisterGroup: (jid: string, group: RegisteredGroup) => void,
    registeredGroups: () => Record<string, RegisteredGroup>,
  ) {
    const topic = interaction.options.getString('topic', true);
    const schedule = interaction.options.getString('schedule', true);
    const hour = parseInt(interaction.options.getString('time', true), 10);
    const targetChannel =
      interaction.options.getChannel('channel') ?? interaction.channel;

    if (!targetChannel) {
      await interaction.reply({
        content: 'Could not resolve target channel.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const channelId = targetChannel.id;
      const cron = buildCron(schedule, hour);

      // Build a readable folder name from the topic
      const slug = topic
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const suffix = channelId.slice(-6);
      const folder = `report_${slug}-${suffix}`;

      // Register the channel as a group if needed, and write CLAUDE.md
      if (!registeredGroups()[channelId]) {
        const groupDir = path.join(process.cwd(), 'groups', folder);
        fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
        fs.writeFileSync(
          path.join(groupDir, 'CLAUDE.md'),
          RESEARCH_SYSTEM_PROMPT,
        );

        onRegisterGroup(channelId, {
          name:
            ('name' in targetChannel ? targetChannel.name : null) ??
            `report-${suffix}`,
          folder,
          trigger: `@Atlas`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: false,
        });
      }

      // Create the scheduled task
      const taskId = crypto.randomUUID();
      const isJobTopic =
        /\b(job|jobs|hiring|openings?|positions?|roles?|careers?|salary|salaries|recruit)\b/i.test(
          topic,
        );

      const prompt = isJobTopic
        ? `You are writing a recurring job market briefing. Topic: "${topic}"

Research current job openings and write the briefing directly as your response — do not write to a file.

Use this exact format:

# 💼 Job Radar — {{DATE}}

---

> **⭐ Top Pick**
> **{{TITLE}}** @ {{COMPANY}}
> 📍 {{LOCATION or REMOTE}} · 💰 {{SALARY RANGE if available}}
> {{2-3 sentences on why this role stands out and what makes it a strong fit}}

---

### Fresh Listings

▸ **{{TITLE}}** @ {{COMPANY}} — {{REMOTE or LOCATION}}
  \`{{KEY_SKILL_1}}\` \`{{KEY_SKILL_2}}\` \`{{KEY_SKILL_3}}\`

▸ **{{TITLE}}** @ {{COMPANY}} — {{REMOTE or LOCATION}}
  \`{{KEY_SKILL_1}}\` \`{{KEY_SKILL_2}}\` \`{{KEY_SKILL_3}}\`

▸ **{{TITLE}}** @ {{COMPANY}} — {{REMOTE or LOCATION}}
  \`{{KEY_SKILL_1}}\` \`{{KEY_SKILL_2}}\` \`{{KEY_SKILL_3}}\`

▸ **{{TITLE}}** @ {{COMPANY}} — {{REMOTE or LOCATION}}
  \`{{KEY_SKILL_1}}\` \`{{KEY_SKILL_2}}\` \`{{KEY_SKILL_3}}\`

▸ **{{TITLE}}** @ {{COMPANY}} — {{REMOTE or LOCATION}}
  \`{{KEY_SKILL_1}}\` \`{{KEY_SKILL_2}}\` \`{{KEY_SKILL_3}}\`

---

### Market Pulse

\`📊\` {{1-2 sentences on hiring trends — which sectors are active, what skills keep appearing}}

---

### 🎯 Move Today

> {{One specific action — apply to X, reach out to Y, update Z on your resume}}

---
*Atlas · Titan · {{TIMESTAMP}}*

Rules:
- Replace every {{placeholder}} with real data — never output literal braces
- Skip roles older than 2 weeks
- Omit the 💰 line entirely if salary is not publicly listed — do not guess
- Key skills: pull from the actual job description
- Top Pick: the single strongest match for an AI/ML engineer in Colorado`
        : `You are writing a recurring research briefing. Topic: "${topic}"

Research the latest developments and write the briefing directly as your response — do not write to a file.

Use this exact format:

# 🤖 AI Intel — {{DATE}}

---

> **🔥 Lead Story**
> {{HEADLINE}}
> {{2-3 sentence summary with why it matters}}

---

### Developments

▸ **{{HEADLINE_2}}**
{{1-2 sentence summary}}

▸ **{{HEADLINE_3}}**
{{1-2 sentence summary}}

▸ **{{HEADLINE_4}}**
{{1-2 sentence summary}}

▸ **{{HEADLINE_5}}**
{{1-2 sentence summary}}

---

### Open Source & Tools
▸ {{REPO or TOOL 1}} — {{what it does, why it matters}}
▸ {{REPO or TOOL 2}} — {{what it does, why it matters}}

---

\`🧭 So What:\` {{2-3 sentences connecting the dots — what pattern or shift to pay attention to this week}}

---
*Atlas · Titan · {{TIMESTAMP}}*

Rules:
- Replace every {{placeholder}} with real data — never output literal braces
- Lead Story: the single most impactful development this cycle
- Developments: 4 items, varied sources, no overlap with Lead Story
- Open Source & Tools: real repos or released tools only, skip vaporware
- So What: synthesis not summary — connect the trends, name the shift`;

      const group = registeredGroups()[channelId]!;
      const taskBase = {
        id: taskId,
        group_folder: group.folder,
        chat_jid: channelId,
        prompt,
        schedule_type: 'cron' as const,
        schedule_value: cron,
        context_mode: 'isolated' as const,
        next_run: null as string | null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
        last_run: null,
        last_result: null,
      };

      taskBase.next_run = computeNextRun(taskBase);
      createTask(taskBase);

      const scheduleLabels: Record<string, string> = {
        daily: 'Daily',
        weekdays: 'Weekdays (Mon–Fri)',
        'weekly-mon': 'Weekly on Monday',
        'weekly-fri': 'Weekly on Friday',
        'twice-daily': 'Twice daily',
      };

      const nextRun = taskBase.next_run
        ? new Date(taskBase.next_run!).toLocaleString('en-US', {
            timeZone: TIMEZONE,
          })
        : 'unknown';

      logger.info({ taskId, topic, cron, channelId }, 'Report scheduled');

      await interaction.editReply(
        `✅ **Report scheduled**\n\n` +
          `**Topic:** ${topic}\n` +
          `**Schedule:** ${scheduleLabels[schedule]} at ${targetChannel}\n` +
          `**Cadence:** \`${cron}\` (${TIMEZONE})\n` +
          `**Next run:** ${nextRun}\n` +
          `**Task ID:** \`${taskBase.id}\`\n\n` +
          `Use \`/status detailed\` to manage scheduled tasks.`,
      );
    } catch (err) {
      logger.error({ err, topic }, 'Failed to schedule report');
      await interaction.editReply(
        `❌ Failed to schedule report: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  },
};
