# Embedding Setup Guide

## Option 1: Local with Ollama (Recommended)

### Ollama with AMD GPU (ROCm)

If you have an AMD GPU, use the ROCm variant of Ollama. Here's a working `docker-compose.yml`:

```yaml
services:
  ollama:
    image: ollama/ollama:rocm          # ROCm variant — NOT the default image
    container_name: ollama
    restart: unless-stopped
    ports:
      - "11434:11434"
    volumes:
      - ~/.ollama:/root/.ollama        # model cache & data
    devices:                            # AMD GPU passthrough (required)
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    group_add:
      - "993"                           # render group GID — check: getent group render
      - "44"                            # video group GID — check: getent group video
    environment:
      HIP_VISIBLE_DEVICES: "0"          # GPU index (multi-GPU: "0,1")
      OLLAMA_FLASH_ATTENTION: "1"       # enable flash attention
      OLLAMA_GPU_MEMORY: "96GB"         # adjust to your GPU VRAM
      OLLAMA_MAX_LOADED_MODELS: "2"     # max concurrent models in VRAM
      OLLAMA_NUM_PARALLEL: "2"          # parallel request handling
      # Uncomment for unsupported cards:
      # HSA_OVERRIDE_GFX_VERSION: "10.3.0"
```

**Important:**
- Must use `ollama/ollama:rocm` — the default image has no AMD GPU support
- `/dev/kfd` and `/dev/dri` device passthrough is required
- Group IDs must match your host — verify with `getent group render video`
- For NVIDIA GPUs, use the default `ollama/ollama` image with `--gpus all` instead

### Install and pull the model

```bash
# If Ollama is running natively
ollama pull nomic-embed-text

# If Ollama is in Docker
docker exec ollama ollama pull nomic-embed-text
```

### Pin in VRAM (optional, saves cold-start latency)

```bash
# Load with infinite keep-alive (stays in VRAM until explicitly unloaded)
curl -s http://localhost:11434/api/generate \
  -d '{"model":"nomic-embed-text","keep_alive":-1,"prompt":"warmup"}' > /dev/null
```

### Configure OpenClaw

Add to your `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "remote": {
          "baseUrl": "http://localhost:11434/v1",
          "apiKey": "ollama"
        },
        "model": "nomic-embed-text",
        "fallback": "none"
      }
    }
  }
}
```

**Note:** We use `provider: "openai"` because Ollama exposes an OpenAI-compatible API at `/v1`. This isn't actually calling OpenAI.

### Resource usage

- **Disk:** 274MB
- **VRAM:** 577MB when loaded
- **Latency:** ~61ms warm, ~3s cold
- **Dimensions:** 768

## Option 2: QMD (OpenClaw Built-in)

QMD is included with OpenClaw and uses its own embedded models:

- **embeddinggemma-300M** for vector embeddings
- **qwen3-reranker-0.6b** for result reranking
- **Qwen3-0.6B** for query expansion

### Configure

```json
{
  "memorySearch": {
    "backend": "qmd",
    "qmd": {
      "includeDefaultMemory": true,
      "limits": {
        "maxResults": 6,
        "timeoutMs": 5000
      }
    }
  }
}
```

### Tradeoffs

- ✅ Best result quality (reranking + query expansion)
- ✅ Zero external dependencies
- ⚠️ 3 models compete for VRAM (~1.5GB total)
- ⚠️ ~4s latency per query (all 3 models run sequentially)

### Recommended: QMD primary + Ollama fallback

Use QMD for reranked quality, fall back to Ollama when QMD times out:

```json
{
  "memorySearch": {
    "backend": "qmd",
    "qmd": {
      "limits": { "timeoutMs": 5000 }
    }
  },
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "remote": {
          "baseUrl": "http://localhost:11434/v1",
          "apiKey": "ollama"
        },
        "model": "nomic-embed-text",
        "fallback": "none"
      }
    }
  }
}
```

## Option 3: OpenAI Cloud

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "model": "text-embedding-3-small"
      }
    }
  }
}
```

Requires `OPENAI_API_KEY` in environment. Cost: ~$0.02 per million tokens.

## Switching Models

⚠️ **Changing embedding models requires re-indexing.** Different models produce different vector dimensions (nomic = 768d, OpenAI = 1536d). Existing embeddings are incompatible with a new model.

To force re-index with QMD:
```bash
qmd update --force -c memory-root
```
