import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const STORE_DIR = path.join(PROJECT_ROOT, 'store');
const HOME_DIR = process.env.HOME || '';
const DOTCLAW_CONFIG_DIR = HOME_DIR ? path.join(HOME_DIR, '.config', 'dotclaw') : '';
const TRACE_DIR = DOTCLAW_CONFIG_DIR ? path.join(DOTCLAW_CONFIG_DIR, 'traces') : '';
const PROMPTS_DIR = DOTCLAW_CONFIG_DIR ? path.join(DOTCLAW_CONFIG_DIR, 'prompts') : '';

function log(label, value) {
  console.log(`${label}: ${value}`);
}

function checkDocker() {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    log('Docker', 'OK');
  } catch {
    log('Docker', 'NOT RUNNING');
  }
}

function checkPathAccess(label, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    log(label, 'read/write OK');
  } catch (err) {
    log(label, `permission error (${err instanceof Error ? err.message : String(err)})`);
  }
}

function countFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function checkSystemd(service) {
  try {
    const output = execSync(`systemctl is-active ${service}`, { stdio: 'pipe' }).toString().trim();
    log(`systemd ${service}`, output);
  } catch {
    log(`systemd ${service}`, 'not available');
  }
}

function diskSpace(dir) {
  try {
    const output = execSync(`df -k "${dir}"`, { stdio: 'pipe' }).toString();
    const lines = output.trim().split('\n');
    const last = lines[lines.length - 1];
    const parts = last.split(/\s+/);
    const availKb = parseInt(parts[3], 10);
    if (Number.isFinite(availKb)) {
      const availGb = (availKb / (1024 * 1024)).toFixed(2);
      return `${availGb} GB available`;
    }
    return 'unknown';
  } catch (err) {
    return `error (${err instanceof Error ? err.message : String(err)})`;
  }
}

log('Node', process.version);
if (typeof process.getuid === 'function') {
  log('UID', String(process.getuid()));
}
if (typeof process.getgid === 'function') {
  log('GID', String(process.getgid()));
}
checkDocker();
log('Project Root', PROJECT_ROOT);
checkPathAccess('data/', DATA_DIR);
checkPathAccess('groups/', GROUPS_DIR);
checkPathAccess('store/', STORE_DIR);
log('Disk space (data/)', diskSpace(DATA_DIR));
log('Disk space (groups/)', diskSpace(GROUPS_DIR));
log('Disk space (store/)', diskSpace(STORE_DIR));

if (DOTCLAW_CONFIG_DIR) {
  checkPathAccess('~/.config/dotclaw', DOTCLAW_CONFIG_DIR);
  log('Trace files', String(countFiles(TRACE_DIR)));
  log('Prompt packs', String(countFiles(PROMPTS_DIR)));
}

const envPath = path.join(PROJECT_ROOT, '.env');
log('.env', fs.existsSync(envPath) ? 'present' : 'missing');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const hasOpenRouter = envContent.includes('OPENROUTER_API_KEY=');
  const hasBrave = envContent.includes('BRAVE_SEARCH_API_KEY=');
  log('OPENROUTER_API_KEY', hasOpenRouter ? 'set' : 'missing');
  log('BRAVE_SEARCH_API_KEY', hasBrave ? 'set (optional, enables WebSearch)' : 'missing');
}

checkSystemd('dotclaw.service');
checkSystemd('autotune.timer');

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  log('Warning', 'Running as root. For best security, run as a non-root user.');
}

const modelConfigPath = path.join(DATA_DIR, 'model.json');
if (fs.existsSync(modelConfigPath)) {
  try {
    const modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8'));
    log('Model', modelConfig.model || 'missing');
    log('Model allowlist', Array.isArray(modelConfig.allowlist) && modelConfig.allowlist.length > 0 ? modelConfig.allowlist.join(', ') : 'none (allow all)');
  } catch (err) {
    log('Model config', `error (${err instanceof Error ? err.message : String(err)})`);
  }
} else {
  log('Model config', 'missing');
}
