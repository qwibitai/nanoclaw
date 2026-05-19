/**
 * Per-checkout install identifiers. Lets two NanoClaw installs coexist on
 * one host without clobbering each other's service registration or the
 * shared `nanoclaw-agent:latest` docker image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 */
import { createHash } from 'crypto';

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/** launchd Label + plist basename. e.g. `com.nanoclaw-v2-ab12cd34`. */
export function getLaunchdLabel(projectRoot?: string): string {
  return `com.nanoclaw-v2-${getInstallSlug(projectRoot)}`;
}

/** systemd unit name (no .service suffix). e.g. `nanoclaw-v2-ab12cd34`. */
export function getSystemdUnit(projectRoot?: string): string {
  return `nanoclaw-v2-${getInstallSlug(projectRoot)}`;
}

/** Docker image base (no tag). e.g. `nanoclaw-agent-v2-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return `nanoclaw-agent-v2-${getInstallSlug(projectRoot)}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}
