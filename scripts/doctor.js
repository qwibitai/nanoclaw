import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const STORE_DIR = path.join(PROJECT_ROOT, 'store');

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
checkDocker();
log('Project Root', PROJECT_ROOT);
checkPathAccess('data/', DATA_DIR);
checkPathAccess('groups/', GROUPS_DIR);
checkPathAccess('store/', STORE_DIR);
log('Disk space (data/)', diskSpace(DATA_DIR));
log('Disk space (groups/)', diskSpace(GROUPS_DIR));
log('Disk space (store/)', diskSpace(STORE_DIR));

const envPath = path.join(PROJECT_ROOT, '.env');
log('.env', fs.existsSync(envPath) ? 'present' : 'missing');
