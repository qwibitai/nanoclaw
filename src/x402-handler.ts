/**
 * Host-side x402 payment handler.
 * Watches IPC directories for x402 requests from containers.
 * Makes the actual HTTP requests with wallet credentials.
 * Private key never enters the container.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const X402_POLL_INTERVAL = 500; // 500ms — fast enough for request/response

let x402Running = false;
let _walletReady = false;
let fetchWithPayment: typeof fetch | null = null;

async function initWallet(): Promise<boolean> {
  const secrets = readEnvFile(['BASE_WALLET_PRIVATE_KEY']);
  const privateKey = secrets.BASE_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    logger.debug('BASE_WALLET_PRIVATE_KEY not set, x402 handler disabled');
    return false;
  }

  try {
    // Dynamic imports (ESM packages)
    const { x402Client, wrapFetchWithPayment: wrap } =
      await import('@x402/fetch');
    const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account as any });
    fetchWithPayment = wrap(fetch, client);

    logger.info({ address: account.address }, 'x402 wallet initialized');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to initialize x402 wallet');
    return false;
  }
}

async function processRequest(
  requestPath: string,
  responsesDir: string,
): Promise<void> {
  let requestData: {
    id: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    max_price_usd: number;
  };

  try {
    requestData = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  } catch (err) {
    logger.error({ requestPath, err }, 'Failed to parse x402 request');
    fs.unlinkSync(requestPath);
    return;
  }

  // Remove request file (we've read it)
  try {
    fs.unlinkSync(requestPath);
  } catch {}

  const responsePath = path.join(responsesDir, `${requestData.id}.json`);

  if (!fetchWithPayment) {
    writeResponse(responsePath, { error: 'x402 wallet not initialized' });
    return;
  }

  logger.info(
    {
      id: requestData.id,
      url: requestData.url,
      maxPrice: requestData.max_price_usd,
    },
    'Processing x402 request',
  );

  try {
    const fetchOptions: RequestInit = {
      method: requestData.method,
      headers: requestData.headers,
    };
    if (requestData.body && requestData.method !== 'GET') {
      fetchOptions.body = requestData.body;
    }

    const response = await fetchWithPayment(requestData.url, fetchOptions);
    const bodyText = await response.text();

    // Check if payment was made (look for payment response header)
    const paymentHeader = response.headers.get('payment-response');
    let paid = false;
    let amountUsd: number | null = null;
    let txHash: string | null = null;

    if (paymentHeader) {
      try {
        // The payment-response header contains base64-encoded JSON
        const decoded = JSON.parse(
          Buffer.from(paymentHeader, 'base64').toString('utf-8'),
        );
        paid = true;
        amountUsd = decoded.amount ? parseFloat(decoded.amount) / 1e6 : null; // USDC has 6 decimals
        txHash = decoded.txHash || decoded.transaction || null;
      } catch {
        // Header exists but couldn't parse — payment likely happened
        paid = true;
      }
    }

    if (paid) {
      logger.info(
        {
          id: requestData.id,
          status: response.status,
          paid,
          amountUsd,
          txHash,
        },
        'x402 request completed with payment',
      );
    } else {
      logger.info(
        { id: requestData.id, status: response.status },
        'x402 request completed (no payment needed)',
      );
    }

    writeResponse(responsePath, {
      status: response.status,
      body: bodyText.slice(0, 50000), // Cap response size
      paid,
      amount_usd: amountUsd,
      tx_hash: txHash,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ id: requestData.id, err }, 'x402 request failed');
    writeResponse(responsePath, { error: errorMsg });
  }
}

function writeResponse(responsePath: string, data: object): void {
  fs.mkdirSync(path.dirname(responsePath), { recursive: true });
  // Atomic write: temp file then rename
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, responsePath);
}

export function startX402Handler(): void {
  if (x402Running) return;
  x402Running = true;

  // Init wallet asynchronously
  initWallet().then((ready) => {
    _walletReady = ready;
    if (!ready) {
      logger.debug('x402 handler not started (no wallet key)');
      x402Running = false;
      return;
    }

    const ipcBaseDir = path.join(DATA_DIR, 'ipc');

    const poll = async () => {
      try {
        // Scan all group IPC directories for x402 requests
        const groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
          try {
            return (
              fs.statSync(path.join(ipcBaseDir, f)).isDirectory() &&
              f !== 'errors'
            );
          } catch {
            return false;
          }
        });

        for (const group of groupFolders) {
          const requestsDir = path.join(ipcBaseDir, group, 'x402-requests');
          const responsesDir = path.join(ipcBaseDir, group, 'x402-responses');

          if (!fs.existsSync(requestsDir)) continue;

          const files = fs
            .readdirSync(requestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of files) {
            await processRequest(path.join(requestsDir, file), responsesDir);
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in x402 poll loop');
      }

      setTimeout(poll, X402_POLL_INTERVAL);
    };

    poll();
    logger.info('x402 handler started');
  });
}
