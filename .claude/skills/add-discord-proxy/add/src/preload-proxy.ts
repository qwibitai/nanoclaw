// Preload script for proxy support
// Run with: node --import ./dist/preload-proxy.js dist/index.js

import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Read proxy from .env or environment
function getProxy(): string | undefined {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (envProxy) return envProxy;

  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('HTTPS_PROXY=') || trimmed.startsWith('HTTP_PROXY=')) {
        const eqIdx = trimmed.indexOf('=');
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch { /* .env not found */ }
  return undefined;
}

const proxy = getProxy();
if (proxy) {
  console.log(`[Preload] Setting up proxy: ${proxy}`);

  // Set up undici proxy for HTTP requests
  const proxyAgent = new ProxyAgent(proxy);
  setGlobalDispatcher(proxyAgent);

  // Set environment variables
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxy;

  // Patch ws module for WebSocket proxy
  const httpsAgent = new HttpsProxyAgent(proxy);
  const Module = require('module');
  const originalLoad = Module._load;

  Module._load = function(request: string, parent: any, isMain: boolean) {
    const result = originalLoad.apply(this, [request, parent, isMain]);

    if (request === 'ws') {
      const OriginalWebSocket = result.WebSocket || result;
      const proxiedWs = class extends OriginalWebSocket {
        constructor(address: any, protocols?: any, options?: any) {
          super(address, protocols, { ...options, agent: httpsAgent });
        }
      };
      return { ...result, WebSocket: proxiedWs, default: proxiedWs };
    }

    return result;
  };

  console.log(`[Preload] Proxy setup complete`);
}
