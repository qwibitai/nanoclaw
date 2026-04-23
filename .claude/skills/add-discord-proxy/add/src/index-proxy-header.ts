// Add this code at the VERY BEGINNING of src/index.ts
// BEFORE any other imports

// Configure proxy support BEFORE any other imports
// This ensures all HTTP/WebSocket requests use the proxy
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

// Read proxy config from .env file early (before other imports)
function readProxyFromEnv(): string | undefined {
  // First check process.env (for manual override)
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (envProxy) return envProxy;

  // Then read from .env file
  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('HTTPS_PROXY=') || trimmed.startsWith('HTTP_PROXY=')) {
        const eqIdx = trimmed.indexOf('=');
        let value = trimmed.slice(eqIdx + 1).trim();
        // Remove quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    // .env not found, ignore
  }
  return undefined;
}

const HTTPS_PROXY = readProxyFromEnv();

if (HTTPS_PROXY) {
  const proxyAgent = new HttpsProxyAgent(HTTPS_PROXY);
  console.log(`[Proxy] Proxy configured: ${HTTPS_PROXY}`);

  // Configure proxy for undici (HTTP requests)
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  const undiciProxyAgent = new ProxyAgent(HTTPS_PROXY);
  setGlobalDispatcher(undiciProxyAgent);

  // Patch global WebSocket to use proxy
  const OriginalWebSocket = WebSocket as any;
  // @ts-expect-error - Patching global WebSocket
  global.WebSocket = class extends OriginalWebSocket {
    constructor(address: string | URL, protocols?: any, options?: any) {
      super(address, protocols, { ...options, agent: proxyAgent });
    }
  };
  console.log(`[Proxy] WebSocket patched`);
}

// === AFTER the above code, continue with your original imports ===
// import fs from 'fs';
// import path from 'path';
// ... rest of imports
