---
name: github-actions
description: Create and manage GitHub Actions workflows for CI/CD, automated testing, deployments, and repository automation. Use when asked to "set up CI/CD", "auto-deploy on push", "run tests automatically", "create a GitHub workflow", or "automate my builds".
allowed-tools: Bash
---

# GitHub Actions Workflows

## Common Workflow Patterns

### CI only (Node.js) — run tests on every push/PR

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

### CI + Deploy to Vercel — test then deploy on push to main

```yaml
name: Deploy to Vercel
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - name: Run tests
        run: npm test --if-present
      - name: Deploy to Vercel
        run: npx vercel --prod --token=${{ secrets.VERCEL_TOKEN }} --yes
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

## Creating a Workflow File

```bash
# Create .github/workflows/ directory
mkdir -p .github/workflows

# Write the workflow file
cat > .github/workflows/deploy.yml <<'WORKFLOW'
name: Deploy to Vercel
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - name: Run tests
        run: npm test --if-present
      - name: Deploy to Vercel
        run: npx vercel --prod --token=${{ secrets.VERCEL_TOKEN }} --yes
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
WORKFLOW

# Commit and push
git add .github/workflows/
git commit -m "Add CI/CD workflow"
git push
```

## Storing Secrets

Always use `gh secret set` to store secrets — never hardcode them in workflow files.

```bash
# From environment variable
echo "$MY_TOKEN" | gh secret set SECRET_NAME --repo owner/repo

# Interactive (prompts for value)
gh secret set SECRET_NAME --repo owner/repo
```

## Getting Vercel IDs

Do a manual deploy first, then read the generated project config:

```bash
# Do a manual deploy first
npx vercel --yes

# Then read the project IDs
cat .vercel/project.json
# → {"orgId": "xxx", "projectId": "yyy"}

# Store them as secrets
echo "xxx" | gh secret set VERCEL_ORG_ID --repo owner/repo
echo "yyy" | gh secret set VERCEL_PROJECT_ID --repo owner/repo
```

Also store your Vercel token:

```bash
# Get token from https://vercel.com/account/tokens
echo "$VERCEL_TOKEN" | gh secret set VERCEL_TOKEN --repo owner/repo
```

## Checking Workflow Status

```bash
gh run list --limit 5
gh run view <run-id>
gh run view <run-id> --log  # See full logs
```

## Common Errors

- **Secret not found** — ensure `gh secret set` was run before the workflow triggered
- **Permission denied pushing** — check `GITHUB_TOKEN` permissions in repo Settings > Actions > General
- **`npm test` fails when no test script** — use `npm test --if-present` to skip gracefully when the test script may not exist in all repos
