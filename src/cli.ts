/**
 * NeoPaw CLI Mode
 * Runs the educational agent directly via Claude CLI (no container).
 * Usage:
 *   npm run cli                    # Interactive mode
 *   npm run cli -- "your prompt"   # Single prompt mode
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const PROJECT_ROOT = process.cwd();
const CLI_WORKSPACE = path.join(PROJECT_ROOT, 'groups', 'cli');
const SKILLS_SRC = path.join(PROJECT_ROOT, 'container', 'skills');
const SKILLS_DST = path.join(CLI_WORKSPACE, '.claude', 'skills');

const WORKSPACE_DIRS = [
  'modules',
  'notes',
  'notes/memory',
  'research',
  'papers',
  'conversations',
  'logs',
];

const NEOPAW_CLAUDE_MD = `# NeoPaw — Your Learning Companion

You are NeoPaw, a personal educational agent built on the NEOLAF framework.
Your purpose is to help learners master AI+X concepts through structured
modules, research, and scientific writing.

## Personality
- Patient, encouraging, and curious
- Use the Socratic method: ask guiding questions before giving answers
- Celebrate progress; treat mistakes as learning opportunities
- Adapt explanations to the learner's level

## Workspace
- modules/ — Course content and lesson plans
- notes/ — Your learning journal, KSTAR traces, and QMD memory
- research/ — Research outputs from research-lookup
- papers/ — Scientific writing drafts and manuscripts
- conversations/ — Archived chat transcripts

## Educational Approach
Follow the AIX Seven-Step Framework:
1. Motivation — Why does this matter?
2. Preparation — What do you already know?
3. Assimilation — Present new concepts
4. Accommodation — Connect to existing knowledge
5. Evaluation — Check understanding
6. Connection — Link to other domains
7. Reflection — What was learned?

## Available Capabilities
- Run educational modules step-by-step with comprehension checks
- Search academic literature via research-lookup
- Write scientific manuscripts with IMRAD structure
- Explain AI+X concepts to any audience
- Record KSTAR learning traces for skill building
- Create QMD flashcards and spaced repetition reviews
`;

function ensureWorkspace(): void {
  // Create workspace directories
  for (const dir of WORKSPACE_DIRS) {
    fs.mkdirSync(path.join(CLI_WORKSPACE, dir), { recursive: true });
  }

  // Write CLAUDE.md if it doesn't exist
  const claudeMdPath = path.join(CLI_WORKSPACE, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, NEOPAW_CLAUDE_MD, 'utf-8');
  }

  // Initialize progress tracking
  const progressPath = path.join(CLI_WORKSPACE, 'notes', 'progress.json');
  if (!fs.existsSync(progressPath)) {
    fs.writeFileSync(progressPath, JSON.stringify({ modules: {} }, null, 2), 'utf-8');
  }

  // Initialize KSTAR traces
  const kstarPath = path.join(CLI_WORKSPACE, 'notes', 'kstar-traces.json');
  if (!fs.existsSync(kstarPath)) {
    fs.writeFileSync(kstarPath, JSON.stringify({ traces: [], skillProfile: {} }, null, 2), 'utf-8');
  }

  // Initialize QMD memory
  const cardsPath = path.join(CLI_WORKSPACE, 'notes', 'memory', 'cards.json');
  if (!fs.existsSync(cardsPath)) {
    fs.writeFileSync(cardsPath, JSON.stringify({ cards: [] }, null, 2), 'utf-8');
  }
}

function syncSkills(): void {
  if (!fs.existsSync(SKILLS_SRC)) return;

  fs.mkdirSync(SKILLS_DST, { recursive: true });

  for (const skillDir of fs.readdirSync(SKILLS_SRC)) {
    const srcDir = path.join(SKILLS_SRC, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(SKILLS_DST, skillDir);
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}

function main(): void {
  console.log('NeoPaw — Personal Agent Workstation for AI+X Learners');
  console.log('─'.repeat(55));

  // Set up workspace
  ensureWorkspace();
  syncSkills();

  // Get user prompt from CLI args (everything after --)
  const args = process.argv.slice(2);
  const userPrompt = args.join(' ').trim();

  // Build claude CLI args
  const claudeArgs: string[] = [];
  if (userPrompt) {
    claudeArgs.push('-p', userPrompt);
  }

  // Spawn claude in the workspace directory
  const child = spawn('claude', claudeArgs, {
    cwd: CLI_WORKSPACE,
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('\nError: claude CLI not found. Install it with:');
      console.error('  npm install -g @anthropic-ai/claude-code');
    } else {
      console.error('Error starting claude:', err.message);
    }
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main();
