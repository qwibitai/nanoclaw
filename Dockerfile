FROM node:22-slim

# Install system dependencies
# - docker.io: To run docker commands from within the container
# - build-essential, python3: To compile native modules like better-sqlite3
RUN apt-get update && apt-get install -y \
    docker.io \
    build-essential \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Build the project
RUN npm run build

# Expose the credential proxy port
EXPOSE 3001

# Entry point
CMD ["npm", "start"]
