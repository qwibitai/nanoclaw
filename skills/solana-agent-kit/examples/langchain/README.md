# LangChain Integration with Solana Agent Kit

Complete guide for integrating Solana Agent Kit with LangChain for building conversational AI agents.

## Setup

### Installation

```bash
npm install solana-agent-kit \
  @solana-agent-kit/plugin-token \
  @solana-agent-kit/plugin-nft \
  @solana-agent-kit/plugin-defi \
  @langchain/openai \
  @langchain/core \
  @langchain/langgraph \
  dotenv \
  bs58
```

### Environment Variables

```bash
# .env
OPENAI_API_KEY=sk-...
RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY=your_base58_encoded_key
```

## Basic Chat Agent

```typescript
// langchain-agent.ts
import { SolanaAgentKit, createSolanaTools } from "solana-agent-kit";
import TokenPlugin from "@solana-agent-kit/plugin-token";
import DefiPlugin from "@solana-agent-kit/plugin-defi";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import * as readline from "readline";
import "dotenv/config";

// Initialize wallet
function createWallet(): Keypair {
  const privateKey = process.env.SOLANA_PRIVATE_KEY!;

  // Handle both formats
  try {
    // Try base58 first
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch {
    // Try JSON array
    const keyArray = JSON.parse(privateKey);
    return Keypair.fromSecretKey(new Uint8Array(keyArray));
  }
}

// Initialize agent
async function initializeAgent() {
  const keypair = createWallet();

  // Create LLM
  const llm = new ChatOpenAI({
    modelName: "gpt-4-turbo-preview",
    temperature: 0.7,
  });

  // Create Solana Agent Kit
  const solanaKit = new SolanaAgentKit(
    bs58.encode(keypair.secretKey),
    process.env.RPC_URL!,
    { OPENAI_API_KEY: process.env.OPENAI_API_KEY! }
  )
    .use(TokenPlugin)
    .use(DefiPlugin);

  // Create LangChain tools from Solana Agent Kit
  const tools = createSolanaTools(solanaKit);

  // Create memory for conversation persistence
  const memory = new MemorySaver();

  // Create ReAct agent
  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memory,
  });

  return { agent, solanaKit };
}

// Interactive chat loop
async function runChat() {
  const { agent } = await initializeAgent();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const config = { configurable: { thread_id: "solana-chat-1" } };

  console.log("Solana Agent ready! Type your message (or 'quit' to exit)");
  console.log("Example: 'What is my wallet address?'");
  console.log("Example: 'Swap 0.1 SOL for USDC'");
  console.log("");

  const askQuestion = () => {
    rl.question("You: ", async (input) => {
      if (input.toLowerCase() === "quit") {
        console.log("Goodbye!");
        rl.close();
        return;
      }

      try {
        const stream = await agent.stream(
          { messages: [new HumanMessage(input)] },
          config
        );

        process.stdout.write("Agent: ");

        for await (const chunk of stream) {
          if ("agent" in chunk) {
            const content = chunk.agent.messages[0].content;
            if (typeof content === "string") {
              process.stdout.write(content);
            }
          } else if ("tools" in chunk) {
            // Tool execution - optionally log
            console.log("\n[Executing tool...]");
          }
        }

        console.log("\n");
      } catch (error) {
        console.error("Error:", error);
      }

      askQuestion();
    });
  };

  askQuestion();
}

runChat();
```

## Agent with Custom System Prompt

```typescript
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";

async function createAgentWithSystemPrompt() {
  const llm = new ChatOpenAI({
    modelName: "gpt-4-turbo-preview",
    temperature: 0.7,
  });

  const solanaKit = new SolanaAgentKit(wallet, rpcUrl, options)
    .use(TokenPlugin)
    .use(DefiPlugin);

  const tools = createSolanaTools(solanaKit);

  // Custom system prompt
  const systemPrompt = `You are a helpful Solana blockchain assistant.
You can help users with:
- Checking wallet balances
- Swapping tokens via Jupiter
- Deploying new tokens
- Managing NFTs

Always confirm large transactions before executing.
When swapping tokens, warn about slippage.
Never reveal private keys.

Current network: ${process.env.RPC_URL?.includes("devnet") ? "Devnet" : "Mainnet"}`;

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("messages"),
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = createReactAgent({
    llm,
    tools,
    messageModifier: prompt,
  });

  return agent;
}
```

## Multi-Turn Conversation with History

```typescript
import { BufferMemory, ChatMessageHistory } from "langchain/memory";

async function createAgentWithHistory() {
  const llm = new ChatOpenAI({ modelName: "gpt-4-turbo-preview" });
  const tools = createSolanaTools(solanaKit);

  // Create persistent memory
  const memory = new MemorySaver();

  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memory,
  });

  // Each conversation has a unique thread_id
  async function chat(threadId: string, message: string) {
    const config = { configurable: { thread_id: threadId } };

    const response = await agent.invoke(
      { messages: [new HumanMessage(message)] },
      config
    );

    return response.messages[response.messages.length - 1].content;
  }

  // Example conversation
  const thread = "user-123";

  await chat(thread, "What is my wallet address?");
  await chat(thread, "Check my SOL balance");
  await chat(thread, "Now swap 0.1 SOL for USDC");
  // Agent remembers context from previous messages
}
```

## Streaming Responses

```typescript
async function streamingChat(agent: any, message: string) {
  const config = { configurable: { thread_id: "streaming-thread" } };

  const stream = await agent.stream(
    { messages: [new HumanMessage(message)] },
    config
  );

  const events: string[] = [];

  for await (const chunk of stream) {
    if ("agent" in chunk) {
      // Agent's response
      const content = chunk.agent.messages[0].content;
      process.stdout.write(content);
      events.push(`agent: ${content}`);
    } else if ("tools" in chunk) {
      // Tool execution
      const toolResult = chunk.tools.messages[0];
      console.log(`\n[Tool: ${toolResult.name}]`);
      events.push(`tool: ${toolResult.name}`);
    }
  }

  return events;
}
```

## Tool Filtering (Reduce Hallucinations)

```typescript
// Only load specific tools to reduce confusion
function createFilteredTools(solanaKit: SolanaAgentKit) {
  const allTools = createSolanaTools(solanaKit);

  // Filter to only swap and balance tools
  const allowedTools = ["trade", "getBalance", "getWalletAddress"];

  return allTools.filter((tool) => allowedTools.includes(tool.name));
}

// Usage
const agent = createReactAgent({
  llm,
  tools: createFilteredTools(solanaKit), // Fewer tools = less confusion
});
```

## Error Handling

```typescript
async function robustChat(agent: any, message: string) {
  const config = { configurable: { thread_id: "robust-thread" } };

  try {
    const response = await agent.invoke(
      { messages: [new HumanMessage(message)] },
      config
    );

    const lastMessage = response.messages[response.messages.length - 1];

    // Check for tool errors
    if (lastMessage.additional_kwargs?.tool_calls) {
      for (const call of lastMessage.additional_kwargs.tool_calls) {
        if (call.error) {
          console.error(`Tool error: ${call.error}`);
        }
      }
    }

    return lastMessage.content;
  } catch (error) {
    if (error.message.includes("rate limit")) {
      console.log("Rate limited, waiting...");
      await new Promise((r) => setTimeout(r, 5000));
      return robustChat(agent, message);
    }

    if (error.message.includes("insufficient funds")) {
      return "Transaction failed: insufficient funds in wallet";
    }

    throw error;
  }
}
```

## Production Considerations

### 1. Rate Limiting

```typescript
import Bottleneck from "bottleneck";

const limiter = new Bottleneck({
  minTime: 1000, // 1 request per second
  maxConcurrent: 1,
});

const rateLimitedChat = limiter.wrap(async (message: string) => {
  return agent.invoke({ messages: [new HumanMessage(message)] }, config);
});
```

### 2. Transaction Confirmation

```typescript
// Add confirmation step for transactions
const systemPrompt = `Before executing any transaction that transfers tokens or SOL:
1. Summarize what the transaction will do
2. Ask the user to confirm with "yes" or "no"
3. Only proceed if user confirms`;
```

### 3. Logging

```typescript
import { CallbackManager } from "@langchain/core/callbacks/manager";

const callbacks = new CallbackManager();
callbacks.addHandler({
  handleToolStart: (tool, input) => {
    console.log(`[TOOL START] ${tool.name}:`, input);
  },
  handleToolEnd: (output) => {
    console.log(`[TOOL END]`, output);
  },
  handleLLMStart: () => {
    console.log("[LLM START]");
  },
});

const agent = createReactAgent({
  llm,
  tools,
  callbacks,
});
```

## Common Commands

Test these commands with your agent:

```
"What is my wallet address?"
"Check my SOL balance"
"Get my USDC balance"
"Swap 0.1 SOL for USDC"
"What tokens do I have?"
"Request devnet SOL" (devnet only)
"Create a new token called TestCoin with symbol TC"
```
