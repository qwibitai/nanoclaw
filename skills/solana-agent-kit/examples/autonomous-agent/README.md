# Autonomous Agent Patterns

Build agents that operate independently with minimal human intervention.

## Overview

Autonomous agents can:
- Execute pre-defined strategies
- React to on-chain events
- Perform scheduled tasks
- Make decisions based on market conditions

## Basic Autonomous Agent

```typescript
// autonomous-agent.ts
import {
  SolanaAgentKit,
  createSolanaTools,
  KeypairWallet,
} from "solana-agent-kit";
import TokenPlugin from "@solana-agent-kit/plugin-token";
import DefiPlugin from "@solana-agent-kit/plugin-defi";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import "dotenv/config";

interface Task {
  id: string;
  prompt: string;
  schedule?: string; // cron expression
  condition?: () => Promise<boolean>;
  maxRetries?: number;
}

class AutonomousAgent {
  private agent: any;
  private solanaKit: SolanaAgentKit;
  private connection: Connection;
  private tasks: Map<string, Task> = new Map();
  private running = false;

  async initialize() {
    const privateKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY!);
    const keypair = Keypair.fromSecretKey(privateKey);
    const wallet = new KeypairWallet(keypair);

    this.connection = new Connection(process.env.RPC_URL!);

    const llm = new ChatOpenAI({
      modelName: "gpt-4-turbo-preview",
      temperature: 0.3, // Lower temperature for more consistent decisions
    });

    this.solanaKit = new SolanaAgentKit(
      wallet,
      process.env.RPC_URL!,
      { OPENAI_API_KEY: process.env.OPENAI_API_KEY! }
    )
      .use(TokenPlugin)
      .use(DefiPlugin);

    const tools = createSolanaTools(this.solanaKit);

    this.agent = createReactAgent({
      llm,
      tools,
      messageModifier: `You are an autonomous Solana agent. Execute tasks efficiently.
Be concise. Only perform the requested action, nothing more.
If a task fails, explain why briefly.`,
    });

    console.log("Autonomous agent initialized");
    console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  }

  async executeTask(task: Task): Promise<string> {
    console.log(`\n[${new Date().toISOString()}] Executing: ${task.id}`);

    // Check condition if specified
    if (task.condition) {
      const shouldRun = await task.condition();
      if (!shouldRun) {
        console.log(`  Condition not met, skipping`);
        return "Skipped: condition not met";
      }
    }

    let retries = task.maxRetries || 3;
    let lastError: Error | null = null;

    while (retries > 0) {
      try {
        const response = await this.agent.invoke({
          messages: [new HumanMessage(task.prompt)],
        });

        const result = response.messages[response.messages.length - 1].content;
        console.log(`  Result: ${result}`);
        return result;
      } catch (error: any) {
        lastError = error;
        retries--;
        console.log(`  Error: ${error.message}. Retries left: ${retries}`);
        await this.sleep(2000);
      }
    }

    throw lastError || new Error("Task failed");
  }

  registerTask(task: Task) {
    this.tasks.set(task.id, task);
    console.log(`Registered task: ${task.id}`);
  }

  async runOnce() {
    for (const [id, task] of this.tasks) {
      try {
        await this.executeTask(task);
      } catch (error: any) {
        console.error(`Task ${id} failed: ${error.message}`);
      }
    }
  }

  async runLoop(intervalMs = 60000) {
    this.running = true;
    console.log(`\nStarting autonomous loop (interval: ${intervalMs}ms)`);

    while (this.running) {
      await this.runOnce();
      console.log(`\nWaiting ${intervalMs}ms until next cycle...`);
      await this.sleep(intervalMs);
    }
  }

  stop() {
    this.running = false;
    console.log("Stopping autonomous agent");
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Usage
async function main() {
  const agent = new AutonomousAgent();
  await agent.initialize();

  // Register tasks
  agent.registerTask({
    id: "check-balance",
    prompt: "Check my SOL balance and report it briefly",
  });

  agent.registerTask({
    id: "monitor-positions",
    prompt: "List all my token holdings with their current values",
  });

  // Run once
  await agent.runOnce();

  // Or run continuously
  // await agent.runLoop(300000); // Every 5 minutes
}

main();
```

## Event-Driven Agent

React to on-chain events:

```typescript
// event-driven-agent.ts
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  SolanaAgentKit,
  createSolanaTools,
  KeypairWallet,
} from "solana-agent-kit";
import DefiPlugin from "@solana-agent-kit/plugin-defi";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";

class EventDrivenAgent {
  private agent: any;
  private connection: Connection;
  private subscriptions: number[] = [];

  async initialize() {
    // ... (same initialization as above)
  }

  // Watch for balance changes
  watchBalance(threshold: number, action: string) {
    const walletPubkey = this.solanaKit.wallet.publicKey;

    const subscriptionId = this.connection.onAccountChange(
      walletPubkey,
      async (accountInfo) => {
        const balance = accountInfo.lamports / LAMPORTS_PER_SOL;
        console.log(`Balance changed: ${balance} SOL`);

        if (balance > threshold) {
          console.log(`Threshold exceeded. Executing: ${action}`);
          await this.execute(action);
        }
      },
      "confirmed"
    );

    this.subscriptions.push(subscriptionId);
    console.log(`Watching balance with threshold: ${threshold} SOL`);
  }

  // Watch for token transfers
  watchTokenAccount(tokenAccount: PublicKey, onTransfer: (amount: number) => Promise<void>) {
    const subscriptionId = this.connection.onAccountChange(
      tokenAccount,
      async (accountInfo) => {
        // Parse token account data
        const data = accountInfo.data;
        // ... parse amount
        await onTransfer(0); // parsed amount
      },
      "confirmed"
    );

    this.subscriptions.push(subscriptionId);
  }

  // Watch for program logs
  watchProgram(programId: PublicKey, logFilter: string, action: string) {
    const subscriptionId = this.connection.onLogs(
      programId,
      async (logs) => {
        if (logs.logs.some((log) => log.includes(logFilter))) {
          console.log(`Log matched: ${logFilter}`);
          await this.execute(action);
        }
      },
      "confirmed"
    );

    this.subscriptions.push(subscriptionId);
    console.log(`Watching program: ${programId.toBase58()}`);
  }

  async execute(prompt: string) {
    const response = await this.agent.invoke({
      messages: [new HumanMessage(prompt)],
    });
    return response.messages[response.messages.length - 1].content;
  }

  cleanup() {
    for (const id of this.subscriptions) {
      this.connection.removeAccountChangeListener(id);
    }
    this.subscriptions = [];
  }
}

// Usage
async function main() {
  const agent = new EventDrivenAgent();
  await agent.initialize();

  // Auto-stake when balance exceeds 10 SOL
  agent.watchBalance(10, "Stake 5 SOL via Jupiter to earn yield");

  // React to specific program events
  agent.watchProgram(
    new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), // Jupiter
    "SwapEvent",
    "Log the latest swap and check if it affects my positions"
  );

  console.log("Agent listening for events...");
  // Keep running
  await new Promise(() => {});
}
```

## Strategy-Based Agent

Execute trading strategies:

```typescript
// strategy-agent.ts
interface Strategy {
  name: string;
  evaluate: () => Promise<StrategyDecision>;
  execute: (decision: StrategyDecision) => Promise<void>;
}

interface StrategyDecision {
  action: "buy" | "sell" | "hold";
  token?: string;
  amount?: number;
  reason: string;
}

class StrategyAgent {
  private agent: any;
  private strategies: Strategy[] = [];

  // Dollar-Cost Averaging Strategy
  addDCAStrategy(token: string, amountSol: number, intervalHours: number) {
    let lastExecution = 0;

    this.strategies.push({
      name: `DCA-${token}`,
      evaluate: async () => {
        const now = Date.now();
        const hoursSinceLastRun = (now - lastExecution) / (1000 * 60 * 60);

        if (hoursSinceLastRun >= intervalHours) {
          return {
            action: "buy",
            token,
            amount: amountSol,
            reason: `DCA interval reached (${intervalHours}h)`,
          };
        }

        return {
          action: "hold",
          reason: `DCA: ${(intervalHours - hoursSinceLastRun).toFixed(1)}h until next buy`,
        };
      },
      execute: async (decision) => {
        if (decision.action === "buy") {
          await this.agent.invoke({
            messages: [
              new HumanMessage(
                `Swap ${amountSol} SOL for ${token} using Jupiter with 1% slippage`
              ),
            ],
          });
          lastExecution = Date.now();
        }
      },
    });
  }

  // Rebalancing Strategy
  addRebalanceStrategy(
    targetAllocations: { token: string; percentage: number }[],
    thresholdPercent: number
  ) {
    this.strategies.push({
      name: "Portfolio-Rebalance",
      evaluate: async () => {
        // Get current allocations
        const response = await this.agent.invoke({
          messages: [
            new HumanMessage(
              "List all my token holdings with their USD values as percentages of total portfolio"
            ),
          ],
        });

        // AI-based evaluation
        const evalResponse = await this.agent.invoke({
          messages: [
            new HumanMessage(
              `Current portfolio: ${response.messages[response.messages.length - 1].content}

              Target allocations: ${JSON.stringify(targetAllocations)}
              Rebalance threshold: ${thresholdPercent}%

              Should we rebalance? If yes, what trades are needed?
              Respond with JSON: { "action": "buy|sell|hold", "trades": [...], "reason": "..." }`
            ),
          ],
        });

        // Parse response and return decision
        return {
          action: "hold",
          reason: "Evaluation complete",
        };
      },
      execute: async (decision) => {
        // Execute rebalancing trades
      },
    });
  }

  // Take-Profit Strategy
  addTakeProfitStrategy(
    token: string,
    entryPrice: number,
    profitPercent: number
  ) {
    this.strategies.push({
      name: `TakeProfit-${token}`,
      evaluate: async () => {
        const response = await this.agent.invoke({
          messages: [new HumanMessage(`What is the current price of ${token}?`)],
        });

        const content = response.messages[response.messages.length - 1].content;
        // Parse price from response
        const currentPrice = parseFloat(content.match(/\$?([\d.]+)/)?.[1] || "0");

        const profitRatio = (currentPrice - entryPrice) / entryPrice;
        const targetProfit = profitPercent / 100;

        if (profitRatio >= targetProfit) {
          return {
            action: "sell",
            token,
            reason: `Profit target reached: ${(profitRatio * 100).toFixed(1)}% (target: ${profitPercent}%)`,
          };
        }

        return {
          action: "hold",
          reason: `Current profit: ${(profitRatio * 100).toFixed(1)}% (target: ${profitPercent}%)`,
        };
      },
      execute: async (decision) => {
        if (decision.action === "sell") {
          await this.agent.invoke({
            messages: [
              new HumanMessage(
                `Sell all my ${decision.token} for USDC via Jupiter`
              ),
            ],
          });
        }
      },
    });
  }

  async runStrategies() {
    for (const strategy of this.strategies) {
      console.log(`\nEvaluating: ${strategy.name}`);

      const decision = await strategy.evaluate();
      console.log(`  Decision: ${decision.action} - ${decision.reason}`);

      if (decision.action !== "hold") {
        console.log(`  Executing...`);
        await strategy.execute(decision);
      }
    }
  }
}

// Usage
async function main() {
  const strategyAgent = new StrategyAgent();
  await strategyAgent.initialize();

  // DCA into USDC every 24 hours
  strategyAgent.addDCAStrategy("USDC", 0.1, 24);

  // Take profit on SOL at 20% gain
  strategyAgent.addTakeProfitStrategy("SOL", 100, 20);

  // Rebalance portfolio
  strategyAgent.addRebalanceStrategy(
    [
      { token: "SOL", percentage: 50 },
      { token: "USDC", percentage: 30 },
      { token: "JUP", percentage: 20 },
    ],
    5 // 5% threshold
  );

  // Run every hour
  while (true) {
    await strategyAgent.runStrategies();
    await new Promise((r) => setTimeout(r, 3600000));
  }
}
```

## Safety Guardrails

Always implement safety measures:

```typescript
// safety-guardrails.ts
interface SafetyConfig {
  maxTransactionValue: number; // Max SOL value
  dailyLimit: number; // Max daily spend
  allowedTokens: string[]; // Whitelist
  blockedActions: string[]; // Blacklist
  requireConfirmation: boolean;
}

class SafeAgent {
  private dailySpent = 0;
  private lastResetDate = new Date().toDateString();

  constructor(private config: SafetyConfig) {}

  async executeWithGuardrails(action: string, params: any): Promise<any> {
    // Reset daily limit
    if (new Date().toDateString() !== this.lastResetDate) {
      this.dailySpent = 0;
      this.lastResetDate = new Date().toDateString();
    }

    // Check blocked actions
    if (this.config.blockedActions.includes(action)) {
      throw new Error(`Action blocked: ${action}`);
    }

    // Check token whitelist
    if (params.token && !this.config.allowedTokens.includes(params.token)) {
      throw new Error(`Token not allowed: ${params.token}`);
    }

    // Check transaction value
    if (params.amount && params.amount > this.config.maxTransactionValue) {
      throw new Error(
        `Transaction exceeds max value: ${params.amount} > ${this.config.maxTransactionValue}`
      );
    }

    // Check daily limit
    if (params.amount && this.dailySpent + params.amount > this.config.dailyLimit) {
      throw new Error(
        `Would exceed daily limit: ${this.dailySpent + params.amount} > ${this.config.dailyLimit}`
      );
    }

    // Execute
    const result = await this.agent.execute(action, params);

    // Track spending
    if (params.amount) {
      this.dailySpent += params.amount;
    }

    return result;
  }
}

// Usage
const safeAgent = new SafeAgent({
  maxTransactionValue: 1.0, // Max 1 SOL per transaction
  dailyLimit: 5.0, // Max 5 SOL per day
  allowedTokens: ["SOL", "USDC", "JUP"], // Only these tokens
  blockedActions: ["launchPumpToken"], // No pump tokens
  requireConfirmation: true,
});
```

## Monitoring & Logging

```typescript
// monitoring.ts
import { createLogger, format, transports } from "winston";

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: "agent-errors.log", level: "error" }),
    new transports.File({ filename: "agent-activity.log" }),
    new transports.Console({ format: format.simple() }),
  ],
});

// Wrap agent actions with logging
async function loggedExecute(agent: any, prompt: string) {
  const startTime = Date.now();

  logger.info("Task started", { prompt });

  try {
    const result = await agent.invoke({
      messages: [new HumanMessage(prompt)],
    });

    const duration = Date.now() - startTime;
    logger.info("Task completed", {
      prompt,
      duration,
      result: result.messages[result.messages.length - 1].content,
    });

    return result;
  } catch (error: any) {
    logger.error("Task failed", {
      prompt,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
```

## Best Practices

1. **Start on Devnet**: Always test autonomous agents on devnet first
2. **Implement Circuit Breakers**: Stop execution on repeated failures
3. **Set Hard Limits**: Cap transaction sizes and daily volumes
4. **Log Everything**: Maintain detailed audit trails
5. **Monitor Continuously**: Set up alerts for anomalies
6. **Use Time Delays**: Add delays between actions to prevent rapid-fire errors
7. **Handle RPC Errors**: Implement retry logic with backoff
8. **Secure Keys**: Use hardware wallets or HSMs in production
