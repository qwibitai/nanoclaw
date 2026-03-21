/**
 * /run command handler
 *
 * Manually triggers a scheduled task by ID prefix.
 */

import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

import { getAllTasks } from '../db.js';
import { logger } from '../logger.js';
import { ScheduledTask } from '../types.js';

export type RunTaskFn = (task: ScheduledTask) => Promise<void>;

export const runCommand = {
  data: new SlashCommandBuilder()
    .setName('run')
    .setDescription('Manually trigger a scheduled task now')
    .addStringOption((o) =>
      o
        .setName('task_id')
        .setDescription('Task ID or prefix (from /status detailed)')
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction, runTask: RunTaskFn) {
    const prefix = interaction.options.getString('task_id', true).trim();

    await interaction.deferReply({ ephemeral: true });

    const tasks = getAllTasks().filter((t) => t.status === 'active');
    const match = tasks.find((t) => t.id.startsWith(prefix));

    if (!match) {
      await interaction.editReply(
        `❌ No active task found with ID starting with \`${prefix}\`.\nUse \`/status detailed\` to list task IDs.`,
      );
      return;
    }

    logger.info({ taskId: match.id, prefix }, 'Manual task trigger');

    await interaction.editReply(
      `▶️ **Running task \`${match.id.slice(0, 8)}\`**\n` +
        `**Schedule:** \`${match.schedule_value}\`\n` +
        `**Topic:** ${match.prompt.slice(0, 80)}${match.prompt.length > 80 ? '…' : ''}\n\n` +
        `Output will be posted to the task's target channel.`,
    );

    // Fire and forget — result goes to the task's chat_jid like a normal run
    runTask(match).catch((err) => {
      logger.error({ taskId: match.id, err }, 'Manual task run failed');
    });
  },
};
