#!/usr/bin/env node
/**
 * Sovereign CLI — single command interface for all operations.
 *
 * Usage: sovereign <command> [options]
 *
 * Commands:
 *   init                 Interactive setup wizard
 *   deploy               Build snapshot + atomic switch
 *   rollback             Revert to previous release
 *   status               Health check (containers, memory, uptime)
 *   logs [--follow]      Tail agent logs
 *   agent add <name>     Spin up new agent from template
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import readline from 'readline';

import { deploy, rollback, listReleases, getCurrentRelease } from './deploy.js';

// ── Helpers ─────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { command: string; args: string[] } {
  // Skip node and script path
  const rest = argv.slice(2);
  const command = rest[0] || 'help';
  return { command, args: rest.slice(1) };
}

function projectRoot(): string {
  return process.cwd();
}

function print(msg: string): void {
  console.log(msg);
}

function error(msg: string): void {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Commands ────────────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  print('🔧 Sovereign Setup Wizard\n');

  const name = await prompt('Agent name (e.g. Adam): ');
  if (!name) error('Agent name is required');

  const discordToken = await prompt(
    'Discord bot token (or press Enter to skip): ',
  );
  const openrouterKey = await prompt(
    'OpenRouter API key (or press Enter to skip): ',
  );
  const assistantName = name;

  // Create .env file
  const root = projectRoot();
  const envLines: string[] = [
    `ASSISTANT_NAME=${assistantName}`,
    `DISCORD_ONLY=true`,
  ];

  if (discordToken) {
    envLines.push(`DISCORD_BOT_TOKEN=${discordToken}`);
  }
  if (openrouterKey) {
    envLines.push(`ANTHROPIC_BASE_URL=https://openrouter.ai/api`);
    envLines.push(`ANTHROPIC_AUTH_TOKEN=${openrouterKey}`);
    envLines.push(`ANTHROPIC_API_KEY=`);
  }

  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const overwrite = await prompt('.env already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      print('Keeping existing .env');
    } else {
      fs.writeFileSync(envPath, envLines.join('\n') + '\n');
      print('✓ .env created');
    }
  } else {
    fs.writeFileSync(envPath, envLines.join('\n') + '\n');
    print('✓ .env created');
  }

  // Set up main agent group from template
  const groupDir = path.join(root, 'groups', 'main');
  const templateDir = path.join(root, 'templates', 'agent-starter');

  if (!fs.existsSync(groupDir) && fs.existsSync(templateDir)) {
    copyDirSync(templateDir, groupDir);
    // Replace placeholders
    replaceInDir(groupDir, '{AGENT_NAME}', assistantName);
    print(`✓ Agent "${assistantName}" created in groups/main/`);
  } else if (fs.existsSync(groupDir)) {
    print(`✓ groups/main/ already exists (keeping existing)`);
  }

  print('\n✓ Setup complete! Run `sovereign deploy` to start.');
}

function cmdDeploy(): void {
  const root = projectRoot();
  const distDir = path.join(root, 'dist');

  // Build first
  print('Building...');
  try {
    execSync('npm run build', { cwd: root, stdio: 'inherit' });
  } catch {
    error('Build failed');
  }

  if (!fs.existsSync(distDir)) {
    error('dist/ not found after build');
  }

  const result = deploy(root, distDir);

  if (result.success) {
    print(`✓ ${result.message}`);
  } else {
    error(result.message);
  }
}

function cmdRollback(): void {
  const root = projectRoot();
  const result = rollback(root);

  if (result.success) {
    print(`✓ ${result.message}`);
  } else {
    error(result.message);
  }
}

function cmdStatus(): void {
  const root = projectRoot();

  // Current release
  const currentSha = getCurrentRelease(root);
  print(`Release: ${currentSha || 'none'}`);

  // All releases
  const releases = listReleases(root);
  if (releases.length > 0) {
    print(`Releases: ${releases.length} (keeping last 5)`);
    for (const r of releases) {
      const date = new Date(r.timestamp)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
      print(`  ${r.isCurrent ? '→' : ' '} ${r.sha} (${date})`);
    }
  }

  // Docker containers
  print('');
  try {
    const containers = execSync(
      'docker ps --filter "name=nanoclaw" --format "{{.Names}}\\t{{.Status}}\\t{{.RunningFor}}"',
      { encoding: 'utf-8' },
    ).trim();

    if (containers) {
      print('Containers:');
      for (const line of containers.split('\n')) {
        const [name, status, running] = line.split('\t');
        print(
          `  ${status?.includes('healthy') ? '✓' : '●'} ${name} — ${status} (${running})`,
        );
      }
    } else {
      print('Containers: none running');
    }
  } catch {
    print('Containers: docker not available');
  }

  // Memory / disk
  print('');
  try {
    const mem = execSync(
      'free -h 2>/dev/null | head -2 || vm_stat 2>/dev/null | head -3',
      {
        encoding: 'utf-8',
      },
    ).trim();
    if (mem) print(`Memory:\n  ${mem.split('\n').join('\n  ')}`);
  } catch {
    // Not critical
  }

  // Store size
  const storePath = path.join(root, 'store', 'messages.db');
  if (fs.existsSync(storePath)) {
    const size = fs.statSync(storePath).size;
    print(`\nDatabase: ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
}

function cmdLogs(args: string[]): void {
  const follow = args.includes('--follow') || args.includes('-f');

  const logArgs = ['logs'];
  if (follow) logArgs.push('-f');
  logArgs.push('--tail', '100');

  // Find the main container
  try {
    const container = execSync(
      'docker ps --filter "name=nanoclaw-main" --format "{{.Names}}"',
      { encoding: 'utf-8' },
    ).trim();

    if (!container) {
      error('No running nanoclaw-main container found');
    }

    logArgs.push(container);

    const proc = spawn('docker', logArgs, { stdio: 'inherit' });
    proc.on('exit', (code) => process.exit(code || 0));
  } catch {
    error('docker not available');
  }
}

function cmdAgentAdd(args: string[]): void {
  const name = args[0];
  if (!name) error('Usage: sovereign agent add <name>');

  const root = projectRoot();
  const templateDir = path.join(root, 'templates', 'agent-starter');
  const groupDir = path.join(root, 'groups', name);

  if (!fs.existsSync(templateDir)) {
    error('templates/agent-starter/ not found');
  }

  if (fs.existsSync(groupDir)) {
    error(`groups/${name}/ already exists`);
  }

  copyDirSync(templateDir, groupDir);
  replaceInDir(groupDir, '{AGENT_NAME}', name);

  print(`✓ Agent "${name}" created in groups/${name}/`);
  print(`  Edit groups/${name}/CLAUDE.md to customize identity.`);
}

function cmdHelp(): void {
  print(
    `
Sovereign CLI — manage your AI agents

Usage: sovereign <command> [options]

Commands:
  init                 Interactive setup wizard
  deploy               Build snapshot + atomic deploy
  rollback             Revert to previous release
  status               Health check + release info
  logs [--follow]      Tail agent logs
  agent add <name>     Create new agent from template
  help                 Show this help
`.trim(),
  );
}

// ── Internal helpers ────────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function replaceInDir(dir: string, search: string, replacement: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      replaceInDir(fullPath, search, replacement);
    } else {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes(search)) {
        fs.writeFileSync(fullPath, content.replaceAll(search, replacement));
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv): Promise<void> {
  const { command, args } = parseArgs(argv);

  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'deploy':
      cmdDeploy();
      break;
    case 'rollback':
      cmdRollback();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'logs':
      cmdLogs(args);
      break;
    case 'agent':
      if (args[0] === 'add') {
        cmdAgentAdd(args.slice(1));
      } else {
        error(`Unknown agent subcommand: ${args[0] || '(none)'}`);
      }
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    default:
      print(`Unknown command: ${command}`);
      cmdHelp();
      process.exit(1);
  }
}

// Run when executed directly
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
