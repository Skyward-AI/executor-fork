import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { createExecutor, type Executor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { observabilityMiddleware } from "../observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

const CAPTURE = '<div class="p-4"><p>12,480 active</p></div>';

const putPreview = (executor: Executor, id: string) =>
  Effect.gen(function* () {
    const web = yield* webHandlerFor(executor);
    const response = yield* Effect.promise(() =>
      web.handler(
        new Request(`http://localhost/artifacts/${id}/preview`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ preview: CAPTURE }),
        }),
        handlerContextFor(executor),
      ),
    );
    return {
      status: response.status,
      body: yield* Effect.promise(() => response.json()),
    };
  });

const insertOrgArtifact = (
  config: ReturnType<typeof makeTestConfig>,
  id: string,
  createdBy: string,
) =>
  Effect.promise(() =>
    config.db.create("artifact", {
      tenant: "test-tenant",
      subject: "",
      owner: "org",
      id,
      title: "Revenue",
      description: null,
      code: "const a = 1;",
      bindings: null,
      preview: null,
      compiled_fingerprint: null,
      compiled_js: null,
      compiled_css: null,
      created_by: createdBy,
      created_at: new Date(),
      updated_at: new Date(),
    }),
  );

describe("artifact preview capture over HTTP", () => {
  it.effect("answers stored: false when the caller did not create the artifact", () =>
    Effect.gen(function* () {
      const config = makeTestConfig();
      const executor = yield* createExecutor(config);
      yield* insertOrgArtifact(config, "art_theirs", "someone-else");

      const result = yield* putPreview(executor, "art_theirs");

      expect(result).toEqual({ status: 200, body: { stored: false } });
    }),
  );

  it.effect("answers stored: true when the caller created the artifact", () =>
    Effect.gen(function* () {
      const config = makeTestConfig();
      const executor = yield* createExecutor(config);
      yield* insertOrgArtifact(config, "art_mine", "test-subject");

      const result = yield* putPreview(executor, "art_mine");

      expect(result).toEqual({ status: 200, body: { stored: true } });
    }),
  );
});
