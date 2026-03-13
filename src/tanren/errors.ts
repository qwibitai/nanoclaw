import type { ValidationError } from "./types.js";

export class TanrenAPIError extends Error {
  override name = "TanrenAPIError";

  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
  }

  static async fromResponse(res: Response, requestId?: string): Promise<TanrenAPIError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }

    const message = `Tanren API ${res.status} ${res.statusText}`;

    switch (res.status) {
      case 401:
        return new TanrenAuthError(message, res.statusText, body, requestId);
      case 404:
        return new TanrenNotFoundError(message, res.statusText, body, requestId);
      case 422:
        return new TanrenValidationError(
          message,
          res.statusText,
          body,
          requestId,
          (body as { detail?: ValidationError[] })?.detail ?? [],
        );
      case 501:
        return new TanrenNotImplementedError(message, res.statusText, body, requestId);
      default:
        return new TanrenAPIError(message, res.status, res.statusText, body, requestId);
    }
  }
}

export class TanrenAuthError extends TanrenAPIError {
  override name = "TanrenAuthError";

  constructor(message: string, statusText: string, body: unknown, requestId?: string) {
    super(message, 401, statusText, body, requestId);
  }
}

export class TanrenNotFoundError extends TanrenAPIError {
  override name = "TanrenNotFoundError";

  constructor(message: string, statusText: string, body: unknown, requestId?: string) {
    super(message, 404, statusText, body, requestId);
  }
}

export class TanrenValidationError extends TanrenAPIError {
  override name = "TanrenValidationError";

  constructor(
    message: string,
    statusText: string,
    body: unknown,
    requestId: string | undefined,
    public readonly detail: ValidationError[],
  ) {
    super(message, 422, statusText, body, requestId);
  }
}

export class TanrenNotImplementedError extends TanrenAPIError {
  override name = "TanrenNotImplementedError";

  constructor(message: string, statusText: string, body: unknown, requestId?: string) {
    super(message, 501, statusText, body, requestId);
  }
}

export class TanrenConnectionError extends Error {
  override name = "TanrenConnectionError";

  constructor(
    message: string,
    public override readonly cause: Error,
  ) {
    super(message, { cause });
  }
}
