/**
 * JSON-RPC 2.0 transport over stdin/stdout for container<->host communication.
 *
 * Stdout interception: all non-JSON-RPC stdout is wrapped in a "log" notification
 * so the host can distinguish protocol messages from debug output.
 */

import {
  JSONRPCClient,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0';

// Capture real stdout BEFORE any other code writes to it
const realStdoutWrite = process.stdout.write.bind(process.stdout);

// NUL byte prefix for JSON-RPC framing — no logger produces this,
// so we can reliably distinguish protocol messages from debug output.
const RPC_PREFIX = '\0';

// Replace stdout.write: lines starting with RPC_PREFIX pass through;
// everything else gets wrapped in a JSON-RPC "log" notification.
process.stdout.write = ((
  data: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void,
): boolean => {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString();
  if (text.startsWith(RPC_PREFIX)) {
    if (typeof encodingOrCallback === 'function') {
      return realStdoutWrite(data, encodingOrCallback);
    }
    return realStdoutWrite(data, encodingOrCallback, callback);
  }
  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method: 'log',
    params: { text },
  });
  return realStdoutWrite(RPC_PREFIX + notification + '\n');
}) as typeof process.stdout.write;

export { realStdoutWrite };

type TransportEvent =
  | { type: 'input'; text: string }
  | { type: 'close' };

export class JsonRpcTransport {
  private serverAndClient: JSONRPCServerAndClient;
  private eventQueue: TransportEvent[] = [];
  private eventWaiter: ((event: TransportEvent | null) => void) | null = null;
  private closed = false;
  private initResolve!: (input: any) => void;
  readonly initialized: Promise<any>;

  constructor() {
    this.initialized = new Promise((resolve) => {
      this.initResolve = resolve;
    });

    const server = new JSONRPCServer();
    const client = new JSONRPCClient((jsonRPCMessage) => {
      realStdoutWrite(RPC_PREFIX + JSON.stringify(jsonRPCMessage) + '\n');
    });

    this.serverAndClient = new JSONRPCServerAndClient(server, client);

    // Register server methods (host -> container)
    this.serverAndClient.addMethod(
      'initialize',
      (params: any) => {
        this.initResolve(params);
        return { ok: true };
      },
    );

    this.serverAndClient.addMethod(
      'input',
      (params: { text: string }) => {
        this.pushEvent({ type: 'input', text: params.text });
        return { ok: true };
      },
    );

    this.serverAndClient.addMethod(
      'close',
      () => {
        this.pushEvent({ type: 'close' });
        return { ok: true };
      },
    );

    // Read stdin line-by-line for JSON-RPC messages
    let buffer = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // Keep incomplete last line in buffer

      for (const line of lines) {
        if (line.startsWith(RPC_PREFIX)) {
          try {
            const parsed = JSON.parse(line.slice(RPC_PREFIX.length));
            this.serverAndClient.receiveAndSend(parsed);
          } catch {
            // Malformed JSON-RPC — ignore
          }
        }
        // Lines without prefix are non-protocol (startup noise) — ignore
      }
    });

    process.stdin.on('end', () => {
      this.closed = true;
      if (this.eventWaiter) {
        this.eventWaiter(null);
        this.eventWaiter = null;
      }
    });
  }

  async nextEvent(): Promise<TransportEvent | null> {
    if (this.eventQueue.length > 0) {
      return this.eventQueue.shift()!;
    }
    if (this.closed) {
      return null;
    }
    return new Promise((resolve) => {
      this.eventWaiter = resolve;
    });
  }

  cancelWait(): void {
    if (this.eventWaiter) {
      this.eventWaiter(null);
      this.eventWaiter = null;
    }
  }

  /** Push events back to the front of the queue (e.g. unconsumed input). */
  unshift(...events: TransportEvent[]): void {
    this.eventQueue.unshift(...events);
  }

  sendRequest(method: string, params?: any): PromiseLike<any> {
    return this.serverAndClient.request(method, params);
  }

  sendNotification(method: string, params?: any): void {
    this.serverAndClient.notify(method, params);
  }

  private pushEvent(event: TransportEvent): void {
    if (this.eventWaiter) {
      const waiter = this.eventWaiter;
      this.eventWaiter = null;
      waiter(event);
    } else {
      this.eventQueue.push(event);
    }
  }
}
