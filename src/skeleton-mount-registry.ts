/**
 * Provision-time bind-mount contributor registry.
 *
 * Used by bulk-provisioning scripts (currently only the
 * `/add-classroom`-installed `class-skeleton.ts`) to let installed
 * extensions inject extra bind mounts into each provisioned agent
 * group's `container.json` without the script knowing about every
 * possible feature.
 *
 * Provision-time only — these go into `container.json` once when the
 * provisioning script runs. Spawn-time env vars use a different
 * registry (`src/container-env-registry.ts`).
 *
 * No-op on a default install: the registry is empty until something
 * registers against it.
 */
import type { ContainerConfig } from './container-config.js';

export interface SkeletonMountContext {
  /** e.g. "student_07" */
  studentFolder: string;
  /** e.g. "Alice Chen" */
  studentName: string;
  /**
   * Whatever the script passed in for class-config — base skeleton
   * writes the students array; extensions can read fields they
   * recognize. Untyped on purpose: extensions that need typed access
   * cast and own the validation.
   */
  classConfig: Record<string, unknown>;
  /** Raw process.argv slice, so contributors can parse their own flags. */
  argv: string[];
}

export type SkeletonMountContributor = (ctx: SkeletonMountContext) => ContainerConfig['additionalMounts'];

const contributors: SkeletonMountContributor[] = [];

/**
 * Append a contributor. Contributors run in registration order; their
 * outputs are concatenated. Each contributor decides whether to emit
 * mounts for a given student (returning `[]` is the no-op).
 */
export function registerSkeletonMountContributor(contributor: SkeletonMountContributor): void {
  contributors.push(contributor);
}

/**
 * Collect mount specs from all registered contributors, in order.
 * The script appends these to its base KB/wiki mounts when writing
 * each student's `container.json`.
 */
export function collectSkeletonMounts(ctx: SkeletonMountContext): ContainerConfig['additionalMounts'] {
  const out: ContainerConfig['additionalMounts'] = [];
  for (const contributor of contributors) {
    for (const mount of contributor(ctx)) {
      out.push(mount);
    }
  }
  return out;
}

/** Test hook — clear the contributor chain. */
export function _resetContributorsForTest(): void {
  contributors.length = 0;
}
