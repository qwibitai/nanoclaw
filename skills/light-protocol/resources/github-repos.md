# Light Protocol GitHub Repositories

## Official Repositories

### Main Protocol Repository

**[Lightprotocol/light-protocol](https://github.com/Lightprotocol/light-protocol)**

The main repository containing the ZK Compression Protocol for Solana.

| Component | Description |
|-----------|-------------|
| `programs/` | Solana smart contract programs |
| `prover/` | Zero-knowledge proof generation |
| `js/` | JavaScript/TypeScript SDK libraries |
| `cli/` | Command-line interface tools |
| `program-tests/` | Integration tests |
| `sdk-tests/` | SDK testing suite |
| `forester/` | Utility services |
| `sparse-merkle-tree/` | Cryptographic data structure |

**Key files:**
- [Light Paper v0.1.0](https://github.com/Lightprotocol/light-protocol/blob/main/light-paper-v0.1.0.pdf) - Technical whitepaper
- [API Documentation](https://github.com/Lightprotocol/light-protocol/blob/main/docs/api-reference.md)

---

### Example Applications

#### Node.js Client Example

**[Lightprotocol/example-nodejs-client](https://github.com/Lightprotocol/example-nodejs-client)**

CommonJS script demonstrating basic compression/decompression and transfer operations.

```bash
# Clone and setup
git clone https://github.com/Lightprotocol/example-nodejs-client
cd example-nodejs-client
npm install

# Configure environment
cp .env.example .env
# Edit .env with your RPC_ENDPOINT and PAYER_KEYPAIR

# Run examples
npm run mint-spl      # Create SPL tokens
npm run compress      # Execute compression
```

---

#### Web Client Example

**[Lightprotocol/example-web-client](https://github.com/Lightprotocol/example-web-client)**

Web application example demonstrating Light Protocol integration in browser environments.

Features:
- React/Next.js integration
- Wallet adapter support
- Compressed token operations UI

---

## SDK Source Code

### TypeScript SDK

Located in the main repository under `js/`:

| Package | Path | Description |
|---------|------|-------------|
| stateless.js | `js/stateless.js/` | Core SDK |
| compressed-token | `js/compressed-token/` | Token operations |

**stateless.js README:**
```
https://github.com/Lightprotocol/light-protocol/blob/main/js/stateless.js/README.md
```

---

### Rust SDK

| Crate | Path | Description |
|-------|------|-------------|
| light-sdk | `sdk/` | On-chain program development |
| light-client | `client/` | Rust client SDK |
| light-program-test | `program-test/` | Testing framework |

---

## Security Audits

Light Protocol has undergone multiple security audits:

| Auditor | Focus | Status |
|---------|-------|--------|
| OtterSec | Program audit | Completed |
| Neodyme | Program audit | Completed |
| Zellic | Program audit | Completed |
| Reilabs | Formal circuit verification | Completed |

Audit reports are available in the main repository.

---

## Related Resources

### Documentation

- **Official Docs**: [zkcompression.com](https://www.zkcompression.com)
- **API Reference**: [zkcompression.com/developers](https://www.zkcompression.com/developers)

### Community

- **Discord (Light Protocol)**: [discord.gg/lightprotocol](https://discord.gg/lightprotocol)
- **Discord (Helius)**: [discord.gg/helius](https://discord.gg/helius) - RPC provider support

### NPM Packages

- [@lightprotocol/stateless.js](https://www.npmjs.com/package/@lightprotocol/stateless.js)
- [@lightprotocol/compressed-token](https://www.npmjs.com/package/@lightprotocol/compressed-token)
- [@lightprotocol/zk-compression-cli](https://www.npmjs.com/package/@lightprotocol/zk-compression-cli)

### Crates.io

- [light-sdk](https://crates.io/crates/light-sdk)
- [light-client](https://crates.io/crates/light-client)

---

## Contributing

The Light Protocol welcomes contributions:

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

See [CONTRIBUTING.md](https://github.com/Lightprotocol/light-protocol/blob/main/CONTRIBUTING.md) for guidelines.

**License:** Apache 2.0
