---
name: add-aws
description: Enable AWS CLI access inside agent containers. Covers awscli in the image, CA bundle wiring, credential mounting, and OneCLI proxy bypass.
---

# Add AWS Support

Gives agent containers access to the AWS CLI and your AWS credentials. The CLI binary (`aws`) is installed in the container image; your credentials and config are bind-mounted read-only from `~/.aws/` on the host.

## What this sets up

- `aws` at `/usr/local/bin/aws` inside every container
- `~/.aws/` (credentials, config, CA bundle) mounted read-only at `/home/node/.aws/`
- Custom CA bundle wired so `aws` trusts your root certificate (if needed)
- `NO_PROXY` bypass so AWS traffic skips the OneCLI credential proxy

## Pre-flight

### 1. Dockerfile: awscli + symlink

`container/Dockerfile` must install `awscli` via apt and symlink it:

```dockerfile
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ...
        awscli \
        ...
    && ln -s /usr/bin/aws /usr/local/bin/aws \
    ...
```

Debian bookworm's `awscli` package is v2 (`aws-cli/2.9.19`). The symlink puts it on the path expected by agents and scripts.

Check whether this is already in place:

```bash
grep -n "awscli\|/usr/local/bin/aws" container/Dockerfile
```

If both lines are present, skip to **Step 2**.

If not, add `awscli \` to the apt block and `&& ln -s /usr/bin/aws /usr/local/bin/aws \` after the apt block, then rebuild:

```bash
./container/build.sh
```

### 2. container-runner.ts: fixed AWS mount + NO_PROXY bypass

`src/container-runner.ts` needs two things:

**A. Fixed `~/.aws/` mount** — bypasses the mount security module (which blocks `.aws` for agent-requested mounts):

```bash
grep -n "awsDir\|\.aws" src/container-runner.ts
```

Expected:

```typescript
const awsDir = path.join(process.env.HOME ?? '/root', '.aws');
if (fs.existsSync(awsDir)) {
  mounts.push({ hostPath: awsDir, containerPath: '/home/node/.aws', readonly: true });
}
```

**B. NO_PROXY bypass for AWS endpoints** — OneCLI injects `HTTPS_PROXY` for all container traffic so it can intercept and inject credentials. AWS CLI re-signs TLS through this proxy and the proxy CA is not in `~/.aws/cacert.pem`, which causes `SSL: CERTIFICATE_VERIFY_FAILED`. The fix is to explicitly bypass the proxy for `*.amazonaws.com`:

```bash
grep -n "NO_PROXY\|awsBypass" src/container-runner.ts
```

Expected (added immediately after `onecli.applyContainerConfig`):

```typescript
const awsBypass = '.amazonaws.com,169.254.169.254';
args.push('-e', `NO_PROXY=${awsBypass}`);
args.push('-e', `no_proxy=${awsBypass}`);
```

Both uppercase and lowercase are set — Python `requests` (used by AWS CLI / botocore) checks the lowercase form; most other tools check uppercase.

If either is missing, add it and rebuild:

```bash
pnpm run build
```

## Credentials

### `~/.aws/credentials`

Standard AWS credentials file:

```ini
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

This file is mounted read-only at `/home/node/.aws/credentials` inside every container.

### `~/.aws/config`

```ini
[default]
region = us-east-1
output = json
```

If your environment requires a custom CA bundle (e.g., a corporate root CA), add:

```ini
ca_bundle = ~/.aws/cacert.pem
```

`~` expands to `/home/node` inside the container, which resolves to the mounted copy of `~/.aws/cacert.pem` — no container-specific path needed.

### CA bundle (`~/.aws/cacert.pem`)

If your AWS endpoints sit behind a corporate proxy or use a private certificate authority, obtain the root CA certificate in PEM format and save it as `~/.aws/cacert.pem`. Multiple certificates can be concatenated into one file.

Without this, `aws` calls will fail with `SSL: CERTIFICATE_VERIFY_FAILED`.

## Rebuild and restart

After any Dockerfile change:

```bash
./container/build.sh
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

After only a `container-runner.ts` change (no image change):

```bash
pnpm run build
systemctl --user restart nanoclaw
```

## Verify

Run `aws sts get-caller-identity` inside a container:

```bash
echo '{"prompt":"Run: aws sts get-caller-identity","groupFolder":"test","isMain":false}' | \
  docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  -v ~/.aws:/home/node/.aws:ro \
  nanoclaw-agent:latest
```

Expected output includes your AWS `Account`, `UserId`, and `Arn`.

Or test the binary directly:

```bash
docker run --rm \
  -v ~/.aws:/home/node/.aws:ro \
  --entrypoint /usr/local/bin/aws \
  nanoclaw-agent:latest --version
# aws-cli/2.x.x Python/3.x.x ...
```

## Troubleshooting

### `SSL: CERTIFICATE_VERIFY_FAILED` — self-signed certificate in certificate chain

**Root cause:** OneCLI injects `HTTPS_PROXY` for all container traffic. When AWS CLI connects to `*.amazonaws.com`, the OneCLI proxy intercepts and re-signs the TLS with its own CA cert. That CA isn't in `~/.aws/cacert.pem`, so verification fails.

**Fix:** Ensure `NO_PROXY` / `no_proxy` are set to `.amazonaws.com,169.254.169.254` in `container-runner.ts` after `onecli.applyContainerConfig` (see Pre-flight step 2B above). This makes AWS CLI connect directly, bypassing the OneCLI proxy entirely.

**Check it's in place:**
```bash
grep -n "awsBypass\|NO_PROXY" src/container-runner.ts
```

### `SSL: CERTIFICATE_VERIFY_FAILED` — unable to get local issuer certificate

Your CA bundle is missing the standard Amazon Root CAs. Check `~/.aws/cacert.pem` contains at least `Amazon Root CA 1–4`:

```bash
python3 -c "
from cryptography import x509; from cryptography.hazmat.backends import default_backend; import re
data = open('/root/.aws/cacert.pem','rb').read()
for pem in re.findall(b'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', data, re.DOTALL):
    c = x509.load_pem_x509_certificate(pem, default_backend())
    cn = c.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)
    if cn and 'amazon' in cn[0].value.lower(): print(cn[0].value)
"
```

If the Amazon Root CAs are missing, concatenate them from the system bundle:
```bash
grep -A 30 "Amazon Root CA" /etc/ssl/certs/ca-certificates.crt >> ~/.aws/cacert.pem
```

### `Unable to locate credentials`

`~/.aws/credentials` is missing or empty. Confirm the file exists on the host and that the fixed mount in `container-runner.ts` is present (check `grep awsDir src/container-runner.ts`).

### `aws: command not found`

The Dockerfile change wasn't picked up. Confirm `grep awscli container/Dockerfile` shows the package, then run `./container/build.sh` and restart the service.

### `No such file or directory: /usr/local/bin/aws`

The symlink is missing. Add `&& ln -s /usr/bin/aws /usr/local/bin/aws \` to the Dockerfile apt block and rebuild.
