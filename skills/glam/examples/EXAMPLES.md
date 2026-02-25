# GLAM Examples

Practical usage patterns for CLI and SDK operations.

## Basic Examples

### Create and Configure a Vault (CLI)

```bash
# 1. Create vault from template
glam-cli vault create ./vault-template.json
# Output: Vault created: <VAULT_STATE_PUBKEY>

# 2. Set active vault
glam-cli vault set <VAULT_STATE_PUBKEY>

# 3. View vault details
glam-cli vault view

# 4. Add assets to allowlist
glam-cli vault allowlist-asset EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --yes
glam-cli vault allowlist-asset Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB --yes

# 5. Enable Jupiter for swaps
glam-cli integration enable JupiterSwap

# 6. Check balances
glam-cli vault token-balances
```

### Create Vault (SDK)

```typescript
import {
  GlamClient,
  WSOL,
  USDC,
  StateAccountType,
  getProgramAndBitflagByProtocolName,
  stringToChars,
} from "@glamsystems/glam-sdk";
import { PublicKey } from "@solana/web3.js";

const client = new GlamClient({ wallet });

// Create vault via state.initialize
const txId = await client.state.initialize({
  accountType: StateAccountType.VAULT,
  name: stringToChars("My Treasury"),
  baseAssetMint: USDC,
  assets: [WSOL, USDC],
});

console.log("Vault created:", client.statePda.toBase58());
console.log("Transaction:", txId);

// Enable integrations
const perms = getProgramAndBitflagByProtocolName();
const [jupProgram, jupBitflag] = perms["JupiterSwap"];
await client.access.enableProtocols(
  new PublicKey(jupProgram),
  parseInt(jupBitflag, 2),
);

const [kaminoProgram, kaminoBitflag] = perms["KaminoLend"];
await client.access.enableProtocols(
  new PublicKey(kaminoProgram),
  parseInt(kaminoBitflag, 2),
);
```

### Simple Token Swap (CLI)

```bash
# Swap 100 USDC to SOL
glam-cli jupiter swap \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  So11111111111111111111111111111111111111112 \
  100 \
  --slippage-bps 50 --yes
```

### Simple Token Swap (SDK)

```typescript
import { BN } from "@coral-xyz/anchor";

// Get quote via Jupiter API client
const quoteResponse = await client.jupiterSwap.jupApi.getQuoteResponse({
  inputMint: USDC.toBase58(),
  outputMint: WSOL.toBase58(),
  amount: 100_000_000, // 100 USDC (6 decimals)
  slippageBps: 50,
});

console.log("Expected output:", quoteResponse.outAmount);

// Execute swap using quoteResponse
const txId = await client.jupiterSwap.swap({ quoteResponse });

// Or execute swap using quoteParams (fetches quote automatically)
const txId2 = await client.jupiterSwap.swap({
  quoteParams: {
    inputMint: USDC.toBase58(),
    outputMint: WSOL.toBase58(),
    amount: 100_000_000,
    slippageBps: 50,
  },
});
```

---

## Intermediate Examples

### Set Up Delegate Permissions (CLI)

```bash
# Grant Jupiter swap permission to a delegate
glam-cli delegate grant <DELEGATE_PUBKEY> SwapAny --protocol JupiterSwap --yes

# Verify delegate was added
glam-cli delegate list

# Grant Drift trading permissions to same or another delegate
glam-cli delegate grant <DELEGATE_PUBKEY> Deposit Withdraw CreateModifyOrders CancelOrders --protocol DriftProtocol --yes

# Grant Kamino permissions to another delegate
glam-cli delegate grant <OTHER_DELEGATE> Deposit Withdraw Borrow Repay --protocol KaminoLend --yes
```

### Set Up Delegate Permissions (SDK)

```typescript
import { BN } from "@coral-xyz/anchor";
import {
  GlamClient,
  getProgramAndBitflagByProtocolName,
  getProtocolsAndPermissions,
} from "@glamsystems/glam-sdk";
import { PublicKey } from "@solana/web3.js";

// Look up protocol program IDs and bitflags
const perms = getProgramAndBitflagByProtocolName();
const protocols = getProtocolsAndPermissions();

// Grant Jupiter SwapAny permission to a delegate
// JupiterSwap permissions: SwapAny=1, SwapLST=2, SwapAllowlisted=4
const [jupProgram, jupBitflag] = perms["JupiterSwap"];
await client.access.grantDelegatePermissions(
  new PublicKey("Delegate111111111111111111111111"), // delegate pubkey
  new PublicKey(jupProgram),
  parseInt(jupBitflag, 2),
  new BN(1), // SwapAny = 1 << 0
);

// Grant Drift trading permissions (Deposit + Withdraw + CreateModifyOrders + CancelOrders + PerpMarkets)
// DriftProtocol permissions: InitUser=1, UpdateUser=2, DeleteUser=4, Deposit=8,
//   Withdraw=16, Borrow=32, Repay=64, CreateModifyOrders=128, CancelOrders=256,
//   PerpMarkets=512, SpotMarkets=1024
const [driftProgram, driftBitflag] = perms["DriftProtocol"];
const driftPermissions = (1 << 3) | (1 << 4) | (1 << 7) | (1 << 8) | (1 << 9);
await client.access.grantDelegatePermissions(
  new PublicKey("Delegate111111111111111111111111"),
  new PublicKey(driftProgram),
  parseInt(driftBitflag, 2),
  new BN(driftPermissions),
);

// Grant Kamino Deposit + Withdraw + Borrow + Repay
// KaminoLend permissions: Init=1, Deposit=2, Withdraw=4, Borrow=8, Repay=16
const [kaminoProgram, kaminoBitflag] = perms["KaminoLend"];
const kaminoPermissions = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4);
await client.access.grantDelegatePermissions(
  new PublicKey("Delegate211111111111111111111111"),
  new PublicKey(kaminoProgram),
  parseInt(kaminoBitflag, 2),
  new BN(kaminoPermissions),
);
```

### Deposit to Kamino Lending (CLI)

```bash
# 1. Enable Kamino integration
glam-cli integration enable KaminoLend

# 2. Initialize Kamino for vault
glam-cli kamino-lend init

# 3. Deposit USDC to main market
glam-cli kamino-lend deposit \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  1000 --yes

# 4. View positions
glam-cli kamino-lend list
```

### Deposit to Kamino Lending (SDK)

```typescript
// Enable Kamino protocol
const perms = getProgramAndBitflagByProtocolName();
const [kaminoProgram, kaminoBitflag] = perms["KaminoLend"];
await client.access.enableProtocols(
  new PublicKey(kaminoProgram),
  parseInt(kaminoBitflag, 2),
);

// Initialize Kamino user metadata
await client.kaminoLending.initUserMetadata();

// Deposit USDC to Kamino main market
const KAMINO_MAIN_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
);

await client.kaminoLending.deposit(
  KAMINO_MAIN_MARKET,
  USDC,
  new BN(1000_000_000), // 1000 USDC (6 decimals)
);

// Check positions by parsing obligations
const obligations = await client.kaminoLending.findAndParseObligations(
  client.vaultPda,
);
for (const obligation of obligations) {
  console.log("Deposits:", obligation.activeDeposits);
  console.log("Borrows:", obligation.activeBorrows);
}
```

### Open Drift Perpetual Position (CLI)

```bash
# 1. Enable Drift integration
glam-cli integration enable DriftProtocol

# 2. Initialize Drift user
glam-cli drift-protocol init-user --yes

# 3. Deposit USDC as collateral (market_index 0 = USDC)
glam-cli drift-protocol deposit 0 1000 --yes

# 4. Open 1 SOL-PERP long (market_index 0 = SOL-PERP, price_limit 0 = market order)
glam-cli drift-protocol perp long 0 1 0 --yes

# 5. View positions
glam-cli drift-protocol list-positions
```

---

## Advanced Examples

### Create Tokenized Vault with Full Configuration (CLI)

```bash
# 1. Create tokenized vault from JSON template (includes share class config)
glam-cli vault create ./tokenized-vault-template.json

# 2. Set active vault
glam-cli vault set <VAULT_STATE_PUBKEY>

# 3. Enable all required integrations
glam-cli integration enable JupiterSwap DriftProtocol KaminoLend

# 4. Set initial share price (update NAV)
glam-cli manage price

# 5. Set up a trading delegate (protocol-scoped)
glam-cli delegate grant <TRADER_PUBKEY> SwapAny --protocol JupiterSwap --yes
glam-cli delegate grant <TRADER_PUBKEY> Deposit Withdraw CreateModifyOrders PerpMarkets --protocol DriftProtocol --yes

# 6. Configure swap policy
glam-cli jupiter set-max-slippage 100 --yes
glam-cli jupiter allowlist-token So11111111111111111111111111111111111111112 --yes
glam-cli jupiter allowlist-token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --yes

# 7. Set timelock for security (24 hours)
glam-cli timelock set 86400 --yes
```

### Create Tokenized Vault (SDK)

```typescript
import {
  GlamClient,
  WSOL,
  USDC,
  StateAccountType,
  getProgramAndBitflagByProtocolName,
  stringToChars,
} from "@glamsystems/glam-sdk";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const client = new GlamClient({ wallet });

// Create tokenized vault
const txId = await client.state.initialize({
  accountType: StateAccountType.TOKENIZED_VAULT,
  name: stringToChars("GLAM Alpha Fund"),
  baseAssetMint: USDC,
  assets: [WSOL, USDC],
});

console.log("Vault created:", client.statePda.toBase58());

// Enable integrations
const perms = getProgramAndBitflagByProtocolName();
for (const name of ["JupiterSwap", "DriftProtocol", "KaminoLend"]) {
  const [program, bitflag] = perms[name];
  await client.access.enableProtocols(
    new PublicKey(program),
    parseInt(bitflag, 2),
  );
}

// Grant trading delegate permissions
const traderPubkey = new PublicKey("Delegate111111111111111111111111");

// Jupiter SwapAny
const [jupProgram, jupBitflag] = perms["JupiterSwap"];
await client.access.grantDelegatePermissions(
  traderPubkey,
  new PublicKey(jupProgram),
  parseInt(jupBitflag, 2),
  new BN(1), // SwapAny
);

// Drift Deposit + Withdraw + CreateModifyOrders + PerpMarkets
const [driftProgram, driftBitflag] = perms["DriftProtocol"];
await client.access.grantDelegatePermissions(
  traderPubkey,
  new PublicKey(driftProgram),
  parseInt(driftBitflag, 2),
  new BN((1 << 3) | (1 << 4) | (1 << 7) | (1 << 9)),
);
```

### Multi-Protocol Yield Strategy (CLI)

```bash
# Starting with 10,000 USDC in vault

# 1. Swap 50% to SOL for diversification
glam-cli jupiter swap \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  So11111111111111111111111111111111111111112 \
  5000 \
  --slippage-bps 50 --yes

# 2. Deposit remaining USDC to Kamino for yield
glam-cli kamino-lend deposit \
  7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  5000 --yes

# 3. Deposit SOL as collateral on Drift
glam-cli drift-protocol deposit 1 50 --yes

# 4. Open delta-neutral position
glam-cli drift-protocol perp short 0 25 0 --yes

# 5. Check all positions
glam-cli vault holdings
glam-cli kamino-lend list
glam-cli drift-protocol list-positions
```

### Investor Subscription Flow (CLI)

```bash
# As investor (not vault manager):

# 1. Subscribe with 1000 USDC
glam-cli invest subscribe 1000 --yes

# 2. Wait for manager to fulfill subscription
# (Manager runs: glam-cli manage fulfill)

# 3. Claim shares
glam-cli invest claim-subscription

# 4. Later, redeem 100 shares
glam-cli invest redeem 100 --yes

# 5. Wait for fulfillment, then claim
glam-cli invest claim-redemption
```

### Investor Subscription Flow (SDK)

```typescript
import { BN } from "@coral-xyz/anchor";

// Subscribe to vault (amount in base asset units)
const subscribeTx = await client.invest.subscribe(
  new BN(1000_000_000), // 1000 USDC (6 decimals)
);

// Or use queued subscription
const queuedTx = await client.invest.subscribe(
  new BN(1000_000_000),
  true, // queued = true
);

// Manager fulfills pending requests
await client.invest.fulfill(null); // null = no limit

// Claim shares after fulfillment
await client.invest.claim();

// Redeem shares
await client.invest.queuedRedeem(new BN(100_000_000)); // 100 shares

// Cancel pending request
await client.invest.cancel();
```

### Cross-Chain USDC Bridge (CLI)

```bash
# Bridge USDC from Solana to Ethereum

# 1. Bridge 1000 USDC to Ethereum address (domain 0 = Ethereum)
glam-cli cctp bridge-usdc 1000 0 0x742d35Cc6634C0532925a3b844Bc9e7595f00000 --yes

# 2. List pending transfers
glam-cli cctp list

# To receive USDC from another chain:
glam-cli cctp receive <SOURCE_DOMAIN> --txHash <TX_HASH>
```

### Full Vault Management Script (SDK)

```typescript
import { GlamClient, WSOL, USDC } from "@glamsystems/glam-sdk";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function manageVault() {
  // Initialize client with existing vault
  const client = new GlamClient({
    wallet,
    statePda: new PublicKey("Vault111111111111111111111111111"),
  });

  // Get current state
  const stateModel = await client.fetchStateModel();
  console.log("Vault:", stateModel.nameStr);

  // Get balances
  const solBalance = await client.getVaultBalance();
  console.log("SOL balance:", solBalance);

  const usdcBalance = await client.getVaultTokenBalance(USDC);
  console.log("USDC balance:", usdcBalance.uiAmount);

  // Rebalance: swap excess USDC to SOL if needed
  if (usdcBalance.amount.gt(new BN(10000_000_000))) {
    const excessAmount = usdcBalance.amount.sub(new BN(5000_000_000));
    await client.jupiterSwap.swap({
      quoteParams: {
        inputMint: USDC.toBase58(),
        outputMint: WSOL.toBase58(),
        amount: excessAmount.toNumber(),
        slippageBps: 50,
      },
    });
    console.log("Rebalanced vault");
  }

  // Check Kamino lending positions
  const obligations = await client.kaminoLending.findAndParseObligations(
    client.vaultPda,
  );
  console.log("Lending positions:", obligations.length);

  // Check Drift positions
  const driftUser = await client.drift.fetchAndParseDriftUser(0);
  if (driftUser) {
    console.log("Drift user:", driftUser);
  }
}

manageVault().catch(console.error);
```
