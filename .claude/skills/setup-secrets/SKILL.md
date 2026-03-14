# Setup Secrets Encryption (sops + age)

If you run NanoClaw on a VPS, you almost certainly have `.env` files sitting on disk
containing API keys, admin passwords, and OAuth tokens. These files end up in:

- **Backups** — your S3 bucket holds a copy in plaintext
- **Shell history** — `cat .env` or `grep .env` commands leave traces
- **Accidental git commits** — one slip and secrets are in your repo history forever
- **Side-channel exposure** — any process running as your user can read them

This skill solves all of that. It encrypts each project's `.env` into a `secrets.yaml`
using [sops](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age) —
two widely trusted, open-source tools used by teams at Google, Cloudflare, and others.
The result: secrets are encrypted at rest, safe to back up to S3, and safe to commit
to git. They're decrypted in memory only, on demand, when a service starts.

**No external service required.** No Vault, no Doppler, no cloud secrets manager.
Your encryption key lives locally on your VPS (`~/.age/key.txt`). You decide where
to back it up — a password manager, a USB drive, another device. If you already
use the `/add-s3-storage` skill, this integrates cleanly with your existing backup.

### What changes for each project

| Before | After |
|--------|-------|
| `docker compose up -d` | `./start.sh` (calls sops-run.sh internally) |
| `env_file: .env` in compose | `environment: - KEY` pass-through |
| `.env` — plaintext on disk | `secrets.yaml` — encrypted at rest |
| `.env` in S3 backup | `secrets.yaml` in S3 backup (safe) |

**Your `.env` files stay on disk** until you're confident everything works. Delete them
when ready — typically after running for a few days without issues.

### Companion scripts (in this skill directory)

| File | Purpose |
|------|---------|
| `sops-run.sh` | Copy to `~/sops-run.sh` — decrypts secrets and runs any command with them as env vars |
| `env_to_yaml.py` | Used during setup — converts `.env` format to YAML, stripping `.env` quoting conventions |

---

## Phase 1: Install age + sops

Check what's already installed:

```bash
~/.local/bin/age --version 2>/dev/null || echo "age: NOT INSTALLED"
~/.local/bin/sops --version 2>/dev/null || echo "sops: NOT INSTALLED"
```

Install age (latest stable):

```bash
AGE_VERSION=$(curl -s https://api.github.com/repos/FiloSottile/age/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
curl -fsSL "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-amd64.tar.gz" -o /tmp/age.tar.gz
tar -xzf /tmp/age.tar.gz -C /tmp
cp /tmp/age/age /tmp/age/age-keygen ~/.local/bin/
chmod +x ~/.local/bin/age ~/.local/bin/age-keygen
rm -rf /tmp/age.tar.gz /tmp/age
~/.local/bin/age --version
```

Install sops (latest stable):

```bash
SOPS_VERSION=$(curl -s https://api.github.com/repos/getsops/sops/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
curl -fsSL "https://github.com/getsops/sops/releases/download/${SOPS_VERSION}/sops-${SOPS_VERSION}.linux.amd64" -o ~/.local/bin/sops
chmod +x ~/.local/bin/sops
~/.local/bin/sops --version
```

## Phase 2: Generate age keypair

Check if a keypair already exists:

```bash
[ -f ~/.age/key.txt ] && echo "EXISTS" || echo "NOT FOUND"
```

If not found, generate one:

```bash
mkdir -p ~/.age
~/.local/bin/age-keygen -o ~/.age/key.txt
chmod 600 ~/.age/key.txt
```

Show the public key (needed for Phase 3):

```bash
grep "^# public key:" ~/.age/key.txt
```

**Warn the user:** The private key at `~/.age/key.txt` must be backed up somewhere
safe before proceeding. If this VPS is lost or rebuilt without the key, all encrypted
secrets become permanently inaccessible. Suggested options: a password manager
(Bitwarden, 1Password, KeePass), a USB drive stored offline, or a trusted second device.

## Phase 3: Configure sops

Write `~/.sops.yaml` so sops automatically uses the age key for all encryption:

```bash
AGE_PUBKEY=$(grep "^# public key:" ~/.age/key.txt | awk '{print $NF}')
cat > ~/.sops.yaml <<EOF
creation_rules:
  - age: ${AGE_PUBKEY}
EOF
cat ~/.sops.yaml
```

## Phase 4: Install companion scripts

Copy the scripts that ship with this skill to the right locations:

```bash
SKILL_DIR="$(dirname "$0")"
cp "$SKILL_DIR/sops-run.sh" ~/sops-run.sh
chmod +x ~/sops-run.sh
cp "$SKILL_DIR/env_to_yaml.py" /tmp/env_to_yaml.py
```

If running this skill interactively (not from the skill directory), write the scripts
inline instead — see Appendix at the bottom of this file.

## Phase 5: Detect projects to encrypt

Ask the user which projects have `.env` files to encrypt. Or auto-detect:

```bash
find ~ -maxdepth 2 -name ".env" -not -path "*/node_modules/*" 2>/dev/null
```

For each project directory identified, run Phase 6.

## Phase 6: Encrypt each project's .env

For each `PROJECT_DIR` (e.g. `~/paycheck`, `~/janasuvidha`, `~/caddy`):

**Step 1:** Convert `.env` → YAML and encrypt:

```bash
SOPS_AGE_KEY_FILE=~/.age/key.txt \
  python3 /tmp/env_to_yaml.py "$PROJECT_DIR/.env" \
  | ~/.local/bin/sops --encrypt --input-type yaml --output-type yaml /dev/stdin \
  > "$PROJECT_DIR/secrets.yaml"
chmod 600 "$PROJECT_DIR/secrets.yaml"
```

**Step 2:** Verify encryption (should show sops-encrypted output, not plaintext):

```bash
head -5 "$PROJECT_DIR/secrets.yaml"
```

**Step 3:** Verify decryption works:

```bash
SOPS_AGE_KEY_FILE=~/.age/key.txt \
  ~/.local/bin/sops --decrypt "$PROJECT_DIR/secrets.yaml" | head -5
```

**Step 4:** Add to `.gitignore`:

```bash
grep -qxF 'secrets.yaml' "$PROJECT_DIR/.gitignore" 2>/dev/null || echo 'secrets.yaml' >> "$PROJECT_DIR/.gitignore"
grep -qxF '.env'         "$PROJECT_DIR/.gitignore" 2>/dev/null || echo '.env'         >> "$PROJECT_DIR/.gitignore"
```

Repeat for each project.

## Phase 7: Migrate docker-compose files

For each project using `docker compose`, migrate from `env_file:` to `environment:` pass-through.

**Before:**
```yaml
env_file:
  - .env
```

**After:**
```yaml
environment:   # injected via ~/sops-run.sh secrets.yaml
  - KEY_ONE
  - KEY_TWO
  - KEY_THREE
```

List the keys from the `.env` file to know what to add:

```bash
grep -v '^#' "$PROJECT_DIR/.env" | grep '=' | cut -d= -f1
```

> **Why this matters:** `env_file:` strips surrounding quotes from values (`KEY='val'` → `val`).
> `environment:` pass-through does not — it takes whatever the shell has. Since `sops-run.sh`
> injects clean values (already quote-stripped during encryption), this works correctly.
> Mixing the two approaches causes subtle value corruption.

## Phase 8: Create start.sh per project

For each docker-compose project, create a `start.sh` that injects secrets before starting:

```bash
cat > "$PROJECT_DIR/start.sh" << 'EOF'
#!/bin/bash
set -e
cd "$(dirname "$0")"
exec ~/sops-run.sh secrets.yaml docker compose up -d "$@"
EOF
chmod +x "$PROJECT_DIR/start.sh"
```

Usage going forward: `~/paycheck/start.sh` instead of `docker compose up -d`.

## Phase 9: Test

For each project, restart via `start.sh` and verify containers are up:

```bash
cd "$PROJECT_DIR" && ./start.sh
docker compose ps
```

Spot-check that env vars reached the container (replace with an actual key name):

```bash
docker exec <CONTAINER_NAME> env | grep KEY_ONE
```

If vars are empty, the container was started without sops-run.sh. Always use `./start.sh`.

## Phase 10: Update backup script (if using /add-s3-storage)

If you have `~/backup.sh` from the `/add-s3-storage` skill, add these lines to include
encrypted secrets and the sops wrapper in your backups:

```bash
# Encrypted secrets — safe to back up, they're encrypted at rest
for project in paycheck janasuvidha caddy nanoclaw; do
  [ -f $HOME/$project/secrets.yaml ] && \
    $RCLONE copyto $HOME/$project/secrets.yaml "s3:<BUCKET>/backups/secrets/${project}/secrets.yaml" --checksum 2>> "$LOG"
done

# sops wrapper and config
[ -f $HOME/sops-run.sh ] && $RCLONE copyto $HOME/sops-run.sh s3:<BUCKET>/backups/home/sops-run.sh --checksum 2>> "$LOG"
[ -f $HOME/.sops.yaml ]  && $RCLONE copyto $HOME/.sops.yaml  s3:<BUCKET>/backups/home/.sops.yaml  --checksum 2>> "$LOG"
# NOTE: ~/.age/key.txt (private key) must be backed up separately — password manager, USB, etc.
# Do NOT sync ~/.age/ to S3 — it contains your private key.
```

## Deleting .env files (when ready)

Run for a few days first to catch any edge cases. Once confident, delete the plaintext files:

```bash
rm ~/paycheck/.env
rm ~/janasuvidha/.env
rm ~/caddy/.env
# Keep any .env that a service reads directly via code (not docker-compose)
```

---

## Troubleshooting

**Container env vars are empty:**
Container was started without `sops-run.sh`. Run `./start.sh` instead of `docker compose up -d` directly.

**"failed to get the data key" when decrypting:**
`SOPS_AGE_KEY_FILE` is not set or points to the wrong file.
Check: `echo $SOPS_AGE_KEY_FILE` and `ls -l ~/.age/key.txt`

**"mac mismatch" or decryption error:**
The secrets.yaml was modified outside sops. Re-encrypt from the original `.env`.

**Re-encrypt after changing a secret:**
Edit the `.env` file, then re-run Phase 6 for that project. The old `secrets.yaml` is replaced.

**Cloudflare R2 per-bucket tokens — 403 on backup:**
Add `no_check_bucket = true` to `~/.config/rclone/rclone.conf` under your `[s3]` section.

**Check which keys are in a secrets.yaml without decrypting:**
```bash
grep -v '^ENC\[' secrets.yaml | grep -v '^sops:' | grep ':'
```

---

## Appendix: Inline script content

If copying from the skill directory isn't possible, write the scripts directly:

### sops-run.sh

```bash
cat > ~/sops-run.sh << 'EOF'
#!/bin/bash
# Usage: sops-run.sh <secrets.yaml> <command...>
set -e
SECRETS_FILE="$1"
shift
if [ -z "$SECRETS_FILE" ] || [ ! -f "$SECRETS_FILE" ]; then
  echo "Usage: sops-run.sh <secrets.yaml> <command...>" >&2
  exit 1
fi
export SOPS_AGE_KEY_FILE="$HOME/.age/key.txt"
exec "${HOME}/.local/bin/sops" exec-env "$SECRETS_FILE" "$*"
EOF
chmod +x ~/sops-run.sh
```

### env_to_yaml.py

```bash
cat > /tmp/env_to_yaml.py << 'PYEOF'
#!/usr/bin/env python3
import re, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    key, _, val = line.partition('=')
    val = re.sub(r'^([\'"])(.*)\1$', r'\2', val)
    val = val.replace('"', '\\"')
    print(f'{key}: "{val}"')
PYEOF
```
