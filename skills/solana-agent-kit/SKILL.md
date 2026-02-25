---
name: solana-agent-kit
description: Comprehensive guide for building AI agents that interact with Solana blockchain using SendAI's Solana Agent Kit. Covers 60+ actions, LangChain/Vercel AI integration, MCP server setup, and autonomous agent patterns.
---

# Solana Agent Kit Development Guide

Build AI agents that autonomously execute **60+ Solana blockchain operations** using SendAI's open-source toolkit. Compatible with LangChain, Vercel AI SDK, and Claude via MCP.

## Overview

The Solana Agent Kit enables any AI model to:
- Deploy and manage tokens (SPL & Token-2022)
- Create and trade NFTs via Metaplex
- Execute DeFi operations (Jupiter, Raydium, Orca, Meteora)
- Stake SOL, bridge tokens, register domains
- Run in interactive or fully autonomous modes

### Key Features

| Feature | Description |
|---------|-------------|
| **60+ Actions** | Token, NFT, DeFi, staking, bridging operations |
| **Plugin Architecture** | Modular - use only what you need |
| **Multi-Framework** | LangChain, Vercel AI SDK, MCP, Eliza |
| **Model Agnostic** | Works with OpenAI, Claude, Llama, Gemini |
| **Autonomous Mode** | Hands-off execution with error recovery |

## Quick Start

### Installation

```bash
# Core package
npm install solana-agent-kit

# With plugins (recommended)
npm install solana-agent-kit \
  @solana-agent-kit/plugin-token \
  @solana-agent-kit/plugin-nft \
  @solana-agent-kit/plugin-defi \
  @solana-agent-kit/plugin-misc \
  @solana-agent-kit/plugin-blinks
```

### Environment Setup

```bash
# .env file
OPENAI_API_KEY=your_openai_api_key
RPC_URL=https://api.mainnet-beta.solana.com  # or devnet
SOLANA_PRIVATE_KEY=your_base58_private_key

# Optional API keys for enhanced features
COINGECKO_API_KEY=your_coingecko_key
HELIUS_API_KEY=your_helius_key
```

### Basic Agent Setup

```typescript
import {
  SolanaAgentKit,
  createVercelAITools,
  KeypairWallet,
} from "solana-agent-kit";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Import plugins
import TokenPlugin from "@solana-agent-kit/plugin-token";
import NFTPlugin from "@solana-agent-kit/plugin-nft";
import DefiPlugin from "@solana-agent-kit/plugin-defi";
import MiscPlugin from "@solana-agent-kit/plugin-misc";
import BlinksPlugin from "@solana-agent-kit/plugin-blinks";

// Create wallet from private key
const privateKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY!);
const keypair = Keypair.fromSecretKey(privateKey);
const wallet = new KeypairWallet(keypair);

// Initialize agent with plugins
const agent = new SolanaAgentKit(
  wallet,
  process.env.RPC_URL!,
  {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  }
)
  .use(TokenPlugin)
  .use(NFTPlugin)
  .use(DefiPlugin)
  .use(MiscPlugin)
  .use(BlinksPlugin);

// Create tools for AI framework
const tools = createVercelAITools(agent, agent.actions);
```

## Plugins & Actions

### Token Plugin (`@solana-agent-kit/plugin-token`)

| Action | Description |
|--------|-------------|
| `deployToken` | Deploy new SPL token or Token-2022 |
| `transfer` | Transfer SOL or SPL tokens |
| `getBalance` | Check token balances |
| `stake` | Stake SOL via Jupiter/Solayer |
| `bridge` | Bridge tokens via Wormhole |
| `rugCheck` | Analyze token safety |

```typescript
// Deploy a new token
const result = await agent.methods.deployToken({
  name: "My Token",
  symbol: "MTK",
  decimals: 9,
  initialSupply: 1000000,
});

// Transfer tokens
await agent.methods.transfer({
  to: "recipient_address",
  amount: 100,
  mint: "token_mint_address", // optional, defaults to SOL
});

// Check balance
const balance = await agent.methods.getBalance({
  tokenAddress: "token_mint_address", // optional
});
```

### NFT Plugin (`@solana-agent-kit/plugin-nft`)

| Action | Description |
|--------|-------------|
| `createCollection` | Create NFT collection via Metaplex |
| `mintNFT` | Mint NFT to collection |
| `listNFT` | List NFT on marketplaces |
| `updateMetadata` | Update NFT metadata |

```typescript
// Create collection
const collection = await agent.methods.createCollection({
  name: "My Collection",
  symbol: "MYCOL",
  uri: "https://arweave.net/metadata.json",
});

// Mint NFT to collection
const nft = await agent.methods.mintNFT({
  collectionMint: collection.collectionAddress,
  name: "NFT #1",
  uri: "https://arweave.net/nft1.json",
});
```

### DeFi Plugin (`@solana-agent-kit/plugin-defi`)

| Action | Description |
|--------|-------------|
| `trade` | Swap tokens via Jupiter |
| `createRaydiumPool` | Create Raydium AMM pool |
| `createOrcaPool` | Create Orca Whirlpool |
| `createMeteoraPool` | Create Meteora DLMM pool |
| `limitOrder` | Place limit order via Manifest |
| `lend` | Lend assets via Lulo |
| `perpetualTrade` | Trade perps via Adrena/Drift |

```typescript
// Swap tokens via Jupiter
const swap = await agent.methods.trade({
  outputMint: "target_token_mint",
  inputAmount: 1.0,
  inputMint: "So11111111111111111111111111111111111111112", // SOL
  slippageBps: 50, // 0.5%
});

// Create Raydium CPMM pool
const pool = await agent.methods.createRaydiumCpmm({
  mintA: "token_a_mint",
  mintB: "token_b_mint",
  configId: "config_id",
  mintAAmount: 1000,
  mintBAmount: 1000,
});
```

### Misc Plugin (`@solana-agent-kit/plugin-misc`)

| Action | Description |
|--------|-------------|
| `airdrop` | ZK-compressed airdrop via Helius |
| `getPrice` | Get token price via CoinGecko |
| `registerDomain` | Register .sol domain |
| `resolveDomain` | Resolve domain to address |
| `getTPS` | Get network TPS |

```typescript
// Compressed airdrop (cost-efficient)
const airdrop = await agent.methods.sendCompressedAirdrop({
  mintAddress: "token_mint",
  amount: 100,
  recipients: ["addr1", "addr2", "addr3"],
  priorityFeeInLamports: 10000,
});

// Get token price
const price = await agent.methods.getPrice({
  tokenId: "solana", // CoinGecko ID
});
```

### Blinks Plugin (`@solana-agent-kit/plugin-blinks`)

Execute Solana Actions/Blinks directly:

```typescript
// Execute a Blink
const result = await agent.methods.executeBlink({
  blinkUrl: "https://example.com/blink",
  params: { /* blink-specific params */ },
});
```

## Integration Patterns

### LangChain Integration

```typescript
import { SolanaAgentKit, createSolanaTools } from "solana-agent-kit";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

async function createLangChainAgent() {
  // Initialize LLM
  const llm = new ChatOpenAI({
    modelName: "gpt-4-turbo-preview",
    temperature: 0.7,
  });

  // Initialize Solana Agent Kit
  const solanaKit = new SolanaAgentKit(
    wallet,
    process.env.RPC_URL!,
    { OPENAI_API_KEY: process.env.OPENAI_API_KEY! }
  )
    .use(TokenPlugin)
    .use(DefiPlugin);

  // Create LangChain tools
  const tools = createSolanaTools(solanaKit);

  // Create agent with memory
  const memory = new MemorySaver();
  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memory,
  });

  return agent;
}

// Run agent
async function chat(agent: any, message: string) {
  const config = { configurable: { thread_id: "solana-agent" } };

  const stream = await agent.stream(
    { messages: [new HumanMessage(message)] },
    config
  );

  for await (const chunk of stream) {
    if ("agent" in chunk) {
      console.log(chunk.agent.messages[0].content);
    }
  }
}
```

### Vercel AI SDK Integration

```typescript
import { SolanaAgentKit, createVercelAITools } from "solana-agent-kit";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

async function runVercelAgent(prompt: string) {
  const agent = new SolanaAgentKit(wallet, rpcUrl, options)
    .use(TokenPlugin)
    .use(DefiPlugin);

  const tools = createVercelAITools(agent, agent.actions);

  const result = await generateText({
    model: openai("gpt-4-turbo"),
    tools,
    maxSteps: 10,
    prompt,
  });

  return result.text;
}

// Usage
const response = await runVercelAgent(
  "Swap 0.1 SOL for USDC using the best rate"
);
```

### MCP Server for Claude

Install and configure the MCP server for Claude Desktop:

```bash
# Install globally
npm install -g solana-mcp

# Or run directly
npx solana-mcp
```

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "solana": {
      "command": "npx",
      "args": ["solana-mcp"],
      "env": {
        "RPC_URL": "https://api.mainnet-beta.solana.com",
        "SOLANA_PRIVATE_KEY": "your_base58_private_key",
        "OPENAI_API_KEY": "your_openai_key"
      }
    }
  }
}
```

Available MCP tools:
- `GET_ASSET` - Get token/asset info
- `DEPLOY_TOKEN` - Create new token
- `GET_PRICE` - Fetch token price
- `WALLET_ADDRESS` - Get wallet address
- `BALANCE` - Check balance
- `TRANSFER` - Send tokens
- `MINT_NFT` - Create NFT
- `TRADE` - Execute swap
- `REQUEST_FUNDS` - Get devnet SOL
- `RESOLVE_DOMAIN` - Lookup .sol domain
- `GET_TPS` - Network throughput

## Autonomous Mode

Run agent in fully autonomous mode:

```typescript
import { SolanaAgentKit } from "solana-agent-kit";

const agent = new SolanaAgentKit(wallet, rpcUrl, options)
  .use(TokenPlugin)
  .use(DefiPlugin);

// Configure autonomous behavior
const autonomousConfig = {
  intervalMs: 60000,        // Check every minute
  maxActions: 100,          // Max actions per session
  errorRecovery: true,      // Auto-retry on failures
  dryRun: false,            // Set true for testing
};

// Start autonomous loop
async function runAutonomous() {
  while (true) {
    try {
      // Agent decides what to do based on market conditions
      const decision = await agent.analyze({
        context: "Monitor my portfolio and rebalance if needed",
        constraints: [
          "Keep at least 1 SOL for gas",
          "Max 10% allocation per token",
        ],
      });

      if (decision.shouldAct) {
        await agent.execute(decision.action);
      }

      await sleep(autonomousConfig.intervalMs);
    } catch (error) {
      if (autonomousConfig.errorRecovery) {
        console.error("Error, recovering:", error);
        await sleep(5000);
      } else {
        throw error;
      }
    }
  }
}
```

## Creating Custom Actions

Extend the agent with custom actions:

```typescript
import { Action, Tool, SolanaAgentKit } from "solana-agent-kit";

// Define the Tool (tells LLM HOW to use it)
const myCustomTool: Tool = {
  name: "my_custom_action",
  description: "Does something custom on Solana",
  parameters: {
    type: "object",
    properties: {
      param1: {
        type: "string",
        description: "First parameter",
      },
      param2: {
        type: "number",
        description: "Second parameter",
      },
    },
    required: ["param1"],
  },
};

// Define the Action (tells agent WHEN and WHY to use it)
const myCustomAction: Action = {
  name: "my_custom_action",
  description: "Use this when you need to do something custom",
  similes: ["custom thing", "special operation"],
  examples: [
    {
      input: "Do the custom thing with value X",
      output: "Custom action executed with param1=X",
    },
  ],
  handler: async (agent: SolanaAgentKit, params: any) => {
    const { param1, param2 } = params;

    // Your custom logic here
    const connection = agent.connection;
    const wallet = agent.wallet;

    // Execute Solana operations...

    return {
      success: true,
      result: `Executed with ${param1}`,
    };
  },
};

// Register custom action
agent.registerAction(myCustomAction);
agent.registerTool(myCustomTool);
```

## Best Practices

### Security

1. **Never expose private keys** - Use environment variables
2. **Use dedicated wallets** - Separate agent wallet from main funds
3. **Set spending limits** - Implement max transaction amounts
4. **Test on devnet first** - Always test before mainnet
5. **Audit agent actions** - Log all operations

### Performance

1. **Use appropriate RPC** - Helius, Triton for production
2. **Batch operations** - Combine related transactions
3. **Handle rate limits** - Implement backoff strategies
4. **Cache when possible** - Price feeds, token metadata

### Agent Design

1. **Limit plugin scope** - Only load needed plugins (reduces hallucinations)
2. **Provide clear context** - Detailed prompts improve accuracy
3. **Add constraints** - Prevent unwanted actions
4. **Monitor and iterate** - Review agent decisions

## Guidelines

- Always test on devnet before mainnet
- Set maximum transaction limits
- Monitor agent activity logs
- Use dedicated wallets for agents
- Implement proper error handling
- Keep private keys secure

## Files in This Skill

```
solana-agent-kit/
├── SKILL.md                           # This file
├── resources/
│   ├── actions-reference.md           # Complete actions list
│   ├── plugins-guide.md               # Plugin deep dive
│   └── security-checklist.md          # Security best practices
├── examples/
│   ├── langchain/                     # LangChain integration
│   ├── vercel-ai/                     # Vercel AI SDK
│   ├── mcp-server/                    # Claude MCP setup
│   └── autonomous-agent/              # Autonomous patterns
├── templates/
│   └── agent-template.ts              # Starter template
└── docs/
    ├── custom-actions.md              # Creating custom actions
    └── troubleshooting.md             # Common issues
```

## V2 Highlights

Version 2 represents a complete evolution of the toolkit with key improvements:

### Plugin Architecture

V2 directly addresses two major V1 challenges:
1. **Security**: Input private key method wasn't 100% secure
2. **Hallucinations**: 100+ aggregate tools caused LLM confusion

The modular plugin system lets you install only what you need, reducing context bloat and hallucinations.

### Embedded Wallet Support (New)

V2 integrates with secure wallet providers for enhanced security:

```typescript
import { TurnkeyWallet, PrivyWallet } from "solana-agent-kit/wallets";

// Turnkey - fine-grained rules and policies
const turnkeyWallet = new TurnkeyWallet({
  organizationId: process.env.TURNKEY_ORG_ID,
  privateKeyId: process.env.TURNKEY_PRIVATE_KEY_ID,
});

// Privy - human-in-the-loop confirmation
const privyWallet = new PrivyWallet({
  appId: process.env.PRIVY_APP_ID,
  requireConfirmation: true,
});

// Initialize agent with secure wallet
const agent = new SolanaAgentKit(turnkeyWallet, rpcUrl, options)
  .use(TokenPlugin)
  .use(DefiPlugin);
```

### Key V2 Benefits

| Feature | V1 | V2 |
|---------|----|----|
| Wallet Security | Private key input | Embedded wallets (Turnkey, Privy) |
| Tool Loading | All 100+ tools | Plugin-based, load what you need |
| LLM Context | Large, caused hallucinations | Minimal, focused context |
| Human-in-loop | Not supported | Native with Privy |

## Notes

- Solana Agent Kit is actively maintained (1,400+ commits, 800+ forks)
- V2 introduced plugin architecture (migration guide available)
- Python version available: `solana-agent-kit-py`
- MCP server enables Claude Desktop integration
- 100,000+ downloads, 1.6k+ GitHub stars
- Apache-2.0 licensed
