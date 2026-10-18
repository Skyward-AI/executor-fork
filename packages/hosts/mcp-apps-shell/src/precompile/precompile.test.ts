import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ARTIFACT_COMPILE_FINGERPRINT } from "./compile-fingerprint.gen";
import { ARTIFACT_PRECOMPILE_MAX_CODE, precompileArtifact } from "./precompile";

const compile = (code: string) => Effect.promise(() => precompileArtifact(code));

const APP = (className: string) => `function App(){return <div className="${className}"/>}`;

describe("precompileArtifact", () => {
  it.effect("stamps the output with the compile fingerprint", () =>
    Effect.gen(function* () {
      const out = yield* compile(APP("p-4"));
      expect(out.fingerprint).toBe(ARTIFACT_COMPILE_FINGERPRINT);
    }),
  );

  it.effect("emits classic-runtime JS", () =>
    Effect.gen(function* () {
      const out = yield* compile('function App(){return <div className="p-4"/>}');
      expect(out.js).toContain("React.createElement('div', { className: \"p-4\"");
    }),
  );

  it.effect("builds utilities against the default theme", () =>
    Effect.gen(function* () {
      const out = yield* compile(APP("text-2xl"));
      expect(out.css).toContain(".text-2xl");
      expect(out.css).toContain("font-size: var(--text-2xl)");
    }),
  );

  it.effect("builds utilities against executor tokens", () =>
    Effect.gen(function* () {
      const out = yield* compile(APP("text-muted-foreground"));
      expect(out.css).toContain("color: var(--muted-foreground)");
    }),
  );

  it.effect("places responsive variants in their media query", () =>
    Effect.gen(function* () {
      const out = yield* compile(APP("md:grid-cols-4"));
      expect(out.css).toMatch(
        /\.md\\:grid-cols-4 \{\s*@media \(width >= 48rem\) \{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
      );
    }),
  );

  it.effect("does not leak one artifact's classes into the next", () =>
    Effect.gen(function* () {
      yield* compile(APP("tracking-widest"));
      const out = yield* compile(APP("p-4"));
      expect(out.css).not.toContain("tracking-widest");
    }),
  );

  it.effect("returns nulls for a syntax error", () =>
    Effect.gen(function* () {
      const out = yield* compile("function App( {");
      expect(out).toEqual({ fingerprint: ARTIFACT_COMPILE_FINGERPRINT, js: null, css: null });
    }),
  );

  it.effect("returns nulls above the size cap", () =>
    Effect.gen(function* () {
      const out = yield* compile(`${APP("p-4")}\n//${"x".repeat(ARTIFACT_PRECOMPILE_MAX_CODE)}`);
      expect(out).toEqual({ fingerprint: ARTIFACT_COMPILE_FINGERPRINT, js: null, css: null });
    }),
  );

  it.effect("keeps the JS but no CSS when classes are built dynamically", () =>
    Effect.gen(function* () {
      const out = yield* compile(
        "function App(){const c='red';return <div className={`bg-${c}-500`}/>}",
      );
      expect(out.js).toContain("createElement");
      expect(out.css).toBeNull();
    }),
  );
});
