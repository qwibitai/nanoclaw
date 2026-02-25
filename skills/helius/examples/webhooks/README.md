# Webhooks Examples

Examples demonstrating Helius Webhooks for real-time blockchain monitoring.

## Setup

```typescript
import { createHelius } from "helius-sdk";

const helius = createHelius({
  apiKey: process.env.HELIUS_API_KEY!,
});
```

## Create Enhanced Webhook

```typescript
async function createSwapWebhook(webhookUrl: string, addresses: string[]) {
  const webhook = await helius.webhooks.createWebhook({
    webhookURL: webhookUrl,
    transactionTypes: ["SWAP"],
    accountAddresses: addresses,
    webhookType: "enhanced",
    authHeader: `Bearer ${process.env.WEBHOOK_SECRET}`,
  });

  console.log("Created webhook:", webhook.webhookID);
  return webhook;
}

// Create webhook for NFT sales
async function createNFTSalesWebhook(webhookUrl: string, collectionAddresses: string[]) {
  const webhook = await helius.webhooks.createWebhook({
    webhookURL: webhookUrl,
    transactionTypes: ["NFT_SALE", "NFT_LISTING", "NFT_BID"],
    accountAddresses: collectionAddresses,
    webhookType: "enhanced",
  });

  console.log("Created NFT sales webhook:", webhook.webhookID);
  return webhook;
}

// Create webhook for wallet monitoring
async function createWalletWebhook(webhookUrl: string, walletAddress: string) {
  const webhook = await helius.webhooks.createWebhook({
    webhookURL: webhookUrl,
    transactionTypes: ["TRANSFER", "SWAP", "NFT_SALE"],
    accountAddresses: [walletAddress],
    webhookType: "enhanced",
  });

  console.log("Created wallet webhook:", webhook.webhookID);
  return webhook;
}
```

## Create Raw Webhook

```typescript
async function createRawWebhook(webhookUrl: string, addresses: string[]) {
  const webhook = await helius.webhooks.createWebhook({
    webhookURL: webhookUrl,
    accountAddresses: addresses,
    webhookType: "raw",
  });

  console.log("Created raw webhook:", webhook.webhookID);
  return webhook;
}
```

## Create Discord Webhook

```typescript
async function createDiscordWebhook(
  discordWebhookUrl: string,
  collectionAddress: string
) {
  const webhook = await helius.webhooks.createWebhook({
    webhookURL: discordWebhookUrl,
    transactionTypes: ["NFT_SALE"],
    accountAddresses: [collectionAddress],
    webhookType: "discord",
  });

  console.log("Created Discord webhook:", webhook.webhookID);
  return webhook;
}
```

## Manage Webhooks

```typescript
// List all webhooks
async function listWebhooks() {
  const webhooks = await helius.webhooks.getAllWebhooks();

  console.log(`Found ${webhooks.length} webhooks:`);
  for (const webhook of webhooks) {
    console.log(`  ID: ${webhook.webhookID}`);
    console.log(`  URL: ${webhook.webhookURL}`);
    console.log(`  Type: ${webhook.webhookType}`);
    console.log(`  Types: ${webhook.transactionTypes?.join(", ") || "all"}`);
    console.log(`  Addresses: ${webhook.accountAddresses?.length || 0}`);
    console.log("---");
  }

  return webhooks;
}

// Get specific webhook
async function getWebhook(webhookId: string) {
  const webhook = await helius.webhooks.getWebhookByID({
    webhookID: webhookId,
  });

  console.log("Webhook details:", webhook);
  return webhook;
}

// Update webhook
async function updateWebhook(
  webhookId: string,
  updates: {
    webhookURL?: string;
    transactionTypes?: string[];
    accountAddresses?: string[];
  }
) {
  await helius.webhooks.updateWebhook({
    webhookID: webhookId,
    ...updates,
  });

  console.log("Webhook updated");
}

// Add addresses to webhook
async function addAddressesToWebhook(webhookId: string, newAddresses: string[]) {
  const webhook = await helius.webhooks.getWebhookByID({ webhookID: webhookId });
  const existingAddresses = webhook.accountAddresses || [];

  await helius.webhooks.updateWebhook({
    webhookID: webhookId,
    accountAddresses: [...existingAddresses, ...newAddresses],
  });

  console.log(`Added ${newAddresses.length} addresses to webhook`);
}

// Delete webhook
async function deleteWebhook(webhookId: string) {
  await helius.webhooks.deleteWebhook({
    webhookID: webhookId,
  });

  console.log("Webhook deleted");
}
```

## Express Webhook Server

```typescript
import express from "express";

const app = express();
app.use(express.json());

// Deduplication set
const processedSignatures = new Set<string>();

// Verify webhook authenticity
function verifyWebhook(req: express.Request): boolean {
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${process.env.WEBHOOK_SECRET}`;
}

// Main webhook endpoint
app.post("/webhook", (req, res) => {
  // Verify auth
  if (!verifyWebhook(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;
  const signature = payload.signature;

  // Deduplicate
  if (processedSignatures.has(signature)) {
    return res.status(200).json({ duplicate: true });
  }
  processedSignatures.add(signature);

  // Clean up old signatures
  if (processedSignatures.size > 10000) {
    const arr = Array.from(processedSignatures);
    arr.slice(0, 5000).forEach(s => processedSignatures.delete(s));
  }

  // Process based on type
  try {
    switch (payload.type) {
      case "SWAP":
        handleSwap(payload);
        break;
      case "NFT_SALE":
        handleNFTSale(payload);
        break;
      case "TRANSFER":
        handleTransfer(payload);
        break;
      default:
        console.log("Unknown type:", payload.type);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(200).json({ received: true, error: true });
  }
});

function handleSwap(payload: any) {
  const { events, signature, timestamp } = payload;

  if (events?.swap) {
    const swap = events.swap;
    console.log("=== SWAP DETECTED ===");
    console.log(`Signature: ${signature}`);
    console.log(`Time: ${new Date(timestamp * 1000).toISOString()}`);

    if (swap.tokenInputs?.[0]) {
      console.log(`Input: ${swap.tokenInputs[0].mint}`);
      console.log(`Amount: ${swap.tokenInputs[0].rawTokenAmount.tokenAmount}`);
    }

    if (swap.tokenOutputs?.[0]) {
      console.log(`Output: ${swap.tokenOutputs[0].mint}`);
      console.log(`Amount: ${swap.tokenOutputs[0].rawTokenAmount.tokenAmount}`);
    }
  }
}

function handleNFTSale(payload: any) {
  const { events, signature } = payload;

  if (events?.nft) {
    const nft = events.nft;
    console.log("=== NFT SALE ===");
    console.log(`Signature: ${signature}`);
    console.log(`Buyer: ${nft.buyer}`);
    console.log(`Seller: ${nft.seller}`);
    console.log(`Price: ${nft.amount / 1e9} SOL`);
    console.log(`Source: ${nft.source}`);

    for (const item of nft.nfts || []) {
      console.log(`NFT: ${item.mint}`);
    }
  }
}

function handleTransfer(payload: any) {
  const { nativeTransfers, tokenTransfers, signature } = payload;

  console.log("=== TRANSFER ===");
  console.log(`Signature: ${signature}`);

  for (const transfer of nativeTransfers || []) {
    console.log(`SOL: ${transfer.fromUserAccount} -> ${transfer.toUserAccount}`);
    console.log(`Amount: ${transfer.amount / 1e9} SOL`);
  }

  for (const transfer of tokenTransfers || []) {
    console.log(`Token: ${transfer.mint}`);
    console.log(`From: ${transfer.fromUserAccount}`);
    console.log(`To: ${transfer.toUserAccount}`);
    console.log(`Amount: ${transfer.tokenAmount}`);
  }
}

app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});
```

## Redis-Based Deduplication

```typescript
import Redis from "ioredis";
import express from "express";

const redis = new Redis(process.env.REDIS_URL);
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const { signature } = req.body;

  // Check if already processed (set with 1 hour expiry)
  const exists = await redis.set(
    `webhook:${signature}`,
    "1",
    "EX", 3600,
    "NX"
  );

  if (!exists) {
    return res.status(200).json({ duplicate: true });
  }

  // Queue for async processing
  await redis.lpush("webhook:queue", JSON.stringify(req.body));

  res.status(200).json({ received: true });
});

// Worker to process webhooks
async function processWebhookQueue() {
  while (true) {
    const item = await redis.brpop("webhook:queue", 0);
    if (item) {
      const payload = JSON.parse(item[1]);
      await processWebhook(payload);
    }
  }
}

async function processWebhook(payload: any) {
  // Process webhook...
  console.log("Processing:", payload.signature);
}

// Start worker in separate process
processWebhookQueue();
```

## Alert System Example

```typescript
import { Webhook } from "discord-webhook-node";

const discordHook = new Webhook(process.env.DISCORD_WEBHOOK_URL!);

async function sendNFTSaleAlert(sale: any) {
  const { buyer, seller, amount, nfts, source } = sale;

  await discordHook.send({
    username: "NFT Sales Bot",
    embeds: [{
      title: "NFT Sale Detected!",
      color: 0x00ff00,
      fields: [
        { name: "NFT", value: nfts[0]?.mint || "Unknown", inline: false },
        { name: "Price", value: `${amount / 1e9} SOL`, inline: true },
        { name: "Marketplace", value: source, inline: true },
        { name: "Buyer", value: buyer?.slice(0, 8) + "...", inline: true },
        { name: "Seller", value: seller?.slice(0, 8) + "...", inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function sendSwapAlert(swap: any, signature: string) {
  const inputToken = swap.tokenInputs?.[0];
  const outputToken = swap.tokenOutputs?.[0];

  await discordHook.send({
    username: "Swap Bot",
    embeds: [{
      title: "Swap Detected!",
      color: 0x0099ff,
      fields: [
        { name: "Input", value: inputToken?.mint?.slice(0, 8) + "..." || "SOL", inline: true },
        { name: "Output", value: outputToken?.mint?.slice(0, 8) + "..." || "SOL", inline: true },
        { name: "Signature", value: `[View](https://solscan.io/tx/${signature})`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}
```

## Complete Monitoring System

```typescript
import express from "express";
import { createHelius } from "helius-sdk";
import Redis from "ioredis";

class WebhookMonitor {
  private helius: ReturnType<typeof createHelius>;
  private redis: Redis;
  private webhookId?: string;

  constructor() {
    this.helius = createHelius({ apiKey: process.env.HELIUS_API_KEY! });
    this.redis = new Redis(process.env.REDIS_URL!);
  }

  async setup(webhookUrl: string, addresses: string[]) {
    // Create webhook
    const webhook = await this.helius.webhooks.createWebhook({
      webhookURL: webhookUrl,
      transactionTypes: ["SWAP", "NFT_SALE", "TRANSFER"],
      accountAddresses: addresses,
      webhookType: "enhanced",
      authHeader: `Bearer ${process.env.WEBHOOK_SECRET}`,
    });

    this.webhookId = webhook.webhookID;
    console.log("Webhook created:", this.webhookId);

    return this.webhookId;
  }

  async addAddress(address: string) {
    if (!this.webhookId) throw new Error("Webhook not setup");

    const webhook = await this.helius.webhooks.getWebhookByID({
      webhookID: this.webhookId,
    });

    await this.helius.webhooks.updateWebhook({
      webhookID: this.webhookId,
      accountAddresses: [...(webhook.accountAddresses || []), address],
    });

    console.log("Address added:", address);
  }

  async processWebhook(payload: any) {
    const { signature, type } = payload;

    // Deduplicate
    const isNew = await this.redis.set(
      `processed:${signature}`,
      "1",
      "EX", 3600,
      "NX"
    );

    if (!isNew) {
      return { duplicate: true };
    }

    // Store event
    await this.redis.lpush(`events:${type}`, JSON.stringify(payload));

    // Trigger alerts based on type
    switch (type) {
      case "SWAP":
        await this.handleSwap(payload);
        break;
      case "NFT_SALE":
        await this.handleNFTSale(payload);
        break;
      case "TRANSFER":
        await this.handleTransfer(payload);
        break;
    }

    return { processed: true };
  }

  private async handleSwap(payload: any) {
    // Custom swap handling
    console.log("Swap:", payload.signature);
  }

  private async handleNFTSale(payload: any) {
    // Custom NFT sale handling
    console.log("NFT Sale:", payload.signature);
  }

  private async handleTransfer(payload: any) {
    // Custom transfer handling
    console.log("Transfer:", payload.signature);
  }

  async getStats() {
    const [swaps, nftSales, transfers] = await Promise.all([
      this.redis.llen("events:SWAP"),
      this.redis.llen("events:NFT_SALE"),
      this.redis.llen("events:TRANSFER"),
    ]);

    return { swaps, nftSales, transfers };
  }

  async cleanup() {
    if (this.webhookId) {
      await this.helius.webhooks.deleteWebhook({
        webhookID: this.webhookId,
      });
      console.log("Webhook deleted");
    }
    await this.redis.quit();
  }
}

// Usage
const monitor = new WebhookMonitor();

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const result = await monitor.processWebhook(req.body);
  res.status(200).json(result);
});

app.get("/stats", async (req, res) => {
  const stats = await monitor.getStats();
  res.json(stats);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await monitor.cleanup();
  process.exit(0);
});

app.listen(3000);
```
