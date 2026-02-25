---
name: lulo
description: Complete guide for Lulo - Solana's premier lending aggregator. Covers API integration for deposits, withdrawals, balance queries, Protected/Boosted deposits, Custom deposits, and automated yield optimization across Kamino, Drift, MarginFi, and Jupiter.
---

# Lulo Development Guide

A comprehensive guide for integrating Lulo, Solana's only lending aggregator, into your applications. Lulo automatically routes deposits to the highest-yielding DeFi protocols while providing optional smart contract protection.

## What is Lulo?

Lulo (formerly FlexLend) is a DeFi savings platform for stablecoins on Solana. It automatically allocates deposits across integrated protocols to maximize yields while maintaining desired risk exposure.

### Key Features

| Feature | Description |
|---------|-------------|
| **Yield Aggregation** | Automatically routes deposits to highest-yielding protocols |
| **Lulo Protect** | Built-in smart contract risk protection (Protected/Boosted deposits) |
| **Custom Deposits** | Full control over protocol allocation and risk parameters |
| **Instant Withdrawals** | No lock-up periods (except 48h cooldown for Boosted) |
| **Multi-Protocol** | Integrates Kamino, Drift, MarginFi, Jupiter |
| **No Custody** | Funds flow directly to integrated protocols, not held by Lulo |

### Why Use Lulo?

- **Automated Rebalancing**: Checks rates hourly, automatically moves funds to better yields
- **Risk Management**: Choose between Protected (insured), Boosted (higher yield), or Custom deposits
- **Zero Management Fees**: Only 0.005 SOL one-time initialization fee
- **Multi-Reward Accrual**: Earn rewards from multiple protocols from a single deposit
- **9,400+ Lifetime Depositors** with $34M+ in directed liquidity

## Overview

Lulo provides three deposit types:

- **Protected Deposits**: Stable yields with automatic coverage against protocol failures
- **Boosted Deposits**: Higher yields by providing insurance for Protected deposits
- **Custom Deposits**: Direct control over which protocols receive your funds

### Integrated Protocols

| Protocol | Description |
|----------|-------------|
| Kamino Finance | Lending and liquidity vaults |
| Drift Protocol | Perpetuals and lending |
| MarginFi | Lending and borrowing |
| Jupiter | Lending/earn features |

### Supported Tokens

- **Stablecoins**: USDC, USDT, USDS, PYUSD
- **Native**: SOL
- **LSTs**: bSOL, JitoSOL, mSOL
- **Other**: BONK, JUP, ORCA, COPE, CASH

**Minimum Deposits**: $100 for stablecoins, 1 SOL for native token

---

## Quick Start

### API Authentication

All API requests require a valid API key. Get your key from the [Lulo Developer Dashboard](https://dev.lulo.fi).

```typescript
const headers = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.LULO_API_KEY,
};
```

### Base URLs

| Environment | URL |
|-------------|-----|
| Production | `https://api.lulo.fi` |
| Staging | `https://staging.lulo.fi` |
| Blinks | `https://blink.lulo.fi` |
| Developer Portal | `https://dev.lulo.fi` |

---

## API Reference

### Generate Deposit Transaction

Creates a serialized transaction for depositing tokens into Lulo.

**Endpoint**: `POST /v1/generate.transactions.deposit`

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `priorityFee` | number | Priority fee in microlamports (e.g., 500000) |

**Request Body**:
```json
{
  "owner": "YourWalletPublicKey",
  "mintAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "depositType": "protected",
  "amount": 100000000
}
```

**Response**:
```json
{
  "transaction": "base64EncodedSerializedTransaction",
  "lastValidBlockHeight": 123456789
}
```

### Generate Withdrawal Transaction

Creates a serialized transaction for withdrawing tokens from Lulo.

**Endpoint**: `POST /v1/generate.transactions.withdraw`

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `priorityFee` | number | Priority fee in microlamports |

**Request Body**:
```json
{
  "owner": "YourWalletPublicKey",
  "mintAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "withdrawType": "protected",
  "amount": 50000000
}
```

### Get Account Data

Retrieves user balances, interest earned, and APY metrics.

**Endpoint**: `GET /v1/account/{walletAddress}`

**Response**:
```json
{
  "totalDeposited": 1000000000,
  "totalInterestEarned": 5000000,
  "currentApy": 8.5,
  "positions": [
    {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "depositType": "protected",
      "balance": 500000000,
      "interestEarned": 2500000,
      "apy": 7.2
    }
  ]
}
```

### Get Pool Data

Returns current APY rates, liquidity amounts, and capacity metrics.

**Endpoint**: `GET /v1/pools`

**Response**:
```json
{
  "pools": [
    {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC",
      "protectedApy": 6.5,
      "boostedApy": 9.2,
      "totalDeposited": 34000000000000,
      "availableCapacity": 10000000000000
    }
  ]
}
```

### Get Pending Withdrawals

Lists active withdrawal requests with cooldown periods.

**Endpoint**: `GET /v1/account/{walletAddress}/pending-withdrawals`

### Initialize Referrer

Sets up a referrer account for earning referral fees.

**Endpoint**: `POST /v1/referrer/initialize`

### Claim Referral Rewards

Processes referral fee claims.

**Endpoint**: `POST /v1/referrer/claim`

---

## Deposit Types Explained

### Protected Deposits

Designed for risk-averse users seeking stable yields with automatic coverage.

**How it works**:
1. Deposits earn interest from lending across integrated protocols
2. A portion of interest is shared with Boosted depositors (protection fee)
3. If a protocol fails, Boosted deposits cover Protected losses automatically

**Benefits**:
- Lower risk with priority coverage
- Stable, predictable yields
- No claims to file - protection is automatic
- Instant withdrawals

**Coverage includes**: Smart contract exploits, oracle failures, bad debt events

**Not covered**: Solana network failures, USDC depegging, Lulo contract failures

### Boosted Deposits

Higher yields in exchange for providing insurance to Protected depositors.

**How it works**:
1. Earn lending yields from integrated protocols
2. Receive additional yield from Protected deposit interest sharing
3. Act as first-loss layer if a protocol fails

**Benefits**:
- Higher APY (typically 1-2% more than Protected)
- Dual income streams (lending + protection fees)

**Risks**:
- First-loss position in case of protocol failures
- 48-hour withdrawal cooldown

### Custom Deposits

Full control over protocol allocation and risk parameters.

**Features**:
- Select specific protocols (Kamino, Drift, MarginFi, Jupiter)
- Set maximum exposure caps per protocol
- Automatic reallocation when yields change
- No protection coverage (direct protocol exposure)

**Example**: 50% max exposure with 3 protocols means no more than half your funds in any single protocol.

---

## Integration Examples

### TypeScript: Deposit to Lulo

```typescript
import { Connection, Transaction, VersionedTransaction, Keypair } from '@solana/web3.js';

const LULO_API_URL = 'https://api.lulo.fi';

interface DepositParams {
  owner: string;
  mintAddress: string;
  amount: number;
  depositType: 'protected' | 'boosted' | 'regular';
  priorityFee?: number;
}

async function generateDepositTransaction(params: DepositParams): Promise<string> {
  const { owner, mintAddress, amount, depositType, priorityFee = 500000 } = params;

  const response = await fetch(
    `${LULO_API_URL}/v1/generate.transactions.deposit?priorityFee=${priorityFee}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LULO_API_KEY!,
      },
      body: JSON.stringify({
        owner,
        mintAddress,
        depositType,
        amount,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Deposit failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.transaction;
}

async function deposit(
  connection: Connection,
  wallet: Keypair,
  mintAddress: string,
  amount: number,
  depositType: 'protected' | 'boosted' | 'regular' = 'protected'
): Promise<string> {
  // Generate deposit transaction
  const serializedTx = await generateDepositTransaction({
    owner: wallet.publicKey.toBase58(),
    mintAddress,
    amount,
    depositType,
  });

  // Deserialize and sign
  const txBuffer = Buffer.from(serializedTx, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([wallet]);

  // Send and confirm
  const signature = await connection.sendTransaction(transaction);
  await connection.confirmTransaction(signature, 'confirmed');

  console.log('Deposit successful:', signature);
  return signature;
}

// Usage
const connection = new Connection('https://api.mainnet-beta.solana.com');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

await deposit(
  connection,
  wallet,
  USDC_MINT,
  100_000_000, // 100 USDC (6 decimals)
  'protected'
);
```

### TypeScript: Withdraw from Lulo

```typescript
interface WithdrawParams {
  owner: string;
  mintAddress: string;
  amount: number;
  withdrawType: 'protected' | 'boosted' | 'regular';
  priorityFee?: number;
}

async function generateWithdrawTransaction(params: WithdrawParams): Promise<string> {
  const { owner, mintAddress, amount, withdrawType, priorityFee = 500000 } = params;

  const response = await fetch(
    `${LULO_API_URL}/v1/generate.transactions.withdraw?priorityFee=${priorityFee}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LULO_API_KEY!,
      },
      body: JSON.stringify({
        owner,
        mintAddress,
        withdrawType,
        amount,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Withdrawal failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.transaction;
}

async function withdraw(
  connection: Connection,
  wallet: Keypair,
  mintAddress: string,
  amount: number,
  withdrawType: 'protected' | 'boosted' | 'regular' = 'protected'
): Promise<string> {
  const serializedTx = await generateWithdrawTransaction({
    owner: wallet.publicKey.toBase58(),
    mintAddress,
    amount,
    withdrawType,
  });

  const txBuffer = Buffer.from(serializedTx, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([wallet]);

  const signature = await connection.sendTransaction(transaction);
  await connection.confirmTransaction(signature, 'confirmed');

  console.log('Withdrawal successful:', signature);
  return signature;
}
```

### TypeScript: Get Account Balance

```typescript
interface LuloPosition {
  mint: string;
  depositType: string;
  balance: number;
  interestEarned: number;
  apy: number;
}

interface LuloAccount {
  totalDeposited: number;
  totalInterestEarned: number;
  currentApy: number;
  positions: LuloPosition[];
}

async function getAccountData(walletAddress: string): Promise<LuloAccount> {
  const response = await fetch(
    `${LULO_API_URL}/v1/account/${walletAddress}`,
    {
      headers: {
        'x-api-key': process.env.LULO_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch account: ${response.statusText}`);
  }

  return response.json();
}

// Usage
const account = await getAccountData(wallet.publicKey.toBase58());
console.log('Total Deposited:', account.totalDeposited);
console.log('Interest Earned:', account.totalInterestEarned);
console.log('Current APY:', account.currentApy);
```

### Using Solana Agent Kit

```typescript
import { SolanaAgentKit } from 'solana-agent-kit';

const agent = new SolanaAgentKit(
  privateKey,
  rpcUrl,
  openAiApiKey
);

// Lend USDC using Lulo (gets best APR)
const signature = await agent.methods.lendAssets(
  agent,
  100 // amount of USDC to lend
);

console.log('Lending transaction:', signature);
```

### Python: Lulo Integration

```python
import aiohttp
import os
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TxOpts
import base64

LULO_API_URL = "https://api.lulo.fi"
LULO_API_KEY = os.environ.get("LULO_API_KEY")

async def lulo_deposit(
    client: AsyncClient,
    wallet: Keypair,
    mint_address: str,
    amount: int,
    deposit_type: str = "protected"
) -> str:
    """Deposit tokens to Lulo for yield optimization."""

    async with aiohttp.ClientSession() as session:
        # Generate deposit transaction
        async with session.post(
            f"{LULO_API_URL}/v1/generate.transactions.deposit?priorityFee=500000",
            headers={
                "Content-Type": "application/json",
                "x-api-key": LULO_API_KEY,
            },
            json={
                "owner": str(wallet.pubkey()),
                "mintAddress": mint_address,
                "depositType": deposit_type,
                "amount": amount,
            }
        ) as response:
            if response.status != 200:
                raise Exception(f"Deposit failed: {await response.text()}")

            data = await response.json()
            tx_data = base64.b64decode(data["transaction"])

    # Deserialize, sign, and send
    transaction = VersionedTransaction.from_bytes(tx_data)
    transaction.sign([wallet])

    signature = await client.send_transaction(
        transaction,
        opts=TxOpts(preflight_commitment=Confirmed)
    )

    await client.confirm_transaction(signature.value, commitment="confirmed")

    return str(signature.value)

async def lulo_withdraw(
    client: AsyncClient,
    wallet: Keypair,
    mint_address: str,
    amount: int,
    withdraw_type: str = "protected"
) -> str:
    """Withdraw tokens from Lulo."""

    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{LULO_API_URL}/v1/generate.transactions.withdraw?priorityFee=500000",
            headers={
                "Content-Type": "application/json",
                "x-api-key": LULO_API_KEY,
            },
            json={
                "owner": str(wallet.pubkey()),
                "mintAddress": mint_address,
                "withdrawType": withdraw_type,
                "amount": amount,
            }
        ) as response:
            if response.status != 200:
                raise Exception(f"Withdrawal failed: {await response.text()}")

            data = await response.json()
            tx_data = base64.b64decode(data["transaction"])

    transaction = VersionedTransaction.from_bytes(tx_data)
    transaction.sign([wallet])

    signature = await client.send_transaction(
        transaction,
        opts=TxOpts(preflight_commitment=Confirmed)
    )

    await client.confirm_transaction(signature.value, commitment="confirmed")

    return str(signature.value)

# Usage
async def main():
    client = AsyncClient("https://api.mainnet-beta.solana.com")
    wallet = Keypair.from_base58_string("your-private-key")

    USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

    # Deposit 100 USDC
    signature = await lulo_deposit(
        client,
        wallet,
        USDC_MINT,
        100_000_000,  # 100 USDC
        "protected"
    )
    print(f"Deposit: {signature}")
```

### Using Lulo Blinks

Lulo also supports Solana Actions/Blinks for simplified interactions:

```typescript
// Blink endpoint for lending
const blinkUrl = `https://blink.lulo.fi/actions?amount=${amount}&symbol=USDC`;

// Fetch blink metadata
const response = await fetch(blinkUrl);
const blinkData = await response.json();

// Execute the action
const postResponse = await fetch(blinkUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account: walletAddress }),
});

const { transaction } = await postResponse.json();
// Sign and send transaction...
```

---

## Common Token Addresses

| Token | Mint Address |
|-------|--------------|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| USDS | `USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA` |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` |
| SOL (Wrapped) | `So11111111111111111111111111111111111111112` |
| mSOL | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` |
| JitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` |
| bSOL | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` |

---

## Best Practices

### Security

1. **Never expose API keys** - Use environment variables
2. **Validate transactions** - Simulate before signing
3. **Set appropriate slippage** - Account for rate changes
4. **Monitor positions** - Regularly check balances and APY

### Performance

1. **Use priority fees** - 500,000+ microlamports for faster confirmation
2. **Batch operations** - Combine multiple operations when possible
3. **Cache pool data** - Rates update hourly, cache appropriately

### Error Handling

```typescript
try {
  const signature = await deposit(connection, wallet, USDC_MINT, amount, 'protected');
} catch (error) {
  if (error.message.includes('BAD_REQUEST')) {
    console.error('Invalid parameters');
  } else if (error.message.includes('UNAUTHORIZED')) {
    console.error('Invalid API key');
  } else if (error.message.includes('NOT_FOUND')) {
    console.error('Account or pool not found');
  } else {
    throw error;
  }
}
```

### Monitoring APY

```typescript
async function monitorRates(interval: number = 3600000) { // 1 hour
  setInterval(async () => {
    const pools = await fetch(`${LULO_API_URL}/v1/pools`, {
      headers: { 'x-api-key': process.env.LULO_API_KEY! },
    }).then(r => r.json());

    pools.pools.forEach(pool => {
      console.log(`${pool.symbol}: Protected ${pool.protectedApy}% | Boosted ${pool.boostedApy}%`);
    });
  }, interval);
}
```

---

## Fee Structure

| Fee Type | Amount | When |
|----------|--------|------|
| Initialization | 0.005 SOL | First deposit only |
| Management | None | - |
| Withdrawal | None | - |
| Transaction | Variable | Per transaction (Solana fees) |

---

## Resources

- [Lulo App](https://lulo.fi)
- [Documentation](https://docs.lulo.fi)
- [Developer Portal](https://dev.lulo.fi)
- [API Documentation](https://docs.lulo.fi/api-docs)
- [Lulo Labs GitHub](https://github.com/lulo-labs)
- [Lulo CPI Example](https://github.com/gabrielkoerich/lulo-cpi-example)
- [Discord](https://discord.gg/lulo)
- [Telegram](https://t.me/uselulo)
- [Twitter/X](https://twitter.com/uselulo)

---

## Skill Structure

```
lulo/
├── SKILL.md                      # This file
├── resources/
│   ├── api-reference.md          # Complete API documentation
│   └── token-addresses.md        # Supported token addresses
├── examples/
│   ├── deposit/
│   │   └── deposit.ts            # Deposit examples
│   ├── withdraw/
│   │   └── withdraw.ts           # Withdrawal examples
│   ├── balance/
│   │   └── balance.ts            # Balance query examples
│   └── integration/
│       └── full-integration.ts   # Complete integration example
├── templates/
│   └── lulo-client.ts            # Ready-to-use client template
└── docs/
    └── troubleshooting.md        # Common issues and solutions
```
