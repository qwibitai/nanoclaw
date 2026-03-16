#!/usr/bin/env node
/**
 * Maintenance Bot — Telegram DM → host-task relay
 *
 * 只做一件事：接收用户 DM，写成 .md 文件到 host-tasks/，
 * host-task-runner.sh (cron) 自动执行。
 *
 * 不做自愈、不做容器清理（watchdog 已覆盖）。
 * 用 flock 锁防止多实例。
 */

import fs from 'fs';
import path from 'path';

const BOT_TOKEN = '8621132320:AAFcHZbPW-C3qROHKqww_K3_lHpXzoysNK4';
const OWNER_CHAT_ID = 8656923396;
const NC_DIR = process.env.HOME + '/nanoclaw';
const TASKS_DIR = `${NC_DIR}/store/host-tasks`;
const TASKS_DONE_DIR = `${NC_DIR}/store/host-tasks-done`;
const LOCKFILE = '/tmp/nc-maintain-bot.lock';

// ── PID lock (same as shlock) ──

function acquireLock() {
  try {
    // O_EXCL = fail if exists
    fs.writeFileSync(LOCKFILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // Check if existing process is alive
    try {
      const existingPid = parseInt(fs.readFileSync(LOCKFILE, 'utf8').trim());
      process.kill(existingPid, 0); // throws if dead
      return false; // still alive
    } catch {
      // Dead process, take over
      fs.writeFileSync(LOCKFILE, String(process.pid));
      return true;
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCKFILE); } catch { /* ignore */ }
}

if (!acquireLock()) {
  console.log('Another instance running, exiting.');
  process.exit(0);
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

// ── Telegram helpers ──

let lastUpdateId = 0;

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });
  return res.json();
}

async function reply(chatId, text) {
  await tg('sendMessage', { chat_id: chatId, text: text.slice(0, 4096) });
}

// ── Quick commands ──

import { execSync } from 'child_process';
const run = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return null; } };

function listTasks() {
  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) return '📋 No pending tasks';
  let out = `📋 Tasks (${files.length}):\n`;
  for (const f of files) {
    const content = fs.readFileSync(path.join(TASKS_DIR, f), 'utf8');
    const title = content.split('\n')[0].replace(/^#\s*/, '');
    out += `\n⏳ ${f.replace('.md', '')}: ${title}`;
  }
  return out;
}

// ── Main: create host-task from user message ──

function createTask(text) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug = text.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-');
  const filename = `${ts}-user-${slug}.md`;

  const content = `# 用户指令

## 内容
${text}

## 来源
用户通过维护 bot DM 下达，${new Date().toLocaleString('zh-CN', { timeZone: 'America/New_York' })}
`;

  fs.writeFileSync(path.join(TASKS_DIR, filename), content);
  return filename;
}

// ── Poll loop ──

async function poll() {
  try {
    const data = await tg('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message'],
    });

    if (data.ok && data.result) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text || msg.from?.id !== OWNER_CHAT_ID) continue;

        const text = msg.text.trim();

        if (text === '/status' || text === '/s') {
          const pid = run('pgrep -f "nanoclaw/dist/index.js"') || 'Not running';
          const containers = run('docker ps --filter "name=nanoclaw" --format "{{.Names}} — {{.Status}}"') || 'None';
          const pending = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md')).length;
          const ports = run('lsof -i :3001 -i :3002 2>/dev/null | grep LISTEN | wc -l')?.trim() || '0';
          await reply(msg.chat.id, `📊 PID: ${pid}\n📦 ${containers}\n📬 Pending tasks: ${pending}\n🔌 Ports: ${ports}`);

        } else if (text === '/tasks' || text === '/t') {
          await reply(msg.chat.id, listTasks());

        } else if (text === '/help' || text === '/h') {
          await reply(msg.chat.id, `维护 bot 指令：
/s — 系统状态
/t — 待执行任务
其他任何消息 → 自动创建 host-task，由 Claude Code 执行`);

        } else {
          const filename = createTask(text);
          await reply(msg.chat.id, `📝 已创建任务: ${filename}\ntask-runner 将在 1 分钟内执行`);
        }
      }
    }
  } catch (e) {
    if (e.name !== 'TimeoutError') {
      console.error(`${new Date().toISOString()} Poll error: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── Start ──

async function flushOldUpdates() {
  // Drain all pending updates so we only process messages sent after startup
  try {
    const data = await tg('getUpdates', { offset: -1, timeout: 0 });
    if (data.ok && data.result?.length > 0) {
      lastUpdateId = data.result[data.result.length - 1].update_id;
      console.log(`${new Date().toISOString()} Flushed ${data.result.length} old update(s), offset now ${lastUpdateId}`);
    }
  } catch (e) {
    console.error('Flush failed:', e.message);
  }
}

console.log(`${new Date().toISOString()} 🤖 Maintenance bot online (relay mode)`);
fs.mkdirSync(TASKS_DIR, { recursive: true });
fs.mkdirSync(TASKS_DONE_DIR, { recursive: true });
await flushOldUpdates();

while (true) { await poll(); }
