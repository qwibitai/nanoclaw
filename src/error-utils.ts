export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

export function isErrnoException(
  value: unknown,
  code?: string,
): value is NodeJS.ErrnoException {
  if (!(value instanceof Error)) return false;
  const errorWithCode = value as NodeJS.ErrnoException;
  if (code === undefined) return true;
  return errorWithCode.code === code;
}

export function isSyntaxError(value: unknown): value is SyntaxError {
  return value instanceof SyntaxError;
}
