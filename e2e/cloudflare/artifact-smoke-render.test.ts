// Cloudflare self-host: create-artifact runs its smoke render in QuickJS inside
// workerd. The render fails open when the sandbox is unavailable, so a created
// artifact proves nothing; a component that throws on first render being
// REFUSED proves the WASM-inlined QuickJS actually ran.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

scenario(
  "Cloudflare · create-artifact refuses a component that throws on first render",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);
    const suffix = randomBytes(4).toString("hex");

    const refused = yield* session.call("create-artifact", {
      code: `function App() { throw new Error("boom-${suffix}"); }`,
      title: `Throws ${suffix}`,
      description: "Should never be saved",
    });

    expect(refused.ok, "create-artifact refuses a first-render throw").toBe(false);
    expect(refused.text, "the refusal carries the sandbox's own error").toContain(`boom-${suffix}`);
  }),
);
