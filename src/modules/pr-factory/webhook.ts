import crypto from 'crypto';
import http from 'http';

import { log } from '../../log.js';

export interface PREvent {
  action: string;
  number: number;
  title: string;
  body: string;
  author: string;
  repoFullName: string;
  headSha: string;
  diffUrl: string;
  htmlUrl: string;
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function startWebhookServer(
  secret: string,
  port: number,
  onPullRequest: (pr: PREvent) => Promise<void>,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook/github') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const signature = req.headers['x-hub-signature-256'] as string;

      if (!signature || !verifySignature(body, signature, secret)) {
        log.warn('GitHub webhook: invalid signature');
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }

      res.writeHead(200);
      res.end('OK');

      const event = req.headers['x-github-event'] as string;
      if (event !== 'pull_request') return;

      try {
        const payload = JSON.parse(body);
        if (payload.action !== 'opened') return;

        const pr = payload.pull_request;
        const prEvent: PREvent = {
          action: payload.action,
          number: pr.number,
          title: pr.title,
          body: pr.body || '',
          author: pr.user.login,
          repoFullName: payload.repository.full_name,
          headSha: pr.head.sha,
          diffUrl: pr.diff_url,
          htmlUrl: pr.html_url,
        };

        log.info('GitHub webhook: PR opened', { pr: prEvent.number, repo: prEvent.repoFullName });

        onPullRequest(prEvent).catch((err) => {
          log.error('Failed to handle PR event', { err, pr: prEvent.number });
        });
      } catch (err) {
        log.error('GitHub webhook: failed to parse payload', { err });
      }
    });
  });

  server.listen(port, () => {
    log.info('GitHub webhook server listening', { port });
  });

  return server;
}
