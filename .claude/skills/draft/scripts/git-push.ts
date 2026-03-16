#!/usr/bin/env npx tsx
/**
 * Draft Skill - Git Commit & Push
 * Commits a thesis directory in huynh.io and pushes to GitHub.
 *
 * Usage: echo '{"directory":"20260316-slug","commitMessage":"draft: 20260316-slug"}' | npx tsx git-push.ts
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface GitPushInput {
  directory: string;
  commitMessage: string;
}

interface ScriptResult {
  success: boolean;
  message: string;
}

async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(new Error(`Invalid JSON input: ${err}`)); }
    });
    process.stdin.on('error', reject);
  });
}

function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

async function gitPush(input: GitPushInput): Promise<ScriptResult> {
  const { directory, commitMessage } = input;

  // Validate directory name (prevent path traversal)
  if (!/^[\w-]+$/.test(directory)) {
    return { success: false, message: `Invalid directory name: ${directory}` };
  }

  const repoPath = process.env.DRAFT_BLOG_REPO_PATH
    || path.join(os.homedir(), 'Projects', 'pj', 'huynh.io');
  const branch = process.env.DRAFT_GIT_BRANCH || 'main';

  if (!fs.existsSync(repoPath)) {
    return { success: false, message: `Blog repo not found at ${repoPath}` };
  }

  const thesisDir = path.join(repoPath, directory);
  if (!fs.existsSync(thesisDir)) {
    return { success: false, message: `Thesis directory not found: ${directory}` };
  }

  const execOpts = { cwd: repoPath, encoding: 'utf-8' as const, timeout: 30000 };

  try {
    // Stage the thesis directory
    execSync(`git add "${directory}"`, execOpts);

    // Check if there are staged changes
    const status = execSync('git diff --cached --stat', execOpts).trim();
    if (!status) {
      return { success: false, message: 'No changes to commit' };
    }

    // Commit
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, execOpts);

    // Push
    execSync(`git push origin ${branch}`, { ...execOpts, timeout: 60000 });

    return {
      success: true,
      message: `Pushed ${directory} to GitHub (${branch}). Commit: "${commitMessage}"`
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Git operation failed: ${msg.slice(0, 300)}` };
  }
}

async function main(): Promise<void> {
  try {
    const input = await readInput<GitPushInput>();
    const result = await gitPush(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }
}

main();
