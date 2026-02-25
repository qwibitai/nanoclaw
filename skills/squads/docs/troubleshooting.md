# Squads Protocol Troubleshooting Guide

Common issues and solutions when working with Squads Protocol products.

---

## Squads V4 Multisig Issues

### "NotAMember" Error

**Problem**: Transaction fails with `NotAMember` error.

**Solutions**:

1. Verify the signer is a member of the multisig:
```typescript
const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
  connection,
  multisigPda
);

const isMember = multisigAccount.members.some(
  (m) => m.key.equals(wallet.publicKey)
);
console.log("Is member:", isMember);
```

2. Check if using the correct multisig PDA:
```typescript
console.log("Multisig PDA:", multisigPda.toString());
console.log("Expected members:", multisigAccount.members.length);
```

---

### "Unauthorized" Error

**Problem**: Member cannot perform an action.

**Solutions**:

1. Check member permissions:
```typescript
import { Permission } from "@sqds/multisig/lib/types";

const member = multisigAccount.members.find(
  (m) => m.key.equals(wallet.publicKey)
);

if (member) {
  const canInitiate = (member.permissions.mask & Permission.Initiate) !== 0;
  const canVote = (member.permissions.mask & Permission.Vote) !== 0;
  const canExecute = (member.permissions.mask & Permission.Execute) !== 0;

  console.log("Can initiate:", canInitiate);
  console.log("Can vote:", canVote);
  console.log("Can execute:", canExecute);
}
```

2. Ensure member has the required permission:
   - `Initiate` - Required to create proposals
   - `Vote` - Required to approve/reject proposals
   - `Execute` - Required to execute approved transactions

---

### "InvalidTransactionIndex" Error

**Problem**: Transaction index is invalid or already used.

**Solutions**:

1. Get the current transaction index:
```typescript
const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
  connection,
  multisigPda
);

const nextIndex = BigInt(Number(multisigAccount.transactionIndex) + 1);
console.log("Next transaction index:", nextIndex.toString());
```

2. Ensure you're incrementing the index for each new transaction.

---

### "ProposalNotApproved" Error

**Problem**: Cannot execute transaction because proposal hasn't reached threshold.

**Solutions**:

1. Check proposal status:
```typescript
const [proposalPda] = multisig.getProposalPda({
  multisigPda,
  transactionIndex,
});

const proposal = await multisig.accounts.Proposal.fromAccountAddress(
  connection,
  proposalPda
);

console.log("Status:", proposal.status.__kind);
console.log("Approvals:", proposal.approved.length);
console.log("Threshold:", multisigAccount.threshold);
```

2. Wait for more members to approve before executing.

---

### "TimeLockNotSatisfied" Error

**Problem**: Transaction cannot be executed because time lock hasn't passed.

**Solutions**:

1. Check time lock status:
```typescript
if (proposal.status.__kind === "Approved") {
  const approvedAt = Number(proposal.status.timestamp);
  const currentTime = Math.floor(Date.now() / 1000);
  const timeLock = multisigAccount.timeLock;

  const canExecuteAt = approvedAt + timeLock;
  const remaining = canExecuteAt - currentTime;

  if (remaining > 0) {
    console.log(`Time lock: ${remaining} seconds remaining`);
    console.log(`Can execute at: ${new Date(canExecuteAt * 1000).toISOString()}`);
  }
}
```

2. Wait until the time lock period has passed.

---

### "StaleProposal" Error

**Problem**: Proposal is too old and has become stale.

**Solutions**:

1. Check if the transaction index is stale:
```typescript
const isStale = transactionIndex <= multisigAccount.staleTransactionIndex;
console.log("Is stale:", isStale);
```

2. Create a new transaction and proposal if the old one is stale.

---

### Vault Funds Not Visible

**Problem**: Sent funds to multisig but they're not visible.

**Solutions**:

1. **Common mistake**: Sending to multisig PDA instead of vault PDA.

```typescript
// WRONG - Don't send to multisig PDA
const multisigPda = "YourMultisigPda...";

// CORRECT - Send to vault PDA
const [vaultPda] = multisig.getVaultPda({
  multisigPda,
  index: 0, // Default vault
});

console.log("Send funds to vault:", vaultPda.toString());
```

2. Always send funds to the vault address, not the multisig address.

---

### Spending Limit Not Working

**Problem**: Cannot use spending limit.

**Solutions**:

1. Verify spending limit exists and is active:
```typescript
const spendingLimit = await multisig.accounts.SpendingLimit.fromAccountAddress(
  connection,
  spendingLimitPda
);

console.log("Amount:", spendingLimit.amount.toString());
console.log("Remaining:", spendingLimit.remainingAmount.toString());
console.log("Period:", spendingLimit.period);
```

2. Check if you're an authorized member:
```typescript
const isAuthorized = spendingLimit.members.some(
  (m) => m.equals(wallet.publicKey)
);
console.log("Is authorized:", isAuthorized);
```

3. Check if destination is allowed:
```typescript
const isAllowedDest = spendingLimit.destinations.some(
  (d) => d.equals(destinationPubkey)
);
console.log("Is allowed destination:", isAllowedDest);
```

---

## Smart Account Issues

### Session Key Expired

**Problem**: Session key no longer works.

**Solutions**:

1. Check expiration:
```typescript
const session = await client.getSessionKey(accountId, sessionId);
const isExpired = new Date(session.expiresAt) < new Date();
console.log("Expired:", isExpired);
```

2. Create a new session key if expired.

---

### Session Permission Denied

**Problem**: Session key cannot perform operation.

**Solutions**:

1. Check session permissions:
```typescript
const session = await client.getSessionKey(accountId, sessionId);
console.log("Permissions:", session.permissions);

// Required permissions:
// - "transfer" for sending tokens
// - "swap" for DEX operations
// - "stake" for staking
// - "sign_message" for message signing
```

2. Check session limits:
```typescript
if (session.limits) {
  console.log("Per-tx limit:", session.limits.perTransaction);
  console.log("Daily limit:", session.limits.daily);
  console.log("Allowed mints:", session.limits.allowedMints);
  console.log("Allowed destinations:", session.limits.allowedDestinations);
}
```

---

### Policy Violation

**Problem**: Transaction rejected due to policy.

**Solutions**:

1. List active policies:
```typescript
const { policies } = await client.listPolicies(accountId);
policies.forEach((policy) => {
  console.log(`${policy.name} (${policy.type}):`, policy.params);
});
```

2. Check spending limits:
```typescript
// If policy type is "spending_limit"
// Verify amount is within limit for the period
```

3. Check allowlist/blocklist:
```typescript
// If policy type is "allowlist" or "blocklist"
// Verify destination is allowed
```

---

### KYC Required

**Problem**: Operation blocked due to KYC status.

**Solutions**:

1. Check KYC status:
```typescript
const kyc = await client.getKycStatus(accountId);
console.log("KYC Status:", kyc.status);
console.log("KYC Level:", kyc.level);
```

2. Complete KYC if needed:
```typescript
const { kycUrl } = await client.startKyc(accountId, "https://yourapp.com/kyc-complete");
console.log("Complete KYC at:", kycUrl);
```

3. KYC levels and limits:
   - `basic`: Email verified, $1,000/day
   - `enhanced`: ID + selfie, $10,000/day
   - `full`: ID + proof of address, $100,000/day

---

## Grid API Issues

### Authentication Failed

**Problem**: API returns 401 Unauthorized.

**Solutions**:

1. Check API key is correct:
```typescript
// Ensure API key is set
if (!process.env.GRID_API_KEY) {
  throw new Error("GRID_API_KEY environment variable not set");
}
```

2. Check token expiration for user auth:
```typescript
// Refresh token if expired
const tokens = await client.refreshToken(refreshToken);
```

---

### Rate Limited

**Problem**: API returns 429 Too Many Requests.

**Solutions**:

1. Implement rate limiting:
```typescript
async function rateLimitedRequest<T>(
  fn: () => Promise<T>,
  retries: number = 3
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.message.includes("RATE_LIMITED") && i < retries - 1) {
        const delay = Math.pow(2, i) * 1000; // Exponential backoff
        console.log(`Rate limited, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries exceeded");
}
```

2. Check rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1705320000
```

---

### Insufficient Funds

**Problem**: Payment fails due to insufficient balance.

**Solutions**:

1. Check available balance:
```typescript
const account = await client.getAccount(accountId);
const usdcBalance = account.balances.find((b) => b.mint === "USDC");

console.log("Total:", usdcBalance?.amount);
console.log("Available:", usdcBalance?.available);
console.log("Pending:", usdcBalance?.pending);
```

2. Wait for pending transactions to complete.

3. Add funds to the account.

---

### Spending Limit Exceeded

**Problem**: Payment blocked by spending limit.

**Solutions**:

1. Check current limits:
```typescript
const { limits } = await client.getSpendingLimits(accountId);
limits.forEach((limit) => {
  const percentage = (parseFloat(limit.used) / parseFloat(limit.amount)) * 100;
  console.log(`${limit.type}: ${limit.used}/${limit.amount} (${percentage.toFixed(1)}%)`);
  if (limit.resetsAt) {
    console.log(`  Resets at: ${limit.resetsAt}`);
  }
});
```

2. Wait for limit to reset or request limit increase.

---

### Duplicate Payment

**Problem**: API returns 409 Conflict for duplicate request.

**Solutions**:

1. Use unique idempotency keys:
```typescript
const payment = await client.createPayment({
  fromAccountId,
  toAddress,
  amount: "100.00",
  currency: "USDC",
  // Generate unique key for each payment attempt
  idempotencyKey: `pay-${Date.now()}-${crypto.randomUUID()}`,
});
```

2. If same idempotency key is used, API returns the original payment.

---

## General Solana Issues

### Transaction Simulation Failed

**Problem**: Transaction fails during simulation.

**Solutions**:

1. Check simulation logs:
```typescript
const tx = new Transaction().add(...instructions);
tx.feePayer = wallet.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

const simulation = await connection.simulateTransaction(tx);
if (simulation.value.err) {
  console.error("Simulation error:", simulation.value.err);
  console.log("Logs:", simulation.value.logs);
}
```

2. Common issues:
   - Insufficient SOL for fees
   - Invalid account addresses
   - Missing required signers
   - Program errors

---

### Blockhash Expired

**Problem**: Transaction fails with expired blockhash.

**Solutions**:

1. Get fresh blockhash immediately before sending:
```typescript
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
tx.recentBlockhash = blockhash;

// Send immediately after setting blockhash
const signature = await connection.sendTransaction(tx, [wallet]);
```

2. Use `lastValidBlockHeight` to retry:
```typescript
async function sendWithRetry(tx: Transaction, maxRetries: number = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    try {
      const signature = await connection.sendTransaction(tx, [wallet]);
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
      return signature;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log("Retrying...");
    }
  }
}
```

---

### Compute Budget Exceeded

**Problem**: Transaction fails due to compute limit.

**Solutions**:

1. Increase compute budget:
```typescript
import { ComputeBudgetProgram } from "@solana/web3.js";

const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
  units: 400_000, // Increase as needed (max 1.4M)
});

const tx = new Transaction()
  .add(computeBudgetIx)
  .add(...yourInstructions);
```

2. Add priority fee for faster inclusion:
```typescript
const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: 10_000, // Adjust based on network congestion
});

const tx = new Transaction()
  .add(computeBudgetIx)
  .add(priorityFeeIx)
  .add(...yourInstructions);
```

---

## Debugging Tips

### Enable Verbose Logging

```typescript
// Log all requests (for debugging)
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  console.log("Request:", url);
  console.log("Options:", JSON.stringify(options, null, 2));
  const response = await originalFetch(url, options);
  console.log("Status:", response.status);
  return response;
};
```

### Check Account State

```typescript
async function debugAccount(connection: Connection, address: PublicKey) {
  const info = await connection.getAccountInfo(address);

  if (!info) {
    console.log("Account does not exist");
    return;
  }

  console.log("Owner:", info.owner.toString());
  console.log("Lamports:", info.lamports);
  console.log("Data length:", info.data.length, "bytes");
  console.log("Executable:", info.executable);
}
```

### Verify Program Deployment

```bash
# Verify Squads V4 program
solana-verify get-program-hash \
  -u mainnet-beta \
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf

# Verify Smart Account program
solana-verify get-program-hash \
  -u mainnet-beta \
  SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG
```

---

## Getting Help

1. **Check documentation** - [docs.squads.so](https://docs.squads.so)
2. **SDK TypeDoc** - [v4-sdk-typedoc.vercel.app](https://v4-sdk-typedoc.vercel.app)
3. **Grid Developer Portal** - [developers.squads.so](https://developers.squads.so)
4. **GitHub Issues** - [github.com/Squads-Protocol/v4](https://github.com/Squads-Protocol/v4/issues)
5. **Test on devnet** - Always test your code on devnet before mainnet
