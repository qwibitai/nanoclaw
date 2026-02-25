# Fetch and Decode Accounts with Solana Kit

Complete examples for fetching and decoding on-chain accounts.

## Setup

```bash
npm install @solana/kit @solana-program/token
```

## Basic Account Fetching

```typescript
import {
  createSolanaRpc,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  assertAccountExists,
  address,
} from "@solana/kit";

const rpc = createSolanaRpc("https://api.devnet.solana.com");

// Fetch single account
async function getAccount(addr: string) {
  const account = await fetchEncodedAccount(rpc, address(addr));

  if (account.exists) {
    console.log("Address:", account.address);
    console.log("Lamports:", account.lamports);
    console.log("Owner:", account.programAddress);
    console.log("Executable:", account.executable);
    console.log("Data length:", account.data.length);
    return account;
  } else {
    console.log("Account does not exist");
    return null;
  }
}

// Fetch multiple accounts
async function getMultipleAccounts(addresses: string[]) {
  const accounts = await fetchEncodedAccounts(
    rpc,
    addresses.map((a) => address(a))
  );

  return accounts.map((account, i) => ({
    address: addresses[i],
    exists: account.exists,
    lamports: account.exists ? account.lamports : null,
    owner: account.exists ? account.programAddress : null,
  }));
}
```

## RPC Methods Directly

```typescript
// getAccountInfo
const accountInfo = await rpc.getAccountInfo(address("..."), {
  encoding: "base64",
  commitment: "confirmed",
}).send();

if (accountInfo.value) {
  console.log("Data:", accountInfo.value.data);
  console.log("Owner:", accountInfo.value.owner);
}

// getMultipleAccounts
const multipleAccounts = await rpc.getMultipleAccounts(
  [address("..."), address("...")],
  { encoding: "base64" }
).send();

// getProgramAccounts
const programAccounts = await rpc.getProgramAccounts(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // Token Program
  {
    encoding: "base64",
    filters: [
      { dataSize: 165n }, // Token account size
      { memcmp: { offset: 32n, bytes: "base58EncodedOwner" } },
    ],
  }
).send();
```

## Decoding Account Data with Codecs

```typescript
import {
  getStructCodec,
  getU8Codec,
  getU64Codec,
  getBooleanCodec,
  getBytesCodec,
  getOptionCodec,
} from "@solana/codecs";

// Define codec for SPL Token Mint
const mintCodec = getStructCodec([
  ["mintAuthority", getOptionCodec(getBytesCodec({ size: 32 }))],
  ["supply", getU64Codec()],
  ["decimals", getU8Codec()],
  ["isInitialized", getBooleanCodec()],
  ["freezeAuthority", getOptionCodec(getBytesCodec({ size: 32 }))],
]);

// Decode mint account
async function decodeMint(mintAddress: string) {
  const account = await fetchEncodedAccount(rpc, address(mintAddress));
  assertAccountExists(account);

  const mintData = mintCodec.decode(account.data);

  return {
    supply: mintData.supply,
    decimals: mintData.decimals,
    isInitialized: mintData.isInitialized,
    mintAuthority: mintData.mintAuthority,
    freezeAuthority: mintData.freezeAuthority,
  };
}

// Define codec for SPL Token Account
const tokenAccountCodec = getStructCodec([
  ["mint", getBytesCodec({ size: 32 })],
  ["owner", getBytesCodec({ size: 32 })],
  ["amount", getU64Codec()],
  ["delegateOption", getU32Codec()],
  ["delegate", getBytesCodec({ size: 32 })],
  ["state", getU8Codec()],
  ["isNativeOption", getU32Codec()],
  ["isNative", getU64Codec()],
  ["delegatedAmount", getU64Codec()],
  ["closeAuthorityOption", getU32Codec()],
  ["closeAuthority", getBytesCodec({ size: 32 })],
]);

// Decode token account
async function decodeTokenAccount(ataAddress: string) {
  const account = await fetchEncodedAccount(rpc, address(ataAddress));
  assertAccountExists(account);

  const data = tokenAccountCodec.decode(account.data);
  return {
    mint: data.mint,
    owner: data.owner,
    amount: data.amount,
    state: data.state,
  };
}
```

## Using Program Package Helpers

```typescript
import {
  fetchMint,
  fetchToken,
  fetchAllMintByAuthority,
  fetchAllTokenByOwner,
} from "@solana-program/token";

// Fetch and decode mint in one step
const mint = await fetchMint(rpc, address("MintAddress..."));
console.log("Supply:", mint.data.supply);
console.log("Decimals:", mint.data.decimals);

// Fetch token account
const tokenAccount = await fetchToken(rpc, address("ATAAddress..."));
console.log("Balance:", tokenAccount.data.amount);

// Fetch all mints by authority
const mints = await fetchAllMintByAuthority(rpc, address("AuthorityAddress..."));

// Fetch all token accounts by owner
const tokens = await fetchAllTokenByOwner(rpc, address("OwnerAddress..."));
```

## Custom Account Decoding

```typescript
import {
  getStructCodec,
  getU8Codec,
  getU64Codec,
  getU32Codec,
  getBytesCodec,
  getArrayCodec,
  getStringCodec,
} from "@solana/codecs";

// Example: Custom program account
interface MyProgramAccount {
  discriminator: number;
  owner: Uint8Array;
  counter: bigint;
  name: string;
  scores: bigint[];
}

const myAccountCodec = getStructCodec([
  ["discriminator", getU8Codec()],
  ["owner", getBytesCodec({ size: 32 })],
  ["counter", getU64Codec()],
  ["name", getStringCodec({ size: getU32Codec() })],  // Length-prefixed string
  ["scores", getArrayCodec(getU64Codec(), { size: getU32Codec() })],  // Dynamic array
]);

async function fetchMyAccount(accountAddress: string): Promise<MyProgramAccount> {
  const account = await fetchEncodedAccount(rpc, address(accountAddress));
  assertAccountExists(account);

  // Verify discriminator
  const discriminator = account.data[0];
  if (discriminator !== 1) {
    throw new Error(`Invalid discriminator: expected 1, got ${discriminator}`);
  }

  return myAccountCodec.decode(account.data);
}
```

## Account Filtering Patterns

```typescript
// Find all accounts owned by a program with specific data
async function findProgramAccounts(
  programId: string,
  filters: Array<{ memcmp?: { offset: number; bytes: string }; dataSize?: number }>
) {
  const accounts = await rpc.getProgramAccounts(
    address(programId),
    {
      encoding: "base64",
      filters: filters.map((f) => ({
        ...(f.memcmp && { memcmp: { offset: BigInt(f.memcmp.offset), bytes: f.memcmp.bytes } }),
        ...(f.dataSize && { dataSize: BigInt(f.dataSize) }),
      })),
    }
  ).send();

  return accounts.map((acc) => ({
    pubkey: acc.pubkey,
    data: Buffer.from(acc.account.data[0], "base64"),
    lamports: acc.account.lamports,
  }));
}

// Example: Find all token accounts for a specific mint
async function findTokenAccountsByMint(mintAddress: string) {
  return findProgramAccounts(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    [
      { dataSize: 165 },  // Token account size
      { memcmp: { offset: 0, bytes: mintAddress } },  // Mint at offset 0
    ]
  );
}

// Example: Find all token accounts by owner
async function findTokenAccountsByOwner(ownerAddress: string) {
  return findProgramAccounts(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    [
      { dataSize: 165 },
      { memcmp: { offset: 32, bytes: ownerAddress } },  // Owner at offset 32
    ]
  );
}
```

## Batch Fetching with Caching

```typescript
class AccountCache {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private ttlMs: number;

  constructor(private rpc: Rpc, ttlMs = 30000) {
    this.ttlMs = ttlMs;
  }

  async fetch<T>(
    addr: string,
    decoder?: (data: Uint8Array) => T
  ): Promise<T | null> {
    const cached = this.cache.get(addr);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return cached.data;
    }

    const account = await fetchEncodedAccount(this.rpc, address(addr));
    if (!account.exists) {
      return null;
    }

    const data = decoder ? decoder(account.data) : account;
    this.cache.set(addr, { data, timestamp: Date.now() });

    return data;
  }

  async fetchMany<T>(
    addresses: string[],
    decoder?: (data: Uint8Array) => T
  ): Promise<Map<string, T | null>> {
    const results = new Map<string, T | null>();
    const toFetch: string[] = [];

    // Check cache first
    for (const addr of addresses) {
      const cached = this.cache.get(addr);
      if (cached && Date.now() - cached.timestamp < this.ttlMs) {
        results.set(addr, cached.data);
      } else {
        toFetch.push(addr);
      }
    }

    // Fetch missing
    if (toFetch.length > 0) {
      const accounts = await fetchEncodedAccounts(
        this.rpc,
        toFetch.map((a) => address(a))
      );

      for (let i = 0; i < toFetch.length; i++) {
        const addr = toFetch[i];
        const account = accounts[i];

        if (account.exists) {
          const data = decoder ? decoder(account.data) : account;
          this.cache.set(addr, { data, timestamp: Date.now() });
          results.set(addr, data);
        } else {
          results.set(addr, null);
        }
      }
    }

    return results;
  }

  invalidate(addr: string) {
    this.cache.delete(addr);
  }

  clear() {
    this.cache.clear();
  }
}

// Usage
const cache = new AccountCache(rpc, 60000);  // 1 minute TTL
const mint = await cache.fetch(mintAddress, (data) => mintCodec.decode(data));
```

## Account Size Constants

```typescript
// Common account sizes
const ACCOUNT_SIZES = {
  SYSTEM_ACCOUNT: 0,
  TOKEN_MINT: 82,
  TOKEN_ACCOUNT: 165,
  TOKEN_MULTISIG: 355,
  METADATA: 679,  // Approximate, varies with data
};

// Calculate rent
async function calculateRent(dataSize: number): Promise<bigint> {
  return rpc.getMinimumBalanceForRentExemption(BigInt(dataSize)).send();
}

// Get rent for common accounts
const tokenAccountRent = await calculateRent(ACCOUNT_SIZES.TOKEN_ACCOUNT);
console.log("Token account rent:", Number(tokenAccountRent) / 1e9, "SOL");
```
