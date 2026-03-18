/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execSync } from "child_process";
import fs from "fs";
import os from "os";

import { INSTANCE_ID } from "./config.js";
import { logger } from "./logger.js";

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = "docker";

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = "host.docker.internal";

/** Full URL agents use to reach the credential proxy (e.g., http://nanoclaw:3001).
 * When set, used as ANTHROPIC_BASE_URL in agent containers instead of auto-detect. */
export const CREDENTIAL_PROXY_EXTERNAL_URL = process.env.CREDENTIAL_PROXY_EXTERNAL_URL || "";

/** Docker network to attach agent containers to (e.g., nanoclaw_default).
 * When set, passes --network to docker run. */
export const AGENT_NETWORK = process.env.AGENT_NETWORK || "";

/**
 * Address the credential proxy binds to.
 * Docker Engine (Linux/WSL): bind to the docker0 bridge IP — containers reach it
 *   via host.docker.internal which resolves to the bridge gateway.
 * Docker Desktop (macOS/WSL): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * When CREDENTIAL_PROXY_EXTERNAL_URL is set: bind to 0.0.0.0 so the proxy is
 *   reachable from Docker networks (sibling container mode).
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST ||
  (CREDENTIAL_PROXY_EXTERNAL_URL ? "0.0.0.0" : detectProxyBindHost());

function detectProxyBindHost(): string {
  if (os.platform() === "darwin") return "127.0.0.1";

  // Docker Engine creates docker0; Docker Desktop does not.
  // Check this first — works for both bare-metal Linux and WSL with Docker Engine.
  try {
    const docker0 = os.networkInterfaces()["docker0"];
    if (docker0) {
      const ipv4 = docker0.find((a) => a.family === "IPv4");
      if (ipv4) return ipv4.address;
    }
  } catch {
    /* interface enumeration blocked — fall through to WSL/loopback */
  }

  // No docker0 — likely Docker Desktop (macOS or WSL). Loopback is correct.
  if (fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) return "127.0.0.1";

  logger.warn(
    "docker0 bridge not found; binding credential proxy to loopback for safety. Set CREDENTIAL_PROXY_HOST to override.",
  );
  return "127.0.0.1";
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === "linux") {
    return ["--add-host=host.docker.internal:host-gateway"];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ["-v", `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: "pipe",
      timeout: 10000,
    });
    logger.debug("Container runtime already running");
  } catch (err) {
    logger.error({ err }, "Failed to reach container runtime");
    console.error("\n╔════════════════════════════════════════════════════════════════╗");
    console.error("║  FATAL: Container runtime failed to start                      ║");
    console.error("║                                                                ║");
    console.error("║  Agents cannot run without a container runtime. To fix:        ║");
    console.error("║  1. Ensure Docker is installed and running                     ║");
    console.error("║  2. Run: docker info                                           ║");
    console.error("║  3. Restart NanoClaw                                           ║");
    console.error("╚════════════════════════════════════════════════════════════════╝\n");
    throw new Error("Container runtime is required but failed to start");
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    // Use execFileSync (argument array) instead of execSync (shell string)
    // so that INSTANCE_ID values with spaces or metacharacters are safe.
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ["ps", "--filter", `label=nanoclaw.instance=${INSTANCE_ID}`, "--format", "{{.Names}}"],
      { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
    );
    const orphans = output.trim().split("\n").filter(Boolean);
    for (const name of orphans) {
      try {
        execFileSync(CONTAINER_RUNTIME_BIN, ["stop", name], { stdio: "pipe" });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans, instanceId: INSTANCE_ID },
        "Stopped orphaned containers",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to clean up orphaned containers");
  }
}
