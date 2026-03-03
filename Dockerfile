# NanoClaw Orchestrator
# Runs the main NanoClaw process (WhatsApp + K8s Job creator)

FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Set in K8s Deployment: DATA_DIR, GROUPS_DIR, STORE_DIR, K8S_* vars
# Secrets come from envFrom nanoclaw-secrets: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
CMD ["node", "dist/index.js"]
