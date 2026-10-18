/**
 * Server-side artifact precompilation: the JSX transform and the Tailwind build
 * the sandboxed frame would otherwise run on every view.
 *
 * React-free and Node-free on purpose (`precompile.worker-compat.test.ts`): a
 * Worker host loads this lazily at save time. The Tailwind input is the SAME
 * source the frame's in-browser compiler gets (default theme plus executor's
 * theme), so the fast path and the runtime fallback emit the same CSS.
 */

import { compile } from "tailwindcss";

import { compileJsx } from "../shell/compile-jsx";
import { TAILWIND_SOURCES, THEME_SOURCE } from "./assets.gen";
import { ARTIFACT_COMPILE_FINGERPRINT } from "./compile-fingerprint.gen";
import { extractCandidates, hasDynamicClassConstruction } from "./extract-candidates";

/** Above this, code is stored without compiled output, which keeps the row
 *  well under D1's per-row limit and bounds the CPU a save can spend here. */
export const ARTIFACT_PRECOMPILE_MAX_CODE = 256 * 1024;

export interface PrecompiledArtifact {
  readonly fingerprint: string;
  /** Null when the code could not be compiled; the frame then compiles it. */
  readonly js: string | null;
  /** Null when the classes cannot be known statically; the frame then runs
   *  Tailwind itself. */
  readonly css: string | null;
}

const STYLESHEETS: Readonly<Record<string, string>> = {
  tailwindcss: TAILWIND_SOURCES.index,
  "tailwindcss/index.css": TAILWIND_SOURCES.index,
  "tailwindcss/preflight": TAILWIND_SOURCES.preflight,
  "tailwindcss/preflight.css": TAILWIND_SOURCES.preflight,
  "./preflight.css": TAILWIND_SOURCES.preflight,
  "tailwindcss/theme": TAILWIND_SOURCES.theme,
  "tailwindcss/theme.css": TAILWIND_SOURCES.theme,
  "./theme.css": TAILWIND_SOURCES.theme,
  "tailwindcss/utilities": TAILWIND_SOURCES.utilities,
  "tailwindcss/utilities.css": TAILWIND_SOURCES.utilities,
  "./utilities.css": TAILWIND_SOURCES.utilities,
};

const nullOutput: PrecompiledArtifact = {
  fingerprint: ARTIFACT_COMPILE_FINGERPRINT,
  js: null,
  css: null,
};

const buildCss = async (code: string): Promise<string> => {
  // A new compiler per artifact: `build()` accumulates candidates across calls,
  // so a shared one would leak one artifact's classes into the next one's CSS.
  const compiler = await compile(`@import "tailwindcss";${THEME_SOURCE}`, {
    base: "/",
    loadStylesheet: async (id, base) => {
      const content = STYLESHEETS[id];
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Tailwind's loader contract reports a missing stylesheet by throwing
      if (content === undefined) throw new Error(`Unexpected stylesheet import: ${id}`);
      return { path: id, base, content };
    },
    loadModule: async () => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Tailwind's loader contract reports a refused module by throwing
      throw new Error("Plugins and configs are not available when precompiling artifacts.");
    },
  });
  return compiler.build([...extractCandidates(code)]);
};

/**
 * Never throws: any failure yields the matching null, and the frame takes the
 * runtime path for whatever is missing.
 */
export async function precompileArtifact(code: string): Promise<PrecompiledArtifact> {
  if (code.length > ARTIFACT_PRECOMPILE_MAX_CODE) return nullOutput;

  let js: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Sucrase reports invalid source by throwing; the contract is a null output
  try {
    js = compileJsx(code);
  } catch {
    return nullOutput;
  }

  if (hasDynamicClassConstruction(code)) {
    return { fingerprint: ARTIFACT_COMPILE_FINGERPRINT, js, css: null };
  }

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Tailwind reports build failures by throwing; the contract is a null css
  try {
    return { fingerprint: ARTIFACT_COMPILE_FINGERPRINT, js, css: await buildCss(code) };
  } catch {
    return { fingerprint: ARTIFACT_COMPILE_FINGERPRINT, js, css: null };
  }
}
