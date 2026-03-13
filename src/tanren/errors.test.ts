import { describe, it, expect } from "vitest";

import {
  TanrenAPIError,
  TanrenAuthError,
  TanrenConnectionError,
  TanrenNotFoundError,
  TanrenNotImplementedError,
  TanrenValidationError,
} from "./errors.js";

function fakeResponse(status: number, statusText: string, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("TanrenAPIError.fromResponse", () => {
  it("returns TanrenAuthError for 401", async () => {
    const err = await TanrenAPIError.fromResponse(
      fakeResponse(401, "Unauthorized", { detail: "bad key" }),
      "req-1",
    );
    expect(err).toBeInstanceOf(TanrenAuthError);
    expect(err.status).toBe(401);
    expect(err.requestId).toBe("req-1");
    expect(err.name).toBe("TanrenAuthError");
  });

  it("returns TanrenNotFoundError for 404", async () => {
    const err = await TanrenAPIError.fromResponse(fakeResponse(404, "Not Found", {}));
    expect(err).toBeInstanceOf(TanrenNotFoundError);
    expect(err.status).toBe(404);
    expect(err.name).toBe("TanrenNotFoundError");
  });

  it("returns TanrenValidationError for 422 with detail", async () => {
    const detail = [{ loc: ["body", "project"], msg: "required", type: "missing" }];
    const err = await TanrenAPIError.fromResponse(
      fakeResponse(422, "Unprocessable Entity", { detail }),
    );
    expect(err).toBeInstanceOf(TanrenValidationError);
    expect(err.status).toBe(422);
    expect((err as TanrenValidationError).detail).toEqual(detail);
    expect(err.name).toBe("TanrenValidationError");
  });

  it("returns TanrenValidationError with empty detail when body has no detail", async () => {
    const err = await TanrenAPIError.fromResponse(fakeResponse(422, "Unprocessable Entity", {}));
    expect(err).toBeInstanceOf(TanrenValidationError);
    expect((err as TanrenValidationError).detail).toEqual([]);
  });

  it("returns TanrenNotImplementedError for 501", async () => {
    const err = await TanrenAPIError.fromResponse(fakeResponse(501, "Not Implemented", {}));
    expect(err).toBeInstanceOf(TanrenNotImplementedError);
    expect(err.status).toBe(501);
    expect(err.name).toBe("TanrenNotImplementedError");
  });

  it("returns base TanrenAPIError for unknown status codes", async () => {
    const err = await TanrenAPIError.fromResponse(
      fakeResponse(500, "Internal Server Error", { error: "boom" }),
    );
    expect(err).toBeInstanceOf(TanrenAPIError);
    expect(err).not.toBeInstanceOf(TanrenAuthError);
    expect(err.status).toBe(500);
    expect(err.name).toBe("TanrenAPIError");
    expect(err.body).toEqual({ error: "boom" });
  });

  it("handles non-JSON response body", async () => {
    const res = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "plain text error",
    } as unknown as Response;
    const err = await TanrenAPIError.fromResponse(res);
    expect(err.status).toBe(500);
    expect(err.body).toBe("plain text error");
  });
});

describe("TanrenConnectionError", () => {
  it("wraps a cause error", () => {
    const cause = new TypeError("fetch failed");
    const err = new TanrenConnectionError("connection failed", cause);
    expect(err.name).toBe("TanrenConnectionError");
    expect(err.message).toBe("connection failed");
    expect(err.cause).toBe(cause);
  });
});

describe("error message properties", () => {
  it("TanrenAPIError has correct message format", async () => {
    const err = await TanrenAPIError.fromResponse(fakeResponse(403, "Forbidden", {}));
    expect(err.message).toBe("Tanren API 403 Forbidden");
    expect(err.statusText).toBe("Forbidden");
  });
});
