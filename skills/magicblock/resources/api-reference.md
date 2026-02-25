# MagicBlock API Quick Reference

Fast lookup for MagicBlock Ephemeral Rollups APIs.

## Rust SDK

### Installation

```toml
[dependencies]
anchor-lang = "0.32.1"
ephemeral-rollups-sdk = { version = "0.6.5", features = ["anchor", "disable-realloc"] }

# For VRF
ephemeral-vrf-sdk = { version = "0.3", features = ["anchor"] }
```

### Macros

| Macro | Location | Purpose |
|-------|----------|---------|
| `#[ephemeral]` | Before `#[program]` | Enable ER support |
| `#[delegate]` | On function | Auto-inject delegation accounts |
| `#[commit]` | On function | Auto-inject commit/undelegate accounts |
| `#[vrf]` | Before `#[program]` | Enable VRF support |
| `del` | Account constraint | Mark account for delegation |

### Core Imports

```rust
use ephemeral_rollups_sdk::anchor::{
    ephemeral,
    delegate_account,
    commit_accounts,
    undelegate_account,
};
use ephemeral_rollups_sdk::cpi::DelegationProgram;
use ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID;
```

### Delegation Functions

```rust
// Manual delegation (if not using #[delegate] macro)
delegate_account(
    &ctx.accounts.payer,
    &ctx.accounts.account_to_delegate,
    &ctx.accounts.delegation_program,
    valid_until: i64,  // Unix timestamp or 0 for no expiry
)?;

// Commit without undelegating
commit_accounts(
    &ctx.accounts.payer,
    vec![&ctx.accounts.account.to_account_info()],
    &ctx.accounts.magic_context,
    &ctx.accounts.magic_program,
)?;

// Manual undelegation (if not using #[commit] macro)
undelegate_account(
    &ctx.accounts.payer,
    &ctx.accounts.account_to_undelegate,
    &ctx.accounts.magic_context,
    &ctx.accounts.magic_program,
)?;
```

### Account Contexts

```rust
// Delegation context
#[derive(Accounts)]
pub struct Delegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Account will be delegated
    #[account(mut, seeds = [...], bump, del)]
    pub account: AccountInfo<'info>,
    pub delegation_program: Program<'info, DelegationProgram>,
}

// Commit/Undelegate context
#[derive(Accounts)]
pub struct Undelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Account will be undelegated
    #[account(mut)]
    pub account: AccountInfo<'info>,
    /// CHECK: Magic context
    pub magic_context: AccountInfo<'info>,
    /// CHECK: Magic program
    pub magic_program: AccountInfo<'info>,
}
```

---

## TypeScript SDK

### Installation

```bash
npm install @magicblock-labs/ephemeral-rollups-sdk @solana/web3.js @coral-xyz/anchor
```

### Core Imports

```typescript
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  createDelegateInstruction,
  createUndelegateInstruction,
  createCommitInstruction,
  GetCommitmentSignature,
} from "@magicblock-labs/ephemeral-rollups-sdk";
```

### Connection Setup

```typescript
// Base layer (Solana)
const baseConnection = new Connection("https://api.devnet.solana.com", "confirmed");

// Ephemeral Rollup
const erConnection = new Connection("https://devnet.magicblock.app", "confirmed");

// Or use Magic Router (auto-selects best ER)
const routerConnection = new Connection("https://devnet-router.magicblock.app", "confirmed");
```

### Provider Setup

```typescript
// Base layer provider
const baseProvider = new AnchorProvider(baseConnection, wallet, {
  commitment: "confirmed",
});

// ER provider (MUST use skipPreflight)
const erProvider = new AnchorProvider(erConnection, wallet, {
  commitment: "confirmed",
  skipPreflight: true,
});
```

### Check Delegation Status

```typescript
async function isDelegated(connection: Connection, pubkey: PublicKey): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(pubkey);
  if (!accountInfo) return false;
  return accountInfo.owner.equals(DELEGATION_PROGRAM_ID);
}
```

### Create Delegate Instruction

```typescript
const delegateIx = createDelegateInstruction({
  payer: payer.publicKey,
  delegatedAccount: accountPda,
  ownerProgram: programId,
  buffer: Buffer.from([]),  // Optional data
  validUntil: 0,  // 0 = no expiry
});
```

### Create Undelegate Instruction

```typescript
const undelegateIx = createUndelegateInstruction({
  payer: payer.publicKey,
  delegatedAccount: accountPda,
});
```

### Get Commitment Signature

```typescript
// Verify state committed to base layer
const commitSig = await GetCommitmentSignature(erConnection, accountPda);
console.log("Commitment verified:", commitSig);
```

### Send Transaction to ER

```typescript
// Always use skipPreflight for ER transactions
const tx = new Transaction().add(instruction);
const sig = await erConnection.sendTransaction(tx, [payer], {
  skipPreflight: true,
});
```

---

## VRF SDK

### Rust

```rust
use ephemeral_vrf_sdk::anchor::{vrf, VrfRequest, VrfResult};
use ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE;

#[vrf]
#[ephemeral]
#[program]
pub mod my_vrf_program {
    // Request randomness - callback name must match
    pub fn request_random(ctx: Context<RequestRandom>) -> Result<()> {
        Ok(())
    }

    // Callback receives result
    pub fn random_callback(ctx: Context<RandomCallback>, result: VrfResult) -> Result<()> {
        let randomness = result.randomness; // [u8; 32]
        let random_u64 = u64::from_le_bytes(randomness[0..8].try_into().unwrap());
        Ok(())
    }
}
```

### TypeScript

```typescript
import {
  createRequestRandomnessInstruction,
  DEFAULT_EPHEMERAL_QUEUE,
} from "@magicblock-labs/ephemeral-vrf-sdk";

const vrfIx = createRequestRandomnessInstruction({
  payer: payer.publicKey,
  program: programId,
  callback: "random_callback",
  accounts: [gameStatePda],
  queue: DEFAULT_EPHEMERAL_QUEUE,
});
```

---

## Crank SDK

### Rust

```rust
use ephemeral_rollups_sdk::cpi::{schedule_crank_instruction, MAGIC_PROGRAM_ID};

pub fn setup_crank(ctx: Context<SetupCrank>, interval_ms: u64) -> Result<()> {
    schedule_crank_instruction(
        &ctx.accounts.payer,
        &ctx.accounts.target_account.to_account_info(),
        &ctx.accounts.magic_program,
        "game_loop",  // Function to call
        interval_ms,
    )?;
    Ok(())
}
```

### TypeScript

```typescript
import { createScheduleCrankInstruction, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const crankIx = createScheduleCrankInstruction({
  payer: payer.publicKey,
  targetAccount: gameStatePda,
  programId: programId,
  instruction: "game_loop",
  intervalMs: 100,  // Every 100ms
});
```

---

## Common Patterns

### Transaction to Base Layer

```typescript
// Init, delegate, final reads
const tx = await program.methods
  .initialize()
  .accounts({ ... })
  .rpc();
```

### Transaction to ER

```typescript
// Operations on delegated accounts
const tx = await erProgram.methods
  .increment()
  .accounts({ ... })
  .rpc({ skipPreflight: true });
```

### Wait for Delegation

```typescript
async function waitForDelegation(pubkey: PublicKey, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isDelegated(baseConnection, pubkey)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
```

### Account Subscription on ER

```typescript
erConnection.onAccountChange(accountPda, (accountInfo) => {
  const decoded = program.coder.accounts.decode("GameState", accountInfo.data);
  console.log("State updated:", decoded);
});
```
