# Helius Troubleshooting Guide

Common issues and solutions when working with Helius APIs.

## Authentication Errors

### 401 Unauthorized

**Symptoms:**
- API returns 401 status
- Error message: "Invalid API key" or "Unauthorized"

**Solutions:**
1. Verify API key is correct in dashboard
2. Check key hasn't been revoked or expired
3. Ensure key is properly passed in URL:
   ```typescript
   // Correct
   const url = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

   // Wrong - missing api-key parameter
   const url = `https://mainnet.helius-rpc.com`;
   ```
4. Check for extra whitespace in environment variable
5. Ensure you're using the right key for the network (mainnet vs devnet)

### API Key Not Working

**Check:**
```typescript
// Test your key
const response = await fetch(
  `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getHealth",
      params: [],
    }),
  }
);
console.log(await response.json());
```

## Rate Limiting

### 429 Too Many Requests

**Symptoms:**
- API returns 429 status
- Error: "Rate limit exceeded"

**Solutions:**

1. **Implement exponential backoff:**
   ```typescript
   async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
     for (let i = 0; i < maxRetries; i++) {
       try {
         return await fn();
       } catch (error: any) {
         if (error.status === 429 && i < maxRetries - 1) {
           const delay = Math.pow(2, i) * 1000;
           console.log(`Rate limited, waiting ${delay}ms...`);
           await new Promise(r => setTimeout(r, delay));
         } else {
           throw error;
         }
       }
     }
     throw new Error("Max retries exceeded");
   }
   ```

2. **Batch requests:**
   ```typescript
   // Instead of multiple calls
   for (const address of addresses) {
     await helius.getAsset({ id: address });
   }

   // Use batch method
   await helius.getAssetBatch({ ids: addresses });
   ```

3. **Add delays between requests:**
   ```typescript
   async function rateLimitedFetch<T>(
     requests: (() => Promise<T>)[],
     delayMs = 100
   ): Promise<T[]> {
     const results: T[] = [];
     for (const request of requests) {
       results.push(await request());
       await new Promise(r => setTimeout(r, delayMs));
     }
     return results;
   }
   ```

4. **Upgrade your plan** if consistently hitting limits

### Checking Credit Usage

Monitor usage in the Helius Dashboard: https://dashboard.helius.dev

## Transaction Errors

### Transaction Failed to Land

**Symptoms:**
- Transaction sent but not confirmed
- Blockhash expired error

**Solutions:**

1. **Use priority fees:**
   ```typescript
   const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
     accountKeys: [signer.address],
     options: { priorityLevel: "HIGH" },
   });
   ```

2. **Increase compute budget:**
   ```typescript
   const tx = pipe(
     createTransactionMessage({ version: 0 }),
     // ...
     (tx) => prependTransactionMessageInstructions([
       getSetComputeUnitLimitInstruction({ units: 400_000 }),
       getSetComputeUnitPriceInstruction({ microLamports: BigInt(priorityFeeEstimate) }),
     ], tx),
   );
   ```

3. **Retry with fresh blockhash:**
   ```typescript
   async function sendWithRetry(buildTx: (blockhash: any) => Transaction, maxRetries = 3) {
     for (let i = 0; i < maxRetries; i++) {
       const { value: blockhash } = await rpc.getLatestBlockhash().send();
       const tx = await buildTx(blockhash);

       try {
         return await sendAndConfirm(tx);
       } catch (error) {
         if (i === maxRetries - 1) throw error;
         console.log(`Attempt ${i + 1} failed, retrying...`);
       }
     }
   }
   ```

### Simulation Failed

**Symptoms:**
- `simulateTransaction` returns error
- Transaction fails preflight checks

**Solutions:**

1. **Check account balances:**
   ```typescript
   const balance = await rpc.getBalance(signer.address).send();
   console.log("Balance:", balance.value);
   ```

2. **Verify accounts exist:**
   ```typescript
   const account = await fetchEncodedAccount(rpc, address);
   if (!account.exists) {
     console.error("Account does not exist");
   }
   ```

3. **Check simulation logs:**
   ```typescript
   const simulation = await rpc.simulateTransaction(encodedTx, {
     encoding: "base64",
   }).send();

   if (simulation.value.err) {
     console.error("Error:", simulation.value.err);
     console.error("Logs:", simulation.value.logs);
   }
   ```

## DAS API Issues

### Asset Not Found

**Symptoms:**
- `getAsset` returns null or error
- Asset exists on-chain but not in DAS

**Solutions:**

1. **Wait for indexing** - New assets may take a few seconds to index
2. **Verify asset ID** - Ensure you're using the correct mint address
3. **Check if asset is burned:**
   ```typescript
   const asset = await helius.getAsset({ id: assetId });
   if (asset.burnt) {
     console.log("Asset has been burned");
   }
   ```

### Compressed NFT Proof Errors

**Symptoms:**
- `getAssetProof` fails
- Proof verification fails

**Solutions:**

1. **Ensure asset is compressed:**
   ```typescript
   const asset = await helius.getAsset({ id: assetId });
   if (!asset.compression?.compressed) {
     console.error("Asset is not compressed");
   }
   ```

2. **Get fresh proof:**
   ```typescript
   const proof = await helius.getAssetProof({ id: assetId });
   // Proofs can become stale, always get fresh before use
   ```

### Search Returns No Results

**Solutions:**

1. **Check filter combinations:**
   ```typescript
   // Start with minimal filters
   const results = await helius.searchAssets({
     ownerAddress: wallet,
     page: 1,
   });

   // Then add filters one by one
   ```

2. **Verify pagination:**
   ```typescript
   // Check total count
   console.log("Total:", results.total);

   // Paginate through all results
   let page = 1;
   while (true) {
     const response = await helius.searchAssets({
       ownerAddress: wallet,
       page,
       limit: 1000,
     });
     if (response.items.length === 0) break;
     page++;
   }
   ```

## Webhook Issues

### Webhooks Not Receiving Events

**Solutions:**

1. **Verify webhook URL is accessible:**
   ```bash
   curl -X POST https://your-server.com/webhook \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

2. **Check webhook configuration:**
   ```typescript
   const webhooks = await helius.webhooks.getAllWebhooks();
   console.log(webhooks);
   ```

3. **Verify addresses are correct:**
   ```typescript
   const webhook = await helius.webhooks.getWebhookByID({ webhookID: id });
   console.log("Addresses:", webhook.accountAddresses);
   console.log("Types:", webhook.transactionTypes);
   ```

4. **Check transaction types match:**
   - Ensure `transactionTypes` includes the types you want
   - Use empty array for all types (raw webhooks)

### Receiving Duplicate Events

**Solution - Implement deduplication:**
```typescript
const processed = new Set<string>();

app.post("/webhook", (req, res) => {
  const { signature } = req.body;

  if (processed.has(signature)) {
    return res.status(200).json({ duplicate: true });
  }

  processed.add(signature);
  // Process webhook...

  res.status(200).json({ received: true });
});
```

### Webhook Delivery Failures

**Check:**
1. Server responds within 30 seconds
2. Server returns 2xx status code
3. No firewall blocking Helius IPs

## WebSocket Issues

### Connection Drops

**Solution - Implement reconnection:**
```typescript
class ReconnectingWebSocket {
  private ws: WebSocket;
  private reconnectAttempts = 0;

  constructor(private url: string) {
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onclose = () => {
      if (this.reconnectAttempts < 5) {
        this.reconnectAttempts++;
        const delay = Math.pow(2, this.reconnectAttempts) * 1000;
        setTimeout(() => this.connect(), delay);
      }
    };

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };
  }
}
```

### Subscriptions Not Working

**Solutions:**

1. **Check subscription ID:**
   ```typescript
   ws.onmessage = (event) => {
     const data = JSON.parse(event.data);
     if (data.result !== undefined) {
       console.log("Subscription ID:", data.result);
     }
   };
   ```

2. **Verify commitment level:**
   ```typescript
   // Use "confirmed" for most use cases
   ws.send(JSON.stringify({
     jsonrpc: "2.0",
     id: 1,
     method: "accountSubscribe",
     params: [address, { commitment: "confirmed" }],
   }));
   ```

## Network Issues

### Request Timeout

**Solutions:**

1. **Increase timeout:**
   ```typescript
   const response = await fetch(url, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify(payload),
     signal: AbortSignal.timeout(30000), // 30 seconds
   });
   ```

2. **Use regional endpoints** for lower latency

### SSL/TLS Errors

**Solutions:**
1. Ensure you're using HTTPS
2. Check system time is correct
3. Update SSL certificates

## SDK Issues

### TypeScript Type Errors

**Solution:**
```typescript
// Ensure correct imports
import type { Asset, EnhancedTransaction } from "helius-sdk";

// Type assertions when needed
const asset = await helius.getAsset({ id }) as Asset;
```

### SDK Version Mismatch

**Solution:**
```bash
# Update to latest version
npm update helius-sdk

# Or install specific version
npm install helius-sdk@2.0.0
```

## Common Error Codes

| Code | Meaning | Solution |
|------|---------|----------|
| -32600 | Invalid Request | Check JSON-RPC format |
| -32601 | Method not found | Verify method name |
| -32602 | Invalid params | Check parameter types |
| -32603 | Internal error | Retry or contact support |
| -32000 | Server error | Check Helius status page |

## Getting Help

1. **Check Helius Status:** https://status.helius.dev
2. **Documentation:** https://www.helius.dev/docs
3. **Discord:** https://discord.gg/helius
4. **Support:** support@helius.dev

## Debug Checklist

- [ ] API key is valid and not expired
- [ ] Using correct network (mainnet vs devnet)
- [ ] Request format is correct (JSON-RPC 2.0)
- [ ] Account addresses are valid base58
- [ ] Sufficient SOL for transaction fees
- [ ] Priority fees are appropriate for network load
- [ ] Webhook URL is publicly accessible
- [ ] WebSocket connection is stable
- [ ] Not exceeding rate limits
