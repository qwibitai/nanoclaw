import { describe, it, expect } from 'vitest';

import { handleSkillCommand } from './cli.js';

describe('handleSkillCommand', () => {
  it('shows help for unknown subcommand', async () => {
    const output = await handleSkillCommand([]);
    expect(output).toContain('NanoClaw Skill Registry');
    expect(output).toContain('search <query>');
    expect(output).toContain('install <name>');
    expect(output).toContain('list');
  });

  it('shows help for explicit unknown command', async () => {
    const output = await handleSkillCommand(['unknown-command']);
    expect(output).toContain('NanoClaw Skill Registry');
  });

  it('shows usage for search without query', async () => {
    const output = await handleSkillCommand(['search']);
    expect(output).toContain('Usage:');
    expect(output).toContain('search');
  });

  it('shows usage for install without name', async () => {
    const output = await handleSkillCommand(['install']);
    expect(output).toContain('Usage:');
    expect(output).toContain('install');
  });

  it('shows usage for info without name', async () => {
    const output = await handleSkillCommand(['info']);
    expect(output).toContain('Usage:');
    expect(output).toContain('info');
  });

  it('clears cache', async () => {
    const output = await handleSkillCommand(['cache-clear']);
    expect(output).toContain('cache cleared');
  });

  it('supports command aliases', async () => {
    // ls → list
    const listOutput = await handleSkillCommand(['ls']);
    expect(listOutput).toContain('skill');

    // show → info
    const infoOutput = await handleSkillCommand(['show']);
    expect(infoOutput).toContain('Usage:');

    // add → install
    const addOutput = await handleSkillCommand(['add']);
    expect(addOutput).toContain('Usage:');

    // rm → uninstall
    const rmOutput = await handleSkillCommand(['rm']);
    expect(rmOutput).toContain('Usage:');
  });
});
