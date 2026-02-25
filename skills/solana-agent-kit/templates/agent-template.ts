/**
 * Solana Agent Kit - Production Agent Template
 *
 * A complete, production-ready starter template for building
 * AI-powered Solana agents.
 *
 * Usage:
 *   1. Copy this file to your project
 *   2. Configure environment variables
 *   3. Customize plugins and system prompt
 *   4. Run: npx ts-node agent-template.ts
 */

import {
  SolanaAgentKit,
  createSolanaTools,
  createVercelAITools,
  KeypairWallet,
} from "solana-agent-kit";
import TokenPlugin from "@solana-agent-kit/plugin-token";
import NFTPlugin from "@solana-agent-kit/plugin-nft";
import DefiPlugin from "@solana-agent-kit/plugin-defi";
import MiscPlugin from "@solana-agent-kit/plugin-misc";

import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

import { Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import * as readline from "readline";
import "dotenv/config";

// ============================================================================
// CONFIGURATION
// ============================================================================

interface AgentConfig {
  // Network
  rpcUrl: string;
  network: "mainnet-beta" | "devnet" | "testnet";

  // AI Model
  modelName: string;
  temperature: number;
  maxSteps: number;

  // Safety
  maxTransactionValue: number; // Max SOL value per transaction
  requireConfirmation: boolean; // Require user confirmation for transactions
  allowedActions: string[] | "all"; // Whitelist actions or allow all

  // Logging
  verbose: boolean;
  logToolCalls: boolean;
}

const DEFAULT_CONFIG: AgentConfig = {
  rpcUrl: process.env.RPC_URL || "https://api.devnet.solana.com",
  network: "devnet",
  modelName: "gpt-4-turbo-preview",
  temperature: 0.7,
  maxSteps: 15,
  maxTransactionValue: 1.0, // Max 1 SOL per transaction
  requireConfirmation: true,
  allowedActions: "all",
  verbose: true,
  logToolCalls: true,
};

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

const SYSTEM_PROMPT = `You are an intelligent Solana blockchain assistant powered by the Solana Agent Kit.

## Capabilities
You can help users with:
- Checking wallet balances (SOL and SPL tokens)
- Swapping tokens via Jupiter aggregator
- Deploying new SPL tokens
- Creating and managing NFT collections
- Staking SOL
- Interacting with DeFi protocols (Raydium, Orca, Meteora)
- Looking up token prices and information
- Managing .sol domains

## Guidelines
1. **Safety First**: Always warn users about transaction risks
2. **Confirm Large Transactions**: For any transaction over 0.5 SOL, summarize and ask for confirmation
3. **Explain Actions**: Before executing, explain what the action will do
4. **Handle Errors Gracefully**: If an action fails, explain why and suggest alternatives
5. **Never Reveal Keys**: Never display or mention private keys
6. **Slippage Warning**: When swapping tokens, warn about slippage (default 1-3% is typical)

## Response Format
- Be concise but informative
- Include transaction signatures when available
- Format numbers with appropriate decimals
- Use bullet points for multiple items

## Current Network
Network: ${DEFAULT_CONFIG.network}
RPC: ${DEFAULT_CONFIG.rpcUrl}
`;

// ============================================================================
// WALLET SETUP
// ============================================================================

function createWallet(): Keypair {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("SOLANA_PRIVATE_KEY environment variable not set");
  }

  try {
    // Try base58 format first
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch {
    // Try JSON array format
    try {
      const keyArray = JSON.parse(privateKey);
      return Keypair.fromSecretKey(new Uint8Array(keyArray));
    } catch {
      throw new Error(
        "Invalid private key format. Use base58 or JSON array."
      );
    }
  }
}

// ============================================================================
// AGENT INITIALIZATION
// ============================================================================

async function initializeAgent(config: AgentConfig = DEFAULT_CONFIG) {
  console.log("Initializing Solana Agent...\n");

  // Create wallet
  const keypair = createWallet();
  const wallet = new KeypairWallet(keypair);

  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Network: ${config.network}`);

  // Check wallet balance
  const connection = new Connection(config.rpcUrl);
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  if (balance === 0 && config.network === "devnet") {
    console.log("Tip: Request devnet SOL with 'Give me some devnet SOL'\n");
  }

  // Create LLM
  const llm = new ChatOpenAI({
    modelName: config.modelName,
    temperature: config.temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });

  // Create Solana Agent Kit with plugins
  const solanaKit = new SolanaAgentKit(
    wallet,
    config.rpcUrl,
    {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    }
  )
    .use(TokenPlugin)
    .use(NFTPlugin)
    .use(DefiPlugin)
    .use(MiscPlugin);

  // Create tools (filter if needed)
  let tools = createSolanaTools(solanaKit);

  if (config.allowedActions !== "all") {
    tools = tools.filter((tool) =>
      config.allowedActions.includes(tool.name)
    );
    console.log(`Enabled tools: ${config.allowedActions.join(", ")}\n`);
  }

  // Create memory for conversation persistence
  const memory = new MemorySaver();

  // Create ReAct agent with callbacks
  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memory,
    messageModifier: SYSTEM_PROMPT,
  });

  return { agent, solanaKit, config, keypair };
}

// ============================================================================
// CHAT HANDLER
// ============================================================================

interface ChatOptions {
  threadId: string;
  onToolCall?: (toolName: string, args: any) => void;
  onToolResult?: (toolName: string, result: any) => void;
}

async function chat(
  agent: any,
  message: string,
  options: ChatOptions
): Promise<string> {
  const config = { configurable: { thread_id: options.threadId } };

  try {
    const stream = await agent.stream(
      { messages: [new HumanMessage(message)] },
      config
    );

    let response = "";

    for await (const chunk of stream) {
      if ("agent" in chunk) {
        const content = chunk.agent.messages[0].content;
        if (typeof content === "string") {
          response += content;
        }
      } else if ("tools" in chunk) {
        const toolMessage = chunk.tools.messages[0];
        if (options.onToolCall) {
          options.onToolCall(toolMessage.name, toolMessage.args);
        }
      }
    }

    return response;
  } catch (error: any) {
    // Handle common errors
    if (error.message?.includes("rate limit")) {
      console.log("Rate limited. Waiting 5 seconds...");
      await new Promise((r) => setTimeout(r, 5000));
      return chat(agent, message, options);
    }

    if (error.message?.includes("insufficient funds")) {
      return "Transaction failed: Insufficient funds in wallet.";
    }

    throw error;
  }
}

// ============================================================================
// INTERACTIVE CLI
// ============================================================================

async function runInteractiveChat() {
  const { agent, config, keypair } = await initializeAgent();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const threadId = `session-${Date.now()}`;

  console.log("=".repeat(60));
  console.log("Solana Agent Ready!");
  console.log("=".repeat(60));
  console.log("\nExample commands:");
  console.log('  "What is my wallet address?"');
  console.log('  "Check my SOL balance"');
  console.log('  "Swap 0.1 SOL for USDC"');
  console.log('  "What tokens do I have?"');
  console.log('  "quit" to exit');
  console.log("");

  const askQuestion = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        askQuestion();
        return;
      }

      if (trimmed.toLowerCase() === "quit" || trimmed.toLowerCase() === "exit") {
        console.log("\nGoodbye!");
        rl.close();
        process.exit(0);
      }

      try {
        process.stdout.write("\nAgent: ");

        const response = await chat(agent, trimmed, {
          threadId,
          onToolCall: (name, args) => {
            if (config.logToolCalls) {
              console.log(`\n[Calling ${name}...]`);
            }
          },
        });

        console.log(response);
        console.log("");
      } catch (error: any) {
        console.error(`\nError: ${error.message}\n`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

// ============================================================================
// PROGRAMMATIC API
// ============================================================================

/**
 * Create an agent for programmatic use (not interactive)
 */
export async function createAgent(customConfig?: Partial<AgentConfig>) {
  const config = { ...DEFAULT_CONFIG, ...customConfig };
  const { agent, solanaKit, keypair } = await initializeAgent(config);

  return {
    /**
     * Send a message to the agent
     */
    chat: async (message: string, threadId = "default") => {
      return chat(agent, message, { threadId });
    },

    /**
     * Execute a specific action directly
     */
    execute: async (actionName: string, params: any) => {
      const action = solanaKit.actions.find((a) => a.name === actionName);
      if (!action) {
        throw new Error(`Action not found: ${actionName}`);
      }
      return action.handler(solanaKit, params);
    },

    /**
     * Get wallet address
     */
    getWalletAddress: () => keypair.publicKey.toBase58(),

    /**
     * Get the underlying Solana Agent Kit instance
     */
    getSolanaKit: () => solanaKit,
  };
}

// ============================================================================
// EXAMPLE: PROGRAMMATIC USAGE
// ============================================================================

async function programmaticExample() {
  const agent = await createAgent({
    network: "devnet",
    verbose: false,
  });

  console.log("Wallet:", agent.getWalletAddress());

  // Chat with agent
  const response = await agent.chat("What is my SOL balance?");
  console.log("Response:", response);

  // Direct action execution
  const balance = await agent.execute("getBalance", {});
  console.log("Balance:", balance);
}

// ============================================================================
// MAIN
// ============================================================================

// Run interactive mode by default
if (require.main === module) {
  runInteractiveChat().catch(console.error);
}

// Export for programmatic use
export { initializeAgent, chat, AgentConfig, DEFAULT_CONFIG };
