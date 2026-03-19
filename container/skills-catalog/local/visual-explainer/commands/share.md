# Share Visual Explainer Page

Share a visual explainer HTML file instantly via Vercel. Returns a live URL with no authentication required.

## Usage

```
/share <file-path>
```

**Arguments:**
- `file-path` - Path to the HTML file to share (required)

**Examples:**
```
/share ~/.agent/diagrams/my-diagram.html
/share /tmp/visual-explainer-output.html
```

## How It Works

1. Copies your HTML file to a temp directory as `index.html`
2. Deploys via the vercel-deploy skill (no auth needed)
3. Returns a live URL immediately

## Requirements

- **vercel-deploy skill** - Should be pre-installed. If not: `pi install npm:vercel-deploy`

No Vercel account, Cloudflare account, or API keys needed. The deployment is "claimable" — you can transfer it to your Vercel account later if you want.

## Script Location

```bash
bash {{skill_dir}}/scripts/share.sh <file>
```

## Output

```
Sharing my-diagram.html...

✓ Shared successfully!

Live URL:  https://skill-deploy-abc123.vercel.app
Claim URL: https://vercel.com/claim-deployment?code=...
```

The script also outputs JSON for programmatic use:
```json
{"previewUrl":"https://...","claimUrl":"https://...","deploymentId":"...","projectId":"..."}
```

## Notes

- Deployments are **public** — anyone with the URL can view
- Preview deployments have a configurable retention period (default: 30 days)
- Each share creates a new deployment with a unique URL
