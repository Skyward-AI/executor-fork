import { Predicate } from "effect";
import * as Cause from "effect/Cause";

export type FailureCategory =
  | "upstream_timeout"
  | "upstream_network"
  | "upstream_http"
  | "auth"
  | "internal";

export interface FailureClassification {
  readonly category: FailureCategory;
  readonly retryable: boolean;
  readonly status?: number;
}

const MAX_CAUSE_DEPTH = 6;
const TIMEOUT_NAMES = new Set(["TimeoutError", "TimeoutException", "AbortError"]);
const NETWORK_TAGS = new Set(["RequestError", "TransportError", "FetchError"]);
const RESPONSE_TAGS = new Set(["ResponseError", "StatusCodeError"]);
const AUTH_TAGS = new Set(["CredentialResolutionError", "OAuthRefreshError"]);

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const hasName = (value: object, names: ReadonlySet<string>): boolean => {
  const name = (value as { readonly name?: unknown }).name;
  return typeof name === "string" && names.has(name);
};

const isOneOf = (value: object, tags: ReadonlySet<string>): boolean =>
  hasName(value, tags) || [...tags].some((tag) => Predicate.isTagged(value, tag));

const statusOf = (value: unknown): number | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const status = (value as { readonly status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : undefined;
};

const classifyValue = (value: unknown, depth: number): FailureClassification | undefined => {
  if (depth > MAX_CAUSE_DEPTH || typeof value !== "object" || value === null) return undefined;
  if (isOneOf(value, TIMEOUT_NAMES)) return { category: "upstream_timeout", retryable: true };
  if (isOneOf(value, NETWORK_TAGS)) return { category: "upstream_network", retryable: true };
  if (isOneOf(value, AUTH_TAGS)) return { category: "auth", retryable: false };
  const status = statusOf(value);
  if (isOneOf(value, RESPONSE_TAGS) && status !== undefined) {
    return { category: "upstream_http", retryable: isRetryableStatus(status), status };
  }
  return classifyValue((value as { readonly cause?: unknown }).cause, depth + 1);
};

/** Reads only error tags, names and numeric status codes, never messages, so
 *  the result is safe to show to the sandbox. */
export const classifyFailure = (cause: Cause.Cause<unknown>): FailureClassification => {
  for (const reason of cause.reasons) {
    const value = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    const found = classifyValue(value, 0);
    if (found) return found;
  }
  return { category: "internal", retryable: false };
};

const SUMMARY: Record<Exclude<FailureCategory, "internal" | "upstream_http">, string> = {
  upstream_timeout: "upstream timeout",
  upstream_network: "upstream network failure",
  auth: "authentication failure, reconnect the integration",
};

/** Text appended after `Internal tool error [id]`; empty when nothing safe is known. */
export const describeFailure = (failure: FailureClassification, toolPath?: string): string => {
  if (failure.category === "internal") return "";
  const target = toolPath === undefined ? "" : ` calling ${toolPath}`;
  const summary =
    failure.category === "upstream_http"
      ? `upstream returned HTTP ${failure.status}${target}`
      : `${SUMMARY[failure.category]}${target}`;
  return `: ${summary}.${failure.retryable ? " Retry may succeed." : ""}`;
};
