import http from 'http';

import QRCode from 'qrcode';

import { logger } from './logger.js';

export interface HttpServer {
  setQrCode(qr: string): void;
  setAuthenticated(): void;
}

export function startHttpServer(port: number): HttpServer {
  let latestQr: string | null = null;
  let isAuthenticated = false;

  const adminToken = process.env.ADMIN_TOKEN;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          whatsapp: isAuthenticated ? 'connected' : 'pending',
        }),
      );
      return;
    }

    if (url.pathname === '/qr') {
      if (adminToken && url.searchParams.get('token') !== adminToken) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized — add ?token=ADMIN_TOKEN to the URL');
        return;
      }

      if (isAuthenticated) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>✅ WhatsApp connected</h1><p>You can close this page.</p></body></html>',
        );
        return;
      }

      if (!latestQr) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        res.end(
          '<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>⏳ QR code not ready yet</h1><p>Refreshing automatically...</p></body></html>',
        );
        return;
      }

      let qrDataUrl: string;
      try {
        qrDataUrl = await QRCode.toDataURL(latestQr, { scale: 8 });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to generate QR code');
        logger.error({ err }, 'Failed to generate QR data URL');
        return;
      }

      const html = `<!DOCTYPE html>
<html>
<head>
  <title>NanoClaw — WhatsApp QR</title>
  <meta http-equiv="refresh" content="30">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: sans-serif; text-align: center; padding: 40px; background: #f0f2f5; }
    .card { background: white; border-radius: 16px; padding: 40px; display: inline-block; box-shadow: 0 2px 16px rgba(0,0,0,.1); }
    img { display: block; margin: 24px auto; }
    h1 { color: #128c7e; }
    p { color: #555; margin: 8px 0; }
    .hint { font-size: 13px; color: #888; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>NanoClaw</h1>
    <p>Scan this QR code with WhatsApp on your phone.</p>
    <p><strong>WhatsApp → Linked Devices → Link a Device</strong></p>
    <img src="${qrDataUrl}" alt="WhatsApp QR Code" />
    <p class="hint">QR expires ~60 seconds after generation. Page auto-refreshes every 30s.</p>
  </div>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    const tokenHint = adminToken ? `?token=${adminToken}` : '';
    logger.info(
      { port },
      `HTTP server started — QR auth: http://localhost:${port}/qr${tokenHint}`,
    );
  });

  return {
    setQrCode(qr: string) {
      latestQr = qr;
      isAuthenticated = false;
      logger.info('WhatsApp QR code updated — visit /qr to authenticate');
    },
    setAuthenticated() {
      isAuthenticated = true;
      latestQr = null;
      logger.info('WhatsApp authenticated successfully');
    },
  };
}
