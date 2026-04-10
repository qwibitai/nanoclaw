---
name: expose
description: Expose a local service on Tailscale with a unique path
user-invocable: true
---

# /expose - Expose Local Services via Tailscale

Expose a local service on Tailscale with a unique path, preserving the root path for the main application.

## Usage
```
/expose <port> [service-name]
```

## Examples
```
/expose                  # Auto-detects running dev server and exposes it
/expose 3000             # Exposes localhost:3000 with auto-generated path
/expose 8080 api         # Exposes localhost:8080 as /api
/expose 5173 vite-app    # Exposes localhost:5173 as /vite-app
```

## Implementation

When called, this command will:

1. **Auto-Detect Dev Server (if no port specified)**
   - Search for common dev server ports: 3000, 3001, 4200, 5173, 5174, 8000, 8080, 8081
   - Check for running processes with common dev commands: `npm run dev`, `yarn dev`, `vite`, `next dev`
   - Use `lsof` to find the actual port being used
   - If multiple found, prompt user to choose

2. **Check Tailscale Status**
   - Verify Tailscale is running
   - Get current Tailscale IP and hostname

3. **Generate Unique Path**
   - If service-name provided: use `/service-name`
   - Otherwise: generate random path like `/svc-<random-8-chars>`
   - Ensure path doesn't conflict with existing services

3. **Preserve Root Path**
   - Never override the root path `/`
   - Keep track of which service owns root (if any)

4. **Expose Service**
   ```bash
   tailscale serve --set-path /<unique-path> --bg http://localhost:<port>
   ```

5. **Store Service Mapping**
   - Save to `.claude/tailscale-services.json`:
   ```json
   {
     "root_service": {
       "port": 6802,
       "name": "lipi",
       "protected": true
     },
     "services": [
       {
         "port": 3000,
         "path": "/svc-a8f3d2c1",
         "name": "frontend",
         "url": "https://example-hostname.example.ts.net/svc-a8f3d2c1",
         "direct": "http://100.64.1.2:3000",
         "created": "2024-01-15T10:30:00Z"
       }
     ]
   }
   ```

6. **Display Access Info**
   ```
   ✅ Service exposed successfully!

   📍 Service: frontend (port 3000)
   🔗 HTTPS Path: https://example-hostname.example.ts.net/svc-a8f3d2c1
   🔗 Direct Access: http://100.64.1.2:3000
   🔗 Hostname Access: http://example-hostname:3000

   💡 For SPAs, use direct access URLs to avoid routing issues
   ```

## Command Logic

```bash
#!/bin/bash

# Auto-detect running dev server
auto_detect_dev_server() {
    # Common dev server ports
    COMMON_PORTS=(3000 3001 3002 4200 4321 5173 5174 8000 8080 8081 6802 4013)

    echo "🔍 Searching for running dev servers..."

    FOUND_SERVICES=()
    for port in "${COMMON_PORTS[@]}"; do
        if lsof -i :$port >/dev/null 2>&1; then
            # Get process info
            PROCESS=$(lsof -i :$port | grep LISTEN | awk '{print $1}' | head -1)
            FOUND_SERVICES+=("$port:$PROCESS")
            echo "   Found: $PROCESS on port $port"
        fi
    done

    # Also check for common dev processes
    DEV_PROCESSES=("next" "vite" "webpack" "parcel" "snowpack" "turbopack")
    for proc in "${DEV_PROCESSES[@]}"; do
        PORTS=$(lsof -i -P | grep -i "$proc" | grep LISTEN | awk '{print $9}' | cut -d: -f2 | sort -u)
        for port in $PORTS; do
            if [[ ! " ${FOUND_SERVICES[@]} " =~ " $port:" ]]; then
                FOUND_SERVICES+=("$port:$proc")
                echo "   Found: $proc on port $port"
            fi
        done
    done

    if [ ${#FOUND_SERVICES[@]} -eq 0 ]; then
        echo "❌ No running dev servers found"
        echo "   Start your dev server first, then run /expose"
        return 1
    elif [ ${#FOUND_SERVICES[@]} -eq 1 ]; then
        # Only one found, use it
        PORT=$(echo "${FOUND_SERVICES[0]}" | cut -d: -f1)
        PROCESS=$(echo "${FOUND_SERVICES[0]}" | cut -d: -f2)
        echo "✅ Auto-detected: $PROCESS on port $PORT"
        return $PORT
    else
        # Multiple found, let user choose
        echo ""
        echo "Multiple dev servers found. Which one to expose?"
        for i in "${!FOUND_SERVICES[@]}"; do
            PORT=$(echo "${FOUND_SERVICES[$i]}" | cut -d: -f1)
            PROCESS=$(echo "${FOUND_SERVICES[$i]}" | cut -d: -f2)
            echo "  $((i+1)). $PROCESS on port $PORT"
        done
        read -p "Enter number (1-${#FOUND_SERVICES[@]}): " choice

        if [[ $choice -ge 1 && $choice -le ${#FOUND_SERVICES[@]} ]]; then
            PORT=$(echo "${FOUND_SERVICES[$((choice-1))]}" | cut -d: -f1)
            return $PORT
        else
            echo "❌ Invalid choice"
            return 1
        fi
    fi
}

expose_service() {
    local PORT=$1
    local SERVICE_NAME=$2

    # If no port specified, auto-detect
    if [ -z "$PORT" ]; then
        auto_detect_dev_server
        PORT=$?
        if [ $PORT -eq 1 ]; then
            return 1
        fi
        # Auto-generate service name based on detected process
        if [ -z "$SERVICE_NAME" ]; then
            SERVICE_NAME="dev-$PORT"
        fi
    fi

    # Get Tailscale info
    TAILSCALE_IP=$(tailscale ip -4)
    TAILSCALE_HOSTNAME=$(tailscale status --self --peers=false | awk '{print $2}')
    TAILSCALE_DOMAIN="${TAILSCALE_HOSTNAME}.example.ts.net"

    # Generate path
    if [ -z "$SERVICE_NAME" ]; then
        RANDOM_ID=$(openssl rand -hex 4)
        PATH_NAME="/svc-${RANDOM_ID}"
        SERVICE_NAME="service-${PORT}"
    else
        PATH_NAME="/${SERVICE_NAME}"
    fi

    # Check if port is already exposed
    EXISTING=$(tailscale serve status --json | jq -r ".Web[\"${TAILSCALE_DOMAIN}:443\"].Handlers[\"${PATH_NAME}\"].Proxy")

    if [ "$EXISTING" != "null" ]; then
        echo "⚠️  Path ${PATH_NAME} is already in use"
        echo "   Current proxy: ${EXISTING}"
        echo "   Generate new path? (y/n)"
        read -r response
        if [ "$response" = "y" ]; then
            RANDOM_ID=$(openssl rand -hex 4)
            PATH_NAME="/svc-${RANDOM_ID}"
        else
            return 1
        fi
    fi

    # Expose the service
    tailscale serve --set-path ${PATH_NAME} --bg http://localhost:${PORT}

    # Save to tracking file
    SERVICES_FILE="$HOME/.claude/tailscale-services.json"

    # Create file if doesn't exist
    if [ ! -f "$SERVICES_FILE" ]; then
        echo '{"root_service": null, "services": []}' > "$SERVICES_FILE"
    fi

    # Add service to tracking
    NEW_SERVICE=$(jq -n \
        --arg port "$PORT" \
        --arg path "$PATH_NAME" \
        --arg name "$SERVICE_NAME" \
        --arg url "https://${TAILSCALE_DOMAIN}${PATH_NAME}" \
        --arg direct "http://${TAILSCALE_IP}:${PORT}" \
        --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{port: $port, path: $path, name: $name, url: $url, direct: $direct, created: $created}')

    jq ".services += [$NEW_SERVICE]" "$SERVICES_FILE" > "${SERVICES_FILE}.tmp" && mv "${SERVICES_FILE}.tmp" "$SERVICES_FILE"

    # Display results
    echo "✅ Service exposed successfully!"
    echo ""
    echo "📍 Service: ${SERVICE_NAME} (port ${PORT})"
    echo "🔗 HTTPS Path: https://${TAILSCALE_DOMAIN}${PATH_NAME}"
    echo "🔗 Direct Access: http://${TAILSCALE_IP}:${PORT}"
    echo "🔗 Hostname Access: http://${TAILSCALE_HOSTNAME}:${PORT}"
    echo ""
    echo "💡 For SPAs, use direct access URLs to avoid routing issues"
}

# List exposed services
list_services() {
    echo "🌐 Exposed Services on Tailscale"
    echo "================================"

    # Show Tailscale serve status
    tailscale serve status

    # Show tracked services
    if [ -f "$HOME/.claude/tailscale-services.json" ]; then
        echo ""
        echo "📋 Service Registry:"
        jq -r '.services[] | "  \(.name): \(.direct) (path: \(.path))"' "$HOME/.claude/tailscale-services.json"
    fi
}

# Remove service
unexpose_service() {
    local PATH_OR_PORT=$1

    if [[ "$PATH_OR_PORT" =~ ^[0-9]+$ ]]; then
        # It's a port, find the path
        PATH_NAME=$(jq -r ".services[] | select(.port == \"$PATH_OR_PORT\") | .path" "$HOME/.claude/tailscale-services.json")
    else
        PATH_NAME="$PATH_OR_PORT"
    fi

    if [ -z "$PATH_NAME" ]; then
        echo "❌ Service not found"
        return 1
    fi

    # Remove from Tailscale
    tailscale serve clear ${PATH_NAME}

    # Remove from tracking
    jq "del(.services[] | select(.path == \"$PATH_NAME\"))" "$HOME/.claude/tailscale-services.json" > "${SERVICES_FILE}.tmp" && mv "${SERVICES_FILE}.tmp" "$SERVICES_FILE"

    echo "✅ Service removed from ${PATH_NAME}"
}
```

## Features

- **Auto-generates unique paths** to avoid conflicts
- **Preserves root path** for main application
- **Tracks all exposed services** in JSON file
- **Provides both HTTPS and direct access URLs**
- **Handles SPAs correctly** by recommending direct port access
- **Supports custom service names** or auto-generation
- **Lists all exposed services** with `/expose list`
- **Removes services** with `/expose remove <port|path>`

## Related Commands
- `/expose list` - Show all exposed services
- `/expose remove <port>` - Unexpose a service
- `/expose clear` - Remove all exposed services (except root)
