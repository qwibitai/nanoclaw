/**
 * Probe whether an AgentLite BoxLite guest can reach host services via
 * the gvproxy gateway (default 192.168.127.1).
 *
 *   npx tsx scripts/test-host-reach.ts
 *
 * What it does:
 *   1. Starts an HTTP server on host:19999 serving a sentinel string
 *   2. Spawns a BoxLite box with networkEnabled: true
 *   3. From inside the box, tries curl against several plausible host addresses
 *   4. Prints the results and cleans up
 */

import http from 'http';
import { JsBoxlite } from '@boxlite-ai/boxlite';

const SENTINEL = 'boxlite-host-reach-ok';
const PORT = 19999;

async function main() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(SENTINEL);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`[host] listening on 127.0.0.1:${PORT} (loopback only)`);

  const rt = new JsBoxlite({ homeDir: '/tmp/boxlite-probe-home' });
  let box: any;
  try {
    box = await rt.create(
      {
        image: 'alpine:latest',
        memoryMib: 512,
        cpus: 1,
        autoRemove: true,
        security: { networkEnabled: true },
      },
      `host-reach-${Date.now()}`,
    );
    console.log('[host] box created');

    const drain = async (stream: any): Promise<string> => {
      let buf = '';
      try {
        while (true) {
          const line = await stream.next();
          if (line === null || line === undefined) break;
          buf += line;
        }
      } catch {
        /* stream closed */
      }
      return buf;
    };

    const runInGuest = async (label: string, script: string) => {
      const handle = await box.exec(
        '/bin/sh',
        ['-c', script],
        null,
        false,
        null,
        30,
        '/',
      );
      const stdoutStream = await handle.stdout();
      const stderrStream = await handle.stderr();
      const [out, err] = await Promise.all([
        drain(stdoutStream),
        drain(stderrStream),
      ]);
      let exit: unknown = '?';
      try {
        exit = await handle.wait();
      } catch {
        /* ignore */
      }
      console.log(`[guest] ${label}: exit=${JSON.stringify(exit)}`);
      if (out.trim()) console.log(`  stdout: ${out.trim()}`);
      if (err.trim()) console.log(`  stderr: ${err.trim()}`);
    };

    // Network diagnostics
    await runInGuest('ip-addr', 'ip addr 2>&1 || ifconfig 2>&1');
    await runInGuest('ip-route', 'ip route 2>&1 || route -n 2>&1');
    await runInGuest('resolv', 'cat /etc/resolv.conf 2>&1');
    // Install curl (proves outbound works)
    await runInGuest(
      'install-curl',
      'apk add --no-cache curl 2>&1 | tail -3',
    );
    // Try candidate host addresses
    for (const addr of [
      '192.168.127.254', // gvproxy host-loopback alias
      '192.168.127.253',
      '192.168.127.1',
      '192.168.124.3', // host LAN IP
    ]) {
      await runInGuest(
        `curl-${addr}`,
        `curl -sS --max-time 3 http://${addr}:${PORT}/ 2>&1 || echo FAIL`,
      );
    }
  } finally {
    try {
      await box?.stop();
    } catch {
      /* ignore */
    }
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
