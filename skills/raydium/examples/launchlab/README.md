# Raydium LaunchLab Examples

Examples for launching tokens and trading on bonding curves with Raydium LaunchLab.

## Overview

LaunchLab enables permissionless token launches with bonding curve price discovery and automatic graduation to Raydium pools.

## Prerequisites

```typescript
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// Initialize SDK
const connection = new Connection(process.env.RPC_URL!);
const owner = Keypair.fromSecretKey(/* your key */);

const raydium = await Raydium.load({
  connection,
  owner,
  cluster: "mainnet",
});
```

---

## Create Token with Bonding Curve

### Basic Token Launch

```typescript
async function launchToken(metadata: {
  name: string;
  symbol: string;
  uri: string;
  description?: string;
}) {
  console.log(`Launching token: ${metadata.name} (${metadata.symbol})`);

  const { execute, extInfo } = await raydium.launchLab.createToken({
    name: metadata.name,
    symbol: metadata.symbol,
    uri: metadata.uri,
    // Default settings
    initialSupply: new BN(1_000_000_000).mul(new BN(10).pow(new BN(9))), // 1B tokens
    bondingCurve: "linear",
    graduationThreshold: new BN(85_000_000_000), // 85 SOL
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log("Token launched successfully!");
  console.log(`Transaction: https://solscan.io/tx/${txId}`);
  console.log(`Token Mint: ${extInfo.mint.toBase58()}`);
  console.log(`Bonding Curve: ${extInfo.bondingCurve.toBase58()}`);

  return {
    mint: extInfo.mint,
    bondingCurve: extInfo.bondingCurve,
    txId,
  };
}

// Usage
await launchToken({
  name: "My Awesome Token",
  symbol: "MAT",
  uri: "https://arweave.net/your-metadata-uri",
});
```

### Launch with Custom Settings

```typescript
async function launchTokenAdvanced(options: {
  name: string;
  symbol: string;
  uri: string;
  initialSupply?: BN;
  bondingCurve?: "linear" | "exponential";
  graduationThreshold?: BN;
  creatorFeeBps?: number;
}) {
  const {
    name,
    symbol,
    uri,
    initialSupply = new BN(1_000_000_000).mul(new BN(10).pow(new BN(9))),
    bondingCurve = "linear",
    graduationThreshold = new BN(85_000_000_000), // 85 SOL
    creatorFeeBps = 100, // 1%
  } = options;

  console.log("Launch Configuration:");
  console.log(`  Name: ${name}`);
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Supply: ${initialSupply.toString()}`);
  console.log(`  Curve: ${bondingCurve}`);
  console.log(`  Graduation: ${Number(graduationThreshold) / 1e9} SOL`);

  const { execute, extInfo } = await raydium.launchLab.createToken({
    name,
    symbol,
    uri,
    initialSupply,
    bondingCurve,
    graduationThreshold,
    creatorFeeBps,
    txVersion: "V0",
    computeBudgetConfig: {
      units: 400000,
      microLamports: 100000,
    },
  });

  const { txId } = await execute({ sendAndConfirm: true });

  return {
    mint: extInfo.mint,
    bondingCurve: extInfo.bondingCurve,
    txId,
  };
}
```

---

## Buy Tokens on Bonding Curve

### Simple Buy

```typescript
async function buyTokens(bondingCurveAddress: string, solAmount: BN) {
  // Get current curve state
  const curveInfo = await raydium.launchLab.getBondingCurveInfo(
    bondingCurveAddress
  );

  console.log("Bonding Curve State:");
  console.log(`  Current Price: ${curveInfo.currentPrice}`);
  console.log(`  Supply Sold: ${curveInfo.supplySold.toString()}`);
  console.log(`  Total Raised: ${Number(curveInfo.totalRaised) / 1e9} SOL`);

  // Calculate expected tokens
  const expectedTokens = await raydium.launchLab.calculateBuy({
    bondingCurve: bondingCurveAddress,
    solAmount,
  });

  console.log(`\nBuying with ${Number(solAmount) / 1e9} SOL`);
  console.log(`Expected tokens: ${Number(expectedTokens) / 1e9}`);

  // Execute purchase with 1% slippage
  const minTokens = expectedTokens.mul(new BN(99)).div(new BN(100));

  const { execute } = await raydium.launchLab.buy({
    bondingCurve: bondingCurveAddress,
    solAmount,
    minTokensOut: minTokens,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log(`Purchase complete: https://solscan.io/tx/${txId}`);
  return expectedTokens;
}

// Buy with 1 SOL
await buyTokens("BONDING_CURVE_ADDRESS", new BN(1_000_000_000));
```

### Buy with Price Check

```typescript
async function buyWithPriceCheck(
  bondingCurveAddress: string,
  solAmount: BN,
  maxPricePerToken: number // In SOL
) {
  const curveInfo = await raydium.launchLab.getBondingCurveInfo(
    bondingCurveAddress
  );

  // Check if price is acceptable
  if (curveInfo.currentPrice > maxPricePerToken) {
    throw new Error(
      `Price too high: ${curveInfo.currentPrice} > ${maxPricePerToken}`
    );
  }

  // Calculate tokens
  const expectedTokens = await raydium.launchLab.calculateBuy({
    bondingCurve: bondingCurveAddress,
    solAmount,
  });

  const effectivePrice =
    Number(solAmount) / Number(expectedTokens) / 1e9 / 1e9;
  console.log(`Effective price: ${effectivePrice} SOL/token`);

  if (effectivePrice > maxPricePerToken) {
    throw new Error(
      `Effective price too high: ${effectivePrice} > ${maxPricePerToken}`
    );
  }

  const { execute } = await raydium.launchLab.buy({
    bondingCurve: bondingCurveAddress,
    solAmount,
    minTokensOut: expectedTokens.mul(new BN(99)).div(new BN(100)),
    txVersion: "V0",
  });

  return execute({ sendAndConfirm: true });
}
```

---

## Sell Tokens on Bonding Curve

### Simple Sell

```typescript
async function sellTokens(bondingCurveAddress: string, tokenAmount: BN) {
  // Calculate expected SOL
  const expectedSol = await raydium.launchLab.calculateSell({
    bondingCurve: bondingCurveAddress,
    tokenAmount,
  });

  console.log(`Selling ${Number(tokenAmount) / 1e9} tokens`);
  console.log(`Expected SOL: ${Number(expectedSol) / 1e9}`);

  // Execute sale with 1% slippage
  const minSol = expectedSol.mul(new BN(99)).div(new BN(100));

  const { execute } = await raydium.launchLab.sell({
    bondingCurve: bondingCurveAddress,
    tokenAmount,
    minSolOut: minSol,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log(`Sale complete: https://solscan.io/tx/${txId}`);
  return expectedSol;
}
```

### Sell All Tokens

```typescript
async function sellAllTokens(bondingCurveAddress: string, tokenMint: string) {
  // Get user's token balance
  const tokenAccount = await raydium.account.tokenAccounts.find(
    (ta) => ta.mint.toBase58() === tokenMint
  );

  if (!tokenAccount || tokenAccount.amount.isZero()) {
    console.log("No tokens to sell");
    return;
  }

  const balance = tokenAccount.amount;
  console.log(`Selling all ${Number(balance) / 1e9} tokens`);

  return sellTokens(bondingCurveAddress, balance);
}
```

---

## Monitor Bonding Curve

### Check Graduation Progress

```typescript
async function checkGraduationProgress(bondingCurveAddress: string) {
  const curveInfo = await raydium.launchLab.getBondingCurveInfo(
    bondingCurveAddress
  );

  const totalRaised = Number(curveInfo.totalRaised) / 1e9;
  const threshold = Number(curveInfo.graduationThreshold) / 1e9;
  const progress = (totalRaised / threshold) * 100;

  console.log("=== Graduation Progress ===");
  console.log(`Token: ${curveInfo.tokenMint.toBase58()}`);
  console.log(`Total Raised: ${totalRaised.toFixed(2)} SOL`);
  console.log(`Threshold: ${threshold.toFixed(2)} SOL`);
  console.log(`Progress: ${progress.toFixed(2)}%`);
  console.log(`Graduated: ${curveInfo.graduated}`);

  if (curveInfo.graduated) {
    console.log(`Pool Address: ${curveInfo.poolAddress}`);
    console.log(`Pool Type: ${curveInfo.poolType}`);
  } else {
    const remaining = threshold - totalRaised;
    console.log(`Remaining: ${remaining.toFixed(2)} SOL`);
  }

  return {
    progress,
    graduated: curveInfo.graduated,
    remaining: threshold - totalRaised,
  };
}
```

### Watch for Graduation

```typescript
async function watchForGraduation(
  bondingCurveAddress: string,
  intervalMs: number = 10000
) {
  console.log(`Watching bonding curve: ${bondingCurveAddress}`);

  const checkAndReport = async () => {
    const status = await checkGraduationProgress(bondingCurveAddress);

    if (status.graduated) {
      console.log("\n🎉 TOKEN GRADUATED! 🎉");
      return true;
    }

    return false;
  };

  // Initial check
  if (await checkAndReport()) return;

  // Poll until graduated
  return new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      if (await checkAndReport()) {
        clearInterval(interval);
        resolve();
      }
    }, intervalMs);
  });
}
```

---

## Claim Creator Fees

### Check Pending Fees

```typescript
async function checkCreatorFees(tokenMint: string) {
  const feeInfo = await raydium.launchLab.getCreatorFeeInfo(tokenMint);

  console.log("=== Creator Fee Info ===");
  console.log(`Token: ${tokenMint}`);
  console.log(`Total Earned: ${Number(feeInfo.totalEarned) / 1e9} SOL`);
  console.log(`Claimed: ${Number(feeInfo.claimed) / 1e9} SOL`);
  console.log(`Pending: ${Number(feeInfo.pending) / 1e9} SOL`);

  return feeInfo;
}
```

### Claim Fees

```typescript
async function claimCreatorFees(tokenMint: string) {
  const feeInfo = await raydium.launchLab.getCreatorFeeInfo(tokenMint);

  if (feeInfo.pending.isZero()) {
    console.log("No pending fees to claim");
    return;
  }

  console.log(`Claiming ${Number(feeInfo.pending) / 1e9} SOL in fees...`);

  const { execute } = await raydium.launchLab.claimCreatorFees({
    tokenMint,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log(`Fees claimed: https://solscan.io/tx/${txId}`);
}
```

---

## Complete Launch Workflow

```typescript
async function completeLaunchWorkflow() {
  // 1. Prepare metadata (should be uploaded to Arweave/IPFS first)
  const metadata = {
    name: "Demo Token",
    symbol: "DEMO",
    uri: "https://arweave.net/your-metadata-json",
  };

  // 2. Launch token
  console.log("Step 1: Launching token...");
  const { mint, bondingCurve } = await launchToken(metadata);

  // 3. Buy some tokens as creator (optional, shows confidence)
  console.log("\nStep 2: Initial creator buy...");
  await buyTokens(bondingCurve.toBase58(), new BN(1_000_000_000)); // 1 SOL

  // 4. Monitor progress
  console.log("\nStep 3: Monitoring graduation progress...");
  const status = await checkGraduationProgress(bondingCurve.toBase58());

  if (!status.graduated) {
    console.log(`\nToken needs ${status.remaining.toFixed(2)} more SOL to graduate`);
    console.log("Share your token link to attract buyers!");
    console.log(
      `Link: https://raydium.io/launchlab/${bondingCurve.toBase58()}`
    );
  }

  // 5. After graduation, claim fees periodically
  if (status.graduated) {
    console.log("\nStep 4: Claiming creator fees...");
    await claimCreatorFees(mint.toBase58());
  }

  return { mint, bondingCurve };
}
```

---

## Query LaunchLab Data

### Get Recent Launches

```typescript
async function getRecentLaunches(limit: number = 10) {
  const launches = await raydium.launchLab.getRecentLaunches({ limit });

  console.log(`=== Recent ${limit} Launches ===`);

  for (const launch of launches) {
    const progress =
      (Number(launch.totalRaised) / Number(launch.graduationThreshold)) * 100;

    console.log(`\n${launch.name} (${launch.symbol})`);
    console.log(`  Mint: ${launch.mint}`);
    console.log(`  Progress: ${progress.toFixed(1)}%`);
    console.log(`  Graduated: ${launch.graduated}`);
  }

  return launches;
}
```

### Search Tokens

```typescript
async function searchLaunchLabTokens(query: string) {
  const results = await raydium.launchLab.search({ query });

  console.log(`Found ${results.length} tokens matching "${query}"`);

  for (const token of results) {
    console.log(`  ${token.name} (${token.symbol}): ${token.mint}`);
  }

  return results;
}
```

---

## Tips

1. **Metadata First** - Upload metadata to permanent storage before launching
2. **Test on Devnet** - Test your launch flow on devnet first
3. **Curve Selection** - Linear is fairer; exponential rewards early buyers more
4. **Graduation Threshold** - Lower = faster but less liquidity
5. **Community Building** - Success depends on attracting buyers

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Token already graduated` | Can't buy/sell on graduated curve | Trade on Raydium pool instead |
| `Insufficient SOL` | Not enough SOL for purchase | Add more SOL to wallet |
| `Slippage exceeded` | Price moved too much | Increase slippage or reduce size |
| `Invalid metadata URI` | Metadata not accessible | Verify URI is reachable |
