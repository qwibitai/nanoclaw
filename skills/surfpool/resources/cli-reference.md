# Surfpool CLI Reference

Complete reference for Surfpool command-line interface.

## Installation

### Automated Installer

```bash
curl -sL https://run.surfpool.run/ | bash
```

### Homebrew (macOS)

```bash
brew install txtx/taps/surfpool
```

### From Source

```bash
git clone https://github.com/txtx/surfpool.git
cd surfpool
cargo surfpool-install
```

### Docker

```bash
docker pull surfpool/surfpool
```

## Commands

### surfpool start

Start the local Surfnet network simulator.

```bash
surfpool start [OPTIONS]
```

#### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--manifest-file-path` | `-m` | `./Surfpool.toml` | Path to manifest file |
| `--port` | `-p` | `8899` | Simnet RPC port |
| `--host` | `-o` | `127.0.0.1` | Simnet host address |
| `--slot-time` | `-s` | `400` | Slot time in milliseconds |
| `--rpc-url` | `-u` | `https://api.mainnet-beta.solana.com` | Source RPC URL |
| `--no-tui` | - | - | Display logs instead of terminal UI |
| `--debug` | - | - | Include debug logs |
| `--no-deploy` | - | - | Disable auto program deployment |
| `--runbook` | `-r` | `deployment` | Runbooks to execute |
| `--airdrop` | `-a` | - | Pubkeys to airdrop SOL |
| `--airdrop-amount` | `-q` | `10000000000000` | Airdrop amount (lamports) |
| `--airdrop-keypair-path` | `-k` | - | Keypair path for airdrop |
| `--no-explorer` | - | - | Disable Surfpool Studio |
| `--unsupervised` | `-u` | - | Run runbooks automatically |

#### Examples

```bash
# Basic start
surfpool start

# Start with custom port
surfpool start -p 9999

# Start with devnet as source
surfpool start -u https://api.devnet.solana.com

# Start without UI (for CI/CD)
surfpool start --no-tui

# Start with airdrop
surfpool start -a "YourPubkey..." -q 100000000000

# Start with multiple runbooks
surfpool start -r deployment -r initialize -r setup

# Start in unsupervised mode
surfpool start --unsupervised

# Start with faster slots (100ms)
surfpool start -s 100

# Start with debug logging
surfpool start --debug
```

---

### surfpool version

Display version information.

```bash
surfpool version
```

**Output:**
```
Surfpool v1.0.0
Solana Core: 1.18.x
Feature Set: 123456789
```

---

### surfpool help

Display help information.

```bash
surfpool help
surfpool help start
surfpool start --help
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SURFPOOL_RPC_URL` | Default source RPC URL |
| `SURFPOOL_SLOT_TIME` | Default slot time |
| `SURFPOOL_PORT` | Default RPC port |
| `SURFPOOL_HOST` | Default host address |

---

## Configuration File

### Surfpool.toml

Default location: `./Surfpool.toml`

```toml
# Network configuration
[network]
slot_time = 400           # Slot time in ms
epoch_duration = 432000   # Slots per epoch
rpc_url = "https://api.mainnet-beta.solana.com"

# Behavior settings
[behavior]
genesis = false           # Start from genesis
point_fork = true         # Fork from mainnet point

# Account pre-loading
[accounts]
clone = [
  # List of accounts to pre-clone from mainnet
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
]

# Program deployment
[programs]
deploy = [
  # Paths to programs to auto-deploy
  "./target/deploy/my_program.so",
]

# Airdrop configuration
[airdrop]
addresses = []
amount = 10000000000000   # 10,000 SOL in lamports

# Runbook configuration
[runbooks]
default = "deployment"
unsupervised = false
```

### Example Configurations

#### Minimal Configuration

```toml
[network]
rpc_url = "https://api.mainnet-beta.solana.com"
```

#### Anchor Project

```toml
[network]
slot_time = 400
rpc_url = "https://api.mainnet-beta.solana.com"

[programs]
deploy = ["./target/deploy/*.so"]

[airdrop]
addresses = ["./keypairs/deployer.json"]
amount = 100000000000
```

#### Fast Testing

```toml
[network]
slot_time = 50            # Fast slots for quick tests
rpc_url = "https://api.mainnet-beta.solana.com"

[behavior]
genesis = true            # Start fresh each time
```

#### Production-like Testing

```toml
[network]
slot_time = 400
epoch_duration = 432000
rpc_url = "https://api.mainnet-beta.solana.com"

[accounts]
clone = [
  # Clone all relevant mainnet accounts
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  # Jupiter
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  # Orca
]

[behavior]
point_fork = true
```

---

## Docker Usage

### Basic Run

```bash
docker run -p 8899:8899 -p 18488:18488 surfpool/surfpool
```

### With Configuration

```bash
docker run -p 8899:8899 -p 18488:18488 \
  -v $(pwd)/Surfpool.toml:/app/Surfpool.toml \
  surfpool/surfpool start -m /app/Surfpool.toml
```

### With Programs

```bash
docker run -p 8899:8899 -p 18488:18488 \
  -v $(pwd)/target/deploy:/app/programs \
  surfpool/surfpool start
```

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'
services:
  surfpool:
    image: surfpool/surfpool
    ports:
      - "8899:8899"
      - "8900:8900"
      - "18488:18488"
    volumes:
      - ./Surfpool.toml:/app/Surfpool.toml
      - ./target/deploy:/app/programs
    command: start -m /app/Surfpool.toml --no-tui
```

---

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Surfpool
        run: curl -sL https://run.surfpool.run/ | bash

      - name: Start Surfpool
        run: surfpool start --no-tui &

      - name: Wait for Surfpool
        run: sleep 5

      - name: Run Tests
        run: anchor test --skip-local-validator
```

### GitLab CI

```yaml
# .gitlab-ci.yml
test:
  image: rust:latest
  services:
    - surfpool/surfpool
  script:
    - anchor test --skip-local-validator
```

---

## Troubleshooting CLI

### Port Already in Use

```bash
# Check what's using port 8899
lsof -i :8899

# Kill existing process
kill -9 $(lsof -t -i:8899)

# Or use different port
surfpool start -p 9999
```

### RPC Connection Failed

```bash
# Check RPC URL is accessible
curl -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
  https://api.mainnet-beta.solana.com

# Use alternative RPC
surfpool start -u https://your-rpc-endpoint.com
```

### Slow Startup

```bash
# Skip account pre-loading
surfpool start --no-deploy

# Use genesis mode (no mainnet fork)
# Edit Surfpool.toml: genesis = true
```

### Memory Issues

```bash
# Reduce slot time (fewer blocks cached)
surfpool start -s 1000

# Or use Docker with memory limits
docker run -m 4g surfpool/surfpool
```
