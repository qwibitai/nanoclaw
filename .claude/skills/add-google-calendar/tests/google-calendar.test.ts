import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('google-calendar skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: google-calendar');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@cocal/google-calendar-mcp');
  });

  it('manifest declares correct modified files', () => {
    const content = fs.readFileSync(path.join(skillDir, 'manifest.yaml'), 'utf-8');
    expect(content).toContain('container/agent-runner/src/index.ts');
    expect(content).toContain('src/container-runner.ts');
    expect(content).toContain('groups/global/CLAUDE.md');
    expect(content).toContain('groups/main/CLAUDE.md');
  });

  it('manifest declares structured metadata', () => {
    const content = fs.readFileSync(path.join(skillDir, 'manifest.yaml'), 'utf-8');
    expect(content).toContain('npx_dependencies');
    expect(content).toContain('@cocal/google-calendar-mcp');
    expect(content).toContain('GOOGLE_OAUTH_CREDENTIALS');
    expect(content).toContain('~/.google-calendar-mcp');
  });

  it('has a SKILL.md with implementation instructions', () => {
    const skillMd = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);

    const content = fs.readFileSync(skillMd, 'utf-8');
    expect(content).toContain('Add Google Calendar Integration');
  });
});

describe('google-calendar agent-runner integration', () => {
  const agentRunnerPath = path.resolve(__dirname, '..', '..', '..', '..', 'container', 'agent-runner', 'src', 'index.ts');

  it('has google_calendar MCP server configured', () => {
    const content = fs.readFileSync(agentRunnerPath, 'utf-8');
    expect(content).toContain('google_calendar:');
    expect(content).toContain('@cocal/google-calendar-mcp');
    expect(content).toContain('GOOGLE_OAUTH_CREDENTIALS');
    expect(content).toContain('/home/node/.google-calendar-mcp/gcp-oauth.keys.json');
  });

  it('has google_calendar tools whitelisted', () => {
    const content = fs.readFileSync(agentRunnerPath, 'utf-8');
    expect(content).toContain("mcp__google_calendar__*");
  });
});

describe('google-calendar container mounts', () => {
  const containerRunnerPath = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'container-runner.ts');

  it('mounts calendar credentials directory', () => {
    const content = fs.readFileSync(containerRunnerPath, 'utf-8');
    expect(content).toContain('.google-calendar-mcp');
    expect(content).toContain('/home/node/.google-calendar-mcp');
  });

  it('mounts calendar token storage directory', () => {
    const content = fs.readFileSync(containerRunnerPath, 'utf-8');
    expect(content).toContain('.config/google-calendar-mcp');
    expect(content).toContain('/home/node/.config/google-calendar-mcp');
  });

  it('mounts calendar dirs as read-write for token refresh', () => {
    const content = fs.readFileSync(containerRunnerPath, 'utf-8');

    // Extract the calendar credentials mount block
    const calendarBlock = content.slice(
      content.indexOf('Google Calendar credentials directory'),
      content.indexOf('Google Calendar MCP token storage'),
    );
    expect(calendarBlock).toContain('readonly: false');

    // Extract the token storage mount block
    const tokenBlock = content.slice(
      content.indexOf('Google Calendar MCP token storage'),
      content.indexOf('Per-group Claude sessions'),
    );
    expect(tokenBlock).toContain('readonly: false');
  });
});

describe('google-calendar agent instructions', () => {
  const globalClaudeMd = path.resolve(__dirname, '..', '..', '..', '..', 'groups', 'global', 'CLAUDE.md');
  const mainClaudeMd = path.resolve(__dirname, '..', '..', '..', '..', 'groups', 'main', 'CLAUDE.md');

  const calendarTools = [
    'mcp__google_calendar__list-calendars',
    'mcp__google_calendar__list-events',
    'mcp__google_calendar__search-events',
    'mcp__google_calendar__get-event',
    'mcp__google_calendar__create-event',
    'mcp__google_calendar__update-event',
    'mcp__google_calendar__delete-event',
    'mcp__google_calendar__get-freebusy',
    'mcp__google_calendar__get-current-time',
  ];

  it('global CLAUDE.md has Calendar section', () => {
    const content = fs.readFileSync(globalClaudeMd, 'utf-8');
    expect(content).toContain('## Calendar (Google Calendar)');
  });

  it('global CLAUDE.md documents all calendar tools', () => {
    const content = fs.readFileSync(globalClaudeMd, 'utf-8');
    for (const tool of calendarTools) {
      expect(content).toContain(tool);
    }
  });

  it('main CLAUDE.md has Calendar section', () => {
    const content = fs.readFileSync(mainClaudeMd, 'utf-8');
    expect(content).toContain('## Calendar (Google Calendar)');
  });

  it('main CLAUDE.md documents all calendar tools', () => {
    const content = fs.readFileSync(mainClaudeMd, 'utf-8');
    for (const tool of calendarTools) {
      expect(content).toContain(tool);
    }
  });
});
