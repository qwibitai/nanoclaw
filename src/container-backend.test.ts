import { afterEach, describe, expect, it } from 'vitest';

import {
  buildContainerRunInvocation,
  getContainerBackend,
} from './container-backend.js';

const ORIGINAL_BACKEND = process.env.CONTAINER_BACKEND;

afterEach(() => {
  if (ORIGINAL_BACKEND === undefined) {
    delete process.env.CONTAINER_BACKEND;
  } else {
    process.env.CONTAINER_BACKEND = ORIGINAL_BACKEND;
  }
});

describe('getContainerBackend', () => {
  it('defaults to apple when unset', () => {
    delete process.env.CONTAINER_BACKEND;
    expect(getContainerBackend()).toBe('apple');
  });

  it('resolves docker when configured', () => {
    process.env.CONTAINER_BACKEND = 'docker';
    expect(getContainerBackend()).toBe('docker');
  });
});

describe('buildContainerRunInvocation', () => {
  const mounts = [
    {
      hostPath: '/host/rw',
      containerPath: '/container/rw',
      readonly: false,
    },
    {
      hostPath: '/host/ro',
      containerPath: '/container/ro',
      readonly: true,
    },
  ];

  it('builds apple-container compatible mount args', () => {
    const invocation = buildContainerRunInvocation(
      mounts,
      'nanoclaw-test',
      'nanoclaw-agent:latest',
      'apple',
    );

    expect(invocation.command).toBe('container');
    expect(invocation.args).toContain('-v');
    expect(invocation.args).toContain('/host/rw:/container/rw');
    expect(invocation.args).toContain('--mount');
    expect(invocation.args).toContain(
      'type=bind,source=/host/ro,target=/container/ro,readonly',
    );
  });

  it('builds docker-compatible mount args', () => {
    const invocation = buildContainerRunInvocation(
      mounts,
      'nanoclaw-test',
      'nanoclaw-agent:latest',
      'docker',
    );

    expect(invocation.command).toBe('docker');
    expect(invocation.args).toContain('/host/rw:/container/rw:rw');
    expect(invocation.args).toContain('/host/ro:/container/ro:ro');
  });
});
