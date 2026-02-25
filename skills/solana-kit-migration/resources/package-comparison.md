# Package Comparison: @solana/web3.js vs @solana/kit

Detailed feature-by-feature comparison of the two Solana JavaScript SDKs.

## Architecture Comparison

| Aspect | @solana/web3.js (v1) | @solana/kit |
|--------|---------------------|-------------|
| Design Pattern | Object-Oriented (Classes) | Functional (Functions) |
| Bundle Strategy | Monolithic | Modular/Tree-shakeable |
| Dependencies | Multiple external deps | Zero external deps |
| TypeScript | Good support | Excellent (compile-time checks) |
| API Style | Imperative | Declarative/Compositional |

## Performance Metrics

| Metric | v1 | Kit | Improvement |
|--------|-----|-----|-------------|
| Confirmation Latency | Baseline | ~200ms faster | Significant |
| Keypair Generation | Native JS | WebCrypto | ~10x faster |
| Transaction Signing | Native JS | WebCrypto | ~10x faster |
| Bundle Size (typical) | ~311KB | ~226KB | 26% smaller |
| Tree-shaking | Not possible | Full support | Varies |

## Feature Comparison

### RPC Communication

**v1: Connection Class**
```typescript
const connection = new Connection(url, commitment);
```
- Single object handles HTTP + WebSocket
- Implicit request handling
- Built-in retry logic
- Less customizable

**Kit: Separate RPC + Subscriptions**
```typescript
const rpc = createSolanaRpc(url);
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
```
- Clear separation of concerns
- Explicit `.send()` calls
- Custom transport support
- Advanced strategies (fallback, round-robin, rate-limiting)

### Key Management

**v1: Keypair Class**
```typescript
const keypair = Keypair.generate(); // Sync
const pubkey = keypair.publicKey;   // PublicKey instance
const secret = keypair.secretKey;   // Uint8Array (exposed)
```
- Synchronous operations
- Class-based
- Secret key easily logged

**Kit: KeyPairSigner**
```typescript
const signer = await generateKeyPairSigner(); // Async
const address = signer.address;               // String
// Private key protected from logging
```
- Async (WebCrypto)
- Interface-based
- Leak-resistant design

### Transaction Building

**v1: Imperative/Mutable**
```typescript
const tx = new Transaction();
tx.add(instruction1);
tx.add(instruction2);
tx.recentBlockhash = blockhash;
tx.feePayer = payer;
tx.sign(keypair);
```
- Mutable transaction object
- Implicit ordering matters
- Easy to forget steps

**Kit: Functional/Immutable**
```typescript
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  tx => setTransactionMessageFeePayer(payer, tx),
  tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  tx => appendTransactionMessageInstructions([...], tx),
);
const signed = await signTransactionMessageWithSigners(tx);
```
- Immutable transformations
- Type system enforces completeness
- Compile-time validation

### Type Safety Examples

**v1: Runtime Errors**
```typescript
// This compiles but fails at runtime
const tx = new Transaction();
tx.add(SystemProgram.transfer({...}));
await sendTransaction(tx, [keypair]); // Error: missing blockhash
```

**Kit: Compile-time Errors**
```typescript
// This won't compile - TypeScript catches it
const tx = createTransactionMessage({ version: 0 });
await signTransactionMessageWithSigners(tx);
// Error: Transaction message must have fee payer and blockhash
```

### Subscriptions

**v1: Callback-based**
```typescript
const id = connection.onAccountChange(pubkey, callback);
// ...
connection.removeAccountChangeListener(id);
```
- Callback pattern
- Manual cleanup
- ID-based management

**Kit: AsyncIterator-based**
```typescript
const controller = new AbortController();
const notifications = await rpcSubscriptions
  .accountNotifications(address)
  .subscribe({ abortSignal: controller.signal });

for await (const notif of notifications) {
  // handle
}
controller.abort(); // cleanup
```
- Modern async patterns
- AbortController integration
- Better error handling

## Package Structure

### v1 (Monolithic)
```
@solana/web3.js
├── Connection
├── Transaction
├── PublicKey
├── Keypair
├── SystemProgram
├── BPF Loader
└── ... everything else
```
All code bundled together, no tree-shaking.

### Kit (Modular)
```
@solana/kit (umbrella)
├── @solana/accounts
├── @solana/addresses
├── @solana/codecs
├── @solana/errors
├── @solana/keys
├── @solana/programs
├── @solana/rpc
├── @solana/rpc-subscriptions
├── @solana/signers
├── @solana/transaction-messages
└── @solana/transactions

@solana-program/* (separate)
├── @solana-program/system
├── @solana-program/token
├── @solana-program/compute-budget
└── @solana-program/memo
```
Import only what you need.

## Code Size Impact

### Minimal App (Send SOL)

**v1 bundle**: ~180KB (entire web3.js included)
**Kit bundle**: ~45KB (only needed modules)

### Medium App (Token Operations)

**v1 bundle**: ~250KB
**Kit bundle**: ~80KB

### Full DeFi App

**v1 bundle**: ~400KB+
**Kit bundle**: ~150KB (depends on features)

## Migration Effort Estimate

| Codebase Size | Estimated Changes | Effort |
|---------------|-------------------|--------|
| Small (<1k LOC) | 20-50 | Low |
| Medium (1k-10k LOC) | 100-500 | Medium |
| Large (10k+ LOC) | 500+ | High |

### What Needs Changing

1. **Import statements** - All of them
2. **Connection creation** - 1 change + patterns
3. **Keypair handling** - Each usage
4. **PublicKey → Address** - Each usage
5. **Transaction building** - Complete rewrite
6. **Subscriptions** - Pattern change
7. **Error handling** - Different error types
8. **Tests** - May need significant updates

## When v1 is Still Better

1. **Learning curve**: v1 is more familiar OOP style
2. **Documentation**: More tutorials/examples for v1
3. **Anchor integration**: v1 is required
4. **Quick prototypes**: Faster to write
5. **Existing codebase**: Migration cost may not be worth it

## When Kit is Better

1. **Production apps**: Better performance
2. **Browser apps**: Smaller bundles
3. **Type safety**: Catch errors early
4. **Custom RPC needs**: Advanced transport
5. **New projects**: Future-proof
6. **Security**: Leak-resistant keys

## Summary Decision Matrix

| Priority | Recommendation |
|----------|----------------|
| Performance | Kit |
| Bundle Size | Kit |
| Type Safety | Kit |
| Learning Curve | v1 |
| Documentation | v1 |
| Anchor Support | v1 |
| Future-proofing | Kit |
| Existing Codebase | Depends on ROI |
