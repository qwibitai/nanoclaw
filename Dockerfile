FROM node:22-slim
RUN apt-get update -q && apt-get install -yq git curl ca-certificates gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update -q && apt-get install -yq docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
# Remove husky prepare hook — it's a dev tool and shouldn't run in Docker
RUN npm pkg delete scripts.prepare
# Install all deps (including dev) so tsc is available for the build
RUN npm install
COPY . .
# Compile TypeScript
RUN npm run build
# Prune dev dependencies — keeps the image lean
RUN npm prune --omit=dev
EXPOSE 3003
CMD ["npm", "start"]
