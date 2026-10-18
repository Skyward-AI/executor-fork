import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { buildPrecompileAssets } from "../../scripts/gen-precompile-assets";

// The fingerprint decides whether stored compiled output is still valid, so a
// stale gen file would serve output from an old compiler or theme. Change the
// compiler, the extractor, the theme or either pinned version and this fails
// until `bun run gen:precompile` is run.
describe("precompile gen files", () => {
  const { assets, fingerprint } = buildPrecompileAssets();

  it("assets.gen.ts matches the sources it embeds", () => {
    expect(fs.readFileSync(path.join(import.meta.dirname, "assets.gen.ts"), "utf8")).toBe(assets);
  });

  it("compile-fingerprint.gen.ts matches the current inputs", () => {
    expect(
      fs.readFileSync(path.join(import.meta.dirname, "compile-fingerprint.gen.ts"), "utf8"),
    ).toContain(`"${fingerprint}"`);
  });
});
