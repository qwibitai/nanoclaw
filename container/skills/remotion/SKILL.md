---
name: add-remotion
description: Add programmatic video generation to NanoClaw using Remotion and AWS Lambda. Your agent can render MP4 videos from React components and deliver them directly to the chat.
---

# Add Remotion Video Generation

This skill adds the ability to create and render MP4 videos programmatically. Videos are React components that Remotion renders to frames — you write code, you get video. Rendering happens on AWS Lambda (serverless, ~$0.01–0.05 per short video). The rendered MP4 is delivered directly to the chat.

## Phase 1: Pre-flight

### Check if already applied

Check whether `groups/main/remotion/` exists. If it does, skip to Phase 3.

### Requirements

- Node.js 18+ (already present in NanoClaw)
- AWS account with IAM access
- An S3 bucket for Remotion renders (Remotion creates this automatically on first deploy)

### Ask the user

Use `AskUserQuestion` to collect:

AskUserQuestion: Do you have AWS credentials (Access Key ID and Secret) for a dedicated Remotion IAM user?

If no, walk them through creating one in Phase 3. If yes, collect both values now.

## Phase 2: Apply Code Changes

### Ensure the Remotion remote

```bash
git remote -v
```

If `jorgenclaw` is missing, add it:

```bash
git remote add jorgenclaw https://github.com/jorgenclaw/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch jorgenclaw skill/remotion
git merge jorgenclaw/skill/remotion || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `groups/main/remotion/` — Remotion project (Root.tsx, Composition.tsx, remotion.config.ts, package.json)
- `groups/main/remotion/src/NanoClawBot.tsx` — default starter composition (animated text on dark background)
- `container/skills/remotion/SKILL.md` — container-level instructions the agent reads at runtime
- `tools/remotion-render` — CLI that wraps Lambda render + download to a local path
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `REMOTION_AWS_BUCKET` added to `.env.example`
- Lambda concurrency notes in `docs/skills/remotion.md`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Install dependencies

```bash
cd groups/main/remotion && npm install && cd ../../..
```

### Validate

```bash
cd groups/main/remotion
npx remotion studio --help
cd ../../..
```

If the help text prints, the install is clean.

## Phase 3: Setup

### Create AWS IAM user (if needed)

Tell the user:

> I need you to create an IAM user for Remotion with limited permissions:
>
> 1. Go to the [AWS IAM console](https://console.aws.amazon.com/iam)
> 2. Click **Users → Add users**
> 3. Username: `remotion-render`
> 4. Select **Programmatic access**
> 5. Attach the policy from `groups/main/remotion/aws-policies/remotion-policy.json` (create as a custom policy first)
> 6. Download the credentials CSV — you can only see the secret key once

Once they have the credentials, continue.

### Write credentials to .env

```bash
# Open .env and add:
AWS_ACCESS_KEY_ID=<their-key>
AWS_SECRET_ACCESS_KEY=<their-secret>
AWS_REGION=us-east-1
```

### Deploy Lambda function (first time only)

```bash
cd groups/main/remotion
npx remotion lambda functions deploy
npx remotion lambda sites create src/index.ts --site-name=nanoclaw-main
cd ../../..
```

This creates the Lambda function and S3 bucket. Takes about 60 seconds. If it prints a serve URL at the end, save it:

```bash
# Add to .env:
REMOTION_SERVE_URL=<the-url-printed-above>
```

### Check Lambda concurrency quota

AWS free-tier accounts have a Lambda concurrency cap of 10. Remotion respects this via `--frames-per-lambda`. The installed tool defaults to `--frames-per-lambda=60`, which keeps short videos (≤30 seconds) safely under the cap.

If the user has requested a quota increase and been approved, they can raise or remove this limit in `tools/remotion-render`.

## Phase 4: Verify

### Test render

```bash
remotion-render NanoClawBot drafts/test-$(date +%s).mp4
```

This should:
- Deploy the site bundle (or use cached `REMOTION_SERVE_URL`)
- Trigger a Lambda render
- Download the MP4 to `groups/main/remotion/drafts/`
- Print the file path

Open the MP4 and confirm it plays. If it does, the skill is working.

## Phase 5: Using the skill

Your agent now has video generation capabilities described in `container/skills/remotion/SKILL.md`. The agent reads this at container startup and understands how to:

- Edit `groups/main/remotion/src/Composition.tsx` for the current video
- Run `remotion-render <CompositionId> <output-path>` to render via Lambda
- Deliver the MP4 back to the chat via `send_message` with `file_path`

Ask the agent: *"Make me a 10-second intro video for my project."*

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| `Cannot find module '@remotion/lambda'` | npm install didn't run | `cd groups/main/remotion && npm install` |
| `Environment variable AWS_ACCESS_KEY_ID not set` | Credentials not in .env | Check .env, restart container |
| `TooManyRequestsException` / rate error | Lambda concurrency cap | Raise `--frames-per-lambda` in `tools/remotion-render` (e.g., 120 or 200) |
| `No function named remotion-render-*` | Lambda not deployed | Re-run `npx remotion lambda functions deploy` |
| `No site with name "nanoclaw-main"` | First run / site deleted | Re-run `npx remotion lambda sites create src/index.ts --site-name=nanoclaw-main` |
| Render hangs indefinitely | Lambda timeout | Check CloudWatch logs; try a shorter composition first |
