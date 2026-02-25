# Solana Agent Kit - Complete Actions Reference

All 60+ actions available in the Solana Agent Kit, organized by plugin.

## Token Plugin Actions

### `deployToken`
Deploy a new SPL token or Token-2022.

```typescript
await agent.methods.deployToken({
  name: "My Token",
  symbol: "MTK",
  decimals: 9,
  initialSupply: 1000000,
  uri: "https://metadata.json",      // optional
  mintAuthority: "pubkey",           // optional
  freezeAuthority: "pubkey",         // optional
});
```

### `transfer`
Transfer SOL or SPL tokens.

```typescript
await agent.methods.transfer({
  to: "recipient_address",
  amount: 100,
  mint: "token_mint",  // optional, SOL if omitted
});
```

### `getBalance`
Check wallet balance.

```typescript
const balance = await agent.methods.getBalance({
  tokenAddress: "mint_address",  // optional
});
// Returns: { balance: number, decimals: number }
```

### `stake`
Stake SOL via Jupiter or Solayer.

```typescript
await agent.methods.stake({
  amount: 10,  // SOL
  provider: "jupiter", // or "solayer"
});
```

### `bridge`
Bridge tokens via Wormhole.

```typescript
await agent.methods.bridge({
  amount: 100,
  token: "token_mint",
  targetChain: "ethereum",
  recipientAddress: "0x...",
});
```

### `rugCheck`
Analyze token safety.

```typescript
const analysis = await agent.methods.rugCheck({
  mint: "token_mint",
});
// Returns: { score: number, risks: string[], safe: boolean }
```

### `getTokenData`
Get token metadata and info.

```typescript
const data = await agent.methods.getTokenData({
  mint: "token_mint",
});
```

### `burnTokens`
Burn SPL tokens.

```typescript
await agent.methods.burnTokens({
  mint: "token_mint",
  amount: 100,
});
```

### `closeEmptyAccounts`
Close empty token accounts to reclaim SOL.

```typescript
await agent.methods.closeEmptyAccounts();
```

---

## NFT Plugin Actions

### `createCollection`
Create NFT collection via Metaplex.

```typescript
const collection = await agent.methods.createCollection({
  name: "My Collection",
  symbol: "MYCOL",
  uri: "https://arweave.net/collection-metadata.json",
  royaltyBasisPoints: 500,  // 5%
  creators: [
    { address: "creator1", share: 100 }
  ],
});
```

### `mintNFT`
Mint NFT to a collection.

```typescript
const nft = await agent.methods.mintNFT({
  collectionMint: "collection_address",
  name: "NFT #1",
  uri: "https://arweave.net/nft-metadata.json",
  sellerFeeBasisPoints: 500,
  recipient: "recipient_address",  // optional
});
```

### `mintNFTWithAI`
Generate NFT artwork with DALL-E and mint.

```typescript
const nft = await agent.methods.mintNFTWithAI({
  collectionMint: "collection_address",
  name: "AI Generated NFT",
  prompt: "A futuristic city with flying cars",
});
```

### `listNFT`
List NFT on marketplace.

```typescript
await agent.methods.listNFT({
  mint: "nft_mint",
  price: 1.5,  // SOL
  marketplace: "3land",  // or others
});
```

### `updateNFTMetadata`
Update NFT metadata.

```typescript
await agent.methods.updateNFTMetadata({
  mint: "nft_mint",
  name: "Updated Name",
  uri: "https://new-metadata.json",
});
```

### `verifyCollection`
Verify NFT in collection.

```typescript
await agent.methods.verifyCollection({
  nftMint: "nft_mint",
  collectionMint: "collection_mint",
});
```

---

## DeFi Plugin Actions

### `trade` (Jupiter Swap)
Swap tokens via Jupiter aggregator.

```typescript
const swap = await agent.methods.trade({
  outputMint: "target_token_mint",
  inputAmount: 1.0,
  inputMint: "So11111111111111111111111111111111111111112", // SOL
  slippageBps: 50,  // 0.5%
});
```

### `createRaydiumCpmm`
Create Raydium CPMM pool.

```typescript
await agent.methods.createRaydiumCpmm({
  mintA: "token_a_mint",
  mintB: "token_b_mint",
  configId: "raydium_config_id",
  mintAAmount: 1000,
  mintBAmount: 1000,
});
```

### `createRaydiumClmm`
Create Raydium Concentrated Liquidity pool.

```typescript
await agent.methods.createRaydiumClmm({
  mintA: "token_a_mint",
  mintB: "token_b_mint",
  configId: "config_id",
  initialPrice: 1.5,
  startTime: Date.now(),
});
```

### `createRaydiumAmmV4`
Create Raydium AMM V4 pool.

```typescript
await agent.methods.createRaydiumAmmV4({
  marketId: "openbook_market_id",
  baseAmount: 1000,
  quoteAmount: 1000,
  startTime: Date.now(),
});
```

### `createOrcaWhirlpool`
Create Orca Whirlpool.

```typescript
await agent.methods.createOrcaWhirlpool({
  tokenMintA: "token_a",
  tokenMintB: "token_b",
  tickSpacing: 64,
  initialPrice: 1.0,
  feeTier: 0.003,  // 0.3%
});
```

### `createMeteoraPool`
Create Meteora Dynamic AMM pool.

```typescript
await agent.methods.createMeteoraPool({
  tokenA: "token_a_mint",
  tokenB: "token_b_mint",
  amountA: 1000,
  amountB: 1000,
});
```

### `createMeteoraDlmm`
Create Meteora DLMM pool.

```typescript
await agent.methods.createMeteoraDlmm({
  tokenA: "token_a_mint",
  tokenB: "token_b_mint",
  binStep: 10,
  initialPrice: 1.0,
});
```

### `createManifestMarket`
Create Manifest market for limit orders.

```typescript
await agent.methods.createManifestMarket({
  baseMint: "base_token",
  quoteMint: "quote_token",
});
```

### `limitOrder`
Place limit order via Manifest.

```typescript
await agent.methods.limitOrder({
  marketId: "manifest_market_id",
  side: "buy",  // or "sell"
  price: 1.5,
  quantity: 100,
});
```

### `lend`
Lend assets via Lulo.

```typescript
await agent.methods.lend({
  asset: "USDC",
  amount: 100,
});
```

### `borrow`
Borrow assets.

```typescript
await agent.methods.borrow({
  asset: "USDC",
  amount: 50,
  collateral: "SOL",
});
```

### `perpetualTrade`
Trade perpetuals via Adrena/Drift.

```typescript
await agent.methods.perpetualTrade({
  market: "SOL-PERP",
  side: "long",
  size: 10,
  leverage: 5,
  protocol: "adrena",  // or "drift"
});
```

### `flashLoan`
Execute flash loan.

```typescript
await agent.methods.flashLoan({
  amount: 10000,
  token: "USDC",
  callback: async (borrowedAmount) => {
    // Your arbitrage logic
  },
});
```

---

## Misc Plugin Actions

### `sendCompressedAirdrop`
ZK-compressed airdrop via Helius.

```typescript
await agent.methods.sendCompressedAirdrop({
  mintAddress: "token_mint",
  amount: 100,
  recipients: ["addr1", "addr2", "addr3"],
  priorityFeeInLamports: 10000,
});
```

### `getPrice`
Get token price via CoinGecko.

```typescript
const price = await agent.methods.getPrice({
  tokenId: "solana",  // CoinGecko ID
});
// Returns: { usd: number, change24h: number }
```

### `getTokenInfo`
Get detailed token info from CoinGecko.

```typescript
const info = await agent.methods.getTokenInfo({
  tokenId: "solana",
});
```

### `registerDomain`
Register .sol domain via SNS.

```typescript
await agent.methods.registerDomain({
  name: "myname",  // results in myname.sol
  space: 1000,     // bytes
});
```

### `resolveDomain`
Resolve domain to address.

```typescript
const address = await agent.methods.resolveDomain({
  domain: "myname.sol",
});
```

### `getAllDomains`
Get all domains for a wallet.

```typescript
const domains = await agent.methods.getAllDomains({
  owner: "wallet_address",  // optional, defaults to agent wallet
});
```

### `requestFaucet`
Request devnet/testnet SOL.

```typescript
await agent.methods.requestFaucet({
  amount: 2,  // SOL
});
```

### `getTPS`
Get current network TPS.

```typescript
const tps = await agent.methods.getTPS();
```

### `getRecentTransactions`
Get recent transactions for wallet.

```typescript
const txs = await agent.methods.getRecentTransactions({
  limit: 10,
});
```

---

## Blinks Plugin Actions

### `executeBlink`
Execute a Solana Blink/Action.

```typescript
const result = await agent.methods.executeBlink({
  blinkUrl: "https://example.com/blink",
  params: {
    // Blink-specific parameters
  },
});
```

### `getLuloBlink`
Execute Lulo lending blink.

```typescript
await agent.methods.getLuloBlink({
  action: "deposit",
  asset: "USDC",
  amount: 100,
});
```

### `getJupSOLBlink`
Stake SOL via JupSOL blink.

```typescript
await agent.methods.getJupSOLBlink({
  amount: 5,  // SOL to stake
});
```

### `getSendArcadeBlink`
Execute SEND Arcade gaming blink.

```typescript
await agent.methods.getSendArcadeBlink({
  game: "coin-flip",
  bet: 0.1,
});
```

---

## Pump.fun Actions

### `launchPumpToken`
Launch token on Pump.fun via PumpPortal.

```typescript
await agent.methods.launchPumpToken({
  name: "My Pump Token",
  symbol: "PUMP",
  description: "A fun token",
  imageUrl: "https://image.png",
  twitter: "@mytoken",
  telegram: "t.me/mytoken",
  website: "https://mytoken.com",
  initialBuyAmount: 0.1,  // SOL
});
```

### `buyPumpToken`
Buy token on Pump.fun.

```typescript
await agent.methods.buyPumpToken({
  mint: "pump_token_mint",
  amount: 1,  // SOL
  slippage: 0.05,  // 5%
});
```

### `sellPumpToken`
Sell token on Pump.fun.

```typescript
await agent.methods.sellPumpToken({
  mint: "pump_token_mint",
  amount: 1000,  // token amount
  slippage: 0.05,
});
```

---

## Utility Actions

### `getWalletAddress`
Get agent wallet address.

```typescript
const address = await agent.methods.getWalletAddress();
```

### `signMessage`
Sign a message with wallet.

```typescript
const signature = await agent.methods.signMessage({
  message: "Hello, Solana!",
});
```

### `sendTransaction`
Send raw transaction.

```typescript
await agent.methods.sendTransaction({
  transaction: serializedTransaction,
  signers: [keypair],
});
```

### `simulateTransaction`
Simulate transaction without sending.

```typescript
const result = await agent.methods.simulateTransaction({
  transaction: serializedTransaction,
});
```
