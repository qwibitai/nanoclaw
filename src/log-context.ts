/**
 * AsyncLocalStorage-based log context for automatic correlation ID propagation.
 * Wrap entry points with withLogContext() to inject traceId into all downstream logs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export interface LogContext {
  traceId: string;
  chatJid?: string;
  groupFolder?: string;
  sender?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

/**
 * 在 fn 执行期间注入日志上下文。logger 自动从 store 读取 traceId 等字段。
 * traceId 自动生成（UUID 前 8 位），无需手动传入。
 */
export function withLogContext<T>(
  partial: Partial<Omit<LogContext, 'traceId'>>,
  fn: () => T,
): T {
  const ctx: LogContext = {
    traceId: crypto.randomUUID().slice(0, 8),
    ...partial,
  };
  return logContext.run(ctx, fn);
}
