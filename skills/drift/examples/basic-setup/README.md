# Basic Setup Examples

## TypeScript Setup

### Installation

```bash
npm install @drift-labs/sdk @solana/web3.js @coral-xyz/anchor bn.js
```

### Complete Setup Example

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  DriftClient,
  DriftEnv,
  BulkAccountLoader,
  initialize,
  QUOTE_PRECISION,
  convertToNumber,
} from '@drift-labs/sdk';
import * as fs from 'fs';

// Configuration
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const ENV: DriftEnv = 'mainnet-beta';

async function setupDriftClient() {
  // 1. Create connection
  const connection = new Connection(RPC_URL, 'confirmed');

  // 2. Load wallet from keypair file
  const secretKey = JSON.parse(
    fs.readFileSync('/path/to/keypair.json', 'utf-8')
  );
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const wallet = new Wallet(keypair);

  console.log('Wallet address:', wallet.publicKey.toString());

  // 3. Initialize SDK config
  const sdkConfig = initialize({ env: ENV });

  // 4. Create account loader for polling
  const accountLoader = new BulkAccountLoader(connection, 'confirmed', 1000);

  // 5. Create DriftClient
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: ENV,
    accountSubscription: {
      type: 'polling',
      accountLoader,
    },
  });

  // 6. Subscribe to updates
  const subscriptionSuccess = await driftClient.subscribe();
  if (!subscriptionSuccess) {
    throw new Error('Failed to subscribe to DriftClient');
  }

  console.log('DriftClient subscribed successfully');

  return driftClient;
}

async function main() {
  const driftClient = await setupDriftClient();

  try {
    // Check if user account exists
    const user = driftClient.getUser();
    const userExists = await user.exists();

    if (!userExists) {
      console.log('User account does not exist. Creating...');

      // Initialize user account (costs ~0.035 SOL rent)
      const [txSig, userPubkey] = await driftClient.initializeUserAccount(
        0, // sub-account ID
        'MainAccount' // account name
      );

      console.log('User account created:', userPubkey.toString());
      console.log('Transaction:', txSig);
    } else {
      console.log('User account exists');

      // Get account info
      const userAccount = user.getUserAccount();
      const freeCollateral = user.getFreeCollateral();
      const health = user.getHealth();

      console.log('Sub-account ID:', userAccount.subAccountId);
      console.log('Free collateral:', convertToNumber(freeCollateral, QUOTE_PRECISION), 'USDC');
      console.log('Health:', health, '%');
    }
  } finally {
    // Always unsubscribe when done
    await driftClient.unsubscribe();
  }
}

main().catch(console.error);
```

## WebSocket Subscription (Real-time Updates)

```typescript
const driftClient = new DriftClient({
  connection,
  wallet,
  env: ENV,
  accountSubscription: {
    type: 'websocket',
    resubTimeoutMs: 30000,
    commitment: 'confirmed',
  },
});
```

## Devnet Setup

```typescript
const RPC_URL = 'https://api.devnet.solana.com';
const ENV: DriftEnv = 'devnet';

// Request airdrop for devnet testing
const airdropSig = await connection.requestAirdrop(
  wallet.publicKey,
  2 * 1e9 // 2 SOL
);
await connection.confirmTransaction(airdropSig);
```

## Python Setup (DriftPy)

### Installation

```bash
pip install driftpy
```

### Complete Setup Example

```python
import asyncio
import json
from pathlib import Path
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from anchorpy import Wallet
from driftpy.drift_client import DriftClient
from driftpy.account_subscription_config import AccountSubscriptionConfig
from driftpy.constants.numeric_constants import QUOTE_PRECISION

RPC_URL = "https://api.mainnet-beta.solana.com"
ENV = "mainnet"

async def setup_drift_client():
    # 1. Create connection
    connection = AsyncClient(RPC_URL, commitment="confirmed")

    # 2. Load wallet
    with open("/path/to/keypair.json") as f:
        secret_key = json.load(f)
    keypair = Keypair.from_bytes(bytes(secret_key))
    wallet = Wallet(keypair)

    print(f"Wallet address: {wallet.public_key}")

    # 3. Create DriftClient
    drift_client = DriftClient(
        connection,
        wallet,
        ENV,
        account_subscription=AccountSubscriptionConfig("polling"),
    )

    # 4. Subscribe
    await drift_client.subscribe()
    print("DriftClient subscribed successfully")

    return drift_client

async def main():
    drift_client = await setup_drift_client()

    try:
        user = drift_client.get_user()

        if not await user.exists():
            print("Creating user account...")
            tx_sig, user_pubkey = await drift_client.initialize_user_account(
                sub_account_id=0,
                name="MainAccount"
            )
            print(f"User account created: {user_pubkey}")
        else:
            print("User account exists")

            user_account = user.get_user_account()
            free_collateral = user.get_free_collateral()

            print(f"Free collateral: ${free_collateral / QUOTE_PRECISION:.2f}")
    finally:
        await drift_client.unsubscribe()

if __name__ == "__main__":
    asyncio.run(main())
```

## Environment Variables Setup

```bash
# .env file
RPC_URL=https://api.mainnet-beta.solana.com
DRIFT_ENV=mainnet-beta
PRIVATE_KEY=[1,2,3,...] # Your keypair as JSON array
```

```typescript
import * as dotenv from 'dotenv';
dotenv.config();

const connection = new Connection(process.env.RPC_URL!);
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY!))
);
```
