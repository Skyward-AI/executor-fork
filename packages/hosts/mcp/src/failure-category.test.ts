import { describe, expect, it } from "@effect/vitest";
import { Cause, Data } from "effect";

import { classifyFailure, describeFailure } from "./failure-category";

class WrappedError extends Data.TaggedError("WrappedError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
class OtherError extends Data.TaggedError("OtherError")<{ readonly message: string }> {}
class RequestError extends Data.TaggedError("RequestError")<{ readonly message: string }> {}
class ResponseError extends Data.TaggedError("ResponseError")<{
  readonly message: string;
  readonly status: number;
}> {}
class TimeoutException extends Data.TaggedError("TimeoutException")<{
  readonly message: string;
}> {}
class CredentialResolutionError extends Data.TaggedError("CredentialResolutionError")<{
  readonly message: string;
}> {}

describe("classifyFailure", () => {
  it("classifies a timeout defect as retryable", () => {
    expect(classifyFailure(Cause.die(new TimeoutException({ message: "x" })))).toEqual({
      category: "upstream_timeout",
      retryable: true,
    });
  });

  it("classifies an AbortError defect as a timeout", () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    expect(classifyFailure(Cause.die(abort))).toEqual({
      category: "upstream_timeout",
      retryable: true,
    });
  });

  it("classifies a transport failure as retryable network failure", () => {
    expect(classifyFailure(Cause.fail(new RequestError({ message: "x" })))).toEqual({
      category: "upstream_network",
      retryable: true,
    });
  });

  it("finds the category through a wrapped cause chain", () => {
    const wrapped = new WrappedError({
      message: "wrapper",
      cause: new TimeoutException({ message: "inner" }),
    });
    expect(classifyFailure(Cause.die(wrapped)).category).toBe("upstream_timeout");
  });

  it("marks 5xx and 429 as retryable and 4xx as not", () => {
    expect(classifyFailure(Cause.fail(new ResponseError({ message: "x", status: 503 })))).toEqual({
      category: "upstream_http",
      retryable: true,
      status: 503,
    });
    expect(classifyFailure(Cause.fail(new ResponseError({ message: "x", status: 429 })))).toEqual({
      category: "upstream_http",
      retryable: true,
      status: 429,
    });
    expect(classifyFailure(Cause.fail(new ResponseError({ message: "x", status: 404 })))).toEqual({
      category: "upstream_http",
      retryable: false,
      status: 404,
    });
  });

  it("classifies credential failures as auth and not retryable", () => {
    expect(classifyFailure(Cause.fail(new CredentialResolutionError({ message: "x" })))).toEqual({
      category: "auth",
      retryable: false,
    });
  });

  it("falls back to internal for anything else", () => {
    expect(classifyFailure(Cause.die(new OtherError({ message: "boom" })))).toEqual({
      category: "internal",
      retryable: false,
    });
  });
});

describe("describeFailure", () => {
  it("returns an empty suffix for internal failures", () => {
    expect(describeFailure({ category: "internal", retryable: false })).toBe("");
  });

  it("names the tool and signals retry for a timeout", () => {
    expect(
      describeFailure({ category: "upstream_timeout", retryable: true }, "slack.org.main.history"),
    ).toBe(": upstream timeout calling slack.org.main.history. Retry may succeed.");
  });

  it("includes the status and omits the retry hint when not retryable", () => {
    expect(describeFailure({ category: "upstream_http", retryable: false, status: 404 })).toBe(
      ": upstream returned HTTP 404.",
    );
  });
});
