/**
 * Typed EventEmitter utility.
 * Wraps Node's EventEmitter with generic type constraints on event names + payloads.
 */
import { EventEmitter } from 'node:events';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TypedEmitter<T extends Record<string, any[]>> = Omit<
  EventEmitter,
  'on' | 'off' | 'emit' | 'once'
> & {
  on<K extends keyof T & string>(
    event: K,
    fn: (...args: T[K]) => void,
  ): TypedEmitter<T>;
  off<K extends keyof T & string>(
    event: K,
    fn: (...args: T[K]) => void,
  ): TypedEmitter<T>;
  once<K extends keyof T & string>(
    event: K,
    fn: (...args: T[K]) => void,
  ): TypedEmitter<T>;
  emit<K extends keyof T & string>(event: K, ...args: T[K]): boolean;
};
