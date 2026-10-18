import { transform } from "sucrase";

/**
 * The one JSX transform for model-written artifact code. The server precompiles
 * with it at save time and the frame falls back to it at render time, so both
 * paths must share these options; `ARTIFACT_COMPILE_FINGERPRINT` covers them.
 */
export const ARTIFACT_JSX_TRANSFORM_OPTIONS = {
  transforms: ["jsx", "typescript", "imports"],
  jsxRuntime: "classic",
  production: true,
} as const;

/** Compile JSX source to plain JS using Sucrase. */
export function compileJsx(code: string): string {
  const result = transform(code, {
    ...ARTIFACT_JSX_TRANSFORM_OPTIONS,
    transforms: [...ARTIFACT_JSX_TRANSFORM_OPTIONS.transforms],
  });
  return result.code;
}
