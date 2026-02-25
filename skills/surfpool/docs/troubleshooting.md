# Surfpool Troubleshooting Guide

Common issues and solutions when using Surfpool.

## Table of Contents

- [Installation Issues](#installation-issues)
- [Startup Issues](#startup-issues)
- [Connection Issues](#connection-issues)
- [Cheatcode Issues](#cheatcode-issues)
- [Performance Issues](#performance-issues)
- [Anchor Integration](#anchor-integration)

---

## Installation Issues

### Error: "Command not found: surfpool"

**Cause:** Surfpool not installed or not in PATH.

**Solutions:**

1. **Reinstall Surfpool:**
```bash
curl -sL https://run.surfpool.run/ | bash
```

2. **Check installation path:**
```bash
which surfpool
# Should output path like /usr/local/bin/surfpool
```

3. **Add to PATH manually:**
```bash
export PATH="$HOME/.local/bin:$PATH"
# Add to ~/.bashrc or ~/.zshrc for persistence
```

### Error: "Permission denied"

**Cause:** Installation script lacks execute permissions.

**Solution:**
```bash
curl -sL https://run.surfpool.run/ -o install.sh
chmod +x install.sh
./install.sh
```

### Homebrew: "Formula not found"

**Cause:** Tap not added.

**Solution:**
```bash
brew tap txtx/taps
brew install surfpool
```

---

## Startup Issues

### Error: "Port 8899 already in use"

**Cause:** Another process (solana-test-validator, previous Surfpool) using the port.

**Solutions:**

1. **Kill existing process:**
```bash
lsof -i :8899
kill -9 <PID>
```

2. **Use different port:**
```bash
surfpool start -p 9999
```

3. **Stop existing Surfpool:**
```bash
# If running in background
pkill surfpool
```

### Error: "Failed to connect to RPC"

**Cause:** Source RPC (mainnet) is unavailable or rate-limited.

**Solutions:**

1. **Check internet connection**

2. **Use different RPC endpoint:**
```bash
surfpool start -u https://api.devnet.solana.com
# Or your own RPC endpoint
surfpool start -u https://your-rpc.helius.dev
```

3. **Start in genesis mode (no mainnet fork):**
```toml
# Surfpool.toml
[behavior]
genesis = true
point_fork = false
```

### Error: "Surfpool.toml not found"

**Cause:** Running from wrong directory or config file missing.

**Solutions:**

1. **Specify config path:**
```bash
surfpool start -m /path/to/Surfpool.toml
```

2. **Run from project root:**
```bash
cd /path/to/your/project
surfpool start
```

3. **Create default config:**
```bash
touch Surfpool.toml
# Add minimal config
echo '[network]' >> Surfpool.toml
```

### TUI not displaying correctly

**Cause:** Terminal doesn't support TUI features.

**Solution:** Disable TUI:
```bash
surfpool start --no-tui
```

---

## Connection Issues

### Error: "Connection refused"

**Cause:** Surfpool not running or wrong endpoint.

**Solutions:**

1. **Verify Surfpool is running:**
```bash
ps aux | grep surfpool
```

2. **Check correct endpoint:**
```typescript
// Default endpoint
const connection = new Connection("http://127.0.0.1:8899");

// If using custom port
const connection = new Connection("http://127.0.0.1:9999");
```

3. **Wait for startup:**
```typescript
async function waitForSurfnet(connection, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await connection.getVersion();
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}
```

### WebSocket connection failed

**Cause:** Wrong WebSocket endpoint or not enabled.

**Solution:**
```typescript
// Use correct WS port (8900 by default)
const connection = new Connection("http://127.0.0.1:8899", {
  wsEndpoint: "ws://127.0.0.1:8900",
});
```

---

## Cheatcode Issues

### Error: "Method not found"

**Cause:** Cheatcode method name incorrect or not available.

**Solutions:**

1. **Check method name:** All cheatcodes start with `surfnet_`
```typescript
// Correct
await connection._rpcRequest("surfnet_setAccount", [...]);

// Wrong
await connection._rpcRequest("setAccount", [...]);
```

2. **Verify Surfpool version:**
```bash
surfpool version
```

### Error: "Invalid params"

**Cause:** Wrong parameter format for cheatcode.

**Solutions:**

1. **Check parameter types:**
```typescript
// Correct: pubkey as string
await connection._rpcRequest("surfnet_setAccount", [
  {
    pubkey: wallet.publicKey.toBase58(), // String
    lamports: 1000000000, // Number
  }
]);

// Wrong: pubkey as PublicKey object
await connection._rpcRequest("surfnet_setAccount", [
  {
    pubkey: wallet.publicKey, // This won't work
  }
]);
```

2. **Use BigInt for large amounts:**
```typescript
await connection._rpcRequest("surfnet_setTokenAccount", [
  {
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    update: {
      amount: "1000000000000000000", // String for large numbers
    }
  }
]);
```

### Cheatcode has no effect

**Cause:** Account was already loaded from mainnet.

**Solution:** Reset account first:
```typescript
// Reset to mainnet state, then override
await connection._rpcRequest("surfnet_resetAccount", [
  { pubkey: account.toBase58() }
]);

// Now set new state
await connection._rpcRequest("surfnet_setAccount", [
  { pubkey: account.toBase58(), lamports: newAmount }
]);
```

---

## Performance Issues

### Slow startup

**Cause:** Too many accounts being pre-loaded.

**Solutions:**

1. **Reduce pre-cloned accounts:**
```toml
# Surfpool.toml
[accounts]
clone = [
  # Only include essential accounts
]
```

2. **Use genesis mode for quick tests:**
```toml
[behavior]
genesis = true
```

3. **Disable Studio if not needed:**
```bash
surfpool start --no-explorer
```

### Slow transactions

**Cause:** Lazy-loading accounts from mainnet.

**Solutions:**

1. **Pre-clone frequently used accounts:**
```toml
[accounts]
clone = [
  "FrequentlyUsedAccount...",
]
```

2. **Use faster source RPC:**
```bash
surfpool start -u https://your-dedicated-rpc.com
```

### High memory usage

**Cause:** Too many accounts cached.

**Solutions:**

1. **Restart Surfpool periodically**

2. **Use Docker with memory limits:**
```bash
docker run -m 4g surfpool/surfpool
```

3. **Reset network between test suites:**
```typescript
afterAll(async () => {
  await connection._rpcRequest("surfnet_resetNetwork", []);
});
```

---

## Anchor Integration

### Programs not auto-deploying

**Cause:** Anchor project not detected or build not complete.

**Solutions:**

1. **Build first:**
```bash
anchor build
surfpool start
```

2. **Specify program path:**
```toml
# Surfpool.toml
[programs]
deploy = ["./target/deploy/my_program.so"]
```

3. **Check Anchor.toml exists** in project root

### IDL not registered

**Cause:** IDL not found or not linked.

**Solution:** Register IDL manually:
```typescript
import idl from "./target/idl/my_program.json";

await connection._rpcRequest("surfnet_registerIdl", [
  {
    programId: "MyProgramPubkey...",
    idl: idl,
  }
]);
```

### Test validator mismatch

**Cause:** Tests configured for solana-test-validator.

**Solution:** Update test configuration:
```typescript
// anchor.toml
[test]
startup_wait = 5000

// Or in tests
const provider = anchor.AnchorProvider.local("http://127.0.0.1:8899");
```

---

## Getting Help

If you're still stuck:

1. **Check official docs:** https://docs.surfpool.run
2. **Search GitHub issues:** https://github.com/txtx/surfpool/issues
3. **Join Discord:** https://discord.gg/surfpool
4. **Check logs:**
```bash
surfpool start --debug
```

---

## Quick Debug Checklist

- [ ] Is Surfpool running? (`ps aux | grep surfpool`)
- [ ] Correct port? (default: 8899)
- [ ] Correct RPC endpoint? (`http://127.0.0.1:8899`)
- [ ] Internet connection working? (for mainnet forking)
- [ ] Sufficient disk space?
- [ ] Using latest Surfpool version? (`surfpool version`)
- [ ] Surfpool.toml valid TOML syntax?
- [ ] Programs built? (`anchor build`)
