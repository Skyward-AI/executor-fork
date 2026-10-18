import { compileJsx } from "./compile-jsx";

// A separate program from the inner renderer so a frame whose artifact arrives
// precompiled never loads or parses Sucrase. The renderer calls this only when
// the shell did not send compiled JS.
(globalThis as { __executorCompileJsx?: (code: string) => string }).__executorCompileJsx =
  compileJsx;
