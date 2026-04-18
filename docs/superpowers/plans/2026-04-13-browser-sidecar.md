# Plan 4: Browser Sidecar

**Date:** 2026-04-13
**Status:** Done

## Overview

Browser sidecar architecture where a Chromium container runs alongside agent containers, connected via Chrome DevTools Protocol (CDP). Agent containers connect to it for browser automation.

## Tasks

### Task 1: Browser configuration (`src/config.ts`)
- Add `BROWSER_CDP_URL` (default `ws://host.docker.internal:9222`)
- Add `BROWSER_MAX_CONTEXTS` (default 3)
- Add `BROWSER_PROFILE_DIR` pattern (per-group `groups/{name}/browser/`)

### Task 2: Browser profile encryption (`src/browser/profile-crypto.ts`)
- `encryptProfile(profileDir, key)` — AES-256-GCM encrypt all files
- `decryptProfile(profileDir, key)` — decrypt to temp dir
- `generateEncryptionKey()` — generate AES-256 key
- Node.js `crypto` module only (no deps)
- Unit tests with temp directories

### Task 3: Browser session manager (`src/browser/session-manager.ts`)
- State machine tracking per-group browser contexts
- `createContext(groupId)` — create isolated context (state only for v1)
- `getContext(groupId)` — return existing context
- `closeContext(groupId)` — close and cleanup
- `getActiveContextCount()` — enforce max concurrent limit
- Emits events via EventBus: `browser.context.created`, `browser.context.closed`

### Task 4: Docker Compose configuration (`docker-compose.browser.yml`)
- Playwright sidecar service on port 9222
- Volume for browser data persistence
- Memory limit 512MB

### Task 5: Container runner updates (`src/container-runner.ts`)
- Pass `BROWSER_CDP_URL` env var to containers

### Task 6: Tests
- `src/browser/profile-crypto.test.ts` — encryption round-trip
- `src/browser/session-manager.test.ts` — state management, limits
