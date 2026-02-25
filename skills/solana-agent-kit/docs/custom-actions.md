# Creating Custom Actions for Solana Agent Kit

Extend the Solana Agent Kit with your own custom actions.

## Architecture Overview

Each action has two components:

1. **Tool** - Tells the LLM *how* to use the action (parameters, descriptions)
2. **Action** - Tells the agent *when* and *why* to use it (handler, examples)

```
┌─────────────────────────────────────────────────────────────┐
│                     Custom Action                           │
├─────────────────────────┬───────────────────────────────────┤
│        Tool             │           Action                  │
│                         │                                   │
│  • name                 │  • name                           │
│  • description          │  • description                    │
│  • parameters (JSON)    │  • similes (trigger phrases)      │
│                         │  • examples                       │
│                         │  • handler function               │
└─────────────────────────┴───────────────────────────────────┘
```

## Basic Custom Action

```typescript
import { SolanaAgentKit, Action, Tool } from "solana-agent-kit";
import { PublicKey } from "@solana/web3.js";

// 1. Define the Tool (LLM interface)
const getAccountInfoTool: Tool = {
  name: "get_account_info",
  description: "Get detailed information about a Solana account including owner, lamports, and data",
  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "The Solana account address to query",
      },
    },
    required: ["address"],
  },
};

// 2. Define the Action (agent behavior)
const getAccountInfoAction: Action = {
  name: "get_account_info",
  description: "Use this to get detailed account information when user asks about an account's state",
  similes: [
    "account info",
    "account details",
    "what's in this account",
    "account state",
  ],
  examples: [
    {
      input: "What's the account info for ABC123...?",
      output: "Account ABC123... has 1.5 SOL and is owned by System Program",
    },
  ],
  handler: async (agent: SolanaAgentKit, params: { address: string }) => {
    const { address } = params;

    try {
      const pubkey = new PublicKey(address);
      const accountInfo = await agent.connection.getAccountInfo(pubkey);

      if (!accountInfo) {
        return {
          success: false,
          error: "Account not found",
        };
      }

      return {
        success: true,
        data: {
          address,
          lamports: accountInfo.lamports,
          owner: accountInfo.owner.toBase58(),
          executable: accountInfo.executable,
          dataLength: accountInfo.data.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  },
};

// 3. Register with agent
const agent = new SolanaAgentKit(wallet, rpcUrl, options);
agent.registerTool(getAccountInfoTool);
agent.registerAction(getAccountInfoAction);
```

## Action with Multiple Parameters

```typescript
const sendMemoTool: Tool = {
  name: "send_memo",
  description: "Send a transaction with a memo message attached",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The memo message to include (max 566 bytes)",
      },
      recipient: {
        type: "string",
        description: "Optional recipient address for the memo",
      },
    },
    required: ["message"],
  },
};

const sendMemoAction: Action = {
  name: "send_memo",
  description: "Send a memo on Solana blockchain, useful for leaving on-chain messages",
  similes: ["memo", "message", "note", "write on chain"],
  examples: [
    {
      input: "Send a memo saying 'Hello Solana!'",
      output: "Memo sent in transaction: ABC123...",
    },
  ],
  handler: async (
    agent: SolanaAgentKit,
    params: { message: string; recipient?: string }
  ) => {
    const { message, recipient } = params;

    // Import memo program
    const { createMemoInstruction } = await import("@solana/spl-memo");

    const instruction = createMemoInstruction(message);

    // Build and send transaction
    const transaction = new Transaction().add(instruction);

    const signature = await agent.connection.sendTransaction(transaction, [
      agent.wallet.payer,
    ]);

    return {
      success: true,
      signature,
      message: `Memo "${message}" sent`,
    };
  },
};
```

## Action with Complex Logic

```typescript
const portfolioAnalysisTool: Tool = {
  name: "analyze_portfolio",
  description: "Analyze wallet portfolio including token distribution and DeFi positions",
  parameters: {
    type: "object",
    properties: {
      includeNFTs: {
        type: "boolean",
        description: "Whether to include NFT holdings in analysis",
        default: false,
      },
      includeDefi: {
        type: "boolean",
        description: "Whether to include DeFi positions",
        default: true,
      },
    },
    required: [],
  },
};

const portfolioAnalysisAction: Action = {
  name: "analyze_portfolio",
  description: "Analyze and summarize wallet portfolio when user wants portfolio overview",
  similes: [
    "portfolio",
    "holdings",
    "what do I own",
    "my assets",
    "investment summary",
  ],
  examples: [
    {
      input: "Analyze my portfolio",
      output: "Portfolio: 10 SOL ($1500), 1000 USDC, 3 NFTs. Total: $2500",
    },
  ],
  handler: async (
    agent: SolanaAgentKit,
    params: { includeNFTs?: boolean; includeDefi?: boolean }
  ) => {
    const { includeNFTs = false, includeDefi = true } = params;
    const walletAddress = agent.wallet.publicKey.toBase58();

    // Get SOL balance
    const solBalance = await agent.connection.getBalance(agent.wallet.publicKey);
    const solInSol = solBalance / 1e9;

    // Get token accounts
    const tokenAccounts = await agent.connection.getParsedTokenAccountsByOwner(
      agent.wallet.publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );

    const tokens = tokenAccounts.value.map((account) => ({
      mint: account.account.data.parsed.info.mint,
      amount: account.account.data.parsed.info.tokenAmount.uiAmount,
      decimals: account.account.data.parsed.info.tokenAmount.decimals,
    }));

    // Build portfolio summary
    const portfolio = {
      wallet: walletAddress,
      sol: {
        balance: solInSol,
        valueUsd: 0, // Would fetch from price API
      },
      tokens: tokens.filter((t) => t.amount > 0),
      totalTokens: tokens.filter((t) => t.amount > 0).length,
    };

    // Include NFTs if requested
    if (includeNFTs) {
      // Would fetch NFT data from Metaplex/Helius
      portfolio.nfts = [];
    }

    // Include DeFi if requested
    if (includeDefi) {
      // Would fetch positions from various protocols
      portfolio.defi = {
        lending: [],
        staking: [],
        lp: [],
      };
    }

    return {
      success: true,
      portfolio,
    };
  },
};
```

## Creating a Custom Plugin

Bundle multiple actions into a plugin:

```typescript
import { Plugin, SolanaAgentKit } from "solana-agent-kit";

// Define your tools and actions
const tools = [getAccountInfoTool, sendMemoTool, portfolioAnalysisTool];
const actions = [getAccountInfoAction, sendMemoAction, portfolioAnalysisAction];

// Create plugin
const MyCustomPlugin: Plugin = {
  name: "my-custom-plugin",
  initialize: (agent: SolanaAgentKit) => {
    // Register all tools
    tools.forEach((tool) => agent.registerTool(tool));

    // Register all actions
    actions.forEach((action) => agent.registerAction(action));

    // Optional: add custom methods to agent
    agent.methods.customMethod = async (params: any) => {
      // Custom logic
    };

    console.log("Custom plugin initialized!");
  },
};

// Usage
const agent = new SolanaAgentKit(wallet, rpcUrl, options)
  .use(TokenPlugin)
  .use(MyCustomPlugin);  // Add your plugin
```

## Action Best Practices

### 1. Clear Descriptions

```typescript
// BAD
description: "Does stuff with tokens"

// GOOD
description: "Transfer SPL tokens from your wallet to another address. Specify the token mint, recipient address, and amount to transfer."
```

### 2. Comprehensive Similes

```typescript
similes: [
  "send tokens",
  "transfer tokens",
  "move tokens",
  "send SPL",
  "transfer SPL",
  "give tokens",
  "pay with tokens",
]
```

### 3. Helpful Examples

```typescript
examples: [
  {
    input: "Send 100 USDC to address ABC...",
    output: "Transferred 100 USDC to ABC... Transaction: XYZ...",
  },
  {
    input: "Transfer all my BONK tokens to my friend",
    output: "Transferred 50000 BONK to [address]. Transaction: ...",
  },
]
```

### 4. Robust Error Handling

```typescript
handler: async (agent, params) => {
  try {
    // Validate inputs
    if (!params.address) {
      return { success: false, error: "Address is required" };
    }

    // Validate address format
    try {
      new PublicKey(params.address);
    } catch {
      return { success: false, error: "Invalid Solana address" };
    }

    // Execute logic
    const result = await doSomething();

    return { success: true, data: result };

  } catch (error) {
    // Handle specific errors
    if (error.message.includes("insufficient funds")) {
      return { success: false, error: "Not enough funds for this operation" };
    }

    // Generic error
    return { success: false, error: error.message };
  }
}
```

### 5. Return Structured Data

```typescript
// BAD
return "Transaction sent";

// GOOD
return {
  success: true,
  signature: "ABC123...",
  details: {
    amount: 100,
    token: "USDC",
    recipient: "XYZ...",
  },
};
```

## Testing Custom Actions

```typescript
import { describe, it, expect } from "vitest";

describe("Custom Actions", () => {
  const agent = new SolanaAgentKit(testWallet, devnetUrl, {});

  it("should get account info", async () => {
    const result = await getAccountInfoAction.handler(agent, {
      address: "11111111111111111111111111111111", // System Program
    });

    expect(result.success).toBe(true);
    expect(result.data.owner).toBe("NativeLoader1111111111111111111111111111111");
  });

  it("should handle invalid address", async () => {
    const result = await getAccountInfoAction.handler(agent, {
      address: "invalid",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid");
  });
});
```

## Publishing Your Plugin

```bash
# Create package
npm init

# Add peer dependency
npm install solana-agent-kit --save-peer

# Build
npm run build

# Publish
npm publish
```

```json
// package.json
{
  "name": "@myorg/solana-agent-kit-custom-plugin",
  "version": "1.0.0",
  "main": "dist/index.js",
  "peerDependencies": {
    "solana-agent-kit": "^2.0.0"
  }
}
```
