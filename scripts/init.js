import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

function log(message) {
  console.log(message);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(filePath, contents) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, contents);
    return true;
  }
  return false;
}

function checkDocker() {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    log('Docker: OK');
  } catch {
    log('Docker: NOT RUNNING');
    log('Start Docker Desktop (macOS) or run: sudo systemctl start docker (Linux)');
  }
}

function initFiles() {
  ensureDir(DATA_DIR);
  ensureDir(GROUPS_DIR);
  ensureDir(path.join(GROUPS_DIR, 'main'));
  ensureDir(path.join(GROUPS_DIR, 'global'));

  const registeredGroupsPath = path.join(DATA_DIR, 'registered_groups.json');
  const sessionsPath = path.join(DATA_DIR, 'sessions.json');
  const routerStatePath = path.join(DATA_DIR, 'router_state.json');

  const createdRegistered = ensureFile(registeredGroupsPath, '{}\n');
  const createdSessions = ensureFile(sessionsPath, '{}\n');
  const createdRouter = ensureFile(routerStatePath, '{"last_agent_timestamp":{}}\n');

  const envPath = path.join(PROJECT_ROOT, '.env');
  const envSample = [
    '# Telegram bot token from @BotFather',
    'TELEGRAM_BOT_TOKEN=your_bot_token_here',
    '',
    '# Claude authentication (choose one)',
    'CLAUDE_CODE_OAUTH_TOKEN=your_oauth_token',
    '# OR',
    'ANTHROPIC_API_KEY=your_api_key',
    ''
  ].join('\n');

  const createdEnv = ensureFile(envPath, envSample);

  log(`registered_groups.json: ${createdRegistered ? 'created' : 'exists'}`);
  log(`sessions.json: ${createdSessions ? 'created' : 'exists'}`);
  log(`router_state.json: ${createdRouter ? 'created' : 'exists'}`);
  log(`.env: ${createdEnv ? 'created (edit this file)' : 'exists'}`);
}

function printNextSteps() {
  log('\nNext steps:');
  log('1) Edit .env with your Telegram bot token and Claude auth');
  log('2) Build the container: ./container/build.sh');
  log('3) Register your chat in data/registered_groups.json');
  log('4) npm run build && npm start');
}

checkDocker();
initFiles();
printNextSteps();
