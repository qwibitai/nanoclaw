import { describe, it, expect } from 'vitest';

import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('allows acquisition up to the max', () => {
    const sem = new Semaphore(3);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.active).toBe(3);
  });

  it('rejects acquisition beyond the max', () => {
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    expect(sem.active).toBe(2);
  });

  it('allows acquisition after release', () => {
    const sem = new Semaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.active).toBe(0);
    expect(sem.tryAcquire()).toBe(true);
  });

  it('release does not go below zero', () => {
    const sem = new Semaphore(2);
    sem.release();
    sem.release();
    expect(sem.active).toBe(0);
  });

  it('reports capacity', () => {
    const sem = new Semaphore(5);
    expect(sem.capacity).toBe(5);
  });

  it('handles semaphore with max=1 as a mutex', () => {
    const sem = new Semaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
    sem.release();
    expect(sem.active).toBe(0);
  });
});
