import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { parseSpecObject } from "../../sdk/parse";
import { slackWebApiAdapter } from "./spec-format-adapter";

const SLACK_SPEC_URL = "https://api.apis.guru/v2/specs/slack.com/1.7.0/openapi.json";

const slackFixture = {
  openapi: "3.0.0",
  info: { title: "Slack Web API", version: "1.7.0" },
  servers: [{ url: "https://slack.com/api" }],
  paths: {
    "/auth.test": {
      get: {
        operationId: "auth_test",
        parameters: [
          {
            name: "token",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Authentication token. Requires scope: `none`",
          },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/conversations.history": {
      get: {
        operationId: "conversations_history",
        parameters: [
          { name: "token", in: "query", schema: { type: "string" } },
          { name: "channel", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/chat.postMessage": {
      post: {
        operationId: "chat_postMessage",
        parameters: [{ name: "token", in: "header", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["channel", "token"],
                properties: { channel: { type: "string" }, token: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
      },
    },
    "/files.upload": {
      post: {
        operationId: "files_upload",
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["token"],
                properties: { token: { type: "string" }, content: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

const slackHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url === SLACK_SPEC_URL
          ? new Response(JSON.stringify(slackFixture), { status: 200 })
          : new Response("not found", { status: 404 }),
      ),
    ),
  ),
);

it("recognizes the Slack Web API spec URLs", () => {
  expect(slackWebApiAdapter.detectsUrl?.(SLACK_SPEC_URL)).toBe(true);
  expect(
    slackWebApiAdapter.detectsUrl?.(
      "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json",
    ),
  ).toBe(true);
  expect(
    slackWebApiAdapter.detectsUrl?.(
      "https://api.apis.guru/v2/specs/stripe.com/2022-11-15/openapi.json",
    ),
  ).toBe(false);
});

it.effect("removes the token input so the connection's credential is the only one sent", () =>
  Effect.gen(function* () {
    const converted = yield* slackWebApiAdapter.fetch({
      urls: [SLACK_SPEC_URL],
      httpClientLayer: slackHttpClientLayer,
    });
    const spec: any = yield* parseSpecObject(converted.specText);

    expect(spec.paths["/auth.test"].get.parameters).toEqual([]);
    expect(spec.paths["/conversations.history"].get.parameters).toEqual([
      { name: "channel", in: "query", schema: { type: "string" } },
    ]);
    expect(spec.paths["/chat.postMessage"].post.parameters).toEqual([]);
    expect(
      spec.paths["/chat.postMessage"].post.requestBody.content["application/x-www-form-urlencoded"]
        .schema,
    ).toEqual({
      type: "object",
      required: ["channel"],
      properties: { channel: { type: "string" } },
    });
    expect(
      spec.paths["/files.upload"].post.requestBody.content["multipart/form-data"].schema,
    ).toEqual({
      type: "object",
      properties: { content: { type: "string" } },
    });
    expect(converted.specUrl).toBe(SLACK_SPEC_URL);
  }),
);
