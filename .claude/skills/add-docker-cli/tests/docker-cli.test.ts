import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('docker skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: add-docker-cli');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('container/Dockerfile');
    expect(content).toContain('src/container-runner.ts');
  });

  it('has all files declared in adds', () => {
    const skillMd = path.join(
      skillDir,
      'add',
      'container',
      'skills',
      'docker',
      'SKILL.md',
    );
    expect(fs.existsSync(skillMd)).toBe(true);
  });

  it('container skill SKILL.md has correct frontmatter', () => {
    const skillMdPath = path.join(
      skillDir,
      'add',
      'container',
      'skills',
      'docker',
      'SKILL.md',
    );
    const content = fs.readFileSync(skillMdPath, 'utf-8');

    expect(content).toContain('name: docker');
    expect(content).toContain('allowed-tools: Bash(docker:*)');
    expect(content).toContain('docker ps');
    expect(content).toContain('docker logs');
    expect(content).toContain('docker inspect');
    expect(content).toContain('docker start');
    expect(content).toContain('docker stop');
  });

  it('has all files declared in modifies', () => {
    const dockerfile = path.join(skillDir, 'modify', 'container', 'Dockerfile');
    const containerRunner = path.join(
      skillDir,
      'modify',
      'src',
      'container-runner.ts',
    );

    expect(fs.existsSync(dockerfile)).toBe(true);
    expect(fs.existsSync(containerRunner)).toBe(true);
  });

  it('has intent files for all modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'container', 'Dockerfile.intent.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          skillDir,
          'modify',
          'src',
          'container-runner.ts.intent.md',
        ),
      ),
    ).toBe(true);
  });

  it('modified Dockerfile includes Docker CLI installation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'Dockerfile'),
      'utf-8',
    );

    expect(content).toContain('docker-27.5.1.tgz');
    expect(content).toContain('/usr/local/bin');
    expect(content).toContain('uname -m');
  });

  it('modified Dockerfile preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'Dockerfile'),
      'utf-8',
    );

    expect(content).toContain('FROM node:22-slim');
    expect(content).toContain('chromium');
    expect(content).toContain('agent-browser');
    expect(content).toContain('WORKDIR /app');
    expect(content).toContain('COPY agent-runner/');
    expect(content).toContain('ENTRYPOINT');
    expect(content).toContain('/workspace/group');
    expect(content).toContain('USER node');
  });

  it('modified container-runner.ts includes Docker socket mount', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'container-runner.ts'),
      'utf-8',
    );

    expect(content).toContain('/var/run/docker.sock');
    expect(content).toContain('hasDockerSocket');
    expect(content).toContain('--group-add');
  });

  it('modified container-runner.ts only mounts Docker socket for main group', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'container-runner.ts'),
      'utf-8',
    );

    // Docker socket mount is gated on isMain
    expect(content).toContain('isMain && fs.existsSync(dockerSock)');
  });

  it('modified container-runner.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'container-runner.ts'),
      'utf-8',
    );

    // Core functions preserved
    expect(content).toContain('function buildVolumeMounts(');
    expect(content).toContain('function buildContainerArgs(');
    expect(content).toContain('function readSecrets(');

    // Core mounts preserved
    expect(content).toContain('/workspace/project');
    expect(content).toContain('/workspace/group');
    expect(content).toContain('/workspace/ipc');
    expect(content).toContain('/home/node/.claude');
    expect(content).toContain('/app/src');

    // Security features preserved
    expect(content).toContain('validateAdditionalMounts');
    expect(content).toContain('/dev/null');
  });
});
