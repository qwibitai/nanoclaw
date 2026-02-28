import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('channel-interactions skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: channel-interactions');
    expect(content).toContain('version: 1.0.0');
  });

  it('has all files declared in modifies', () => {
    const modifiedFiles = [
      'src/types.ts',
      'src/ipc.ts',
      'src/router.ts',
      'src/index.ts',
      'src/container-runner.ts',
      'container/agent-runner/src/ipc-mcp-stdio.ts',
      'src/formatting.test.ts',
    ];

    for (const file of modifiedFiles) {
      const filePath = path.join(skillDir, 'modify', file);
      expect(fs.existsSync(filePath), `Missing modify file: ${file}`).toBe(true);
    }
  });

  it('has intent files for all modified files', () => {
    const intentFiles = [
      'src/types.ts.intent.md',
      'src/ipc.ts.intent.md',
      'src/router.ts.intent.md',
      'src/index.ts.intent.md',
      'src/container-runner.ts.intent.md',
      'container/agent-runner/src/ipc-mcp-stdio.ts.intent.md',
      'src/formatting.test.ts.intent.md',
    ];

    for (const file of intentFiles) {
      const filePath = path.join(skillDir, 'modify', file);
      expect(fs.existsSync(filePath), `Missing intent file: ${file}`).toBe(true);
    }
  });

  it('has SKILL.md documentation', () => {
    const skillMd = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);

    const content = fs.readFileSync(skillMd, 'utf-8');
    expect(content).toContain('add-channel-interactions');
    expect(content).toContain('Phase 1');
    expect(content).toContain('Phase 2');
    expect(content).toContain('Phase 3');
  });

  it('modified types.ts adds Channel interaction methods', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'types.ts'),
      'utf-8',
    );

    // New types
    expect(content).toContain('interface Attachment');
    expect(content).toContain('interface GroupMetadata');

    // Optional Channel methods
    expect(content).toContain('sendReaction?(');
    expect(content).toContain('sendReply?(');
    expect(content).toContain('sendPoll?(');
    expect(content).toContain('getGroupMetadata?(');
    expect(content).toContain('setTyping?(');

    // Extended sendMessage with attachments
    expect(content).toContain('sendMessage(jid: string, text: string, attachments?: string[])');

    // NewMessage extensions
    expect(content).toContain('attachments?: Attachment[]');
    expect(content).toContain('quote?: { author: string; text: string }');
    expect(content).toContain('reaction?: { emoji: string; targetAuthor: string; targetTimestamp: number }');

    // Existing types preserved
    expect(content).toContain('interface RegisteredGroup');
    expect(content).toContain('interface ContainerConfig');
    expect(content).toContain('interface NewMessage');
    expect(content).toContain('type OnInboundMessage');
    expect(content).toContain('type OnChatMetadata');
  });

  it('modified ipc.ts adds optional interaction deps', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'ipc.ts'),
      'utf-8',
    );

    // Optional IpcDeps
    expect(content).toContain('sendReaction?:');
    expect(content).toContain('sendReply?:');
    expect(content).toContain('sendPoll?:');

    // Attachment resolution
    expect(content).toContain('resolveAttachmentPaths');
    expect(content).toContain('MAX_IPC_FILE_SIZE');

    // Runtime guards for optional deps
    expect(content).toContain('if (!deps.sendReaction)');
    expect(content).toContain('if (!deps.sendPoll)');

    // Existing IPC preserved
    expect(content).toContain('processTaskIpc');
    expect(content).toContain('startIpcWatcher');
  });

  it('modified router.ts adds msg-id and attachment formatting', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'router.ts'),
      'utf-8',
    );

    // msg-id extraction
    expect(content).toContain('msg-id=');

    // Quote context
    expect(content).toContain('replying-to=');

    // Attachment elements
    expect(content).toContain('<attachment');

    // routeOutbound attachments parameter
    expect(content).toContain('attachments?: string[]');

    // Existing functions preserved
    expect(content).toContain('escapeXml');
    expect(content).toContain('findChannel');
    expect(content).toContain('formatMessages');
    expect(content).toContain('routeOutbound');
  });

  it('modified index.ts wires IPC deps and adds /chatid', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    // /chatid handler
    expect(content).toContain('/chatid');

    // IPC dep wiring
    expect(content).toContain('sendReaction');
    expect(content).toContain('sendReply');
    expect(content).toContain('sendPoll');

    // Group metadata snapshot
    expect(content).toContain('writeGroupMetadataSnapshot');

    // Core functions preserved
    expect(content).toContain('function loadState()');
    expect(content).toContain('function saveState()');
    expect(content).toContain('function registerGroup(');
    expect(content).toContain('function runAgent(');
    expect(content).toContain('function startMessageLoop()');
    expect(content).toContain('async function main()');
    expect(content).toContain('_setRegisteredGroups');
    expect(content).toContain('isDirectRun');
  });

  it('modified container-runner.ts adds writeGroupMetadataSnapshot', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'container-runner.ts'),
      'utf-8',
    );

    expect(content).toContain('writeGroupMetadataSnapshot');
    expect(content).toContain('group_metadata.json');
    expect(content).toContain('GroupMetadata');

    // Existing exports preserved
    expect(content).toContain('runContainerAgent');
    expect(content).toContain('resolveGroupIpcPath');
  });

  it('modified ipc-mcp-stdio.ts adds MCP tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
      'utf-8',
    );

    // New tools
    expect(content).toContain("'send_reaction'");
    expect(content).toContain("'send_poll'");
    expect(content).toContain("'get_group_info'");

    // Extended send_message
    expect(content).toContain('reply_to_msg_id');
    expect(content).toContain('attachments');

    // Existing tools preserved
    expect(content).toContain("'send_message'");
    expect(content).toContain("'schedule_task'");
    expect(content).toContain("'list_tasks'");
    expect(content).toContain("'register_group'");
  });

  it('modified formatting.test.ts adds agnosticism tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'formatting.test.ts'),
      'utf-8',
    );

    // Agnosticism tests
    expect(content).toContain('msg-id agnosticism');
    expect(content).toContain('WhatsApp');
    expect(content).toContain('signal-');
    expect(content).toContain('telegram-');
    expect(content).toContain('discord-');

    // Existing tests preserved
    expect(content).toContain('escapeXml');
    expect(content).toContain('formatMessages');
  });
});
