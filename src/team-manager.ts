import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  model: string;
  prompt: string;
  color: string;
  process?: ChildProcess;
  inboxPath: string;
  outputPath: string;
}

export interface TeamConfig {
  name: string;
  description: string;
  members: TeamMember[];
  createdAt: number;
}

export class TeamManager {
  private teams: Map<string, TeamConfig> = new Map();
  private teamDir: string;
  private pollingInterval: NodeJS.Timeout | null = null;
  private sendMessage?: (text: string) => Promise<void>;

  constructor(teamDir: string, sendMessage?: (text: string) => Promise<void>) {
    this.teamDir = teamDir;
    this.sendMessage = sendMessage;
    this.loadTeams();
  }

  /**
   * Load all teams from disk
   */
  private loadTeams(): void {
    if (!fs.existsSync(this.teamDir)) {
      fs.mkdirSync(this.teamDir, { recursive: true });
      return;
    }

    const teamFolders = fs.readdirSync(this.teamDir);

    for (const folder of teamFolders) {
      const configPath = path.join(this.teamDir, folder, 'config.json');

      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

          // Set inbox and output paths for each member
          config.members = config.members.map((member: any) => ({
            ...member,
            inboxPath: path.join(this.teamDir, folder, 'inboxes', `${member.name}.json`),
            outputPath: path.join(this.teamDir, folder, 'outputs', `${member.name}.json`),
          }));

          this.teams.set(config.name, config);
          logger.info({ teamName: config.name, members: config.members.length }, 'Team loaded');
        } catch (err) {
          logger.error({ err, configPath }, 'Failed to load team config');
        }
      }
    }
  }

  /**
   * Start all team members as background processes
   */
  async startAllTeams(): Promise<void> {
    for (const [teamName, config] of this.teams) {
      await this.startTeam(teamName);
    }

    // Start inbox polling
    this.startPolling();
  }

  /**
   * Start a specific team
   */
  async startTeam(teamName: string): Promise<void> {
    const team = this.teams.get(teamName);
    if (!team) {
      logger.error({ teamName }, 'Team not found');
      return;
    }

    logger.info({ teamName, members: team.members.length }, 'Starting team');

    for (const member of team.members) {
      // Skip team lead (that's us)
      if (member.name === 'team-lead') continue;

      await this.startTeamMember(teamName, member);
    }
  }

  /**
   * Start a single team member as background process
   */
  private async startTeamMember(teamName: string, member: TeamMember): Promise<void> {
    // Create inbox file if it doesn't exist
    const inboxDir = path.dirname(member.inboxPath);
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    if (!fs.existsSync(member.inboxPath)) {
      fs.writeFileSync(member.inboxPath, JSON.stringify({ messages: [] }, null, 2));
    }

    // Create output directory
    const outputDir = path.dirname(member.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    logger.info({ teamName, memberName: member.name }, 'Team member started (inbox monitoring)');
  }

  /**
   * Start polling all team member inboxes
   */
  private startPolling(): void {
    if (this.pollingInterval) return;

    this.pollingInterval = setInterval(() => {
      this.pollAllInboxes();
    }, 5000); // Poll every 5 seconds

    logger.info('Team inbox polling started');
  }

  /**
   * Poll all team member inboxes for new messages
   */
  private async pollAllInboxes(): Promise<void> {
    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        // Skip team lead
        if (member.name === 'team-lead') continue;

        await this.checkMemberInbox(teamName, member);
      }
    }
  }

  /**
   * Check a team member's inbox for new messages
   */
  private async checkMemberInbox(teamName: string, member: TeamMember): Promise<void> {
    try {
      if (!fs.existsSync(member.inboxPath)) return;

      const inboxData = JSON.parse(fs.readFileSync(member.inboxPath, 'utf-8'));
      const unreadMessages = inboxData.messages?.filter((msg: any) => !msg.read) || [];

      if (unreadMessages.length === 0) return;

      logger.info({
        teamName,
        memberName: member.name,
        unreadCount: unreadMessages.length
      }, 'Processing inbox messages');

      // Mark all as read and save BEFORE processing (prevents duplicate spawning on next poll)
      for (const message of unreadMessages) {
        message.read = true;
      }
      fs.writeFileSync(member.inboxPath, JSON.stringify(inboxData, null, 2));

      // Process each message after marking read
      for (const message of unreadMessages) {
        await this.processMessage(teamName, member, message);
      }

    } catch (err) {
      logger.error({ err, memberName: member.name }, 'Failed to check inbox');
    }
  }

  /**
   * Process a message by executing the team member's task
   */
  private async processMessage(teamName: string, member: TeamMember, message: any): Promise<void> {
    logger.info({
      teamName,
      memberName: member.name,
      messageFrom: message.from,
      summary: message.summary
    }, 'Processing message');

    // Create a prompt that includes the member's role and the task
    const fullPrompt = `${member.prompt}

You have received a message:

From: ${message.from}
Summary: ${message.summary}

Message:
${message.content}

Please analyze this and provide a detailed response.`;

    // Execute as a container agent (similar to how messages are processed)
    const { runContainerAgent } = await import('./container-runner.js');

    try {
      // Create a fake group for the team
      const group = {
        name: teamName,
        folder: 'main',
        trigger: '@team',
        added_at: new Date().toISOString(),
      };

      const input = {
        chatJid: `team:${teamName}:${member.name}`,
        prompt: fullPrompt,
        groupFolder: 'main',
        isMain: false,
      };

      const result = await runContainerAgent(
        group as any,
        input,
        () => {}, // onProcess callback
      );

      // Save output
      const output = {
        messageId: message.id,
        timestamp: new Date().toISOString(),
        result: result.result,
        status: result.status,
      };

      fs.writeFileSync(member.outputPath, JSON.stringify(output, null, 2));

      // Send response back to team lead
      if (result.result) {
        await this.sendResponseToLead(teamName, member.name, message.from, result.result);

        // Notify via WhatsApp
        if (this.sendMessage) {
          const memberLabel = member.name.replace(/-/g, ' ');
          await this.sendMessage(`[${memberLabel}]\n${result.result}`);
        }
      }

      logger.info({
        teamName,
        memberName: member.name,
        status: result.status
      }, 'Message processed successfully');

    } catch (err) {
      logger.error({ err, memberName: member.name }, 'Failed to process message');
    }
  }

  /**
   * Send response from team member back to team lead
   */
  private async sendResponseToLead(
    teamName: string,
    fromMember: string,
    toMember: string,
    content: string
  ): Promise<void> {
    const team = this.teams.get(teamName);
    if (!team) return;

    // Find team lead's inbox
    const leadMember = team.members.find(m => m.name === toMember);
    if (!leadMember) return;

    // Add message to lead's inbox
    let inboxData: any = { messages: [] };
    if (fs.existsSync(leadMember.inboxPath)) {
      inboxData = JSON.parse(fs.readFileSync(leadMember.inboxPath, 'utf-8'));
    }

    inboxData.messages.push({
      id: Date.now().toString(),
      from: fromMember,
      to: toMember,
      content,
      timestamp: new Date().toISOString(),
      read: false,
    });

    fs.writeFileSync(leadMember.inboxPath, JSON.stringify(inboxData, null, 2));

    logger.info({
      teamName,
      from: fromMember,
      to: toMember,
      contentLength: content.length
    }, 'Response sent to team lead');
  }

  /**
   * Stop all teams
   */
  async stopAllTeams(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        if (member.process) {
          member.process.kill();
          logger.info({ teamName, memberName: member.name }, 'Team member stopped');
        }
      }
    }

    logger.info('All teams stopped');
  }

  /**
   * Get all team data for dashboard display
   */
  getAllTeamData(): Array<{
    name: string;
    description: string;
    createdAt: number;
    memberCount: number;
    members: Array<{
      name: string;
      agentType: string;
      model: string;
      color: string;
      unreadCount: number;
      totalMessages: number;
      lastActivity: string | null;
    }>;
    recentMessages: Array<{
      from: string;
      to: string;
      summary: string;
      timestamp: string;
      read: boolean;
    }>;
  }> {
    const result: ReturnType<TeamManager['getAllTeamData']> = [];

    for (const [, config] of this.teams) {
      const members: typeof result[number]['members'] = [];
      const allMessages: Array<{ from: string; to: string; content: string; summary: string; timestamp: string; read: boolean }> = [];

      for (const member of config.members) {
        let unreadCount = 0;
        let totalMessages = 0;
        let lastActivity: string | null = null;

        if (fs.existsSync(member.inboxPath)) {
          try {
            const inboxData = JSON.parse(fs.readFileSync(member.inboxPath, 'utf-8'));
            const msgs = inboxData.messages || [];
            totalMessages = msgs.length;
            unreadCount = msgs.filter((m: any) => !m.read).length;

            if (msgs.length > 0) {
              lastActivity = msgs[msgs.length - 1].timestamp || null;
            }

            // Collect messages for recent activity display
            for (const msg of msgs) {
              allMessages.push({
                from: msg.from || 'unknown',
                to: member.name,
                content: msg.content || '',
                summary: (msg.content || '').slice(0, 80) + ((msg.content || '').length > 80 ? '...' : ''),
                timestamp: msg.timestamp || '',
                read: !!msg.read,
              });
            }
          } catch {
            // ignore parse errors
          }
        }

        members.push({
          name: member.name,
          agentType: member.agentType,
          model: member.model,
          color: member.color,
          unreadCount,
          totalMessages,
          lastActivity,
        });
      }

      // Sort messages by timestamp descending, take latest 10
      allMessages.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      const recentMessages = allMessages.slice(0, 10).map(({ content, ...rest }) => rest);

      result.push({
        name: config.name,
        description: config.description,
        createdAt: config.createdAt,
        memberCount: config.members.length,
        members,
        recentMessages,
      });
    }

    return result;
  }

  /**
   * Get team lead's unread messages
   */
  getLeadMessages(teamName: string): any[] {
    const team = this.teams.get(teamName);
    if (!team) return [];

    const leadMember = team.members.find(m => m.name === 'team-lead');
    if (!leadMember || !fs.existsSync(leadMember.inboxPath)) return [];

    const inboxData = JSON.parse(fs.readFileSync(leadMember.inboxPath, 'utf-8'));
    return inboxData.messages?.filter((msg: any) => !msg.read) || [];
  }

  /**
   * Mark lead messages as read
   */
  markLeadMessagesRead(teamName: string): void {
    const team = this.teams.get(teamName);
    if (!team) return;

    const leadMember = team.members.find(m => m.name === 'team-lead');
    if (!leadMember || !fs.existsSync(leadMember.inboxPath)) return;

    const inboxData = JSON.parse(fs.readFileSync(leadMember.inboxPath, 'utf-8'));
    inboxData.messages = inboxData.messages.map((msg: any) => ({ ...msg, read: true }));

    fs.writeFileSync(leadMember.inboxPath, JSON.stringify(inboxData, null, 2));
  }
}
