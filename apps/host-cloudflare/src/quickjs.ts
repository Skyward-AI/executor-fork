import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
// Static .wasm import: wrangler/workerd compiles this to a WebAssembly.Module at
// BUILD time. Workers forbid runtime WASM compilation (both fetching the .wasm
// and `WebAssembly.instantiate()` of bytes are blocked), so the engine bytes
// MUST be a pre-compiled module imported like this. The file is vendored into
// src/ (copied from @jitl/quickjs-wasmfile-release-sync) because wrangler's
// CompiledWasm module rule is rooted at the app dir and won't match the
// monorepo-root node_modules path — see scripts/vendor-quickjs-wasm.ts.
import wasmModule from "./quickjs-engine.wasm";

import type { QuickJSWASMModule } from "quickjs-emscripten";

// ---------------------------------------------------------------------------
// QuickJS-on-Workers WASM loading.
//
// The base variant's module loader resolves to the variant package's `workerd`
// build (its `./emscripten-module` export has a `workerd` condition wrangler
// selects) — that build expects the WASM module to be supplied rather than
// fetched/compiled at runtime. `newVariant(base, { wasmModule })` hands it the
// statically-imported, pre-compiled module. The worker entry registers this
// through `setQuickJSModuleLoader`, so the runtime builds it on the first
// execution and reuses it for the rest of the isolate.
// ---------------------------------------------------------------------------

export const loadQuickJs = (): Promise<QuickJSWASMModule> =>
  newQuickJSWASMModuleFromVariant(newVariant(baseVariant, { wasmModule }));
