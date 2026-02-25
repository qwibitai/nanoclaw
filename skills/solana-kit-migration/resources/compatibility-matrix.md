# SDK Compatibility Matrix

Overview of which Solana SDKs and libraries support @solana/kit vs @solana/web3.js (v1).

## Core Libraries

| Package | v1 Support | Kit Support | Notes |
|---------|------------|-------------|-------|
| `@solana/web3.js` (1.x) | Native | N/A | Legacy, maintenance mode |
| `@solana/kit` | Via compat | Native | New standard |
| `@solana/compat` | Bridge | Bridge | Interoperability layer |

## Program Libraries

| Package | v1 Support | Kit Support | Notes |
|---------|------------|-------------|-------|
| `@solana/spl-token` | ✅ Native | ⚠️ Use alternatives | Use `@solana-program/token` for Kit |
| `@solana-program/system` | N/A | ✅ Native | Kit-native system program |
| `@solana-program/token` | N/A | ✅ Native | Kit-native token program |
| `@solana-program/token-2022` | N/A | ✅ Native | Kit-native Token-2022 |
| `@solana-program/compute-budget` | N/A | ✅ Native | Kit-native compute budget |
| `@solana-program/memo` | N/A | ✅ Native | Kit-native memo program |
| `@solana-program/associated-token-account` | N/A | ✅ Native | Kit-native ATA |

## Framework Support

| Framework | v1 Support | Kit Support | Notes |
|-----------|------------|-------------|-------|
| Anchor (`@coral-xyz/anchor`) | ✅ Native | ❌ Not yet | Wait for Anchor update |
| Anchor (legacy `@project-serum/anchor`) | ✅ Native | ❌ No | Deprecated, won't support Kit |

## Wallet Adapters

| Package | v1 Support | Kit Support | Notes |
|---------|------------|-------------|-------|
| `@solana/wallet-adapter-base` | ✅ Native | ⚠️ Partial | Check latest version |
| `@solana/wallet-adapter-react` | ✅ Native | ⚠️ Partial | Migration in progress |
| `@solana/wallet-adapter-wallets` | ✅ Native | ⚠️ Partial | Varies by wallet |

## Third-Party SDKs

| SDK | v1 Support | Kit Support | Notes |
|-----|------------|-------------|-------|
| Metaplex (`@metaplex-foundation/js`) | ✅ Native | ❌ Not yet | Check for updates |
| Metaplex Umi | ✅ Via adapters | ✅ Via adapters | Abstraction layer |
| Jupiter SDK | ✅ Native | ⚠️ Partial | Check latest docs |
| Raydium SDK | ✅ Native | ❌ Not yet | Check for updates |
| Orca (`@orca-so/whirlpools-sdk`) | ✅ Native | ✅ Migrated | One of first to migrate |
| Tensor Toolkit | ✅ Native | ✅ Migrated | Early adopter |
| Lighthouse SDK | ✅ Native | ✅ Migrated | Early adopter |
| Helius SDK | ✅ Native | ⚠️ Partial | Check latest docs |
| Triton One | ✅ Native | ✅ Native | Supports both |

## Helper Libraries

| Package | v1 Support | Kit Support | Notes |
|---------|------------|-------------|-------|
| `gill` | N/A | ✅ Built on Kit | High-level Kit wrapper |
| `@solana/buffer-layout` | ✅ Works | ⚠️ Not needed | Kit has built-in codecs |
| `@solana/codecs` | N/A | ✅ Native | Part of Kit |
| `borsh` / `@coral-xyz/borsh` | ✅ Common | ⚠️ Use codecs | Kit has `@solana/codecs` |

## Build Tools & Testing

| Tool | v1 Support | Kit Support | Notes |
|------|------------|-------------|-------|
| `solana-bankrun` | ✅ Native | ⚠️ Partial | Check version |
| `solana-test-validator` | ✅ Works | ✅ Works | Independent of SDK |
| `@solana/web3.js` mocks | ✅ Native | N/A | Need Kit-specific mocks |

## Migration Status Legend

- ✅ **Full Support**: Works natively, recommended
- ⚠️ **Partial/In Progress**: May work but check docs
- ❌ **Not Supported**: Use v1 or wait for migration
- N/A: Not applicable

## Checking SDK Compatibility

Before migrating, check if your dependencies support Kit:

```bash
# Check package.json for peer dependencies
cat node_modules/<package>/package.json | grep -A5 '"peerDependencies"'

# Look for Kit-specific packages
npm info <package> | grep -E "@solana/(kit|web3)"
```

## Recommended Approach by Use Case

### New DeFi App (No Anchor)
```
Recommended: @solana/kit
- Better performance
- Smaller bundles
- Type safety
- Use: @solana-program/* packages
```

### New NFT App
```
Recommended: Wait or use v1
- Metaplex not fully migrated
- Can use Umi for abstraction
- Check Metaplex roadmap
```

### Anchor-based App
```
Recommended: @solana/web3.js v1
- Anchor requires v1
- Wait for Anchor Kit support
- Can use hybrid approach for non-Anchor parts
```

### Wallet Integration App
```
Recommended: Check wallet-adapter status
- Wallet adapter migration in progress
- May need hybrid approach
- Use @solana/compat for bridging
```

### Trading Bot / High Performance
```
Recommended: @solana/kit
- ~200ms faster confirmations
- Better RPC handling
- Custom transport strategies
```

### Browser dApp (Bundle Size Critical)
```
Recommended: @solana/kit
- Tree-shakeable
- 26%+ smaller bundles
- No external dependencies
```
