const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DASHBOARD_PORT || '3100', 10);
const HOME = '/Users/boty';

// Discover all nanoclaw instances by scanning for .env files
function discoverInstances() {
  const instances = [];
  try {
    const entries = fs.readdirSync(HOME);
    for (const entry of entries) {
      if (!entry.startsWith('nanoclaw')) continue;
      const dir = path.join(HOME, entry);
      const envPath = path.join(dir, '.env');
      if (fs.existsSync(envPath) && (fs.existsSync(path.join(dir, 'src')) || fs.existsSync(path.join(dir, 'dist')))) {
        instances.push({ name: entry, dir });
      }
    }
  } catch (e) {
    // fallback
  }
  // Ensure primary is first
  instances.sort((a, b) => {
    if (a.name === 'nanoclaw') return -1;
    if (b.name === 'nanoclaw') return 1;
    return a.name.localeCompare(b.name);
  });
  return instances;
}

// Parse .env file into key-value pairs
function parseEnv(envPath) {
  const result = {};
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  } catch (e) { /* missing file */ }
  return result;
}

// Read last N lines of a file efficiently
function readLastLines(filePath, n) {
  try {
    const stat = fs.statSync(filePath);
    const bufSize = Math.min(stat.size, n * 4000); // ~4KB per line for logs with stack traces
    const buf = Buffer.alloc(bufSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, bufSize, Math.max(0, stat.size - bufSize));
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch (e) {
    return [];
  }
}

// Parse JSON log lines
function parseLogLines(lines) {
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch (e) { /* skip */ }
  }
  return parsed;
}

// Check if a process is running for an instance
function getProcessInfo(instanceName) {
  try {
    let serviceName;
    if (instanceName === 'nanoclaw') {
      serviceName = 'com.nanoclaw';
    } else {
      const suffix = instanceName.replace('nanoclaw-', '');
      serviceName = `com.nanoclaw.${suffix}`;
    }

    const output = execSync(`launchctl list 2>/dev/null | grep '${serviceName}$'`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (output) {
      const parts = output.split(/\s+/);
      const pid = parts[0];
      const lastExitCode = parts[1];
      if (pid && pid !== '-') {
        let startTime = null;
        try {
          // Use etime (elapsed time) which is locale-independent: [[DD-]HH:]MM:SS
          const etimeOut = execSync(`ps -p ${pid} -o etime=`, {
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();
          if (etimeOut) {
            let totalSecs = 0;
            const dayMatch = etimeOut.match(/^(\d+)-/);
            const timePart = etimeOut.replace(/^\d+-/, '');
            const parts = timePart.split(':').map(Number);
            if (parts.length === 3) totalSecs = parts[0] * 3600 + parts[1] * 60 + parts[2];
            else if (parts.length === 2) totalSecs = parts[0] * 60 + parts[1];
            if (dayMatch) totalSecs += parseInt(dayMatch[1], 10) * 86400;
            startTime = new Date(Date.now() - totalSecs * 1000).toISOString();
          }
        } catch (e) { /* */ }
        return { running: true, pid: parseInt(pid, 10), startTime, serviceName, lastExitCode };
      }
      return { running: false, pid: null, startTime: null, serviceName, lastExitCode };
    }
    return { running: false, pid: null, startTime: null, serviceName, lastExitCode: null };
  } catch (e) {
    return { running: false, pid: null, startTime: null, serviceName: null, lastExitCode: null };
  }
}

// Count running docker containers for a prefix
function getContainerCount(containerPrefix) {
  try {
    const output = execSync(`docker ps --filter "name=${containerPrefix}" --format "{{.Names}}" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (!output) return 0;
    return output.split('\n').length;
  } catch (e) {
    return 0;
  }
}

// Extract channel status, last activity, and error count from logs
function analyzeLog(logDir) {
  const logPath = path.join(logDir, 'nanoclaw.log');
  // Read many lines — noisy logs (stack traces) can push connection messages far back
  const lines = readLastLines(logPath, 2000);
  const entries = parseLogLines(lines);

  const channels = new Set();
  let lastActivity = null;
  let errorCount = 0;
  const oneHourAgo = Date.now() - 3600000;

  for (const entry of entries) {
    const ts = entry.time || 0;
    const msg = entry.msg || '';

    // Detect channel connections
    if (msg.includes('Gmail channel connected')) channels.add('gmail');
    if (msg.includes('connected to WA') || msg.includes('WhatsApp connected')) channels.add('whatsapp');
    if (msg.includes('Telegram connected') || msg.includes('telegram connected') || msg.includes('Telegram bot started')) channels.add('telegram');
    if (msg.includes('Discord connected') || msg.includes('discord connected') || msg.includes('Discord bot ready')) channels.add('discord');
    if (msg.includes('Slack connected') || msg.includes('slack connected') || msg.includes('Slack bot started')) channels.add('slack');

    // Track last activity
    if (msg.includes('Agent output') || msg.includes('invoking agent') ||
        msg.includes('Running scheduled task') || msg.includes('Container started') ||
        msg.includes('new messages for')) {
      if (!lastActivity || ts > lastActivity) lastActivity = ts;
    }

    // Count errors in last hour (level 50 = error, level 60 = fatal)
    if ((entry.level >= 50) && ts > oneHourAgo) {
      errorCount++;
    }
  }

  return {
    channels: Array.from(channels).sort(),
    lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
    errorCount,
  };
}

// Build status for one instance
function getInstanceStatus(instance) {
  const env = parseEnv(path.join(instance.dir, '.env'));
  const processInfo = getProcessInfo(instance.name);
  const containerPrefix = env.CONTAINER_PREFIX || instance.name;
  const containerCount = getContainerCount(containerPrefix);
  const logAnalysis = analyzeLog(path.join(instance.dir, 'logs'));

  return {
    name: instance.name,
    assistantName: env.ASSISTANT_NAME || instance.name,
    status: processInfo.running ? 'running' : 'stopped',
    pid: processInfo.pid,
    uptime: processInfo.startTime,
    serviceName: processInfo.serviceName,
    lastExitCode: processInfo.lastExitCode,
    channels: logAnalysis.channels,
    lastActivity: logAnalysis.lastActivity,
    activeContainers: containerCount,
    errors: logAnalysis.errorCount,
    port: env.CREDENTIAL_PROXY_PORT || (instance.name === 'nanoclaw' ? '3001' : null),
    model: env.CLAUDE_MODEL || 'unknown',
    containerPrefix,
  };
}

// Build status JSON
function getStatus() {
  const instances = discoverInstances();
  const statuses = instances.map(getInstanceStatus);

  const summary = {
    total: statuses.length,
    running: statuses.filter(s => s.status === 'running').length,
    totalContainers: statuses.reduce((sum, s) => sum + s.activeContainers, 0),
    totalErrors: statuses.reduce((sum, s) => sum + s.errors, 0),
    timestamp: new Date().toISOString(),
  };

  return { summary, agents: statuses };
}

// HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/status') {
    try {
      const data = getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load dashboard HTML');
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NanoClaw Dashboard running on http://localhost:${PORT}`);
});
