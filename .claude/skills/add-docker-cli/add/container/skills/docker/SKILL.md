---
name: docker
description: Manage Docker containers on the host machine
allowed-tools: Bash(docker:*)
---

# Docker

You have access to the Docker CLI connected to the host machine's Docker daemon.

## Available Commands

### List containers
```bash
docker ps                          # Running containers
docker ps -a                       # All containers (including stopped)
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

### Container logs
```bash
docker logs <container>            # Full logs
docker logs --tail 50 <container>  # Last 50 lines
docker logs --since 1h <container> # Last hour
docker logs -f <container>         # Follow (stream) — use with timeout
```

### Container inspection
```bash
docker inspect <container>         # Full details (JSON)
docker stats --no-stream           # Resource usage snapshot
docker top <container>             # Running processes
```

### Container lifecycle
```bash
docker start <container>
docker stop <container>
docker restart <container>
docker rm <container>              # Remove stopped container
```

### Images
```bash
docker images                      # List images
docker pull <image>                # Pull an image
```

### Running new containers
```bash
docker run -d --name <name> <image>           # Detached
docker run -d --name <name> -p 8080:80 <image> # With port mapping
docker run -d --name <name> --restart unless-stopped <image>  # Auto-restart
```

### Run a command in a container
```bash
docker exec <container> <command>
```

### Docker Compose (if available)
```bash
docker compose ps
docker compose up -d
docker compose down
docker compose logs <service>
```

## Monitoring Pattern

When asked to monitor containers, check their health status:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -v "Up"
```

If any containers have exited or are unhealthy, pull their logs to diagnose:

```bash
docker logs --tail 100 <failed-container>
```

## Never Run These Commands

These are destructive and affect the host machine — do not run them:

- `docker system prune` — deletes unused images, containers, networks
- `docker volume prune` — deletes unused volumes (data loss)
- `docker rmi` — removes images needed by other containers
- `docker rm -f` — force-kills and removes running containers
- `docker network rm` — removes networks other containers depend on

## Important Notes

- Containers you see are running on the **host machine**, not inside your own container
- `docker logs -f` (follow mode) will block — always use `--tail` or `--since` instead
- For long-running monitoring, use scheduled tasks rather than continuous polling
