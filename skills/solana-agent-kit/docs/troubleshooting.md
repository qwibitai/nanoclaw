# Troubleshooting Guide

Common issues and solutions when using Solana Agent Kit.

## Installation Issues

### Error: Cannot find module 'solana-agent-kit'

**Cause**: Package not installed or incorrect import path.

**Solution**:
```bash
# Install the package
npm install solana-agent-kit

# If using plugins, install them separately
npm install @solana-agent-kit/plugin-token @solana-agent-kit/plugin-defi
```

### Error: Module not found '@solana/web3.js'

**Cause**: Peer dependency not installed.

**Solution**:
```bash
npm install @solana/web3.js @solana/spl-token
```

### TypeScript errors with imports

**Cause**: TypeScript configuration or version mismatch.

**Solution**:
```json
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "esModuleInterop": true,
    "target": "ES2020",
    "module": "commonjs"
  }
}
```

---

## Wallet & Key Issues

### Error: Invalid private key format

**Cause**: Private key is not properly formatted.

**Solution**:
```typescript
// Base58 format (Phantom export)
const privateKey = "your_base58_key";
const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));

// JSON array format (Solana CLI)
const privateKey = "[1,2,3,4,...]";
const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(privateKey)));

// File path (Solana CLI default)
const keyfile = fs.readFileSync("/path/to/keypair.json", "utf8");
const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(keyfile)));
```

### Error: Wallet not connected

**Cause**: Wallet not properly initialized before use.

**Solution**:
```typescript
// Ensure wallet is created before agent
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY!));
const wallet = new KeypairWallet(keypair);

// Pass wallet to agent
const agent = new SolanaAgentKit(wallet, rpcUrl, options);
```

### Error: Insufficient funds

**Cause**: Wallet doesn't have enough SOL for transaction + fees.

**Solution**:
```bash
# Check balance
solana balance <your-address>

# On devnet, request airdrop
solana airdrop 2 <your-address> --url devnet

# Or use agent
await agent.methods.requestFaucet({ amount: 2 });
```

---

## RPC Connection Issues

### Error: 429 Too Many Requests

**Cause**: RPC rate limits exceeded.

**Solution**:
```typescript
// Use a premium RPC provider
const RPC_URL = "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY";

// Or implement rate limiting
import Bottleneck from "bottleneck";

const limiter = new Bottleneck({
  minTime: 100,
  maxConcurrent: 5,
});

// Wrap your RPC calls
const rateLimitedBalance = limiter.wrap(async () => {
  return connection.getBalance(pubkey);
});
```

### Error: WebSocket connection failed

**Cause**: WebSocket endpoint issues or firewall blocking.

**Solution**:
```typescript
// Use HTTP commitment instead of WebSocket subscriptions
const connection = new Connection(rpcUrl, {
  commitment: "confirmed",
  wsEndpoint: undefined, // Disable WebSocket
});

// Poll instead of subscribe
async function pollBalance(pubkey: PublicKey, intervalMs = 5000) {
  setInterval(async () => {
    const balance = await connection.getBalance(pubkey);
    console.log("Balance:", balance);
  }, intervalMs);
}
```

### Error: Connection timeout

**Cause**: Network issues or slow RPC.

**Solution**:
```typescript
// Increase timeout
const connection = new Connection(rpcUrl, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000, // 60 seconds
});

// Implement retry logic
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("Max retries exceeded");
}
```

---

## Transaction Issues

### Error: Transaction simulation failed

**Cause**: Various - insufficient funds, invalid accounts, program error.

**Solution**:
```typescript
// Simulate first to get detailed error
const simulation = await connection.simulateTransaction(transaction);

if (simulation.value.err) {
  console.error("Simulation error:", simulation.value.err);
  console.error("Logs:", simulation.value.logs);
}

// Common causes:
// - "insufficient funds" -> need more SOL
// - "account not found" -> wrong address or account not created
// - "custom program error" -> check program-specific error codes
```

### Error: Blockhash not found / expired

**Cause**: Transaction took too long to confirm.

**Solution**:
```typescript
// Get fresh blockhash
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

transaction.recentBlockhash = blockhash;
transaction.lastValidBlockHeight = lastValidBlockHeight;

// Use with confirmation
const signature = await sendAndConfirmTransaction(
  connection,
  transaction,
  [signer],
  {
    maxRetries: 5,
    skipPreflight: false,
  }
);
```

### Error: Transaction too large

**Cause**: Transaction exceeds 1232 byte limit.

**Solution**:
```typescript
// Split into multiple transactions
const chunks = splitInstructions(instructions, 5); // 5 per tx

for (const chunk of chunks) {
  const tx = new Transaction().add(...chunk);
  await sendAndConfirmTransaction(connection, tx, [signer]);
}

// Or use versioned transactions with lookup tables
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash,
  instructions,
}).compileToV0Message([lookupTable]);

const tx = new VersionedTransaction(message);
```

### Error: Slippage tolerance exceeded

**Cause**: Price moved during swap execution.

**Solution**:
```typescript
// Increase slippage (careful!)
await agent.methods.trade({
  outputMint: "USDC_MINT",
  inputAmount: 1,
  inputMint: "SOL_MINT",
  slippageBps: 100, // 1% slippage (default is usually 50 = 0.5%)
});

// Or use dynamic slippage based on liquidity
const tokenInfo = await getTokenLiquidity(mint);
const slippage = tokenInfo.liquidity < 100000 ? 300 : 50; // 3% for low liquidity
```

---

## LLM Integration Issues

### Error: OpenAI API rate limit

**Cause**: Too many requests to OpenAI.

**Solution**:
```typescript
// Add delays between requests
async function rateLimitedChat(prompt: string) {
  await new Promise((r) => setTimeout(r, 1000)); // 1 second delay
  return agent.chat(prompt);
}

// Use exponential backoff
async function withBackoff(fn: () => Promise<any>, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.message.includes("rate limit")) {
        const delay = Math.pow(2, i) * 1000;
        console.log(`Rate limited, waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
}
```

### Error: Tool not found / hallucinated tool

**Cause**: LLM calling non-existent tool.

**Solution**:
```typescript
// List available tools explicitly in system prompt
const availableTools = tools.map((t) => t.name).join(", ");

const systemPrompt = `You are a Solana assistant.
Available tools: ${availableTools}

ONLY use tools from this list. If a user asks for something not supported, explain what you CAN do instead.`;

// Reduce temperature for more deterministic tool selection
const llm = new ChatOpenAI({
  modelName: "gpt-4-turbo-preview",
  temperature: 0.3, // Lower = more consistent
});
```

### Error: Context length exceeded

**Cause**: Too much conversation history or tool output.

**Solution**:
```typescript
// Summarize long tool outputs
function summarizeToolOutput(output: any): string {
  if (typeof output === "string" && output.length > 1000) {
    return output.substring(0, 1000) + "... (truncated)";
  }
  return JSON.stringify(output).substring(0, 1000);
}

// Implement conversation pruning
function pruneHistory(messages: Message[], maxTokens = 8000): Message[] {
  // Keep system message + recent messages
  const system = messages.find((m) => m.role === "system");
  const recent = messages.slice(-10);

  return system ? [system, ...recent] : recent;
}
```

---

## Plugin Issues

### Error: Plugin not registered

**Cause**: Plugin not added to agent.

**Solution**:
```typescript
// Make sure to chain .use() calls
const agent = new SolanaAgentKit(wallet, rpcUrl, options)
  .use(TokenPlugin)
  .use(NFTPlugin)
  .use(DefiPlugin);

// Check registered plugins
console.log("Plugins:", agent.plugins.map((p) => p.name));
console.log("Actions:", agent.actions.map((a) => a.name));
```

### Error: Action not available

**Cause**: Required plugin not loaded or action not exported.

**Solution**:
```typescript
// List all available actions
for (const action of agent.actions) {
  console.log(`${action.name}: ${action.description}`);
}

// Check if specific action exists
const hasAction = agent.actions.some((a) => a.name === "trade");
if (!hasAction) {
  console.log("Install DefiPlugin for trading");
}
```

---

## MCP Server Issues

### Claude Desktop not detecting MCP server

**Cause**: Config file syntax error or wrong path.

**Solution**:
```bash
# Validate JSON syntax
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | jq

# Check file permissions
ls -la ~/Library/Application\ Support/Claude/

# Verify node path
which node
which npx
```

**Correct config**:
```json
{
  "mcpServers": {
    "solana": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://api.devnet.solana.com",
        "SOLANA_PRIVATE_KEY": "your_base58_key"
      }
    }
  }
}
```

### MCP server crashes on startup

**Cause**: Missing environment variables or invalid config.

**Solution**:
```bash
# Test MCP server directly
RPC_URL=https://api.devnet.solana.com \
SOLANA_PRIVATE_KEY=your_key \
npx solana-mcp

# Check for errors in output
```

---

## Performance Issues

### Slow response times

**Cause**: Multiple sequential RPC calls or slow LLM.

**Solution**:
```typescript
// Batch RPC calls
const [balance, accounts, recentTxs] = await Promise.all([
  connection.getBalance(pubkey),
  connection.getTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
  connection.getSignaturesForAddress(pubkey, { limit: 10 }),
]);

// Use smaller/faster models for simple tasks
const llm = new ChatOpenAI({
  modelName: "gpt-3.5-turbo", // Faster for simple queries
});

// Cache frequently accessed data
const cache = new Map<string, { data: any; expiry: number }>();

async function cachedGetBalance(pubkey: PublicKey): Promise<number> {
  const key = pubkey.toBase58();
  const cached = cache.get(key);

  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }

  const balance = await connection.getBalance(pubkey);
  cache.set(key, { data: balance, expiry: Date.now() + 30000 }); // 30s cache
  return balance;
}
```

### High costs

**Cause**: Too many LLM calls or expensive model.

**Solution**:
```typescript
// Use cheaper models when possible
const cheapLLM = new ChatOpenAI({ modelName: "gpt-3.5-turbo" });
const expensiveLLM = new ChatOpenAI({ modelName: "gpt-4-turbo" });

// Route based on complexity
function selectModel(prompt: string) {
  const complexKeywords = ["analyze", "strategy", "compare", "explain"];
  const isComplex = complexKeywords.some((k) => prompt.toLowerCase().includes(k));
  return isComplex ? expensiveLLM : cheapLLM;
}

// Track token usage
const result = await generateText({
  model,
  prompt,
  onFinish: ({ usage }) => {
    console.log(`Tokens: ${usage.promptTokens} + ${usage.completionTokens}`);
  },
});
```

---

## Quick Diagnostic Checklist

When something doesn't work:

1. **Check environment variables**:
   ```bash
   echo $SOLANA_PRIVATE_KEY  # Should be set
   echo $RPC_URL             # Should be valid URL
   echo $OPENAI_API_KEY      # Should start with sk-
   ```

2. **Verify wallet balance**:
   ```bash
   solana balance <address> --url <rpc>
   ```

3. **Test RPC connection**:
   ```bash
   curl $RPC_URL -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```

4. **Check Node.js version**:
   ```bash
   node --version  # Should be 16+
   ```

5. **Verify package installation**:
   ```bash
   npm list solana-agent-kit
   npm list @langchain/openai
   ```

6. **Enable verbose logging**:
   ```typescript
   process.env.DEBUG = "solana-agent-kit:*";
   ```
