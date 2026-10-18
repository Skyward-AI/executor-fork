import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { createExecutor, type ArtifactCompiler, type Executor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { observabilityMiddleware } from "../observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

const compiler: ArtifactCompiler = {
  fingerprint: "fp-1",
  compile: (code) =>
    Effect.succeed({ fingerprint: "fp-1", js: `js(${code})`, css: `css(${code})` }),
};

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

interface ArtifactBody {
  readonly id: string;
  readonly code: string;
  readonly compiled?: { readonly fingerprint: string; readonly js: string | null } | null;
}

describe("artifact compiled output over HTTP", () => {
  it.effect("get returns the precompiled output", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ artifactCompiler: compiler }));
      const saved = yield* executor.artifacts.save({ title: "A", code: "const a = 1;" });
      const web = yield* webHandlerFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request(`http://localhost/artifacts/${saved.id}`),
          handlerContextFor(executor),
        ),
      );
      expect(response.status).toBe(200);
      const body = (yield* Effect.promise(() => response.json())) as ArtifactBody;
      expect(body.compiled).toEqual({
        fingerprint: "fp-1",
        js: "js(const a = 1;)",
        css: "css(const a = 1;)",
      });
    }),
  );

  it.effect("a save payload carrying compiled output does not store it", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ artifactCompiler: compiler }));
      const web = yield* webHandlerFor(executor);

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/artifacts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "A",
              code: "const a = 1;",
              compiled: { fingerprint: "fp-1", js: "evil()", css: "evil" },
            }),
          }),
          handlerContextFor(executor),
        ),
      );
      expect(response.status).toBe(200);
      const saved = (yield* Effect.promise(() => response.json())) as ArtifactBody;

      const rendered = yield* executor.artifacts.getForRender(saved.id);
      expect(rendered.compiled?.js).toBe("js(const a = 1;)");
    }),
  );
});
