import { spawn } from "child_process";
import fs from "fs";
import os from "os";

export type RestartManager = "launchd" | "systemd-user" | "systemd-system" | "none";
export const RESTART_COMMAND_TIMEOUT_MS = 30_000;
const SAFE_RESTART_IDENTIFIER = /^[A-Za-z0-9_.:@-]+$/;

export interface RestartPlanOptions {
  platform?: NodeJS.Platform;
  uid?: number | null;
  hasSystemd?: boolean;
  serviceName?: string;
  launchdLabel?: string;
}

export interface RestartPlan {
  manager: RestartManager;
  command: RestartCommand | null;
  reason?: string;
}

export interface RestartResult extends RestartPlan {
  ok: boolean;
  error?: string;
}

function detectSystemdOnLinux(): boolean {
  try {
    const init = fs.readFileSync("/proc/1/comm", "utf-8").trim();
    return init === "systemd";
  } catch {
    return false;
  }
}

export interface RestartCommand {
  bin: string;
  args: string[];
  display: string;
}

function invalidRestartConfigReason(envVar: string, value: string): string {
  return `invalid ${envVar} value "${value}" (allowed chars: letters, numbers, ., _, :, @, -)`;
}

function toNone(reason: string): RestartPlan {
  return {
    manager: "none",
    command: null,
    reason,
  };
}

export function getRestartPlan(options: RestartPlanOptions = {}): RestartPlan {
  const platform = options.platform ?? os.platform();
  const uid = options.uid ?? process.getuid?.() ?? null;
  const hasSystemd = options.hasSystemd ?? (platform === "linux" ? detectSystemdOnLinux() : false);
  const serviceName = options.serviceName ?? process.env.NANOCLAW_SERVICE_NAME ?? "nanoclaw";
  const launchdLabel = options.launchdLabel ?? process.env.NANOCLAW_LAUNCHD_LABEL ?? "com.nanoclaw";

  if (platform === "darwin") {
    if (uid == null) {
      return toNone("launchd restart requires a numeric uid");
    }

    if (!SAFE_RESTART_IDENTIFIER.test(launchdLabel)) {
      return toNone(invalidRestartConfigReason("NANOCLAW_LAUNCHD_LABEL", launchdLabel));
    }

    return {
      manager: "launchd",
      command: {
        bin: "launchctl",
        args: ["kickstart", "-k", `gui/${uid}/${launchdLabel}`],
        display: `launchctl kickstart -k gui/${uid}/${launchdLabel}`,
      },
    };
  }

  if (platform === "linux") {
    if (!SAFE_RESTART_IDENTIFIER.test(serviceName)) {
      return toNone(invalidRestartConfigReason("NANOCLAW_SERVICE_NAME", serviceName));
    }

    if (!hasSystemd) {
      return toNone("systemd not detected on this host");
    }

    if (uid === 0) {
      return {
        manager: "systemd-system",
        command: {
          bin: "systemctl",
          args: ["restart", serviceName],
          display: `systemctl restart ${serviceName}`,
        },
      };
    }

    return {
      manager: "systemd-user",
      command: {
        bin: "systemctl",
        args: ["--user", "restart", serviceName],
        display: `systemctl --user restart ${serviceName}`,
      },
    };
  }

  return toNone(`unsupported platform: ${platform}`);
}

export async function restartNanoClawService(
  plan = getRestartPlan(),
  timeoutMs = RESTART_COMMAND_TIMEOUT_MS,
): Promise<RestartResult> {
  const command = plan.command;
  if (!command) {
    return {
      ...plan,
      ok: false,
      error: plan.reason,
    };
  }

  return new Promise<RestartResult>((resolve) => {
    const child = spawn(command.bin, command.args, { stdio: "ignore" });
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (result: RestartResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    timeout = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
        finish({
          ...plan,
          ok: false,
          error: `Restart command timed out after ${timeoutMs}ms: ${command.display}`,
        });
      }
    }, timeoutMs);

    child.once("error", (err) => {
      finish({
        ...plan,
        ok: false,
        error: err.message,
      });
    });

    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({
          ...plan,
          ok: true,
        });
        return;
      }

      const signalPart = signal ? `, signal ${signal}` : "";
      finish({
        ...plan,
        ok: false,
        error: `Restart command exited with code ${code ?? "null"}${signalPart}`,
      });
    });
  });
}
