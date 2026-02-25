# MagicBlock Troubleshooting Guide

Common issues and solutions when working with Ephemeral Rollups.

## Delegation Issues

### Account Not Delegating

**Symptoms:**
- `isDelegated()` returns false after delegation tx
- Delegation transaction succeeds but account owner unchanged

**Solutions:**

1. **Wait longer** - Delegation propagation takes 1-3 seconds
```typescript
await program.methods.delegate().rpc();
await new Promise(r => setTimeout(r, 3000)); // Wait 3 seconds
const delegated = await isDelegated(accountPda);
```

2. **Check account exists** - Cannot delegate non-existent accounts
```typescript
const info = await connection.getAccountInfo(accountPda);
if (!info) {
  throw new Error("Account doesn't exist - initialize first");
}
```

3. **Verify seeds** - PDA seeds must match exactly
```typescript
// Rust seeds
seeds = [b"state", payer.key().as_ref()]

// TypeScript seeds (must match!)
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("state"), payer.publicKey.toBuffer()],
  programId
);
```

### Delegation Reverted

**Symptoms:**
- Account delegated briefly then reverted

**Cause:** Delegation expired or was cancelled

**Solution:** Check `valid_until` parameter
```rust
delegate_account(
    &ctx.accounts.payer,
    &ctx.accounts.account,
    &ctx.accounts.delegation_program,
    0, // 0 = no expiry, or set Unix timestamp
)?;
```

---

## Transaction Issues

### "Account not found" on ER

**Symptoms:**
- Transaction fails with account not found
- Works on base layer but not ER

**Solutions:**

1. **Verify delegation first**
```typescript
if (!(await isDelegated(accountPda))) {
  throw new Error("Account not delegated - delegate first");
}
```

2. **Wait for propagation** - ER needs time to sync
```typescript
await delegateTx();
await new Promise(r => setTimeout(r, 2000));
await erOperation();
```

### Transaction Timeout

**Symptoms:**
- ER transactions hang or timeout

**Solutions:**

1. **Use skipPreflight**
```typescript
await erProgram.methods.action().rpc({
  skipPreflight: true, // Required for ER
});
```

2. **Check ER endpoint** - Use router for auto-failover
```typescript
const erConnection = new Connection(
  "https://devnet-router.magicblock.app", // Router auto-selects best
  "confirmed"
);
```

3. **Increase timeout**
```typescript
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  skipPreflight: true,
  preflightCommitment: "confirmed",
});
```

### "Blockhash not found"

**Symptoms:**
- Transaction rejected with blockhash error

**Cause:** Blockhash expired (ER has faster block times)

**Solution:** Get fresh blockhash immediately before sending
```typescript
const { blockhash } = await connection.getLatestBlockhash();
const tx = new Transaction({
  recentBlockhash: blockhash,
  feePayer: payer.publicKey,
});
// Send immediately
await connection.sendTransaction(tx, [payer]);
```

---

## State Issues

### State Mismatch Between Layers

**Symptoms:**
- ER state differs from base layer state
- Values reset after undelegation

**Solutions:**

1. **Wait for finalization** - Base layer updates after undelegation completes
```typescript
await undelegate(accountPda);
await new Promise(r => setTimeout(r, 5000)); // Wait for finalization
const state = await baseProgram.account.state.fetch(accountPda);
```

2. **Commit before reading base layer**
```typescript
await commit(accountPda);
const commitSig = await GetCommitmentSignature(erConnection, accountPda);
// Now base layer has updated state
```

### Cannot Fetch Account on ER

**Symptoms:**
- `program.account.xxx.fetch()` fails on ER

**Cause:** Some account fetching methods don't work on ER

**Solution:** Use manual decoding
```typescript
const accountInfo = await erConnection.getAccountInfo(accountPda);
if (accountInfo) {
  const decoded = program.coder.accounts.decode("State", accountInfo.data);
  console.log(decoded);
}
```

---

## Build Issues

### Macro Not Found

**Symptoms:**
- `#[ephemeral]` or `#[delegate]` not recognized

**Solution:** Check Cargo.toml features
```toml
[dependencies]
ephemeral-rollups-sdk = {
  version = "0.6.5",
  features = ["anchor", "disable-realloc"]  # Both features required
}
```

### Anchor Version Mismatch

**Symptoms:**
- IDL generation fails
- Type errors in client

**Solution:** Ensure version alignment
```toml
# Cargo.toml
anchor-lang = "0.32.1"

# package.json
"@coral-xyz/anchor": "^0.32.1"
```

### "realloc" Feature Conflict

**Symptoms:**
- Build fails with realloc errors

**Solution:** Disable realloc in SDK
```toml
ephemeral-rollups-sdk = {
  version = "0.6.5",
  features = ["anchor", "disable-realloc"]  # Add disable-realloc
}
```

---

## VRF Issues

### VRF Callback Not Received

**Symptoms:**
- Random request sent but callback never arrives
- `pending_request` stays true

**Solutions:**

1. **Check callback function name** - Must match pattern
```rust
// Request function
pub fn roll_dice(ctx: Context<RollDice>) -> Result<()>

// Callback MUST be named: <request_fn>_callback
pub fn roll_dice_callback(ctx: Context<DiceCallback>, result: VrfResult) -> Result<()>
```

2. **Include account in callback context**
```rust
#[derive(Accounts)]
pub struct DiceCallback<'info> {
    #[account(mut)]
    pub game: Account<'info, GameState>,  // Must include the game account
}
```

3. **Wait longer** - VRF can take 5-10 seconds
```typescript
const timeout = 30000; // 30 seconds
await waitForCallback(gamePda, timeout);
```

---

## Crank Issues

### Crank Not Executing

**Symptoms:**
- Crank started but function not being called

**Solutions:**

1. **Verify function name matches**
```rust
schedule_crank(
    &ctx.accounts.payer,
    &ctx.accounts.game,
    &ctx.accounts.magic_program,
    "game_loop", // Must match exactly
    interval_ms,
)?;

// Function must exist with this name
pub fn game_loop(ctx: Context<GameLoop>) -> Result<()>
```

2. **Check crank_active flag**
```rust
pub fn game_loop(ctx: Context<GameLoop>) -> Result<()> {
    let game = &ctx.accounts.game;
    require!(game.crank_active, GameError::CrankNotActive);
    // ...
}
```

### Crank Running Too Fast/Slow

**Solution:** Adjust interval
```rust
// Interval in milliseconds
schedule_crank(..., 100)?;  // 10 times per second
schedule_crank(..., 1000)?; // Once per second
```

---

## React Native Issues

### Buffer Not Defined

**Symptoms:**
- `Buffer is not defined` error

**Solution:** Add polyfill
```javascript
import { Buffer } from "buffer";
global.Buffer = Buffer;
```

### Account Decoding Fails

**Symptoms:**
- `program.account.xxx.fetch()` crashes in React Native

**Solution:** Use manual decoding
```typescript
const accountInfo = await connection.getAccountInfo(pubkey);
const decoded = program.coder.accounts.decode("AccountType", accountInfo.data);
```

---

## Debugging Tips

### Enable Verbose Logging

```typescript
// Log all transactions
const connection = new Connection(rpc, {
  commitment: "confirmed",
  wsEndpoint: wsRpc,
});

connection.onLogs("all", (logs) => {
  console.log("Logs:", logs);
});
```

### Check Transaction Status

```typescript
async function checkTx(signature: string) {
  const status = await connection.getSignatureStatus(signature);
  console.log("Status:", status);

  if (status.value?.err) {
    const tx = await connection.getTransaction(signature);
    console.log("Error:", tx?.meta?.err);
    console.log("Logs:", tx?.meta?.logMessages);
  }
}
```

### Verify Account Owner

```typescript
async function debugAccount(pubkey: PublicKey) {
  const info = await connection.getAccountInfo(pubkey);
  console.log("Exists:", !!info);
  console.log("Owner:", info?.owner.toBase58());
  console.log("Lamports:", info?.lamports);
  console.log("Data length:", info?.data.length);
  console.log("Delegated:", info?.owner.equals(DELEGATION_PROGRAM_ID));
}
```

---

## Getting Help

1. **Discord** - Join MagicBlock Discord for real-time support
2. **GitHub Issues** - https://github.com/magicblock-labs/ephemeral-rollups-sdk/issues
3. **Documentation** - https://docs.magicblock.gg
4. **Examples** - https://github.com/magicblock-labs/magicblock-engine-examples
