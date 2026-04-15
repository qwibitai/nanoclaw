import http from 'http';

const host = process.env.SKILL_SERVER_HOST || '127.0.0.1';
const port = parseInt(process.env.SKILL_SERVER_PORT || '3002', 10);
const timeoutMs = parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '30000', 10);
const intervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '1000', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: host,
        port,
        path: '/health',
        timeout: Math.min(intervalMs, 5000),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Health check timed out'));
    });
  });
}

const deadline = Date.now() + timeoutMs;
let lastError = 'Health endpoint did not return status=ok.';

while (Date.now() < deadline) {
  try {
    const snapshot = await fetchHealth();
    if (snapshot?.status === 'ok') {
      console.log(
        `Health OK on ${host}:${port} (${snapshot.runtime?.kind ?? 'unknown-runtime'}, channels=${snapshot.channels?.active?.length ?? 0})`,
      );
      process.exit(0);
    }

    lastError = JSON.stringify(snapshot);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  await sleep(intervalMs);
}

console.error(`Health check failed for ${host}:${port}: ${lastError}`);
process.exit(1);
