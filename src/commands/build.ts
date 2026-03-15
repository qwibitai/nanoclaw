/**
 * /build command handler
 *
 * Creates a thread for spec iteration, then triggers autonomous build
 */

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { logger } from '../logger.js';

export const buildCommand = {
  data: new SlashCommandBuilder()
    .setName('build')
    .setDescription('Start an autonomous build project')
    .addStringOption((option) =>
      option
        .setName('description')
        .setDescription('Brief description of what to build')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction, onMessage: any) {
    const description = interaction.options.getString('description', true);

    try {
      if (!interaction.channel) {
        await interaction.reply({
          content: 'This command must be used in a channel.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      if (!('threads' in interaction.channel)) {
        await interaction.editReply('This command must be used in a text channel.');
        return;
      }

      // Create thread for this build
      const thread = await (interaction.channel as any).threads.create({
        name: `Build: ${description.slice(0, 80)}`,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `Build task initiated by ${interaction.user.tag}`,
      });

      logger.info(
        {
          threadId: thread.id,
          description,
          user: interaction.user.tag,
        },
        'Build thread created'
      );

      // Create action buttons for build workflow
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('show-spec')
          .setLabel('Show Spec')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('start-build')
          .setLabel('🚀 Start Build')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('cancel-build')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger)
      );

      // Send initial message to thread
      await thread.send({
        content:
          `🏗️ **Build Project Started**\n\n` +
          `**Project:** ${description}\n` +
          `**Initiated by:** ${interaction.user}\n\n` +
          `**Next Steps:**\n` +
          `1. Describe your requirements and we'll iterate on a CLAUDE.md spec\n` +
          `2. When ready, click "Start Build" to begin autonomous implementation\n\n` +
          `💡 *Tip: Be as specific as possible about requirements, tech stack preferences, and constraints.*`,
        components: [row],
      });

      await interaction.editReply({
        content: `✅ Build project started! Continue here: ${thread.url}`,
      });

      // Start iteration mode - the user will chat with Claude to refine the spec
      const initialPrompt = buildIterationPrompt(description);

      onMessage(thread.id, {
        id: `cmd-${Date.now()}`,
        chat_jid: thread.id,
        sender: interaction.user.id,
        sender_name: interaction.user.username,
        content: initialPrompt,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });
    } catch (err) {
      logger.error({ err, description }, 'Failed to create build thread');

      if (interaction.deferred) {
        await interaction.editReply({
          content: `❌ Failed to start build: ${err instanceof Error ? err.message : 'Unknown error'}`,
        });
      } else {
        await interaction.reply({
          content: `❌ Failed to start build: ${err instanceof Error ? err.message : 'Unknown error'}`,
          ephemeral: true,
        });
      }
    }
  },
};

function buildIterationPrompt(description: string): string {
  return `New build project: ${description}

Let's create a detailed specification together. Please help me understand:

1. What exactly should this project do? (core functionality)
2. Who is the intended user/audience?
3. Are there any specific technical requirements or preferences? (language, framework, database, etc.)
4. What constraints should I be aware of? (performance, compatibility, deployment target, etc.)
5. Are there any similar projects or examples you'd like me to reference?

I'll create a CLAUDE.md specification based on your answers. We can iterate on it until you're satisfied, then trigger the autonomous build.`;
}
