# NanoClaw Service
# Runs the NanoClaw host process (message routing, scheduling, channel management).
# Agent containers are spawned via the host Docker daemon (DooD pattern) —
# this container only needs the Docker CLI, not a full daemon.

FROM node:22-slim

# Install Docker CLI so NanoClaw can spawn agent containers via the host socket.
# Force bookworm repo since Docker doesn't yet publish a trixie suite.
RUN apt-get update && \
    apt-get install -y ca-certificates curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install build tools needed for native modules (e.g. better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

CMD ["npm", "start"]
