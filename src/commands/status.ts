/**
 * /status command handler
 *
 * Shows current system status, running agents, and recent activity
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import { logger } from '../logger.js';
import { getAllTasks } from '../db.js';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show Atlas system status and active tasks')
    .addBooleanOption((option) =>
      option
        .setName('detailed')
        .setDescription('Show detailed information')
        .setRequired(false)
    ),

  async execute(
    interaction: ChatInputCommandInteraction,
    registeredGroups: Record<string, any>,
    activeContainers: Set<string>
  ) {
    const detailed = interaction.options.getBoolean('detailed') ?? false;

    try {
      await interaction.deferReply({ ephemeral: !detailed });

      // Get all registered groups (threads)
      const groups = Object.values(registeredGroups);
      const researchThreads = groups.filter((g: any) =>
        g.folder?.startsWith('thread-')
      );
      const controlGroup = groups.find((g: any) => g.isMain);

      // Get scheduled tasks
      const tasks = getAllTasks();
      const activeTasks = tasks.filter((t) => t.status === 'active');

      // Build status embed
      const embed = new EmbedBuilder()
        .setTitle('🤖 Atlas System Status')
        .setColor(0x5865f2)
        .setTimestamp()
        .addFields(
          {
            name: '📊 Overview',
            value:
              `**Active Threads:** ${researchThreads.length}\n` +
              `**Active Containers:** ${activeContainers.size}\n` +
              `**Scheduled Tasks:** ${activeTasks.length}`,
            inline: false,
          },
          {
            name: '🎯 Control Channel',
            value: controlGroup
              ? `✅ Registered (${controlGroup.name})`
              : '⚠️ Not registered',
            inline: true,
          },
          {
            name: '🔄 System Health',
            value: '✅ Operational',
            inline: true,
          }
        );

      if (detailed && activeContainers.size > 0) {
        const containerList = Array.from(activeContainers)
          .slice(0, 10)
          .map((name) => `• ${name}`)
          .join('\n');

        embed.addFields({
          name: '📦 Active Containers',
          value: containerList || 'None',
          inline: false,
        });
      }

      if (detailed && activeTasks.length > 0) {
        const taskList = activeTasks
          .slice(0, 5)
          .map(
            (t) =>
              `• **${t.schedule_type}**: ${t.prompt.slice(0, 50)}${t.prompt.length > 50 ? '...' : ''}`
          )
          .join('\n');

        embed.addFields({
          name: '⏰ Scheduled Tasks',
          value: taskList,
          inline: false,
        });
      }

      if (detailed && researchThreads.length > 0) {
        const threadList = researchThreads
          .slice(0, 5)
          .map((g: any) => `• ${g.name}`)
          .join('\n');

        embed.addFields({
          name: '🧵 Recent Threads',
          value: threadList || 'None',
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });

      logger.info(
        {
          user: interaction.user.tag,
          detailed,
          threadCount: researchThreads.length,
          containerCount: activeContainers.size,
        },
        'Status command executed'
      );
    } catch (err) {
      logger.error({ err }, 'Failed to get status');

      await interaction.editReply({
        content: `❌ Failed to retrieve status: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    }
  },
};
