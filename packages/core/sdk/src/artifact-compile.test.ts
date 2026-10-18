import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ArtifactCompiler } from "./artifact";
import { makeTestExecutor } from "./testing";

const CODE = "export default function App() { return <div>hi</div>; }";

// A compiler with literal outputs, so expectations are worked examples rather
// than a recomputation of what a real compiler would emit. `fingerprint` is
// mutable to model a deploy that changes the compiler.
const makeCompiler = (onCompile?: (code: string) => Effect.Effect<void>) => {
  const state = { fingerprint: "fp-1", calls: 0 };
  const compiler: ArtifactCompiler = {
    get fingerprint() {
      return state.fingerprint;
    },
    compile: (code) =>
      Effect.gen(function* () {
        state.calls++;
        if (onCompile) yield* onCompile(code);
        return { fingerprint: state.fingerprint, js: `js(${code})`, css: `css(${code})` };
      }),
  };
  return { compiler, state };
};

describe("artifact precompile", () => {
  it.effect("save stores compiled output that getForRender returns", () =>
    Effect.gen(function* () {
      const { compiler, state } = makeCompiler();
      const executor = yield* makeTestExecutor({ artifactCompiler: compiler });
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });

      const rendered = yield* executor.artifacts.getForRender(saved.id);
      expect(rendered.compiled).toEqual({
        fingerprint: "fp-1",
        js: `js(${CODE})`,
        css: `css(${CODE})`,
      });
      expect(state.calls).toBe(1);
    }),
  );

  it.effect("overwriting replaces the compiled output with the new source's", () =>
    Effect.gen(function* () {
      const { compiler } = makeCompiler();
      const executor = yield* makeTestExecutor({ artifactCompiler: compiler });
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });
      yield* executor.artifacts.save({ id: saved.id, title: "A", code: "const x = 1;" });

      const rendered = yield* executor.artifacts.getForRender(saved.id);
      expect(rendered.compiled?.js).toBe("js(const x = 1;)");
    }),
  );

  it.effect("a compiler failure still saves, with no compiled output", () =>
    Effect.gen(function* () {
      const compiler: ArtifactCompiler = {
        fingerprint: "fp-1",
        compile: () => Effect.die("boom"),
      };
      const executor = yield* makeTestExecutor({ artifactCompiler: compiler });
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });

      expect(saved.code).toBe(CODE);
      const rendered = yield* executor.artifacts.getForRender(saved.id);
      expect(rendered.code).toBe(CODE);
      expect(rendered.compiled).toBeNull();
    }),
  );

  it.effect("rename keeps the compiled output", () =>
    Effect.gen(function* () {
      const { compiler, state } = makeCompiler();
      const executor = yield* makeTestExecutor({ artifactCompiler: compiler });
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });
      yield* executor.artifacts.rename({ id: saved.id, title: "B" });

      const rendered = yield* executor.artifacts.getForRender(saved.id);
      expect(rendered.title).toBe("B");
      expect(rendered.compiled?.js).toBe(`js(${CODE})`);
      expect(state.calls).toBe(1);
    }),
  );

  it.effect("a host without a compiler stores nothing and reports null", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor();
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });
      expect((yield* executor.artifacts.getForRender(saved.id)).compiled).toBeNull();
    }),
  );

  it.effect("get carries no compiled output", () =>
    Effect.gen(function* () {
      const { compiler } = makeCompiler();
      const executor = yield* makeTestExecutor({ artifactCompiler: compiler });
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });

      expect(yield* executor.artifacts.get(saved.id)).not.toHaveProperty("compiled");
      expect(saved).not.toHaveProperty("compiled");
    }),
  );

  it.effect("getForRender recompiles a stale fingerprint and writes it back in place", () =>
    Effect.gen(function* () {
      const { compiler, state } = makeCompiler();
      const executor = yield* makeTestExecutor({ artifactCompiler: compiler });
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });

      state.fingerprint = "fp-2";
      const first = yield* executor.artifacts.getForRender(saved.id);
      expect(first.compiled?.fingerprint).toBe("fp-2");
      expect(first.updatedAt).toEqual(saved.updatedAt);
      expect(state.calls).toBe(2);

      const second = yield* executor.artifacts.getForRender(saved.id);
      expect(second.compiled).toEqual(first.compiled);
      expect(state.calls).toBe(2);
    }),
  );

  it.effect("a save that lands during the write-back compile is not overwritten", () =>
    Effect.gen(function* () {
      let concurrentSave: Effect.Effect<void> = Effect.void;
      const { compiler, state } = makeCompiler((code) =>
        code === CODE ? concurrentSave : Effect.void,
      );
      const executor = yield* makeTestExecutor({ artifactCompiler: compiler });
      const saved = yield* executor.artifacts.save({ title: "A", code: CODE });

      state.fingerprint = "fp-2";
      concurrentSave = executor.artifacts
        .save({ id: saved.id, title: "A", code: "const next = 1;" })
        .pipe(Effect.asVoid, Effect.orDie);
      yield* executor.artifacts.getForRender(saved.id);

      const rendered = yield* executor.artifacts.getForRender(saved.id);
      expect(rendered.code).toBe("const next = 1;");
      expect(rendered.compiled?.js).toBe("js(const next = 1;)");
    }),
  );
});
