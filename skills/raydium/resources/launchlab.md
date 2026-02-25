# Raydium LaunchLab

LaunchLab is Raydium's permissionless token launch platform enabling projects to bootstrap price discovery through bonding curves with automatic liquidity migration.

## Overview

### How It Works

**Three-Stage Process:**

```
1. LAUNCH          2. GRADUATE          3. TRADE
   │                    │                   │
   ▼                    ▼                   ▼
Create token      Hit funding        Live on Raydium
with bonding  →   target (85 SOL) →  with permanent
curve              auto-migrate       liquidity
```

1. **Launch** - Create a token with a bonding curve. Early buyers get lower prices; price increases as supply is purchased.

2. **Graduate** - When the bonding curve reaches the graduation threshold (default: 85 SOL), the token "graduates" and liquidity automatically migrates to a Raydium pool.

3. **Trade** - The token becomes live on Raydium with permanent liquidity. LP tokens are burned, ensuring liquidity is locked forever.

### Key Features

| Feature | Description |
|---------|-------------|
| **Permissionless** | Anyone can launch tokens for free |
| **Fair Price Discovery** | Bonding curves ensure transparent pricing |
| **Locked Liquidity** | LP tokens burned = permanent liquidity |
| **Community Benefits** | 50% of trading fees return to community |
| **Creator Incentives** | Earn trading fees from AMM liquidity |

---

## Bonding Curves

### How Bonding Curves Work

A bonding curve is a mathematical function that determines token price based on supply:

```
Price = f(Supply)

As more tokens are bought:
- Supply increases
- Price increases along the curve
- Early buyers get better prices
```

### Curve Types

**Linear Bonding Curve:**
```
Price = BasePrice + (Slope × Supply)
```
- Predictable, steady price increases
- Good for community tokens

**Exponential Bonding Curve:**
```
Price = BasePrice × e^(k × Supply)
```
- Faster price appreciation
- Rewards early participants more

---

## Migration Options

After graduation, tokens migrate to one of two pool types:

### CPMM (Recommended)
- Simple, passive, full-range liquidity
- Lower complexity
- Best for most token launches

### CLMM
- Concentrated liquidity for tighter spreads
- Higher capital efficiency
- Better for advanced projects

---

## Platform PDA System

The Platform Derived Address (PDA) infrastructure enables third-party builders to create custom launch platforms.

### Benefits for Builders

- **Custom Branding** - Your own UI/UX
- **Fee Structures** - Set your own platform fees
- **Leverage Raydium** - Access to Raydium's liquidity and trader base
- **Permissionless** - No approval needed

### Platform Integration

```typescript
import { PublicKey } from "@solana/web3.js";

// Derive platform PDA
const [platformPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("platform"), platformAuthority.toBuffer()],
  LAUNCHLAB_PROGRAM_ID
);

// Platform can set custom:
// - Fee percentage
// - Graduation threshold
// - Default curve type
// - Branding/metadata
```

---

## SDK Integration

### Create Token with Bonding Curve

```typescript
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair } from "@solana/web3.js";
import BN from "bn.js";

async function launchToken(
  raydium: Raydium,
  tokenMetadata: {
    name: string;
    symbol: string;
    uri: string;
  },
  options: {
    initialSupply?: BN;
    bondingCurve?: "linear" | "exponential";
    graduationThreshold?: BN;
  } = {}
) {
  const {
    initialSupply = new BN(1_000_000_000).mul(new BN(10).pow(new BN(9))), // 1B tokens
    bondingCurve = "linear",
    graduationThreshold = new BN(85_000_000_000), // 85 SOL in lamports
  } = options;

  const { execute, extInfo } = await raydium.launchLab.createToken({
    name: tokenMetadata.name,
    symbol: tokenMetadata.symbol,
    uri: tokenMetadata.uri,
    initialSupply,
    bondingCurve,
    graduationThreshold,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log("Token created!");
  console.log(`Transaction: ${txId}`);
  console.log(`Token mint: ${extInfo.mint.toBase58()}`);
  console.log(`Bonding curve: ${extInfo.bondingCurve.toBase58()}`);

  return extInfo;
}
```

### Buy Tokens on Bonding Curve

```typescript
async function buyFromBondingCurve(
  raydium: Raydium,
  bondingCurveAddress: string,
  solAmount: BN // Amount in lamports
) {
  // Get bonding curve info
  const curveInfo = await raydium.launchLab.getBondingCurveInfo(
    bondingCurveAddress
  );

  console.log(`Current price: ${curveInfo.currentPrice}`);
  console.log(`Tokens remaining: ${curveInfo.remainingSupply}`);

  // Calculate tokens to receive
  const tokensOut = await raydium.launchLab.calculateBuy({
    bondingCurve: bondingCurveAddress,
    solAmount,
  });

  console.log(`Expected tokens: ${tokensOut.toString()}`);

  // Execute purchase
  const { execute } = await raydium.launchLab.buy({
    bondingCurve: bondingCurveAddress,
    solAmount,
    minTokensOut: tokensOut.mul(new BN(99)).div(new BN(100)), // 1% slippage
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Purchase complete: ${txId}`);

  return tokensOut;
}
```

### Sell Tokens on Bonding Curve

```typescript
async function sellToBondingCurve(
  raydium: Raydium,
  bondingCurveAddress: string,
  tokenAmount: BN
) {
  // Calculate SOL to receive
  const solOut = await raydium.launchLab.calculateSell({
    bondingCurve: bondingCurveAddress,
    tokenAmount,
  });

  console.log(`Expected SOL: ${solOut.toString()} lamports`);

  // Execute sale
  const { execute } = await raydium.launchLab.sell({
    bondingCurve: bondingCurveAddress,
    tokenAmount,
    minSolOut: solOut.mul(new BN(99)).div(new BN(100)), // 1% slippage
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Sale complete: ${txId}`);

  return solOut;
}
```

### Check Graduation Status

```typescript
async function checkGraduationStatus(
  raydium: Raydium,
  bondingCurveAddress: string
) {
  const curveInfo = await raydium.launchLab.getBondingCurveInfo(
    bondingCurveAddress
  );

  const progress =
    (Number(curveInfo.totalRaised) / Number(curveInfo.graduationThreshold)) *
    100;

  console.log(`Graduation progress: ${progress.toFixed(2)}%`);
  console.log(`Total raised: ${Number(curveInfo.totalRaised) / 1e9} SOL`);
  console.log(
    `Threshold: ${Number(curveInfo.graduationThreshold) / 1e9} SOL`
  );
  console.log(`Graduated: ${curveInfo.graduated}`);

  if (curveInfo.graduated) {
    console.log(`Pool address: ${curveInfo.poolAddress}`);
  }

  return curveInfo;
}
```

---

## Creator Fees

After graduation, token creators earn a portion of trading fees:

```typescript
// Creator earns 10% of trading fees after graduation
const CREATOR_FEE_SHARE = 0.10; // 10%

// Claim accumulated creator fees
async function claimCreatorFees(
  raydium: Raydium,
  tokenMint: string
) {
  const { execute } = await raydium.launchLab.claimCreatorFees({
    tokenMint,
    txVersion: "V0",
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log(`Fees claimed: ${txId}`);
}
```

---

## Best Practices

### For Token Creators

1. **Prepare Metadata First**
   - Upload image to Arweave/IPFS
   - Create metadata JSON with name, symbol, description, image
   - Use permanent storage (Arweave recommended)

2. **Choose Curve Wisely**
   - Linear: Fairer distribution, slower price growth
   - Exponential: Rewards early buyers more

3. **Set Realistic Threshold**
   - Default 85 SOL works for most projects
   - Lower = faster graduation but less liquidity
   - Higher = more liquidity but takes longer

4. **Engage Community**
   - Announce launch timing
   - Be transparent about tokenomics
   - Build hype responsibly

### For Buyers

1. **Research the Project**
   - Check creator reputation
   - Verify metadata/socials
   - Understand the bonding curve

2. **Mind the Curve**
   - Earlier = better price
   - Check current position on curve
   - Understand price will rise with purchases

3. **Consider Slippage**
   - Bonding curves can move fast
   - Set appropriate slippage tolerance
   - Don't chase pumps

---

## Statistics (2025)

- **35,000+** tokens launched via LaunchLab
- **Orb Explorer** launched for on-chain analytics
- Multiple successful graduations to Raydium pools

---

## Related Resources

- [LaunchLab UI](https://raydium.io/launchlab)
- [SDK Documentation](https://github.com/raydium-io/raydium-sdk-V2)
- [Raydium Discord](https://discord.gg/raydium)
