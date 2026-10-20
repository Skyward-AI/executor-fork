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

describe("artifact share over HTTP", () => {
  it.effect("moves a personal artifact to the org tier", () =>
    Effect.gen(function* () {
      const config = makeTestConfig();
      const executor = yield* createExecutor(config);
      const context = { tenant: "test-tenant", subject: "test-subject" };
      yield* Effect.promise(() =>
        config.db.create("artifact", {
          ...context,
          owner: "user",
          id: "art_mine",
          title: "Mine",
          description: null,
          code: "const a = 1;",
          bindings: null,
          preview: null,
          compiled_fingerprint: null,
          compiled_js: null,
          compiled_css: null,
          created_by: null,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );
      const web = yield* webHandlerFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/artifacts/art_mine/share", { method: "POST" }),
          handlerContextFor(executor),
        ),
      );

      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as { owner: string; id: string };
      expect(body.owner).toBe("org");
      expect(body.id).toBe("art_mine");
    }),
  );

  it.effect("answers 404 for an unknown id", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig());
      const web = yield* webHandlerFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/artifacts/art_missing/share", { method: "POST" }),
          handlerContextFor(executor),
        ),
      );

      expect(response.status).toBe(404);
    }),
  );
});
