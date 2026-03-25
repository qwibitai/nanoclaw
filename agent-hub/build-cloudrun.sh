#!/bin/bash
set -e

# Build and deploy agent-hub to Cloud Run
# Embeds GWS credentials for thais@, sam@, and default (yacine@)

PROJECT_ID="adp-413110"
REGION="europe-west1"
SERVICE="agent-hub"
IMAGE="gcr.io/$PROJECT_ID/$SERVICE:latest"

echo "=== Preparing credentials ==="
mkdir -p .gws-creds/accounts/thais .gws-creds/accounts/sam

# Copy credential files (encrypted + keys)
for account in thais sam; do
    src="$HOME/.config/gws/accounts/$account"
    dst=".gws-creds/accounts/$account"
    cp "$src/.encryption_key" "$dst/"
    cp "$src/credentials.enc" "$dst/"
    cp "$src/client_secret.json" "$dst/"
    [ -f "$src/credentials.json" ] && cp "$src/credentials.json" "$dst/" || true
    [ -f "$src/token_cache.json" ] && cp "$src/token_cache.json" "$dst/" || true
done

# Default account (yacine@)
cp "$HOME/.config/gws/.encryption_key" .gws-creds/
cp "$HOME/.config/gws/credentials.enc" .gws-creds/
cp "$HOME/.config/gws/client_secret.json" .gws-creds/
[ -f "$HOME/.config/gws/token_cache.json" ] && cp "$HOME/.config/gws/token_cache.json" .gws-creds/ || true

echo "=== Building image ==="
docker build --platform linux/amd64 -t "$IMAGE" .

echo "=== Pushing to GCR ==="
docker push "$IMAGE"

echo "=== Deploying to Cloud Run ==="
# Get API key from Secret Manager
API_KEY=$(gcloud secrets versions access latest --secret=agent-hub-api-key --project=$PROJECT_ID)

gcloud run deploy "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --image="$IMAGE" \
    --platform=managed \
    --allow-unauthenticated \
    --set-env-vars="SHADOW_MODE=false,AGENT_HUB_API_KEY=$API_KEY,GEMINI_API_KEY=$(cat /tmp/gemini-api-key.txt 2>/dev/null || echo ''),GCP_PROJECT_ID=$PROJECT_ID,WEBHOOK_PORT=8080,GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file" \
    --memory=512Mi \
    --cpu=1 \
    --min-instances=0 \
    --max-instances=1 \
    --timeout=120

echo ""
echo "=== Deployed ==="
gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)"

# Cleanup
rm -rf .gws-creds
