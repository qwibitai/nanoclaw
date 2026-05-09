/**
 * Pure registry tests for skeleton-mount-registry. The actual gws
 * Drive contributor is exercised end-to-end by class-skeleton.ts
 * smoke-running with --drive-parent set.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _resetContributorsForTest,
  collectSkeletonMounts,
  registerSkeletonMountContributor,
} from './skeleton-mount-registry.js';

beforeEach(() => _resetContributorsForTest());

describe('collectSkeletonMounts', () => {
  it('returns empty when no contributors are registered (default install)', () => {
    expect(
      collectSkeletonMounts({
        studentFolder: 'student_01',
        studentName: 'Alice',
        classConfig: {},
        argv: [],
      }),
    ).toEqual([]);
  });

  it('concatenates outputs from all registered contributors', () => {
    registerSkeletonMountContributor(() => [{ hostPath: '/a', containerPath: '/x', readonly: true }]);
    registerSkeletonMountContributor(() => [
      { hostPath: '/b', containerPath: '/y', readonly: false },
      { hostPath: '/c', containerPath: '/z', readonly: false },
    ]);
    const out = collectSkeletonMounts({ studentFolder: 'f', studentName: 'n', classConfig: {}, argv: [] });
    expect(out).toEqual([
      { hostPath: '/a', containerPath: '/x', readonly: true },
      { hostPath: '/b', containerPath: '/y', readonly: false },
      { hostPath: '/c', containerPath: '/z', readonly: false },
    ]);
  });

  it('passes the same context to every contributor', () => {
    const ctxs: unknown[] = [];
    registerSkeletonMountContributor((ctx) => {
      ctxs.push(ctx);
      return [];
    });
    registerSkeletonMountContributor((ctx) => {
      ctxs.push(ctx);
      return [];
    });
    const ctx = {
      studentFolder: 'student_07',
      studentName: 'Bob',
      classConfig: { driveParent: 'XYZ' },
      argv: ['--drive-parent', 'XYZ'],
    };
    collectSkeletonMounts(ctx);
    expect(ctxs).toEqual([ctx, ctx]);
  });

  it('contributors that return [] are no-ops', () => {
    registerSkeletonMountContributor(() => []);
    registerSkeletonMountContributor(() => [{ hostPath: '/only', containerPath: '/c', readonly: false }]);
    expect(collectSkeletonMounts({ studentFolder: 'f', studentName: 'n', classConfig: {}, argv: [] })).toEqual([
      { hostPath: '/only', containerPath: '/c', readonly: false },
    ]);
  });

  it('mutations to classConfig by one contributor are visible to the next', () => {
    const order: Array<Record<string, unknown>> = [];
    registerSkeletonMountContributor((ctx) => {
      ctx.classConfig.driveParent = 'XYZ';
      order.push({ ...ctx.classConfig });
      return [];
    });
    registerSkeletonMountContributor((ctx) => {
      order.push({ ...ctx.classConfig });
      return [];
    });
    const blob: Record<string, unknown> = {};
    collectSkeletonMounts({ studentFolder: 'f', studentName: 'n', classConfig: blob, argv: [] });
    expect(order[0]).toEqual({ driveParent: 'XYZ' });
    expect(order[1]).toEqual({ driveParent: 'XYZ' });
    expect(blob.driveParent).toBe('XYZ');
  });
});
