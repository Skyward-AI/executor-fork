import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

// A Worker host imports `./precompile` lazily. Its graph must hold no React, no
// `.tsx`, and no Node builtin, or the Worker bundle breaks or balloons.
describe("precompile module graph", () => {
  it.effect("reaches no React, .tsx or node: module", () =>
    Effect.gen(function* () {
      const { build } = yield* Effect.promise(() => import("esbuild"));
      const result = yield* Effect.promise(() =>
        build({
          entryPoints: [path.join(import.meta.dirname, "precompile.ts")],
          bundle: true,
          write: false,
          metafile: true,
          format: "esm",
          platform: "neutral",
          mainFields: ["module", "main"],
          conditions: ["import"],
          logLevel: "silent",
        }),
      );

      const inputs = Object.keys(result.metafile.inputs);
      const externals = Object.values(result.metafile.inputs).flatMap((input) =>
        input.imports.filter((i) => i.external).map((i) => i.path),
      );
      expect(
        inputs.filter((p) => p.endsWith(".tsx") || /node_modules\/react(-dom)?\//.test(p)),
      ).toEqual([]);
      expect(externals.filter((p) => p.startsWith("node:") || p === "react")).toEqual([]);
    }),
  );
});
