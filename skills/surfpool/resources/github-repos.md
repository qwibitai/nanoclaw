# Surfpool GitHub Repositories

Official repositories for Surfpool development environment.

## Main Repository

### txtx/surfpool

The primary Surfpool repository containing the complete development environment.

| Property | Value |
|----------|-------|
| URL | https://github.com/txtx/surfpool |
| Language | Rust (99.9%) |
| License | Apache-2.0 |
| Stars | 460+ |
| Forks | 100+ |

**Description:** Drop-in replacement for solana-test-validator with mainnet forking, Infrastructure as Code, and developer tools.

**Key Features:**
- Local network simulation with mainnet state
- Cheatcodes for state manipulation
- Infrastructure as Code (txtx DSL)
- IDL-to-SQL engine
- Surfpool Studio dashboard

**Installation:**
```bash
# Automated installer
curl -sL https://run.surfpool.run/ | bash

# Homebrew
brew install txtx/taps/surfpool

# From source
git clone https://github.com/txtx/surfpool.git
cd surfpool
cargo surfpool-install
```

---

## Related Repositories

### txtx/txtx

The txtx DSL engine that powers Surfpool's Infrastructure as Code.

| Property | Value |
|----------|-------|
| URL | https://github.com/txtx/txtx |
| Language | Rust |
| Purpose | Infrastructure as Code runtime |

**Description:** Non-Turing complete configuration language inspired by Terraform/HCL for defining deployment workflows.

---

## Documentation

### Official Documentation

| Resource | URL |
|----------|-----|
| Main Docs | https://docs.surfpool.run |
| Website | https://surfpool.run |
| API Reference | https://docs.surfpool.run/rpc |

### Video Tutorials

| Series | Platform |
|--------|----------|
| Surfpool 101 | [Blueshift](https://learn.blueshift.gg/en/courses/testing-with-surfpool/surfpool-101) |

---

## Community

### Support Channels

| Platform | Link |
|----------|------|
| Discord | https://discord.gg/surfpool |
| Twitter/X | [@surfaboratory](https://twitter.com/surfaboratory) |
| Telegram | Announcements channel |

### Contributing

Contributions are welcome via GitHub Issues and Pull Requests. Look for issues labeled "help wanted" for community opportunities.

**Contribution Guidelines:**
1. Fork the repository
2. Create a feature branch
3. Submit a pull request
4. Follow Rust coding standards

---

## Docker Images

### Official Docker Hub

| Image | Tag | Description |
|-------|-----|-------------|
| `surfpool/surfpool` | `latest` | Latest stable release |
| `surfpool/surfpool` | `v1.0.0` | Specific version |

**Usage:**
```bash
docker pull surfpool/surfpool
docker run -p 8899:8899 -p 18488:18488 surfpool/surfpool
```

---

## Crates.io Packages

### surfpool-cli

| Property | Value |
|----------|-------|
| URL | https://crates.io/crates/surfpool-cli |
| Language | Rust |

### surfpool-core

| Property | Value |
|----------|-------|
| URL | https://crates.io/crates/surfpool-core |
| Language | Rust |

**Installation via Cargo:**
```bash
cargo install surfpool-cli
```

---

## Related Projects

### LiteSVM

Lightweight Solana VM that Surfpool uses as a wrapper.

### Solana SVM API

The underlying Solana Virtual Machine API that Surfpool builds upon.

---

## Quick Links

| Resource | URL |
|----------|-----|
| GitHub Issues | https://github.com/txtx/surfpool/issues |
| Releases | https://github.com/txtx/surfpool/releases |
| Changelog | https://github.com/txtx/surfpool/blob/main/CHANGELOG.md |
| License | https://github.com/txtx/surfpool/blob/main/LICENSE |
