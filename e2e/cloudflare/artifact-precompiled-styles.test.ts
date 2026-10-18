// Cloudflare self-host: an artifact saved through the API is precompiled by the
// host, and the page renders it with the model's own classes styled from the
// stored CSS. The assertion is on COMPUTED styles two frames down, because a
// class present in the DOM was always true even when it did nothing.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { AccountHttpApi } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([] as const);

// Classes that exist nowhere in the shell's own sources: they only become CSS
// through the artifact's own styles.
const CODE = `function App() {
  return (
    <div id="probe">
      <div id="size" className="text-2xl">24</div>
      <div id="grid" className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <span>a</span><span>b</span><span>c</span><span>d</span>
      </div>
      <div id="arbitrary" className="tracking-[0.08em] text-[11px]">label</div>
    </div>
  );
}`;

scenario(
  "Cloudflare · an artifact created through the API renders with its model-written classes styled",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: apiClient } = yield* Api;

    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const accountClient = yield* apiClient(AccountHttpApi, identity);
    const orgSlug = (yield* accountClient.account.me()).organization?.slug;

    const title = `Styled classes ${randomBytes(4).toString("hex")}`;
    const saved = yield* client.artifacts.save({ payload: { title, code: CODE } });

    yield* Effect.gen(function* () {
      const fetched = yield* client.artifacts.get({ params: { artifactId: saved.id } });
      expect(fetched.compiled?.js, "the host stored the compiled JS").toContain("createElement");
      expect(fetched.compiled?.css, "the host stored the artifact's CSS").toContain(".text-2xl");

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the artifact saved through the API", async () => {
          const path = orgSlug ? `/${orgSlug}/artifacts/${saved.id}` : `/artifacts/${saved.id}`;
          await visit(page, new URL(path, target.baseUrl).toString());
          await page
            .frameLocator('[data-testid="artifact-shell-frame"]')
            .frameLocator("iframe")
            .locator("#probe")
            .waitFor({ timeout: 30_000 });
        });

        await step("The model's own classes are real styles", async () => {
          const computed = await page
            .frameLocator('[data-testid="artifact-shell-frame"]')
            .frameLocator("iframe")
            .locator("#probe")
            .evaluate(() => {
              const styleOf = (id: string) => getComputedStyle(document.getElementById(id)!);
              return {
                fontSize: styleOf("size").fontSize,
                gridColumns: styleOf("grid").gridTemplateColumns.split(" ").length,
                labelSize: styleOf("arbitrary").fontSize,
              };
            });
          expect(computed.fontSize, "text-2xl resolves to its real size").toBe("24px");
          expect(computed.gridColumns, "md:grid-cols-4 produces four columns").toBe(4);
          expect(computed.labelSize, "an arbitrary text size compiles").toBe("11px");
        });
      });
    }).pipe(
      Effect.ensuring(
        client.artifacts.remove({ params: { artifactId: saved.id } }).pipe(
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: cleanup must fail the scenario if the API cannot remove the fixture
          Effect.orDie,
        ),
      ),
    );
  }),
);
