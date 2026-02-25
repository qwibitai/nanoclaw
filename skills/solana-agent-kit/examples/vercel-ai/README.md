# Vercel AI SDK Integration with Solana Agent Kit

Build AI-powered Solana applications using Vercel AI SDK.

## Setup

### Installation

```bash
npm install solana-agent-kit \
  @solana-agent-kit/plugin-token \
  @solana-agent-kit/plugin-defi \
  @solana-agent-kit/plugin-nft \
  ai \
  @ai-sdk/openai \
  dotenv
```

### Environment Variables

```bash
# .env
OPENAI_API_KEY=sk-...
RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY=your_base58_private_key
```

## Basic Agent

```typescript
// vercel-agent.ts
import {
  SolanaAgentKit,
  createVercelAITools,
  KeypairWallet,
} from "solana-agent-kit";
import TokenPlugin from "@solana-agent-kit/plugin-token";
import DefiPlugin from "@solana-agent-kit/plugin-defi";
import { openai } from "@ai-sdk/openai";
import { generateText, streamText, tool } from "ai";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import "dotenv/config";

// Initialize wallet
const privateKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY!);
const keypair = Keypair.fromSecretKey(privateKey);
const wallet = new KeypairWallet(keypair);

// Initialize Solana Agent Kit
const agent = new SolanaAgentKit(
  wallet,
  process.env.RPC_URL!,
  { OPENAI_API_KEY: process.env.OPENAI_API_KEY! }
)
  .use(TokenPlugin)
  .use(DefiPlugin);

// Create Vercel AI tools
const tools = createVercelAITools(agent, agent.actions);

// Generate single response
async function chat(prompt: string) {
  const result = await generateText({
    model: openai("gpt-4-turbo"),
    tools,
    maxSteps: 10,  // Allow multi-step tool calls
    prompt,
  });

  return result.text;
}

// Example usage
async function main() {
  console.log(await chat("What is my wallet address?"));
  console.log(await chat("Check my SOL balance"));
  console.log(await chat("Swap 0.1 SOL for USDC"));
}

main();
```

## Streaming Responses

```typescript
import { streamText } from "ai";

async function streamChat(prompt: string) {
  const result = await streamText({
    model: openai("gpt-4-turbo"),
    tools,
    maxSteps: 10,
    prompt,
  });

  // Stream the response
  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }

  console.log("\n");

  // Get final result
  return result.text;
}
```

## Next.js API Route

```typescript
// app/api/chat/route.ts
import {
  SolanaAgentKit,
  createVercelAITools,
  KeypairWallet,
} from "solana-agent-kit";
import TokenPlugin from "@solana-agent-kit/plugin-token";
import DefiPlugin from "@solana-agent-kit/plugin-defi";
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  // Initialize agent (consider caching this)
  const privateKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY!);
  const keypair = Keypair.fromSecretKey(privateKey);
  const wallet = new KeypairWallet(keypair);

  const agent = new SolanaAgentKit(
    wallet,
    process.env.RPC_URL!,
    { OPENAI_API_KEY: process.env.OPENAI_API_KEY! }
  )
    .use(TokenPlugin)
    .use(DefiPlugin);

  const tools = createVercelAITools(agent, agent.actions);

  const result = await streamText({
    model: openai("gpt-4-turbo"),
    tools,
    maxSteps: 10,
    messages,
  });

  return result.toDataStreamResponse();
}
```

## React Client Component

```tsx
// components/SolanaChat.tsx
"use client";

import { useChat } from "ai/react";

export function SolanaChat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({
      api: "/api/chat",
    });

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto p-4">
      <div className="flex-1 overflow-y-auto space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`p-4 rounded-lg ${
              message.role === "user"
                ? "bg-blue-100 ml-auto max-w-[80%]"
                : "bg-gray-100 mr-auto max-w-[80%]"
            }`}
          >
            <p className="text-sm font-semibold mb-1">
              {message.role === "user" ? "You" : "Agent"}
            </p>
            <p>{message.content}</p>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 mt-4">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask about your Solana wallet..."
          className="flex-1 p-3 border rounded-lg"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="px-6 py-3 bg-blue-500 text-white rounded-lg disabled:opacity-50"
        >
          {isLoading ? "..." : "Send"}
        </button>
      </form>
    </div>
  );
}
```

## System Prompt Configuration

```typescript
import { generateText } from "ai";

const systemPrompt = `You are a Solana blockchain assistant.
You help users manage their wallets, swap tokens, and interact with DeFi protocols.

Guidelines:
- Always confirm large transactions (>1 SOL) before executing
- Warn users about slippage when swapping
- Never reveal private keys
- Explain what each action does before doing it

Current capabilities:
- Check balances
- Swap tokens via Jupiter
- Deploy new tokens
- Manage NFTs`;

async function chatWithSystem(userMessage: string) {
  const result = await generateText({
    model: openai("gpt-4-turbo"),
    tools,
    maxSteps: 10,
    system: systemPrompt,
    prompt: userMessage,
  });

  return result.text;
}
```

## Multi-Step Workflows

```typescript
async function complexWorkflow() {
  const result = await generateText({
    model: openai("gpt-4-turbo"),
    tools,
    maxSteps: 20,  // Allow more steps for complex tasks
    prompt: `
      Please do the following:
      1. Check my SOL balance
      2. If I have more than 0.5 SOL, swap 0.1 SOL for USDC
      3. Report the final balances
    `,
  });

  // Access step details
  console.log("Steps taken:", result.steps.length);

  for (const step of result.steps) {
    if (step.toolCalls) {
      for (const call of step.toolCalls) {
        console.log(`Tool: ${call.toolName}`, call.args);
      }
    }
  }

  return result.text;
}
```

## Tool Call Handling

```typescript
import { generateText, ToolCall, ToolResult } from "ai";

async function chatWithToolLogging(prompt: string) {
  const result = await generateText({
    model: openai("gpt-4-turbo"),
    tools,
    maxSteps: 10,
    prompt,
    onStepFinish: ({ toolCalls, toolResults }) => {
      // Log each tool call
      if (toolCalls) {
        for (const call of toolCalls) {
          console.log(`[Tool Call] ${call.toolName}:`, call.args);
        }
      }

      // Log results
      if (toolResults) {
        for (const result of toolResults) {
          console.log(`[Tool Result]:`, result.result);
        }
      }
    },
  });

  return result;
}
```

## Error Handling

```typescript
import { generateText, APICallError, RetryError } from "ai";

async function robustChat(prompt: string) {
  try {
    const result = await generateText({
      model: openai("gpt-4-turbo"),
      tools,
      maxSteps: 10,
      prompt,
      maxRetries: 3,  // Retry on failure
    });

    return result.text;
  } catch (error) {
    if (error instanceof APICallError) {
      console.error("API Error:", error.message);

      if (error.statusCode === 429) {
        // Rate limited
        await new Promise((r) => setTimeout(r, 5000));
        return robustChat(prompt);
      }
    }

    if (error instanceof RetryError) {
      console.error("Max retries exceeded");
    }

    throw error;
  }
}
```

## Restricting Tools

```typescript
// Only allow read operations
const readOnlyActions = agent.actions.filter((action) =>
  ["getBalance", "getWalletAddress", "getPrice", "getTokenData"].includes(
    action.name
  )
);

const readOnlyTools = createVercelAITools(agent, readOnlyActions);

const result = await generateText({
  model: openai("gpt-4-turbo"),
  tools: readOnlyTools,
  prompt: "Check all my token balances",
});
```

## Edge Runtime Support

```typescript
// app/api/chat/route.ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

export const runtime = "edge";

export async function POST(req: Request) {
  const { messages } = await req.json();

  // Note: Edge runtime has limitations
  // Consider using serverless functions for full Solana Agent Kit support

  const result = await streamText({
    model: openai("gpt-4-turbo"),
    messages,
    // Limited tools in edge runtime
  });

  return result.toDataStreamResponse();
}
```

## Production Tips

1. **Cache agent initialization** - Don't create new agent per request
2. **Use connection pooling** - Reuse RPC connections
3. **Implement rate limiting** - Protect your API
4. **Add authentication** - Secure your endpoints
5. **Monitor tool usage** - Log all blockchain operations
6. **Set transaction limits** - Prevent large unintended transfers
