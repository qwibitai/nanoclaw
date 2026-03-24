#!/usr/bin/env node
/**
 * Sovereign MCP proxy — routes /mcp and /sse for mcp.jorgenclaw.ai
 *
 * Handles SSE→Streamable HTTP bridging natively — no supergateway needed.
 *
 * Routes:
 *   POST /mcp      → bridges to localhost:3002 SSE (Streamable HTTP interface)
 *   GET  /sse      → localhost:3002 (native SSE, backward compat)
 *   POST /messages → localhost:3002 (SSE message endpoint)
 *   GET  /health   → localhost:3002 (health check)
 *   *              → 404
 */

import { createServer, request as httpRequest, get as httpGet } from 'http';

const PORT = 3004;
const SSE_PORT = 3002;

function proxy(req, res, targetPort) {
  const proxyReq = httpRequest(
    {
      hostname: 'localhost',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on('error', (err) => {
    console.error(`[sovereign-proxy] Error proxying to port ${targetPort}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend unavailable' }));
    }
  });

  req.pipe(proxyReq, { end: true });
}

/**
 * Bridge Streamable HTTP → SSE transport.
 *
 * 1. Open SSE connection to /sse on port 3002
 * 2. Wait for the 'endpoint' event to get the sessionId
 * 3. POST the client's JSON-RPC body to /messages?sessionId=X
 * 4. Collect JSON-RPC responses from the SSE stream
 * 5. Return collected responses and close
 */
function handleStreamableHttp(req, res) {
  // Read the incoming JSON-RPC body
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    // Step 1: Open SSE session
    const sseReq = httpGet(
      { hostname: 'localhost', port: SSE_PORT, path: '/sse', headers: { Accept: 'text/event-stream' } },
      (sseRes) => {
        let sseBuf = '';
        let sessionEndpoint = null;
        let responded = false;
        const collectedEvents = [];

        const cleanup = () => {
          sseRes.destroy();
          sseReq.destroy();
        };

        // Timeout: if no response within 30s, bail
        const timeout = setTimeout(() => {
          if (!responded) {
            responded = true;
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'SSE bridge timeout' }));
            cleanup();
          }
        }, 30000);

        sseRes.on('data', (chunk) => {
          sseBuf += chunk.toString();

          // Parse SSE events
          const parts = sseBuf.split('\n\n');
          sseBuf = parts.pop(); // keep incomplete event in buffer

          for (const part of parts) {
            const lines = part.split('\n');
            let eventType = null;
            let eventData = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) eventType = line.slice(7).trim();
              else if (line.startsWith('data: ')) eventData = line.slice(6);
            }

            // Step 2: Capture the endpoint event to get sessionId
            if (eventType === 'endpoint' && eventData && !sessionEndpoint) {
              sessionEndpoint = eventData;

              // Step 3: POST the JSON-RPC body to the messages endpoint
              const messagesReq = httpRequest(
                {
                  hostname: 'localhost',
                  port: SSE_PORT,
                  path: sessionEndpoint,
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                },
                (messagesRes) => {
                  // The POST response is just an ack (202 or similar)
                  messagesRes.resume();
                },
              );
              messagesReq.on('error', (err) => {
                console.error('[sovereign-proxy] Error posting message:', err.message);
                if (!responded) {
                  responded = true;
                  clearTimeout(timeout);
                  res.writeHead(502, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Failed to send message to MCP server' }));
                  cleanup();
                }
              });
              messagesReq.write(body);
              messagesReq.end();
              continue;
            }

            // Step 4: Collect JSON-RPC response events
            if (eventType === 'message' && eventData) {
              try {
                const parsed = JSON.parse(eventData);
                collectedEvents.push(parsed);

                // If this is a JSON-RPC response (has 'result' or 'error'), we're done
                if (parsed.jsonrpc && (parsed.result !== undefined || parsed.error !== undefined)) {
                  if (!responded) {
                    responded = true;
                    clearTimeout(timeout);
                    res.writeHead(200, {
                      'Content-Type': 'application/json',
                      'Access-Control-Allow-Origin': '*',
                    });
                    res.end(JSON.stringify(parsed));
                    cleanup();
                  }
                }
              } catch {
                // Not JSON, skip
              }
            }
          }
        });

        sseRes.on('end', () => {
          if (!responded) {
            responded = true;
            clearTimeout(timeout);
            if (collectedEvents.length > 0) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(collectedEvents[collectedEvents.length - 1]));
            } else {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No response from MCP server' }));
            }
          }
        });

        sseRes.on('error', (err) => {
          console.error('[sovereign-proxy] SSE stream error:', err.message);
          if (!responded) {
            responded = true;
            clearTimeout(timeout);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'SSE connection failed' }));
          }
        });
      },
    );

    sseReq.on('error', (err) => {
      console.error('[sovereign-proxy] Failed to connect to SSE:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'MCP server unavailable' }));
      }
    });
  });
}

const server = createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (urlPath === '/mcp' && req.method === 'POST') {
    handleStreamableHttp(req, res);
  } else if (urlPath === '/sse' || urlPath === '/messages' || urlPath === '/health') {
    proxy(req, res, SSE_PORT);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /mcp (Streamable HTTP) or /sse (legacy).' }));
  }
});

server.listen(PORT, () => {
  console.log(`[sovereign-proxy] Listening on port ${PORT}`);
  console.log(`[sovereign-proxy]   POST /mcp  → SSE bridge to localhost:${SSE_PORT}`);
  console.log(`[sovereign-proxy]   GET  /sse  → localhost:${SSE_PORT} (native SSE)`);
  console.log(`[sovereign-proxy]   GET  /health → localhost:${SSE_PORT}`);
});
