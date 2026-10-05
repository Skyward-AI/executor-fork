import { Effect, Schema } from "effect";

import { parseSpecObject, resolveSpecText } from "../../sdk/parse";
import type { SpecFormatAdapter } from "../../sdk/spec-format";

const SLACK_SPEC_URL_PATTERNS = [
  /^https:\/\/api\.apis\.guru\/v2\/specs\/slack\.com\//,
  /^https:\/\/raw\.githubusercontent\.com\/slackapi\/slack-api-specs\//,
];

const encodeJsonText = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const TOKEN_INPUT = "token";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const detectsSlackSpecUrl = (url: string): boolean =>
  SLACK_SPEC_URL_PATTERNS.some((pattern) => pattern.test(url.trim()));

function withoutTokenParameter(parameters: unknown): unknown {
  if (!Array.isArray(parameters)) return parameters;
  return parameters.filter((parameter) => !isRecord(parameter) || parameter.name !== TOKEN_INPUT);
}

function withoutTokenProperty(schema: unknown): unknown {
  if (!isRecord(schema) || !isRecord(schema.properties) || !(TOKEN_INPUT in schema.properties)) {
    return schema;
  }
  const { [TOKEN_INPUT]: _token, ...properties } = schema.properties;
  const { required, ...rest } = schema;
  const remainingRequired = Array.isArray(required)
    ? required.filter((name) => name !== TOKEN_INPUT)
    : [];
  return {
    ...rest,
    ...(remainingRequired.length > 0 ? { required: remainingRequired } : {}),
    properties,
  };
}

function withoutTokenBody(requestBody: unknown): unknown {
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) return requestBody;
  const content = Object.fromEntries(
    Object.entries(requestBody.content).map(([mediaType, media]) => [
      mediaType,
      isRecord(media) ? { ...media, schema: withoutTokenProperty(media.schema) } : media,
    ]),
  );
  return { ...requestBody, content };
}

function withoutTokenOperation(operation: unknown): unknown {
  if (!isRecord(operation)) return operation;
  return {
    ...operation,
    ...("parameters" in operation
      ? { parameters: withoutTokenParameter(operation.parameters) }
      : {}),
    ...("requestBody" in operation ? { requestBody: withoutTokenBody(operation.requestBody) } : {}),
  };
}

/**
 * The published Slack specs predate header auth and declare the credential as
 * an ordinary `token` input on every operation. Left in, each tool asks the
 * caller for the token and sends it in the query or body, where Slack rejects
 * it for current apps. Dropping it leaves the connection's credential, sent as
 * an `Authorization` header, as the only one.
 */
export function stripSlackTokenInputs(document: unknown): unknown {
  if (!isRecord(document) || !isRecord(document.paths)) return document;
  const paths = Object.fromEntries(
    Object.entries(document.paths).map(([path, pathItem]) => {
      if (!isRecord(pathItem)) return [path, pathItem];
      const cleaned = Object.fromEntries(
        Object.entries(pathItem).map(([key, value]) => [
          key,
          key === "parameters"
            ? withoutTokenParameter(value)
            : HTTP_METHODS.has(key)
              ? withoutTokenOperation(value)
              : value,
        ]),
      );
      return [path, cleaned];
    }),
  );
  return { ...document, paths };
}

export const slackWebApiAdapter: SpecFormatAdapter = {
  id: "slack-web-api",
  detectsUrl: detectsSlackSpecUrl,
  fetch: (input) =>
    Effect.gen(function* () {
      const url = input.urls[0]!;
      const specText = yield* resolveSpecText(url, input.credentials).pipe(
        Effect.provide(input.httpClientLayer),
      );
      const document = yield* parseSpecObject(specText);
      return { specText: encodeJsonText(stripSlackTokenInputs(document)), specUrl: url };
    }),
};
