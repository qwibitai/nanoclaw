# deBridge Troubleshooting Guide

Common issues and solutions when integrating deBridge on Solana.

## Common Errors

### 1. TargetChainNotSupported

**Error:** `TargetChainNotSupported`

**Cause:** The destination chain is not enabled in deBridge.

**Solution:**
```rust
// Check chain support before sending
let is_supported = debridge_sending::is_chain_supported(
    &target_chain_id,
    ctx.remaining_accounts,
)?;

if !is_supported {
    return Err(error!(ErrorCode::UnsupportedChain));
}
```

**TypeScript:**
```typescript
// Verify chain ID format
const targetChainId = evmChainIdToBytes(1n); // Ethereum

// Check support
const supported = await program.methods
    .isChainSupported(targetChainId)
    .view();
```

### 2. WrongAccountDiscriminator

**Error:** `WrongAccountDiscriminator`

**Cause:** Account passed to SDK is not the expected type.

**Solution:**
- Verify account derivation using correct PDAs
- Check program IDs are correct (DEBRIDGE_ID, SETTINGS_ID)
- Ensure accounts are in correct order

```rust
use debridge_solana_sdk::keys::*;

// Correct PDA derivation
let (bridge, _) = Pubkey::find_bridge_address(&token_mint);
let (chain_support, _) = Pubkey::find_chain_support_info_address(&chain_id);
```

### 3. AssetFeeNotSupported

**Error:** `AssetFeeNotSupported`

**Cause:** Trying to use asset fee when not available for the chain.

**Solution:**
```rust
// Check availability before using asset fee
if debridge_sending::is_asset_fee_available(&chain_id, accounts)? {
    // Use asset fee
    is_use_asset_fee: true
} else {
    // Fall back to native fee
    is_use_asset_fee: false
}
```

### 4. AmountOverflowedWhileAddingFee

**Error:** `AmountOverflowedWhileAddingFee`

**Cause:** Amount + fees exceeds u64::MAX.

**Solution:**
```rust
// Check for potential overflow
let max_safe_amount = u64::MAX / 2; // Conservative limit

require!(
    amount < max_safe_amount,
    ErrorCode::AmountTooLarge
);

let total = debridge_sending::add_all_fees(amount, &chain_id, accounts)?;
```

### 5. WrongClaimParentSubmissionAuth

**Error:** `WrongClaimParentSubmissionAuth`

**Cause:** Claim validation failed - submission authority mismatch.

**Solution:**
```rust
// Ensure correct validation setup
let claim_ix = ValidatedExecuteExtCallIx::try_from_current_ix()?;

// Validate against expected values
claim_ix.validate_submission_auth(&expected_authority)?;
```

### 6. ExternalStorageWrongState

**Error:** `ExternalStorageWrongState`

**Cause:** External call storage account in unexpected state.

**Solution:**
- Initialize storage before use
- Don't reuse already-used storage accounts
- Check if storage already exists before init

```rust
// Initialize external call storage first
invoke_init_external_call(
    InitExternalCallIx {
        external_call_len: data.len() as u32,
        chain_id: target_chain_id,
        external_call_shortcut: shortcut,
        external_call: data,
    },
    accounts,
)?;
```

## Account Issues

### Wrong Account Order

**Problem:** Transaction fails silently or with generic error.

**Solution:** Follow exact account order:

```rust
// Required account order for invoke_debridge_send
let remaining_accounts = vec![
    AccountMeta::new(bridge, false),              // 0
    AccountMeta::new_readonly(token_mint, false), // 1
    AccountMeta::new(staking_wallet, false),      // 2
    AccountMeta::new_readonly(mint_auth, false),  // 3
    AccountMeta::new_readonly(chain_info, false), // 4
    AccountMeta::new_readonly(settings, false),   // 5
    AccountMeta::new_readonly(token_prog, false), // 6
    AccountMeta::new_readonly(state, false),      // 7
    AccountMeta::new_readonly(debridge, false),   // 8
    AccountMeta::new(nonce_storage, false),       // 9
    // ... more accounts
];
```

### Missing Accounts

**Problem:** `AccountNotEnoughKeys` or similar.

**Solution:**
1. Count required accounts in SDK documentation
2. Verify all PDAs are derived correctly
3. Include all token accounts

### Account Not Initialized

**Problem:** Account has no data or wrong owner.

**Solution:**
```typescript
// Check account exists
const accountInfo = await connection.getAccountInfo(bridgePda);
if (!accountInfo) {
    throw new Error('Bridge account not initialized for this token');
}

// Verify owner
if (!accountInfo.owner.equals(DEBRIDGE_PROGRAM_ID)) {
    throw new Error('Wrong account owner');
}
```

## Transaction Issues

### Transaction Too Large

**Problem:** Transaction exceeds size limit.

**Solution:**
1. Use `init_external_call` for large payloads
2. Split into multiple transactions
3. Use versioned transactions with lookup tables

```typescript
// For large external calls
const { data, shortcut } = buildExternalCallData(...);

if (data.length > 450) {
    // Initialize storage first
    await program.methods
        .initExternalCallBuffer(targetChainId, Buffer.from(data))
        .rpc();
}

// Then send
await program.methods
    .sendWithExternalCall(...)
    .rpc();
```

### Compute Budget Exceeded

**Problem:** Transaction runs out of compute units.

**Solution:**
```typescript
import { ComputeBudgetProgram } from '@solana/web3.js';

const tx = new Transaction()
    .add(
        ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000, // Increase limit
        })
    )
    .add(
        // Your deBridge instruction
    );
```

### Blockhash Expired

**Problem:** Transaction confirmation times out.

**Solution:**
```typescript
// Use confirmed commitment
const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');

// Retry with exponential backoff
async function sendWithRetry(tx: Transaction, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await connection.sendTransaction(tx, [signer]);
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}
```

## Fee Issues

### Insufficient SOL for Native Fee

**Problem:** User doesn't have enough SOL for protocol fees.

**Solution:**
```typescript
// Check balance before sending
const balance = await connection.getBalance(sender);
const nativeFee = await getNativeFee(chainId);

if (balance < nativeFee + 5000) { // 5000 for tx fee
    throw new Error('Insufficient SOL balance');
}

// Or use asset fee
if (await isAssetFeeAvailable(chainId)) {
    sendWithAssetFee(...);
}
```

### Fee Changed Between Quote and Send

**Problem:** Fees changed after user approved transaction.

**Solution:**
```typescript
// Get fresh fees right before sending
const fees = await getFeeBreakdown(chainId, amount);

// Add slippage tolerance
const maxAmount = amount + (amount * 1n / 100n); // 1% tolerance

if (fees.amountWithAllFees > maxAmount) {
    throw new Error('Fee increased significantly');
}
```

## Receiver Address Issues

### Invalid EVM Address Length

**Problem:** Receiver address wrong length.

**Solution:**
```typescript
function validateEvmAddress(address: string): Uint8Array {
    // Remove 0x prefix
    const hex = address.replace('0x', '');

    // Check length
    if (hex.length !== 40) {
        throw new Error('EVM address must be 20 bytes');
    }

    // Check valid hex
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error('Invalid hex characters');
    }

    // Convert to bytes
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }

    return bytes;
}
```

### Checksum Address Issues

**Problem:** Address has wrong checksum.

**Solution:**
```typescript
import { getAddress } from 'ethers';

function normalizeEvmAddress(address: string): string {
    try {
        // This validates checksum and normalizes
        return getAddress(address);
    } catch {
        throw new Error('Invalid EVM address checksum');
    }
}
```

## Testing Issues

### Mainnet-Only Infrastructure

**Problem:** deBridge not available on devnet.

**Solution:**
```typescript
// Use mainnet fork for testing
const connection = new Connection(
    'https://api.mainnet-beta.solana.com',
    { commitment: 'confirmed' }
);

// Or mock the SDK responses for unit tests
jest.mock('debridge-solana-sdk', () => ({
    // Mock implementations
}));
```

### Airdrop Limits

**Problem:** Can't get enough SOL for testing on mainnet.

**Solution:**
1. Use small amounts for testing
2. Create dedicated test wallet with mainnet SOL
3. Use mainnet fork that allows airdrops

## Debug Logging

Enable detailed logging:

```rust
// In your program
msg!("deBridge: Sending {} to chain {:?}", amount, target_chain_id);
msg!("deBridge: Using asset fee: {}", is_use_asset_fee);
msg!("deBridge: Accounts count: {}", ctx.remaining_accounts.len());

// Log each account
for (i, account) in ctx.remaining_accounts.iter().enumerate() {
    msg!("Account {}: {} (signer: {}, writable: {})",
        i,
        account.key,
        account.is_signer,
        account.is_writable
    );
}
```

```typescript
// TypeScript logging
console.log('deBridge Transfer:');
console.log('  Target Chain:', targetChainId);
console.log('  Receiver:', receiver);
console.log('  Amount:', amount);
console.log('  Accounts:', remainingAccounts.map(a => ({
    pubkey: a.pubkey.toBase58(),
    isSigner: a.isSigner,
    isWritable: a.isWritable,
})));
```

## Getting Help

1. **deBridge Docs**: https://docs.debridge.com
2. **SDK GitHub**: https://github.com/debridge-finance/debridge-solana-sdk
3. **Discord**: https://discord.gg/debridge
4. **SDK Issues**: Open issue on GitHub repo

When reporting issues, include:
- Transaction signature (if available)
- Error message
- Chain IDs involved
- Token mint address
- Amount being transferred
