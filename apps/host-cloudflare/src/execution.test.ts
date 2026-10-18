import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { withLazyPreload } from "./execution";

const makeInner = (calls: string[]) => ({
  execute: (code: string) => {
    calls.push(`execute:${code}`);
    return Effect.succeed({ result: code });
  },
});

describe("withLazyPreload", () => {
  it.effect("loads nothing until the first execute, then runs the code", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const preload = () => {
        calls.push("preload");
        return Promise.resolve();
      };
      const executor = withLazyPreload(
        // oxlint-disable-next-line executor/no-double-cast -- test double: only execute is used
        makeInner(calls) as unknown as Parameters<typeof withLazyPreload>[0],
        preload,
      );

      expect(calls).toEqual([]);

      // oxlint-disable-next-line executor/no-double-cast -- test double: the invoker is never called
      const invoker = {} as unknown as Parameters<typeof executor.execute>[1];
      const outcome = yield* executor.execute("1 + 1", invoker);

      expect(calls).toEqual(["preload", "execute:1 + 1"]);
      expect(outcome).toEqual({ result: "1 + 1" });
    }),
  );
});
