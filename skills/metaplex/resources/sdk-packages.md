# Metaplex SDK Packages

Complete reference of all Metaplex NPM packages for JavaScript/TypeScript development.

## Core Framework

### Umi (Required for all SDKs)

```bash
npm install @metaplex-foundation/umi @metaplex-foundation/umi-bundle-defaults
```

| Package | Description |
|---------|-------------|
| `@metaplex-foundation/umi` | Core Umi framework interfaces |
| `@metaplex-foundation/umi-bundle-defaults` | Default implementations bundle |

### Umi Plugins

```bash
# Wallet adapters
npm install @metaplex-foundation/umi-signer-wallet-adapters

# File uploaders
npm install @metaplex-foundation/umi-uploader-irys       # Arweave via Irys
npm install @metaplex-foundation/umi-uploader-nft-storage # NFT.Storage
npm install @metaplex-foundation/umi-uploader-aws        # AWS S3

# Utilities
npm install @metaplex-foundation/umi-web3js-adapters     # web3.js compatibility
```

## NFT Standards

### MPL Core (Recommended)

```bash
npm install @metaplex-foundation/mpl-core
```

| Package | Description | TypeDoc |
|---------|-------------|---------|
| `@metaplex-foundation/mpl-core` | Core NFT SDK | [mpl-core.typedoc.metaplex.com](https://mpl-core.typedoc.metaplex.com) |

### Token Metadata

```bash
npm install @metaplex-foundation/mpl-token-metadata
```

| Package | Description | TypeDoc |
|---------|-------------|---------|
| `@metaplex-foundation/mpl-token-metadata` | Token Metadata SDK | [mpl-token-metadata.typedoc.metaplex.com](https://mpl-token-metadata.typedoc.metaplex.com) |

### Bubblegum (Compressed NFTs)

```bash
npm install @metaplex-foundation/mpl-bubblegum
```

| Package | Description | TypeDoc |
|---------|-------------|---------|
| `@metaplex-foundation/mpl-bubblegum` | Compressed NFT SDK | [mpl-bubblegum.typedoc.metaplex.com](https://mpl-bubblegum.typedoc.metaplex.com) |

## Minting & Distribution

### Candy Machine (Token Metadata NFTs)

```bash
npm install @metaplex-foundation/mpl-candy-machine
```

| Package | Description |
|---------|-------------|
| `@metaplex-foundation/mpl-candy-machine` | Candy Machine V3 SDK |

### Core Candy Machine (Core Assets)

```bash
npm install @metaplex-foundation/mpl-core-candy-machine
```

| Package | Description |
|---------|-------------|
| `@metaplex-foundation/mpl-core-candy-machine` | Core Candy Machine SDK |

## Token Launches

### Genesis

```bash
npm install @metaplex-foundation/mpl-genesis
```

| Package | Description |
|---------|-------------|
| `@metaplex-foundation/mpl-genesis` | Token launch platform SDK |

## Utilities

### MPL-Hybrid (MPL-404)

```bash
npm install @metaplex-foundation/mpl-hybrid
```

| Package | Description |
|---------|-------------|
| `@metaplex-foundation/mpl-hybrid` | Token/NFT swap SDK |

### Inscriptions

```bash
npm install @metaplex-foundation/mpl-inscription
```

| Package | Description |
|---------|-------------|
| `@metaplex-foundation/mpl-inscription` | On-chain storage SDK |

### DAS API

```bash
npm install @metaplex-foundation/digital-asset-standard-api
```

| Package | Description |
|---------|-------------|
| `@metaplex-foundation/digital-asset-standard-api` | DAS API client |

## Complete Installation

### For Core NFT Projects

```bash
npm install \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults \
  @metaplex-foundation/mpl-core \
  @metaplex-foundation/umi-uploader-irys \
  @metaplex-foundation/digital-asset-standard-api
```

### For Token Metadata Projects

```bash
npm install \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults \
  @metaplex-foundation/mpl-token-metadata \
  @metaplex-foundation/umi-uploader-irys
```

### For Compressed NFT Projects

```bash
npm install \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults \
  @metaplex-foundation/mpl-bubblegum \
  @metaplex-foundation/mpl-token-metadata \
  @metaplex-foundation/digital-asset-standard-api
```

### For Collection Launches (Candy Machine)

```bash
npm install \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults \
  @metaplex-foundation/mpl-candy-machine \
  @metaplex-foundation/mpl-token-metadata \
  @metaplex-foundation/umi-uploader-irys
```

### For Token Launches (Genesis)

```bash
npm install \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults \
  @metaplex-foundation/mpl-genesis \
  @metaplex-foundation/mpl-token-metadata
```

## Rust Crates

For Rust/Anchor development:

| Crate | Description |
|-------|-------------|
| `mpl-core` | Core program crate |
| `mpl-token-metadata` | Token Metadata crate |
| `mpl-bubblegum` | Bubblegum crate |
| `mpl-candy-machine-core` | Candy Machine crate |

```toml
# Cargo.toml
[dependencies]
mpl-core = "0.7"
mpl-token-metadata = "4.1"
mpl-bubblegum = "1.4"
```

## Version Compatibility

Ensure version compatibility across packages:

```json
{
  "dependencies": {
    "@metaplex-foundation/umi": "^0.9.0",
    "@metaplex-foundation/umi-bundle-defaults": "^0.9.0",
    "@metaplex-foundation/mpl-core": "^1.0.0",
    "@metaplex-foundation/mpl-token-metadata": "^3.0.0",
    "@metaplex-foundation/mpl-bubblegum": "^4.0.0",
    "@solana/web3.js": "^1.91.0"
  }
}
```

## Legacy SDK (Deprecated)

The old `@metaplex-foundation/js` SDK is deprecated. Migrate to Umi-based SDKs.

```bash
# Deprecated - do not use for new projects
npm install @metaplex-foundation/js  # DEPRECATED
```
