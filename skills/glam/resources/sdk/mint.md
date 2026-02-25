# Mint Operations (SDK only)

Share class token management is available through the SDK (`client.mint`), not as CLI commands.

**Prerequisite:** Vault must have a share class (configured via JSON template at vault creation).

## SDK Methods

### `client.mint.fetchTokenHolders`

List all token holders for the vault's share class.

```typescript
const holders = await client.mint.fetchTokenHolders(mintPda);
// Returns: { owner: PublicKey, amount: BN }[]
```

### `client.mint.update`

Update share class mint settings.

```typescript
await client.mint.update({
  minSubscription?: BN,
  minRedemption?: BN,
}, txOptions);
```

### `client.mint.pauseSubscription` / `unpauseSubscription`

```typescript
await client.mint.pauseSubscription(txOptions);
await client.mint.unpauseSubscription(txOptions);
```

### `client.mint.pauseRedemption` / `unpauseRedemption`

```typescript
await client.mint.pauseRedemption(txOptions);
await client.mint.unpauseRedemption(txOptions);
```

### `client.mint.initializeWithStateParams`

Create a new share class for a vault.

```typescript
const { mintPda, txId } = await client.mint.initializeWithStateParams(vaultPda, {
  name: string,
  symbol: string,
  decimals: number,
  // ... additional mint config
}, txOptions);
```

### `client.mint.setTokenAccountsStates`

Freeze or unfreeze token accounts (prevents/allows transfers).

```typescript
await client.mint.setTokenAccountsStates(vaultPda, {
  accounts: [accountPubkey1, accountPubkey2],
  frozen: true, // true to freeze, false to unfreeze
}, txOptions);
```

### `client.mint.mint`

Issue (mint) new tokens.

```typescript
await client.mint.mint(amount, recipientPubkey, txOptions);
```

### `client.mint.burn`

Burn tokens from an account.

```typescript
await client.mint.burn(amount, fromPubkey, txOptions);
```

### `client.mint.forceTransfer`

Force transfer tokens between accounts (requires permanent delegate authority).

```typescript
await client.mint.forceTransfer(vaultPda, {
  source: PublicKey,
  destination: PublicKey,
  amount: BN,
}, txOptions);
```

---

## Typical Workflows

### Compliance Freeze (SDK)

```typescript
// 1. List holders to identify accounts
const holders = await client.mint.fetchTokenHolders(mintPda);

// 2. Freeze flagged accounts
await client.mint.setTokenAccountsStates(vaultPda, {
  accounts: [suspiciousAccount],
  frozen: true,
});

// 3. Later, unfreeze cleared accounts
await client.mint.setTokenAccountsStates(vaultPda, {
  accounts: [clearedAccount],
  frozen: false,
});
```

### Forced Redemption (SDK)

```typescript
// 1. Force transfer tokens back to vault
await client.mint.forceTransfer(vaultPda, {
  source: investorTokenAccount,
  destination: vaultTokenAccount,
  amount: new BN(5000),
});

// 2. Burn the returned tokens
await client.mint.burn(new BN(5000), vaultTokenAccount);
```
