#!/usr/bin/env node

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

function runGit(args: string[], opts: { cwd?: string } = {}) {
  const result = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    code: result.status ?? 0,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

function copyDirectory(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function tryCopyRemoteSkills(repoUrl: string): boolean {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-'));
  try {
    const clone = spawnSync('git', ['clone', '--depth', '1', repoUrl, tmpDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (clone.status !== 0) {
      return false;
    }

    const candidates = ['.claude/skills', 'skills'];
    const found = candidates.find((p) => fs.existsSync(path.join(tmpDir, p)));
    if (!found) {
      return false;
    }

    const target = path.join(process.cwd(), '.claude', 'skills');
    console.log(`Copying skills from ${found} into ${target}`);
    copyDirectory(path.join(tmpDir, found), target);
    return true;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseGitHubRepo(input: string): {
  owner: string;
  repo: string;
  url: string;
} {
  // Accept: owner/repo, github.com/owner/repo, https://github.com/owner/repo(.git), git@github.com:owner/repo.git
  const trimmed = input.trim();

  // owner/repo
  const simpleMatch = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (simpleMatch) {
    const owner = simpleMatch[1];
    const repo = simpleMatch[2];
    return {
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}.git`,
    };
  }

  // https://github.com/owner/repo(.git)
  const httpsMatch =
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\.git)?$/.exec(trimmed);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2], url: trimmed }; // keep original
  }

  // git@github.com:owner/repo.git
  const sshMatch = /^git@github\.com:([\w.-]+)\/([\w.-]+)(?:\.git)?$/.exec(
    trimmed,
  );
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2], url: trimmed };
  }

  die(
    `Unable to parse GitHub repo from '${input}'. Expected owner/repo or GitHub URL.`,
  );
}

function sanitizeRemoteName(name: string): string {
  return name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

async function promptChoice(
  prompt: string,
  choices: string[],
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const question = `${prompt}\n${choices.map((c, i) => `  [${i + 1}] ${c}`).join('\n')}\nChoose 1-${choices.length}: `;

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const idx = Number(answer.trim()) - 1;
      if (isNaN(idx) || idx < 0 || idx >= choices.length) {
        die('Invalid selection');
      }
      resolve(choices[idx]);
    });
  });
}

function showHelp(): void {
  console.log(`nanoclaw CLI

Usage:
  nanoclaw add <owner/repo>   Install skills from a GitHub repo (skill branches or .claude/skills/ folder)

Examples:
  nanoclaw add qwibitai/nanoclaw-whatsapp
  nanoclaw add username/your-skill-repo
`);
}

async function run(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);

  if (!sub) {
    showHelp();
    process.exit(0);
  }

  if (sub === 'add') {
    if (rest.length !== 1) {
      die('Usage: nanoclaw add <owner/repo>');
    }

    const { owner, repo, url } = parseGitHubRepo(rest[0]);

    const rootRes = runGit(['rev-parse', '--show-toplevel']);
    if (rootRes.code !== 0) {
      die('Not inside a git repository. Run this from the NanoClaw repo root.');
    }
    const root = rootRes.stdout.trim();
    process.chdir(root);

    const remoteName = sanitizeRemoteName(`skill-${owner}-${repo}`);

    // Add remote if missing.
    const existing = runGit(['remote', 'get-url', remoteName]);
    if (existing.code === 0) {
      if (existing.stdout.trim() !== url.trim()) {
        console.warn(
          `Remote '${remoteName}' already exists with a different URL (${existing.stdout.trim()}).`,
        );
        console.warn(`You can remove it with: git remote remove ${remoteName}`);
        process.exit(1);
      }
    } else {
      console.log(`Adding git remote '${remoteName}' -> ${url}`);
      const add = runGit(['remote', 'add', remoteName, url]);
      if (add.code !== 0) {
        console.error(add.stderr);
        die(`Failed to add remote ${remoteName}`);
      }
    }

    console.log(`Fetching ${remoteName}...`);
    const fetch = runGit(['fetch', remoteName]);
    if (fetch.code !== 0) {
      console.error(fetch.stderr);
      die(`Failed to fetch remote ${remoteName}`);
    }

    const branchesRes = runGit([
      'branch',
      '-r',
      '--list',
      `${remoteName}/skill/*`,
    ]);

    if (branchesRes.code !== 0) {
      console.error(branchesRes.stderr);
      die('Failed to list remote branches');
    }

    const branches = branchesRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(`${remoteName}/`, ''));

    if (branches.length === 0) {
      console.log(
        `No skill branches found on ${remoteName}. Trying to install skills from the repo's .claude/skills (or skills/) folder...`,
      );
      const copied = tryCopyRemoteSkills(url);
      if (!copied) {
        die(
          `No skill branches found on ${remoteName} and no .claude/skills or skills folder detected in the repo.`,
        );
      }

      console.log('Skills copied successfully. You may need to run:');
      console.log('  npm install');
      console.log('  npm run build');
      console.log('  npx vitest run');
      process.exit(0);
    }

    const chosenBranch =
      branches.length === 1
        ? branches[0]
        : await promptChoice(
            'Found multiple skill branches, pick one to install:',
            branches,
          );

    console.log(`Merging ${remoteName}/${chosenBranch}...`);
    const merge = runGit([
      'merge',
      `${remoteName}/${chosenBranch}`,
      '--no-edit',
    ]);
    if (merge.code !== 0) {
      console.error(merge.stderr);
      console.error(
        `Merge failed. Resolve conflicts, then run 'git merge --continue' (or abort with 'git merge --abort').`,
      );
      process.exit(1);
    }

    console.log('Merge successful. You may need to run:');
    console.log('  npm install');
    console.log('  npm run build');
    console.log('  npx vitest run');

    process.exit(0);
  }

  showHelp();
  process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
