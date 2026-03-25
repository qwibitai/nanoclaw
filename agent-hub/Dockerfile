FROM python:3.13-slim

WORKDIR /app

# Install gws CLI (Linux x86_64)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://github.com/googleworkspace/cli/releases/download/v0.18.1/gws-x86_64-unknown-linux-gnu.tar.gz \
       | tar -xz --strip-components=1 -C /usr/local/bin gws-x86_64-unknown-linux-gnu/gws \
    && chmod +x /usr/local/bin/gws \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Python deps (minimal for Cloud Run)
RUN pip install --no-cache-dir fastapi uvicorn[standard] pydantic

# Copy app
COPY cloudrun_server.py .

# Copy GWS credentials (baked at build time)
COPY gws-creds/ /app/gws-creds/

ENV GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file
ENV PORT=8080
EXPOSE 8080

CMD ["python", "cloudrun_server.py"]
